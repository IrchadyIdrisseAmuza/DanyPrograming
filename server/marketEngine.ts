import crypto from 'node:crypto';
import {
  db,
  generateId,
  generateReference,
  getPlatformSettings,
  logAudit,
  withTransaction,
  type MarketControlMode,
} from './db.ts';

type RegimeType = 'ABERTURA' | 'EXPANSÃO' | 'CONSOLIDAÇÃO' | 'FECHO';

export interface MarketSessionRecord {
  id: string;
  session_number: number;
  regime: RegimeType;
  drift: number;
  volatility: number;
  seed_hash: string;
  open_price: number;
  close_price: number | null;
  started_at: string;
  ends_at: string;
  status: 'ACTIVE' | 'CLOSED';
}

export interface MarketTickRecord {
  id: number;
  session_id: string;
  price: number;
  delta: number;
  delta_pct: number;
  timestamp: string;
}

export interface OrderBookLevel {
  price: number;
  size_usd: number;
  total_usd: number;
}

export interface MarketTapeItem {
  id: string;
  side: 'SUBIDA' | 'DESCIDA';
  price: number;
  amount_usd: number;
  timestamp: string;
}

export interface GlobalMarketSnapshot {
  index_name: string;
  methodology: string;
  current_price: number;
  previous_price: number;
  open_24h_price: number;
  high_24h: number;
  low_24h: number;
  volume_24h_usd: number;
  change_24h_pct: number;
  movement: 'SUBIDA' | 'DESCIDA' | 'NEUTRO';
  session: MarketSessionRecord;
  global_market_value: number;
  global_market_delta_pct: number;
  active_investors: number;
  total_active_operations: number;
  capital_in_operations_usd: number;
  sentiment_up_pct: number;
  sentiment_down_pct: number;
  market_paused: boolean;
  market_control_mode: MarketControlMode;
  usd_to_mt_rate: number;
  proportional_multiplier: number;
  max_gain_pct: number;
  max_duration_days: number;
  recent_ticks: MarketTickRecord[];
  order_book: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  };
  recent_tape: MarketTapeItem[];
}

type BroadcastFn = (event: string, payload: unknown) => void;

export interface SettledOperationEvent {
  operationId: string;
  userId: string;
  reference: string;
  direction: 'SUBIDA' | 'DESCIDA';
  amountUsd: number;
  netResult: number;
  payout: number;
  returnPct: number;
  entryPrice: number;
  exitPrice: number;
  terminationReason: 'ZEROED_OUT' | 'ZEROED_AT_EXPIRY' | 'EXPIRED';
  settledAt: string;
}

const REGIMES: Array<{ regime: RegimeType; driftRange: [number, number]; volMult: number }> = [
  { regime: 'ABERTURA', driftRange: [-0.00012, 0.00022], volMult: 1.05 },
  { regime: 'EXPANSÃO', driftRange: [-0.00025, 0.00032], volMult: 1.3 },
  { regime: 'CONSOLIDAÇÃO', driftRange: [-0.0001, 0.0001], volMult: 0.75 },
  { regime: 'FECHO', driftRange: [-0.00018, 0.00018], volMult: 0.95 },
];

export class MarketEngine {
  private broadcast: BroadcastFn;
  private onOperationSettled?: (event: SettledOperationEvent) => void;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private currentPrice = 2500.0;
  private previousPrice = 2500.0;
  private activeSession: MarketSessionRecord | null = null;

  // Organic global macro telemetry state
  private globalValueMultiplier = 825_400_000; // ~2.06T at 2500 index, fluctuates organically
  private baseInvestors = 123_418;
  private baseActiveOps = 34_890;
  private baseCapitalInOps = 86_420_500;
  private volume24h = 412_850_000;
  private tape: MarketTapeItem[] = [];

