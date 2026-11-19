import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.MILION_DB_PATH
  ? path.resolve(process.env.MILION_DB_PATH)
  : path.resolve(process.cwd(), 'milion.db');

function cleanupSqliteSidecars() {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${DB_PATH}${suffix}`;
    if (fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        // ignore
      }
    }
  }
}

function openHealthyDatabase(): DatabaseSync {
  const configure = (conn: DatabaseSync) => {
    conn.exec('PRAGMA busy_timeout = 5000;');
    conn.exec('PRAGMA journal_mode = DELETE;');
    conn.exec('PRAGMA synchronous = FULL;');
    conn.exec('PRAGMA foreign_keys = ON;');
  };

  try {
    const conn = new DatabaseSync(DB_PATH);
    conn.exec('PRAGMA busy_timeout = 5000;');
    const check = conn.prepare('PRAGMA quick_check(1);').get() as
      | { quick_check?: string }
      | undefined;
    if (check?.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${check?.quick_check ?? 'unknown'}`);
    }
    configure(conn);
    return conn;
  } catch (err) {
    console.error('Corrupted SQLite database detected, recreating clean database:', err);
    if (fs.existsSync(DB_PATH)) {
      try {
        fs.renameSync(DB_PATH, `${DB_PATH}.corrupt.${Date.now()}`);
      } catch {
        try {
          fs.unlinkSync(DB_PATH);
        } catch {
          // ignore
        }
      }
    }
    cleanupSqliteSidecars();
    const fresh = new DatabaseSync(DB_PATH);
    configure(fresh);
    return fresh;
  }
}