  constructor(
    broadcast: BroadcastFn,
    options?: { onOperationSettled?: (event: SettledOperationEvent) => void }
  ) {
    this.broadcast = broadcast;
    this.onOperationSettled = options?.onOperationSettled;
  }

  public init() {
    this.ensureSessionAndInitialTicks();
    this.seedInitialTape();

    // Autonomous market tick every 2 seconds
    this.tickTimer = setInterval(() => {
      try {
        this.stepTick();
      } catch (err) {
        console.error('Market tick error:', err);
      }
    }, 2000);

    // Operation settlement check every 1 second
    this.settleTimer = setInterval(() => {
      try {
        this.settleOperations();
      } catch (err) {
        console.error('Settlement error:', err);
      }
    }, 1000);
  }

  public stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
  }

  public resetFresh() {
    this.activeSession = null;
    this.currentPrice = 2500.0;
    this.previousPrice = 2500.0;
    this.ensureSessionAndInitialTicks();
    this.seedInitialTape();
    this.broadcast('market:update', this.getGlobalMarketSnapshot(160));
  }

  private seedInitialTape() {
    const now = Date.now();
    this.tape = Array.from({ length: 14 }, (_, idx) => {
      const side: 'SUBIDA' | 'DESCIDA' = crypto.randomInt(0, 100) >= 46 ? 'SUBIDA' : 'DESCIDA';
      const jitter = (crypto.randomInt(-80, 81) / 100);
      const amount = Number((crypto.randomInt(150, 18500) + crypto.randomInt(0, 99) / 100).toFixed(2));
      return {
        id: `tp_${now}_${idx}`,
        side,
        price: Number((this.currentPrice + jitter).toFixed(4)),
        amount_usd: amount,
        timestamp: new Date(now - (14 - idx) * 1800).toISOString(),
      };
    }).reverse();
  }

  private createSession(sessionNumber: number, openPrice: number, startMs: number): MarketSessionRecord {
    const settings = getPlatformSettings();
    const spec = REGIMES[(sessionNumber - 1) % REGIMES.length];
    const randFactor = crypto.randomInt(0, 10000) / 10000;
    const drift = Number(
      (spec.driftRange[0] + randFactor * (spec.driftRange[1] - spec.driftRange[0])).toFixed(6)
    );
    const volatility = Number((settings.market_base_volatility * spec.volMult).toFixed(6));
    const startedAt = new Date(startMs).toISOString();
    const endsAt = new Date(startMs + settings.session_duration_minutes * 60 * 1000).toISOString();
    const rawSeed = `${sessionNumber}|${spec.regime}|${drift}|${volatility}|${openPrice}|${startedAt}|${crypto.randomBytes(16).toString('hex')}`;
    const seedHash = crypto.createHash('sha256').update(rawSeed).digest('hex');

    const session: MarketSessionRecord = {
      id: generateId('ses'),
      session_number: sessionNumber,
      regime: spec.regime,
      drift,
      volatility,
      seed_hash: seedHash,
      open_price: Number(openPrice.toFixed(4)),
      close_price: null,
      started_at: startedAt,
      ends_at: endsAt,
      status: 'ACTIVE',
    };

    db.prepare(
      `INSERT INTO market_sessions (id, session_number, regime, drift, volatility, seed_hash, open_price, close_price, started_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.session_number,
      session.regime,
      session.drift,
      session.volatility,
      session.seed_hash,
      session.open_price,
      null,
      session.started_at,
      session.ends_at,
      'ACTIVE'
    );

    return session;
  }

  private ensureSessionAndInitialTicks() {
    const existingSession = db
      .prepare(`SELECT * FROM market_sessions WHERE status = 'ACTIVE' ORDER BY session_number DESC LIMIT 1`)
      .get() as MarketSessionRecord | undefined;

    const latestTick = db
      .prepare(`SELECT * FROM market_ticks ORDER BY id DESC LIMIT 1`)
      .get() as MarketTickRecord | undefined;

    if (existingSession && latestTick && Number(latestTick.price) >= 1800) {
      this.activeSession = existingSession;
      this.currentPrice = Number(latestTick.price);
      this.previousPrice = Number((latestTick.price - latestTick.delta).toFixed(4));
      return;
    }

    if (latestTick && Number(latestTick.price) < 1800) {
      db.exec('DELETE FROM market_ticks; DELETE FROM market_sessions;');
    }

    const nowMs = Date.now();
    const session = this.createSession(1, 2500.0, nowMs - 180 * 2000);
    this.activeSession = session;

    const tickCount = (db.prepare('SELECT COUNT(*) as c FROM market_ticks').get() as { c: number }).c;
    if (tickCount === 0) {
      let price = session.open_price;
      let prev = price;
      const insertTick = db.prepare(
        `INSERT INTO market_ticks (session_id, price, delta, delta_pct, timestamp) VALUES (?, ?, ?, ?, ?)`
      );
      withTransaction(() => {
        for (let i = 180; i >= 1; i--) {
          const ts = new Date(nowMs - i * 2000).toISOString();
          const { nextPrice, delta, deltaPct } = this.computeNextStep(price, session);
          prev = price;
          price = nextPrice;
          insertTick.run(session.id, price, delta, deltaPct, ts);
        }
      });
      this.currentPrice = price;
      this.previousPrice = prev;
    }
  }

  private resolveHouseWinDirection(price: number): 'FORCE_UP' | 'FORCE_DOWN' | 'AUTO' {
    const activeOps = db
      .prepare(
        `SELECT direction, amount_usd, entry_price, expires_at
         FROM operations
         WHERE status = 'ACTIVE'
         ORDER BY expires_at ASC`
      )
      .all() as Array<{
      direction: 'SUBIDA' | 'DESCIDA';
      amount_usd: number;
      entry_price: number;
      expires_at: string;
    }>;

    if (activeOps.length === 0) {
      return 'AUTO';
    }

    const nowMs = Date.now();
    let upPressure = 0;
    let downPressure = 0;

    for (const op of activeOps) {
      const remainingSec = Math.max(1, (new Date(op.expires_at).getTime() - nowMs) / 1000);
      const urgencyBoost = remainingSec <= 120 ? 1.5 : remainingSec <= 600 ? 1.2 : 1.0;
      // Prioritize draining the side with greater real USD exposure / urgency
      const weight = op.amount_usd * urgencyBoost;
      if (op.direction === 'SUBIDA') {
        upPressure += weight;
      } else {
        downPressure += weight;
      }
    }

    // To collect from SUBIDA positions, market must move DOWN.
    // To collect from DESCIDA positions, market must move UP.
    if (upPressure > downPressure) {
      return 'FORCE_DOWN';
    }
    if (downPressure > upPressure) {
      return 'FORCE_UP';
    }

    // Equal exposure on both sides: target the earliest-expiring operation first
    const earliest = activeOps[0];
    return earliest.direction === 'SUBIDA' ? 'FORCE_DOWN' : 'FORCE_UP';
  }

  private computeNextStep(
    price: number,
    session: MarketSessionRecord,
    controlMode: MarketControlMode = 'AUTO'
  ) {
    let effectiveMode: 'AUTO' | 'FORCE_UP' | 'FORCE_DOWN' =
      controlMode === 'HOUSE_WIN'
        ? this.resolveHouseWinDirection(price)
        : controlMode;

    let clampedPct: number;

    if (effectiveMode === 'FORCE_UP') {
      const magnitude = 0.0024 + (crypto.randomInt(0, 220) / 100000); // +0.24% to +0.46% per tick
      clampedPct = Math.min(0.0085, magnitude);
    } else if (effectiveMode === 'FORCE_DOWN') {
      const magnitude = 0.0024 + (crypto.randomInt(0, 220) / 100000); // -0.24% to -0.46% per tick
      clampedPct = -Math.min(0.0085, magnitude);
    } else {
      const u1 = Math.max(1e-7, crypto.randomInt(1, 1000000) / 1000000);
      const u2 = crypto.randomInt(0, 1000000) / 1000000;
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      const meanReversion = ((session.open_price - price) / session.open_price) * 0.012;
      const rawPct = session.drift + meanReversion + z * session.volatility;
      clampedPct = Math.max(-0.0085, Math.min(0.0085, rawPct));
    }

    const nextPrice = Math.max(100, Number((price * (1 + clampedPct)).toFixed(4)));
    const delta = Number((nextPrice - price).toFixed(4));
    const deltaPct = Number((clampedPct * 100).toFixed(4));
    return { nextPrice, delta, deltaPct };
  }

  private stepTick() {
    const settings = getPlatformSettings();
    if (settings.market_paused) {
      return;
    }

    if (!this.activeSession) {
      this.ensureSessionAndInitialTicks();
      return;
    }

    const nowMs = Date.now();
    if (nowMs >= new Date(this.activeSession.ends_at).getTime()) {
      const closedSession = this.activeSession;
      withTransaction(() => {
        db.prepare(
          `UPDATE market_sessions SET status = 'CLOSED', close_price = ? WHERE id = ?`
        ).run(this.currentPrice, closedSession.id);

        this.activeSession = this.createSession(
          closedSession.session_number + 1,
          this.currentPrice,
          nowMs
        );
      });
    }

    const session = this.activeSession!;
    const regimeSpec = REGIMES.find((r) => r.regime === session.regime) ?? REGIMES[0];
    const effectiveSession: MarketSessionRecord = {
      ...session,
      volatility: Number((settings.market_base_volatility * regimeSpec.volMult).toFixed(6)),
    };

    const { nextPrice, delta, deltaPct } = this.computeNextStep(
      this.currentPrice,
      effectiveSession,
      settings.market_control_mode
    );
    const ts = new Date(nowMs).toISOString();

    const res = db
      .prepare(
        `INSERT INTO market_ticks (session_id, price, delta, delta_pct, timestamp) VALUES (?, ?, ?, ?, ?)`
      )
      .run(session.id, nextPrice, delta, deltaPct, ts);

    if (Number(res.lastInsertRowid) % 100 === 0) {
      db.prepare(
        `DELETE FROM market_ticks WHERE id < (SELECT MAX(id) - 3000 FROM market_ticks)`
      ).run();
    }

    this.previousPrice = this.currentPrice;
    this.currentPrice = nextPrice;

    // Immediately terminate any operations whose value reached $0.00 on this tick
    this.settleOperations();

    // Organic macro liquidity & investor flow drift (never static)
    const liquidityWave = 1 + (crypto.randomInt(-32, 35) / 10000);
    this.globalValueMultiplier = Math.max(
      760_000_000,
      Math.min(910_000_000, this.globalValueMultiplier * liquidityWave)
    );
    this.baseInvestors = Math.max(
      121_500,
      Math.min(126_500, this.baseInvestors + crypto.randomInt(-6, 9))
    );
    this.baseActiveOps = Math.max(
      31_000,
      Math.min(39_500, this.baseActiveOps + crypto.randomInt(-28, 34))
    );
    this.baseCapitalInOps = Math.max(
      78_000_000,
      Math.min(98_000_000, this.baseCapitalInOps + crypto.randomInt(-185000, 210000))
    );
    const tradeAmount = Number(
      (crypto.randomInt(250, 24000) + crypto.randomInt(0, 99) / 100).toFixed(2)
    );
    this.volume24h = Number((this.volume24h + tradeAmount).toFixed(2));

    this.tape = [
      {
        id: `tp_${nowMs}_${res.lastInsertRowid}`,
        side: delta >= 0 ? 'SUBIDA' : 'DESCIDA',
        price: nextPrice,
        amount_usd: tradeAmount,
        timestamp: ts,
      },
      ...this.tape.slice(0, 13),
    ];

    const snapshot = this.getGlobalMarketSnapshot(160);
    this.broadcast('market:tick', {
      tick: {
        id: Number(res.lastInsertRowid),
        session_id: session.id,
        price: nextPrice,
        delta,
        delta_pct: deltaPct,
        timestamp: ts,
      },
      snapshot,
    });
  }

  public applyControlModeNow() {
    const settings = getPlatformSettings();
    if (!settings.market_paused) {
      this.stepTick();
    } else {
      this.broadcast('market:update', this.getGlobalMarketSnapshot(160));
    }
  }

  public settleOperations() {
    const nowIso = new Date().toISOString();
    const activeOps = db
      .prepare(`SELECT * FROM operations WHERE status = 'ACTIVE'`)
      .all() as Array<{
      id: string;
      reference: string;
      user_id: string;
      direction: 'SUBIDA' | 'DESCIDA';
      amount_usd: number;
      entry_price: number;
      expires_at: string;
      rule_snapshot: string;
    }>;

    if (activeOps.length === 0) return;

    const exitPrice = this.currentPrice;

    for (const op of activeOps) {
      let multiplier = 25;
      try {
        const rules = JSON.parse(op.rule_snapshot) as {
          proportional_multiplier?: number;
        };
        if (rules.proportional_multiplier) multiplier = rules.proportional_multiplier;
      } catch {
        // Use defaults
      }

      const priceChangePct = (exitPrice - op.entry_price) / op.entry_price;
      const directionalPct = op.direction === 'SUBIDA' ? priceChangePct : -priceChangePct;
      const rawReturnRate = directionalPct * multiplier;
      const boundedReturnRate = Math.max(-1.0, rawReturnRate);
      const payout = Math.max(0, Number((op.amount_usd * (1 + boundedReturnRate)).toFixed(2)));

      const hitZero = payout <= 0 || boundedReturnRate <= -1.0;
      const isExpired = op.expires_at <= nowIso;

      // Only terminate early if the operation's value hits $0.00; winning/positive positions wait for configured expiry
      if (!hitZero && !isExpired) {
        continue;
      }

      const terminationReason =
        hitZero && !isExpired ? 'ZEROED_OUT' : hitZero ? 'ZEROED_AT_EXPIRY' : 'EXPIRED';

      const settled = withTransaction(() => {
        const freshOp = db
          .prepare(`SELECT status FROM operations WHERE id = ?`)
          .get(op.id) as { status: string } | undefined;
        if (!freshOp || freshOp.status !== 'ACTIVE') return null;

        const netResult = Number((payout - op.amount_usd).toFixed(2));
        const returnPct = Number((boundedReturnRate * 100).toFixed(2));

        const wallet = db
          .prepare(`SELECT available_balance, locked_balance FROM wallets WHERE user_id = ?`)
          .get(op.user_id) as { available_balance: number; locked_balance: number };

        const newLocked = Math.max(0, Number((wallet.locked_balance - op.amount_usd).toFixed(2)));
        const newAvailable = Number((wallet.available_balance + payout).toFixed(2));

        db.prepare(
          `UPDATE wallets SET available_balance = ?, locked_balance = ?, updated_at = ? WHERE user_id = ?`
        ).run(newAvailable, newLocked, nowIso, op.user_id);

        db.prepare(
          `UPDATE operations
           SET exit_price = ?, result_amount_usd = ?, payout_amount_usd = ?, return_pct = ?, status = 'COMPLETED', termination_reason = ?, settled_at = ?
           WHERE id = ?`
        ).run(exitPrice, netResult, payout, returnPct, terminationReason, nowIso, op.id);

        const ledgerType =
          netResult > 0 ? 'OP_SETTLE_WIN' : netResult < 0 ? 'OP_SETTLE_LOSS' : 'OP_SETTLE_DRAW';
        const signStr = netResult >= 0 ? `+$${netResult.toFixed(2)}` : `-$${Math.abs(netResult).toFixed(2)}`;
        const reasonTag = hitZero && !isExpired ? 'Encerrada ao atingir $0.00' : 'Liquidação no vencimento';

        db.prepare(
          `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          generateId('led'),
          generateReference('TXN'),
          op.user_id,
          ledgerType,
          payout,
          wallet.available_balance,
          newAvailable,
          `${reasonTag} ${op.reference} (${op.direction}): retorno ${returnPct.toFixed(2)}% (${signStr})`,
          nowIso
        );

        db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          generateId('ntf'),
          op.user_id,
          hitZero && !isExpired
            ? `Operação ${op.reference} encerrada ($0.00)`
            : `Operação ${op.reference} concluída`,
          `Direção ${op.direction} · Aplicado $${op.amount_usd.toFixed(2)} · Liquidação $${payout.toFixed(2)} · Resultado ${signStr} (${returnPct.toFixed(2)}%).`,
          'OPERATION',
          0,
          nowIso
        );

        logAudit({
          actorId: null,
          actorEmail: 'market-engine@milion.space',
          actorRole: 'SYSTEM',
          action: hitZero && !isExpired ? 'OPERATION_ZEROED_OUT' : 'OPERATION_SETTLED',
          entityType: 'OPERATION',
          entityId: op.id,
          details: {
            reference: op.reference,
            direction: op.direction,
            entry_price: op.entry_price,
            exit_price: exitPrice,
            payout_amount_usd: payout,
            net_result_usd: netResult,
            return_pct: returnPct,
            zeroed_early: hitZero && !isExpired,
          },
        });

        return {
          operationId: op.id,
          userId: op.user_id,
          reference: op.reference,
          direction: op.direction,
          amountUsd: op.amount_usd,
          netResult,
          payout,
          returnPct,
          entryPrice: op.entry_price,
          exitPrice,
          terminationReason,
          settledAt: nowIso,
        } satisfies SettledOperationEvent;
      });

      if (settled) {
        this.broadcast('operation:settled', settled);
        try {
          this.onOperationSettled?.(settled);
        } catch (err) {
          console.error('onOperationSettled callback error:', err);
        }
      }
    }
  }

  public getCurrentPrice(): number {
    return this.currentPrice;
  }

  private buildOrderBook(): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
    const bids: OrderBookLevel[] = [];
    const asks: OrderBookLevel[] = [];
    let bidTotal = 0;
    let askTotal = 0;

    for (let i = 1; i <= 6; i++) {
      const spreadStep = i * (0.42 + (crypto.randomInt(0, 25) / 100));
      const bidSize = Number((crypto.randomInt(12000, 95000) + i * 8500).toFixed(2));
      bidTotal = Number((bidTotal + bidSize).toFixed(2));
      bids.push({
        price: Number((this.currentPrice - spreadStep).toFixed(2)),
        size_usd: bidSize,
        total_usd: bidTotal,
      });

      const askSize = Number((crypto.randomInt(12000, 95000) + i * 8200).toFixed(2));
      askTotal = Number((askTotal + askSize).toFixed(2));
      asks.push({
        price: Number((this.currentPrice + spreadStep).toFixed(2)),
        size_usd: askSize,
        total_usd: askTotal,
      });
    }

    return { bids, asks: asks.reverse() };
  }

  public getGlobalMarketSnapshot(tickLimit = 160): GlobalMarketSnapshot {
    const settings = getPlatformSettings();
    const session =
      this.activeSession ??
      (db
        .prepare(`SELECT * FROM market_sessions ORDER BY session_number DESC LIMIT 1`)
        .get() as MarketSessionRecord);

    const recentTicksDesc = db
      .prepare(`SELECT * FROM market_ticks ORDER BY id DESC LIMIT ?`)
      .all(tickLimit) as MarketTickRecord[];
    const recentTicks = [...recentTicksDesc].reverse();

    const firstTick = recentTicks[0];
    const open24 = firstTick ? firstTick.price : this.currentPrice;
    const allPrices = recentTicks.map((t) => t.price);
    const high24 = allPrices.length > 0 ? Math.max(...allPrices, this.currentPrice) : this.currentPrice;
    const low24 = allPrices.length > 0 ? Math.min(...allPrices, this.currentPrice) : this.currentPrice;
    const changePct =
      open24 > 0
        ? Number((((this.currentPrice - open24) / open24) * 100).toFixed(3))
        : 0;

    const activeStats = db
      .prepare(
        `SELECT
           COUNT(*) as total_ops,
           COUNT(DISTINCT user_id) as active_investors,
           COALESCE(SUM(amount_usd), 0) as capital_in_ops,
           COALESCE(SUM(CASE WHEN direction = 'SUBIDA' THEN 1 ELSE 0 END), 0) as up_count,
           COALESCE(SUM(CASE WHEN direction = 'DESCIDA' THEN 1 ELSE 0 END), 0) as down_count
         FROM operations
         WHERE status = 'ACTIVE'`
      )
      .get() as {
      total_ops: number;
      active_investors: number;
      capital_in_ops: number;
      up_count: number;
      down_count: number;
    };

    const dbTotal = activeStats.up_count + activeStats.down_count;
    // Dynamic sentiment combining order flow + real active ops
    const marketBias = this.currentPrice >= open24 ? 58 : 42;
    const sentimentUp =
      dbTotal > 0
        ? Math.round((activeStats.up_count / dbTotal) * 40 + marketBias * 0.6)
        : Math.max(36, Math.min(68, marketBias + Math.round(changePct * 4)));
    const sentimentDown = 100 - sentimentUp;

    const movement: 'SUBIDA' | 'DESCIDA' | 'NEUTRO' =
      this.currentPrice > this.previousPrice
        ? 'SUBIDA'
        : this.currentPrice < this.previousPrice
          ? 'DESCIDA'
          : 'NEUTRO';

    const globalMarketValue = Number(
      (this.currentPrice * this.globalValueMultiplier + activeStats.capital_in_ops).toFixed(2)
    );
    const baselineVal = 2500 * 825_400_000;
    const globalDeltaPct = Number((((globalMarketValue - baselineVal) / baselineVal) * 100).toFixed(3));

    return {
      index_name: 'MIL-IDX',
      methodology: 'Índice autónomo MIL-IDX em tempo real.',
      current_price: Number(this.currentPrice.toFixed(4)),
      previous_price: Number(this.previousPrice.toFixed(4)),
      open_24h_price: Number(open24.toFixed(4)),
      high_24h: Number(high24.toFixed(4)),
      low_24h: Number(low24.toFixed(4)),
      volume_24h_usd: this.volume24h,
      change_24h_pct: changePct,
      movement,
      session,
      global_market_value: globalMarketValue,
      global_market_delta_pct: globalDeltaPct,
      active_investors: this.baseInvestors + activeStats.active_investors,
      total_active_operations: this.baseActiveOps + activeStats.total_ops,
      capital_in_operations_usd: Number((this.baseCapitalInOps + activeStats.capital_in_ops).toFixed(2)),
      sentiment_up_pct: sentimentUp,
      sentiment_down_pct: sentimentDown,
      market_paused: settings.market_paused,
      market_control_mode: settings.market_control_mode,
      usd_to_mt_rate: settings.usd_to_mt_rate,
      proportional_multiplier: settings.proportional_multiplier,
      max_gain_pct: settings.max_gain_pct,
      max_duration_days: settings.max_duration_days,
      recent_ticks: recentTicks,
      order_book: this.buildOrderBook(),
      recent_tape: this.tape,
    };
  }
}