export const db = openHealthyDatabase();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function generateId(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function generateReference(prefix: string): string {
  const num = crypto.randomInt(100000, 999999);
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${num}-${suffix}`;
}

export function generatePublicCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = `MIL-${crypto.randomInt(100000, 999999)}`;
    const existing = db.prepare('SELECT id FROM users WHERE public_code = ?').get(code);
    if (!existing) return code;
  }
  return `MIL-${Date.now().toString().slice(-6)}`;
}

export function withDbTransaction<T>(targetDb: DatabaseSync, fn: () => T): T {
  targetDb.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    targetDb.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      targetDb.exec('ROLLBACK;');
    } catch {
      // ignore rollback error if transaction not active
    }
    throw err;
  }
}

export function withTransaction<T>(fn: () => T): T {
  return withDbTransaction(db, fn);
}

// ==================== EXACT INTEGER MINOR-UNIT MONEY HELPERS ====================

export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error('INVALID_MONEY_AMOUNT');
  }
  return Math.round((amount + Number.EPSILON) * 100);
}

export function fromMinorUnits(cents: number): number {
  return Number((Math.round(cents) / 100).toFixed(2));
}

export function usdCentsToMtCents(usdCents: number, usdToMtRate = 70): number {
  return Math.round(usdCents * usdToMtRate);
}

export function mtCentsToUsdCents(mtCents: number, usdToMtRate = 70): number {
  return Math.round(mtCents / usdToMtRate);
}

export type MarketControlMode = 'AUTO' | 'FORCE_UP' | 'FORCE_DOWN' | 'HOUSE_WIN';

export interface PlatformSettings {
  usd_to_mt_rate: number;
  min_deposit_usd: number;
  min_withdrawal_usd: number;
  proportional_multiplier: number;
  max_gain_pct: number;
  max_duration_days: number;
  market_base_volatility: number;
  market_paused: boolean;
  session_duration_minutes: number;
  market_control_mode: MarketControlMode;
}

export function getSettingsFromDb(targetDb: DatabaseSync): PlatformSettings {
  const rows = targetDb.prepare('SELECT key, value FROM platform_settings').all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const rawMode = map.get('market_control_mode') ?? 'AUTO';
  const controlMode: MarketControlMode =
    rawMode === 'FORCE_UP' || rawMode === 'FORCE_DOWN' || rawMode === 'HOUSE_WIN'
      ? rawMode
      : 'AUTO';
  return {
    usd_to_mt_rate: Number(map.get('usd_to_mt_rate') ?? 70),
    min_deposit_usd: Number(map.get('min_deposit_usd') ?? 1),
    min_withdrawal_usd: Number(map.get('min_withdrawal_usd') ?? 2),
    proportional_multiplier: Number(map.get('proportional_multiplier') ?? 25),
    max_gain_pct: Number(map.get('max_gain_pct') ?? 200),
    max_duration_days: Number(map.get('max_duration_days') ?? 14),
    market_base_volatility: Number(map.get('market_base_volatility') ?? 0.0016),
    market_paused: map.get('market_paused') === '1',
    session_duration_minutes: Number(map.get('session_duration_minutes') ?? 240),
    market_control_mode: controlMode,
  };
}

export function getPlatformSettings(): PlatformSettings {
  return getSettingsFromDb(db);
}

export function logDbAudit(
  targetDb: DatabaseSync,
  params: {
    actorId: string | null;
    actorEmail: string;
    actorRole: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }
) {
  targetDb
    .prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_email, actor_role, action, entity_type, entity_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      generateId('aud'),
      params.actorId,
      params.actorEmail,
      params.actorRole,
      params.action,
      params.entityType,
      params.entityId,
      JSON.stringify(params.details),
      new Date().toISOString()
    );
}

export function logAudit(params: {
  actorId: string | null;
  actorEmail: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}) {
  logDbAudit(db, params);
}

const DEPOSIT_STATES_CHECK = `'CREATED', 'PAYMENT_PENDING', 'PAID', 'CREDITED', 'FAILED', 'EXPIRED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'`;
const WITHDRAWAL_STATES_CHECK = `'AWAITING_APPROVAL', 'APPROVED', 'DISBURSEMENT_PENDING', 'PAID', 'REJECTED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'PENDING', 'CANCELLED'`;

function migrateTableStatusCheckIfNeeded(
  targetDb: DatabaseSync,
  tableName: 'deposit_requests' | 'withdrawal_requests'
) {
  const row = targetDb
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: string } | undefined;
  if (!row?.sql) return;

  const sentinel = tableName === 'deposit_requests' ? 'PAYMENT_PENDING' : 'AWAITING_APPROVAL';
  if (row.sql.includes(sentinel)) {
    return;
  }

  targetDb.exec('PRAGMA foreign_keys = OFF;');
  try {
    withDbTransaction(targetDb, () => {
      if (tableName === 'deposit_requests') {
        targetDb.exec(`
          CREATE TABLE deposit_requests_migrated (
            id TEXT PRIMARY KEY,
            reference TEXT UNIQUE NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            method TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'M-PESA',
            msisdn TEXT,
            msisdn_masked TEXT,
            idempotency_key TEXT,
            provider_reference TEXT,
            mpesa_transaction_id TEXT,
            mpesa_conversation_id TEXT,
            mpesa_response_code TEXT,
            mpesa_response_desc TEXT,
            amount_usd REAL NOT NULL CHECK(amount_usd > 0),
            amount_mt REAL NOT NULL CHECK(amount_mt > 0),
            amount_usd_cents INTEGER,
            amount_mt_cents INTEGER,
            exchange_rate_used REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING' CHECK(status IN (${DEPOSIT_STATES_CHECK})),
            notes TEXT,
            reviewed_by TEXT,
            reviewed_at TEXT,
            confirmed_at TEXT,
            credited_at TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO deposit_requests_migrated (
            id, reference, user_id, method, msisdn, mpesa_transaction_id, mpesa_conversation_id,
            mpesa_response_code, mpesa_response_desc, amount_usd, amount_mt, amount_usd_cents, amount_mt_cents,
            exchange_rate_used, status, notes, reviewed_by, reviewed_at, created_at
          )
          SELECT
            id, reference, user_id, method, msisdn, mpesa_transaction_id, mpesa_conversation_id,
            mpesa_response_code, mpesa_response_desc, amount_usd, amount_mt,
            CAST(ROUND(amount_usd * 100) AS INTEGER),
            CAST(ROUND(amount_mt * 100) AS INTEGER),
            exchange_rate_used, status, notes, reviewed_by, reviewed_at, created_at
          FROM deposit_requests;
          DROP TABLE deposit_requests;
          ALTER TABLE deposit_requests_migrated RENAME TO deposit_requests;
        `);
      } else {
        targetDb.exec(`
          CREATE TABLE withdrawal_requests_migrated (
            id TEXT PRIMARY KEY,
            reference TEXT UNIQUE NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            destination_type TEXT NOT NULL,
            destination_account TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'M-PESA',
            msisdn TEXT,
            msisdn_masked TEXT,
            idempotency_key TEXT,
            mpesa_transaction_id TEXT,
            mpesa_conversation_id TEXT,
            mpesa_response_code TEXT,
            mpesa_response_desc TEXT,
            amount_usd REAL NOT NULL CHECK(amount_usd > 0),
            amount_mt REAL NOT NULL CHECK(amount_mt > 0),
            amount_usd_cents INTEGER,
            amount_mt_cents INTEGER,
            exchange_rate_used REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL' CHECK(status IN (${WITHDRAWAL_STATES_CHECK})),
            disbursement_status TEXT,
            risk_score INTEGER DEFAULT 0,
            risk_flags TEXT,
            notes TEXT,
            reviewed_by TEXT,
            reviewed_at TEXT,
            approved_by TEXT,
            approved_at TEXT,
            paid_at TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO withdrawal_requests_migrated (
            id, reference, user_id, destination_type, destination_account, msisdn, mpesa_transaction_id,
            mpesa_conversation_id, mpesa_response_code, mpesa_response_desc, amount_usd, amount_mt,
            amount_usd_cents, amount_mt_cents, exchange_rate_used, status, notes, reviewed_by, reviewed_at, created_at
          )
          SELECT
            id, reference, user_id, destination_type, destination_account, msisdn, mpesa_transaction_id,
            mpesa_conversation_id, mpesa_response_code, mpesa_response_desc, amount_usd, amount_mt,
            CAST(ROUND(amount_usd * 100) AS INTEGER),
            CAST(ROUND(amount_mt * 100) AS INTEGER),
            exchange_rate_used, status, notes, reviewed_by, reviewed_at, created_at
          FROM withdrawal_requests;
          DROP TABLE withdrawal_requests;
          ALTER TABLE withdrawal_requests_migrated RENAME TO withdrawal_requests;
        `);
      }
    });
  } finally {
    targetDb.exec('PRAGMA foreign_keys = ON;');
  }
}

export function initSchema(targetDb: DatabaseSync, seedAdmin = true) {
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      public_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('USER', 'ADMIN', 'SUPER_ADMIN')),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      recovery_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available_balance REAL NOT NULL DEFAULT 0 CHECK(available_balance >= 0),
      locked_balance REAL NOT NULL DEFAULT 0 CHECK(locked_balance >= 0),
      pending_balance REAL NOT NULL DEFAULT 0 CHECK(pending_balance >= 0),
      reserved_balance REAL NOT NULL DEFAULT 0 CHECK(reserved_balance >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposit_requests (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'M-PESA',
      msisdn TEXT,
      msisdn_masked TEXT,
      idempotency_key TEXT,
      provider_reference TEXT,
      mpesa_transaction_id TEXT,
      mpesa_conversation_id TEXT,
      mpesa_response_code TEXT,
      mpesa_response_desc TEXT,
      amount_usd REAL NOT NULL CHECK(amount_usd > 0),
      amount_mt REAL NOT NULL CHECK(amount_mt > 0),
      amount_usd_cents INTEGER,
      amount_mt_cents INTEGER,
      exchange_rate_used REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING' CHECK(status IN (${DEPOSIT_STATES_CHECK})),
      notes TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      confirmed_at TEXT,
      credited_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      destination_type TEXT NOT NULL,
      destination_account TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'M-PESA',
      msisdn TEXT,
      msisdn_masked TEXT,
      idempotency_key TEXT,
      mpesa_transaction_id TEXT,
      mpesa_conversation_id TEXT,
      mpesa_response_code TEXT,
      mpesa_response_desc TEXT,
      amount_usd REAL NOT NULL CHECK(amount_usd > 0),
      amount_mt REAL NOT NULL CHECK(amount_mt > 0),
      amount_usd_cents INTEGER,
      amount_mt_cents INTEGER,
      exchange_rate_used REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL' CHECK(status IN (${WITHDRAWAL_STATES_CHECK})),
      disbursement_status TEXT,
      risk_score INTEGER DEFAULT 0,
      risk_flags TEXT,
      notes TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      approved_by TEXT,
      approved_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_attempts (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('DEPOSIT', 'WITHDRAWAL')),
      entity_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT,
      request_payload_json TEXT,
      response_code TEXT,
      response_desc TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_transactions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('DEPOSIT', 'WITHDRAWAL')),
      entity_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      provider_tx_id TEXT NOT NULL,
      conversation_id TEXT,
      third_party_conversation_id TEXT,
      amount_mt_cents INTEGER NOT NULL CHECK(amount_mt_cents > 0),
      currency TEXT NOT NULL DEFAULT 'MZN',
      status TEXT NOT NULL,
      raw_payload_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(provider, provider_tx_id)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reference TEXT,
      provider_tx_id TEXT,
      amount_mt_cents INTEGER,
      currency TEXT,
      status TEXT NOT NULL,
      signature_valid INTEGER NOT NULL DEFAULT 0,
      raw_payload_json TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(provider, event_key)
    );

    CREATE TABLE IF NOT EXISTS withdrawal_reserves (
      id TEXT PRIMARY KEY,
      withdrawal_id TEXT UNIQUE NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_usd_cents INTEGER NOT NULL CHECK(amount_usd_cents > 0),
      status TEXT NOT NULL CHECK(status IN ('HELD', 'RELEASED', 'CONSUMED')),
      created_at TEXT NOT NULL,
      released_at TEXT,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS disbursement_orders (
      id TEXT PRIMARY KEY,
      withdrawal_id TEXT UNIQUE NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
      reference TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      msisdn TEXT NOT NULL,
      amount_usd_cents INTEGER NOT NULL CHECK(amount_usd_cents > 0),
      amount_mt_cents INTEGER NOT NULL CHECK(amount_mt_cents > 0),
      exchange_rate_used REAL NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED')),
      provider_tx_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reconciliation_records (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('DEPOSIT', 'WITHDRAWAL')),
      entity_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'RESOLVED_CONFIRMED', 'RESOLVED_FAILED')),
      resolution_notes TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entity_id TEXT,
      response_status INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS market_sessions (
      id TEXT PRIMARY KEY,
      session_number INTEGER NOT NULL,
      regime TEXT NOT NULL,
      drift REAL NOT NULL,
      volatility REAL NOT NULL,
      seed_hash TEXT NOT NULL,
      open_price REAL NOT NULL,
      close_price REAL,
      started_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CLOSED'))
    );

    CREATE TABLE IF NOT EXISTS market_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES market_sessions(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      delta REAL NOT NULL,
      delta_pct REAL NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT UNIQUE NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('SUBIDA', 'DESCIDA')),
      amount_usd REAL NOT NULL CHECK(amount_usd > 0),
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 300),
      entry_price REAL NOT NULL,
      exit_price REAL,
      result_amount_usd REAL,
      payout_amount_usd REAL,
      return_pct REAL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'REJECTED')),
      termination_reason TEXT,
      opened_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT,
      rule_snapshot TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'INFO',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
      admin_reply TEXT,
      replied_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (notification_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_payouts (
      id TEXT PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      admin_id TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      recipient_name TEXT,
      msisdn TEXT NOT NULL,
      msisdn_masked TEXT NOT NULL,
      amount_usd REAL NOT NULL CHECK(amount_usd > 0),
      amount_mt REAL NOT NULL CHECK(amount_mt > 0),
      fee_pct REAL NOT NULL DEFAULT 2,
      fee_usd REAL NOT NULL DEFAULT 0,
      total_deducted_usd REAL NOT NULL CHECK(total_deducted_usd > 0),
      exchange_rate_used REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PROCESSING', 'PAID', 'FAILED', 'RECONCILIATION_REQUIRED')),
      provider TEXT NOT NULL,
      provider_payout_id TEXT,
      provider_transaction_id TEXT,
      response_code TEXT,
      response_desc TEXT,
      notes TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_email_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('ACCOUNT_CONFIRMATION', 'PASSWORD_RECOVERY', 'VERIFICATION_CODE')),
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  // Safe incremental ALTERs for pre-existing tables before status check migrations
  const safeAlterColumns = [
    `ALTER TABLE operations ADD COLUMN termination_reason TEXT`,
    `ALTER TABLE wallets ADD COLUMN reserved_balance REAL NOT NULL DEFAULT 0 CHECK(reserved_balance >= 0)`,
    `ALTER TABLE deposit_requests ADD COLUMN msisdn TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN msisdn_masked TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN provider TEXT NOT NULL DEFAULT 'M-PESA'`,
    `ALTER TABLE deposit_requests ADD COLUMN idempotency_key TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN provider_reference TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN amount_usd_cents INTEGER`,
    `ALTER TABLE deposit_requests ADD COLUMN amount_mt_cents INTEGER`,
    `ALTER TABLE deposit_requests ADD COLUMN confirmed_at TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN credited_at TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN mpesa_transaction_id TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN mpesa_conversation_id TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN mpesa_response_code TEXT`,
    `ALTER TABLE deposit_requests ADD COLUMN mpesa_response_desc TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN msisdn TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN msisdn_masked TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN provider TEXT NOT NULL DEFAULT 'M-PESA'`,
    `ALTER TABLE withdrawal_requests ADD COLUMN idempotency_key TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN amount_usd_cents INTEGER`,
    `ALTER TABLE withdrawal_requests ADD COLUMN amount_mt_cents INTEGER`,
    `ALTER TABLE withdrawal_requests ADD COLUMN disbursement_status TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN risk_score INTEGER DEFAULT 0`,
    `ALTER TABLE withdrawal_requests ADD COLUMN risk_flags TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN approved_by TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN approved_at TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN paid_at TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN mpesa_transaction_id TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN mpesa_conversation_id TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN mpesa_response_code TEXT`,
    `ALTER TABLE withdrawal_requests ADD COLUMN mpesa_response_desc TEXT`,
    `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN email_verified_at TEXT`,
  ];
  for (const sql of safeAlterColumns) {
    try {
      targetDb.exec(sql);
    } catch {
      // Column already exists
    }
  }

  migrateTableStatusCheckIfNeeded(targetDb, 'deposit_requests');
  migrateTableStatusCheckIfNeeded(targetDb, 'withdrawal_requests');

  targetDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_operations_user ON operations(user_id, opened_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ticks_session ON market_ticks(session_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposits_user_created ON deposit_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposit_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_user_created ON withdrawal_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reconciliation_status ON reconciliation_records(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_attempts_entity ON payment_attempts(entity_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_admin_payouts_status ON admin_payouts(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_exp ON revoked_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_user ON auth_email_tokens(user_id, purpose, created_at DESC);
  `);

  const now = new Date().toISOString();
  const defaultSettings: Array<[string, string]> = [
    ['usd_to_mt_rate', '70'],
    ['min_deposit_usd', '1'],
    ['min_withdrawal_usd', '2'],
    ['proportional_multiplier', '25'],
    ['max_gain_pct', '200'],
    ['max_duration_days', '14'],
    ['market_base_volatility', '0.0016'],
    ['market_paused', '0'],
    ['session_duration_minutes', '240'],
    ['market_control_mode', 'AUTO'],
  ];

  const insertSetting = targetDb.prepare(
    `INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)`
  );
  for (const [k, v] of defaultSettings) {
    insertSetting.run(k, v, now);
  }

  if (seedAdmin) {
    const userCount = (targetDb.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    if (userCount === 0) {
      withDbTransaction(targetDb, () => {
        const adminId = generateId('usr');

        targetDb
          .prepare(
            `INSERT INTO users (id, public_code, full_name, username, phone, email, password_hash, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            adminId,
            'MIL-000001',
            'Administrador MILION',
            'admin_milion',
            '+258840000001',
            'admin@milion.space',
            hashPassword('Admin@2026'),
            'SUPER_ADMIN',
            'ACTIVE',
            now,
            now
          );

        targetDb
          .prepare(
            `INSERT INTO wallets (user_id, available_balance, locked_balance, pending_balance, reserved_balance, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(adminId, 0, 0, 0, 0, now);

        logDbAudit(targetDb, {
          actorId: adminId,
          actorEmail: 'system@milion.space',
          actorRole: 'SUPER_ADMIN',
          action: 'SYSTEM_SEED',
          entityType: 'PLATFORM',
          entityId: 'milion.space',
          details: { message: 'Inicialização da plataforma MILION.SPACE apenas com conta administrativa' },
        });
      });
    }
  }
}

export function initDatabase() {
  initSchema(db, true);
}

