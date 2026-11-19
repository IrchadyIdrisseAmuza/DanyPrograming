import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  fromMinorUnits,
  generateId,
  generateReference,
  getSettingsFromDb,
  logDbAudit,
  toMinorUnits,
  usdCentsToMtCents,
  withDbTransaction,
} from './db.ts';
import {
  maskMsisdn,
  normalizeMozMpesaMsisdn,
  verifyMpesaWebhookAuth,
  type MpesaGatewayAdapter,
  type MpesaGatewayResult,
} from './mpesa.ts';
import { getZaasPayConfig } from './zaaspay.ts';

export interface ActorInfo {
  id: string;
  email: string;
  role: string;
  phone?: string;
}

export class PaymentServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'PAYMENT_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface SanitizedDepositRow {
  id: string;
  reference: string;
  user_id: string;
  method: string;
  provider: string;
  msisdn_masked: string;
  provider_reference: string | null;
  mpesa_transaction_id: string | null;
  mpesa_conversation_id: string | null;
  mpesa_response_code: string | null;
  mpesa_response_desc: string | null;
  amount_usd: number;
  amount_mt: number;
  amount_usd_cents: number;
  amount_mt_cents: number;
  exchange_rate_used: number;
  status: string;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  confirmed_at: string | null;
  credited_at: string | null;
  created_at: string;
  full_name?: string;
  email?: string;
  public_code?: string;
}

export interface SanitizedWithdrawalRow {
  id: string;
  reference: string;
  user_id: string;
  destination_type: string;
  destination_account: string;
  provider: string;
  msisdn_masked: string;
  mpesa_transaction_id: string | null;
  mpesa_conversation_id: string | null;
  mpesa_response_code: string | null;
  mpesa_response_desc: string | null;
  amount_usd: number;
  amount_mt: number;
  amount_usd_cents: number;
  amount_mt_cents: number;
  exchange_rate_used: number;
  status: string;
  disbursement_status: string | null;
  risk_score: number;
  risk_flags: string[];
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  full_name?: string;
  email?: string;
  public_code?: string;
}

export function sanitizeDepositRow(row: Record<string, unknown>): SanitizedDepositRow {
  const msisdnRaw = (row.msisdn as string | null) || null;
  const masked = (row.msisdn_masked as string | null) || maskMsisdn(msisdnRaw);
  return {
    id: String(row.id),
    reference: String(row.reference),
    user_id: String(row.user_id),
    method: String(row.method),
    provider: String(row.provider ?? 'M-PESA'),
    msisdn_masked: masked,
    provider_reference: (row.provider_reference as string | null) ?? null,
    mpesa_transaction_id: (row.mpesa_transaction_id as string | null) ?? null,
    mpesa_conversation_id: (row.mpesa_conversation_id as string | null) ?? null,
    mpesa_response_code: (row.mpesa_response_code as string | null) ?? null,
    mpesa_response_desc: (row.mpesa_response_desc as string | null) ?? null,
    amount_usd: Number(row.amount_usd),
    amount_mt: Number(row.amount_mt),
    amount_usd_cents:
      typeof row.amount_usd_cents === 'number' ? row.amount_usd_cents : toMinorUnits(Number(row.amount_usd)),
    amount_mt_cents:
      typeof row.amount_mt_cents === 'number' ? row.amount_mt_cents : toMinorUnits(Number(row.amount_mt)),
    exchange_rate_used: Number(row.exchange_rate_used),
    status: String(row.status),
    notes: (row.notes as string | null) ?? null,
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    reviewed_at: (row.reviewed_at as string | null) ?? null,
    confirmed_at: (row.confirmed_at as string | null) ?? null,
    credited_at: (row.credited_at as string | null) ?? null,
    created_at: String(row.created_at),
    full_name: row.full_name as string | undefined,
    email: row.email as string | undefined,
    public_code: row.public_code as string | undefined,
  };
}

export function sanitizeWithdrawalRow(row: Record<string, unknown>): SanitizedWithdrawalRow {
  const msisdnRaw = (row.msisdn as string | null) || (row.destination_account as string | null) || null;
  const masked = (row.msisdn_masked as string | null) || maskMsisdn(msisdnRaw);
  let parsedFlags: string[] = [];
  if (typeof row.risk_flags === 'string' && row.risk_flags.trim().startsWith('[')) {
    try {
      parsedFlags = JSON.parse(row.risk_flags) as string[];
    } catch {
      parsedFlags = [];
    }
  }
  return {
    id: String(row.id),
    reference: String(row.reference),
    user_id: String(row.user_id),
    destination_type: String(row.destination_type),
    destination_account: masked,
    provider: String(row.provider ?? 'M-PESA'),
    msisdn_masked: masked,
    mpesa_transaction_id: (row.mpesa_transaction_id as string | null) ?? null,
    mpesa_conversation_id: (row.mpesa_conversation_id as string | null) ?? null,
    mpesa_response_code: (row.mpesa_response_code as string | null) ?? null,
    mpesa_response_desc: (row.mpesa_response_desc as string | null) ?? null,
    amount_usd: Number(row.amount_usd),
    amount_mt: Number(row.amount_mt),
    amount_usd_cents:
      typeof row.amount_usd_cents === 'number' ? row.amount_usd_cents : toMinorUnits(Number(row.amount_usd)),
    amount_mt_cents:
      typeof row.amount_mt_cents === 'number' ? row.amount_mt_cents : toMinorUnits(Number(row.amount_mt)),
    exchange_rate_used: Number(row.exchange_rate_used),
    status: String(row.status),
    disbursement_status: (row.disbursement_status as string | null) ?? null,
    risk_score: Number(row.risk_score ?? 0),
    risk_flags: parsedFlags,
    notes: (row.notes as string | null) ?? null,
    reviewed_by: (row.reviewed_by as string | null) ?? null,
    reviewed_at: (row.reviewed_at as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null,
    approved_at: (row.approved_at as string | null) ?? null,
    paid_at: (row.paid_at as string | null) ?? null,
    created_at: String(row.created_at),
    full_name: row.full_name as string | undefined,
    email: row.email as string | undefined,
    public_code: row.public_code as string | undefined,
  };
}

export class PaymentService {
  private readonly db: DatabaseSync;
  private readonly gateway: MpesaGatewayAdapter;
  private readonly nowFn: () => string;

  constructor(deps: { db: DatabaseSync; gateway: MpesaGatewayAdapter; nowFn?: () => string }) {
    this.db = deps.db;
    this.gateway = deps.gateway;
    this.nowFn = deps.nowFn ?? (() => new Date().toISOString());
  }

  public async createDeposit(params: {
    actor: ActorInfo;
    method?: string;
    msisdn?: string;
    amount_usd?: number;
    notes?: string;
    idempotencyKey?: string;
  }): Promise<{
    deposit: SanitizedDepositRow;
    gateway_configured: boolean;
    duplicate?: boolean;
    message: string;
  }> {
    if (params.method && params.method !== 'M-Pesa') {
      throw new PaymentServiceError(
        'A plataforma utiliza exclusivamente M-Pesa para novos depósitos.',
        400,
        'UNSUPPORTED_METHOD'
      );
    }

    const normalizedMsisdn = normalizeMozMpesaMsisdn((params.msisdn || params.notes || params.actor.phone || '').trim());
    if (!normalizedMsisdn) {
      throw new PaymentServiceError(
        'Indique um número M-Pesa Vodacom válido (prefixos 84 ou 85, ex.: +258 84 123 4567).',
        400,
        'INVALID_MSISDN'
      );
    }

    const settings = getSettingsFromDb(this.db);
    const rawAmount = Number(params.amount_usd);
    if (!Number.isFinite(rawAmount) || rawAmount < settings.min_deposit_usd || rawAmount > 100000) {
      throw new PaymentServiceError(
        `O valor do depósito deve estar entre $${settings.min_deposit_usd.toFixed(2)} e $100,000.00.`,
        400,
        'INVALID_AMOUNT'
      );
    }

    const amountUsdCents = toMinorUnits(rawAmount);
    if (amountUsdCents < toMinorUnits(settings.min_deposit_usd)) {
      throw new PaymentServiceError(
        `O depósito mínimo é $${settings.min_deposit_usd.toFixed(2)}.`,
        400,
        'MIN_DEPOSIT'
      );
    }

    const cleanAmountUsd = fromMinorUnits(amountUsdCents);
    const amountMtCents = usdCentsToMtCents(amountUsdCents, settings.usd_to_mt_rate);
    if (this.gateway.requiresIntegerMt?.() && amountMtCents % 100 !== 0) {
      throw new PaymentServiceError(
        'O gateway M-Pesa (ZaasPay) aceita apenas montantes inteiros em Meticais (MT). Com 1 USD = 70 MT, indique um valor em USD múltiplo de $0.10 (ex.: $1.00 = 70 MT, $1.50 = 105 MT, $10.00 = 700 MT).',
        400,
        'INTEGER_MT_REQUIRED'
      );
    }

    const amountMt = fromMinorUnits(amountMtCents);
    const maskedMsisdn = maskMsisdn(normalizedMsisdn);
    const idemKey = params.idempotencyKey?.trim() || null;

    if (idemKey) {
      const existing = this.db
        .prepare(`SELECT entity_id, response_json FROM idempotency_keys WHERE scope = 'DEPOSIT' AND user_id = ? AND idempotency_key = ?`)
        .get(params.actor.id, idemKey) as { entity_id?: string; response_json?: string } | undefined;
      if (existing?.entity_id) {
        const depRow = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(existing.entity_id) as Record<string, unknown> | undefined;
        if (depRow) {
          return {
            deposit: sanitizeDepositRow(depRow),
            gateway_configured: this.gateway.isConfigured(),
            duplicate: true,
            message: `Pedido M-Pesa ${depRow.reference} já registado (idempotência aplicada).`,
          };
        }
      }
    }

    if (!this.gateway.isConfigured()) {
      const cfg = getZaasPayConfig();
      const problemMsg = !cfg.keyPresent
        ? 'Cobrança M-Pesa (ZaasPay) indisponível: configure a chave ZAASPAY_KEY (sk_test_... ou sk_live_...) no servidor para enviar cobranças reais.'
        : 'Cobrança M-Pesa (ZaasPay) indisponível: ZAASPAY_API_URL inválida no servidor (utilize https://pay.zaastec.co.mz/v1).';
      throw new PaymentServiceError(problemMsg, 503, 'MPESA_NOT_CONFIGURED');
    }

    const now = this.nowFn();
    const id = generateId('dep');
    const reference = generateReference('MPD');
    const thirdPartyConvId = crypto.randomBytes(8).toString('hex').toUpperCase();
    const providerName = this.gateway.getProviderName();

    withDbTransaction(this.db, () => {
      if (idemKey) {
        this.db
          .prepare(
            `INSERT INTO idempotency_keys (idempotency_key, scope, user_id, entity_id, response_status, created_at)
             VALUES (?, 'DEPOSIT', ?, ?, 201, ?)`
          )
          .run(idemKey, params.actor.id, id, now);
      }

      // Create strictly in PAYMENT_PENDING — NEVER touch available_balance or pending_balance!
      this.db
        .prepare(
          `INSERT INTO deposit_requests (
             id, reference, user_id, method, provider, msisdn, msisdn_masked, idempotency_key,
             mpesa_conversation_id, amount_usd, amount_mt, amount_usd_cents, amount_mt_cents,
             exchange_rate_used, status, notes, created_at
           )
           VALUES (?, ?, ?, 'M-Pesa', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, ?)`
        )
        .run(
          id,
          reference,
          params.actor.id,
          providerName,
          normalizedMsisdn,
          maskedMsisdn,
          idemKey,
          thirdPartyConvId,
          cleanAmountUsd,
          amountMt,
          amountUsdCents,
          amountMtCents,
          settings.usd_to_mt_rate,
          (params.notes || `Depósito M-Pesa (${maskedMsisdn})`).trim().slice(0, 200),
          now
        );

      this.db
        .prepare(
          `INSERT INTO payment_attempts (
             id, direction, entity_id, reference, provider, idempotency_key, request_payload_json, status, created_at, updated_at
           )
           VALUES (?, 'DEPOSIT', ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, ?)`
        )
        .run(
          generateId('att'),
          id,
          reference,
          providerName,
          idemKey,
          JSON.stringify({ msisdn_masked: maskedMsisdn, amount_usd_cents: amountUsdCents, amount_mt_cents: amountMtCents, rate: settings.usd_to_mt_rate }),
          now,
          now
        );

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'DEPOSIT_CREATED_PAYMENT_PENDING',
        entityType: 'DEPOSIT_REQUEST',
        entityId: id,
        details: {
          reference,
          method: 'M-Pesa',
          msisdn_masked: maskedMsisdn,
          amount_usd: cleanAmountUsd,
          amount_mt: amountMt,
          rate: settings.usd_to_mt_rate,
        },
      });
    });

    // Call official M-Pesa C2B API OUTSIDE SQLite transaction
    const gwRes = await this.gateway.initiateC2B({
      amountMt,
      msisdn: normalizedMsisdn,
      reference,
      thirdPartyConversationId: thirdPartyConvId,
    });

    const afterCallAt = this.nowFn();

    if (gwRes.acceptedPending) {
      withDbTransaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE deposit_requests
             SET mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
                 mpesa_response_code = ?,
                 mpesa_response_desc = ?
             WHERE id = ?`
          )
          .run(gwRes.conversationId, gwRes.responseCode, gwRes.responseDesc, id);

        this.db
          .prepare(
            `UPDATE payment_attempts
             SET response_code = ?, response_desc = ?, status = 'PAYMENT_PENDING', updated_at = ?
             WHERE entity_id = ?`
          )
          .run(gwRes.responseCode, gwRes.responseDesc, afterCallAt, id);
      });

      const dep = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(id) as Record<string, unknown>;
      return {
        deposit: sanitizeDepositRow(dep),
        gateway_configured: true,
        message: `Solicitação M-Pesa enviada para o telemóvel ${maskedMsisdn}. Introduza o seu PIN M-Pesa no telemóvel para confirmar.`,
      };
    }

    if (gwRes.ok && gwRes.transactionId) {
      const credited = this.verifyAndCreditDeposit({
        depositId: id,
        providerTxId: gwRes.transactionId,
        conversationId: gwRes.conversationId || thirdPartyConvId,
        responseCode: gwRes.responseCode,
        responseDesc: gwRes.responseDesc,
        confirmedAmountMtCents: gwRes.confirmedAmountMtCents ?? amountMtCents,
        confirmedCurrency: gwRes.confirmedCurrency ?? 'MZN',
        source: `${providerName}-SYNC`,
        rawPayload: gwRes.rawPayload ?? {},
      });

      return {
        deposit: credited.deposit,
        gateway_configured: true,
        message: `Depósito M-Pesa de ${amountMt.toFixed(2)} MT ($${cleanAmountUsd.toFixed(2)}) confirmado e creditado automaticamente.`,
      };
    }

    if (gwRes.uncertain) {
      // Unknown/timeout outcome: ALWAYS query operator status before deciding!
      if (this.gateway.queryTransactionStatus) {
        const probeRes = await this.gateway.queryTransactionStatus({
          queryReference: gwRes.conversationId || reference,
          thirdPartyConversationId: thirdPartyConvId,
          reference,
        });
        if (probeRes.ok && probeRes.transactionId) {
          const credited = this.verifyAndCreditDeposit({
            depositId: id,
            providerTxId: probeRes.transactionId,
            conversationId: probeRes.conversationId || gwRes.conversationId || thirdPartyConvId,
            responseCode: probeRes.responseCode,
            responseDesc: probeRes.responseDesc,
            confirmedAmountMtCents: probeRes.confirmedAmountMtCents ?? amountMtCents,
            confirmedCurrency: probeRes.confirmedCurrency ?? 'MZN',
            source: `${providerName}-QUERY`,
            rawPayload: probeRes.rawPayload ?? {},
          });
          return {
            deposit: credited.deposit,
            gateway_configured: true,
            message: `Depósito M-Pesa de ${amountMt.toFixed(2)} MT ($${cleanAmountUsd.toFixed(2)}) confirmado após verificação na operadora e creditado.`,
          };
        }
        if (probeRes.acceptedPending) {
          const convToPersist = probeRes.conversationId || gwRes.conversationId;
          if (convToPersist) {
            this.db
              .prepare(`UPDATE deposit_requests SET mpesa_conversation_id = ?, mpesa_response_code = ?, mpesa_response_desc = ? WHERE id = ?`)
              .run(convToPersist, probeRes.responseCode, probeRes.responseDesc, id);
          }
          const dep = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(id) as Record<string, unknown>;
          return {
            deposit: sanitizeDepositRow(dep),
            gateway_configured: true,
            message: probeRes.friendlyMessage,
          };
        }
        if (!probeRes.uncertain && !probeRes.ok) {
          const probeFailStatus = probeRes.responseCode === 'INS-9' ? 'EXPIRED' : 'FAILED';
          withDbTransaction(this.db, () => {
            this.db
              .prepare(
                `UPDATE deposit_requests
                 SET status = ?, mpesa_response_code = ?, mpesa_response_desc = ?, reviewed_by = 'MPESA-QUERY', reviewed_at = ?
                 WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING')`
              )
              .run(probeFailStatus, probeRes.responseCode, probeRes.responseDesc, this.nowFn(), id);
          });
          throw new PaymentServiceError(probeRes.friendlyMessage, 400, probeRes.responseCode || 'MPESA_FAILED');
        }
      }

      withDbTransaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE deposit_requests
             SET status = 'RECONCILIATION_REQUIRED',
                 mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
                 mpesa_response_code = ?,
                 mpesa_response_desc = ?
             WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING')`
          )
          .run(gwRes.conversationId, gwRes.responseCode, gwRes.responseDesc, id);

        this.db
          .prepare(
            `INSERT INTO reconciliation_records (id, entity_type, entity_id, reference, reason, status, created_at)
             VALUES (?, 'DEPOSIT', ?, ?, ?, 'OPEN', ?)`
          )
          .run(generateId('rec'), id, reference, `${gwRes.responseCode}: ${gwRes.responseDesc}`, afterCallAt);

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'DEPOSIT_RECONCILIATION_REQUIRED',
          entityType: 'DEPOSIT_REQUEST',
          entityId: id,
          details: { reference, code: gwRes.responseCode, desc: gwRes.responseDesc },
        });
      });

      const dep = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(id) as Record<string, unknown>;
      return {
        deposit: sanitizeDepositRow(dep),
        gateway_configured: true,
        message: gwRes.friendlyMessage,
      };
    }

    const terminalStatus = gwRes.responseCode === 'INS-9' ? 'EXPIRED' : 'FAILED';
    withDbTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE deposit_requests
           SET status = ?,
               mpesa_transaction_id = ?,
               mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
               mpesa_response_code = ?,
               mpesa_response_desc = ?,
               reviewed_by = 'MPESA-OPENAPI',
               reviewed_at = ?
           WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING')`
        )
        .run(terminalStatus, gwRes.transactionId, gwRes.conversationId, gwRes.responseCode, gwRes.responseDesc, afterCallAt, id);

      this.db
        .prepare(
          `UPDATE payment_attempts
           SET response_code = ?, response_desc = ?, status = ?, updated_at = ?
           WHERE entity_id = ?`
        )
        .run(gwRes.responseCode, gwRes.responseDesc, terminalStatus, afterCallAt, id);

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: `DEPOSIT_${terminalStatus}`,
        entityType: 'DEPOSIT_REQUEST',
        entityId: id,
        details: { reference, code: gwRes.responseCode, desc: gwRes.responseDesc },
      });
    });

    throw new PaymentServiceError(gwRes.friendlyMessage, 400, gwRes.responseCode || 'MPESA_FAILED');
  }

  public verifyAndCreditDeposit(params: {
    depositId: string;
    providerTxId: string;
    conversationId?: string | null;
    responseCode: string;
    responseDesc?: string;
    confirmedAmountMtCents?: number;
    confirmedCurrency?: string;
    source: string;
    rawPayload?: Record<string, unknown>;
  }): { deposit: SanitizedDepositRow; alreadyCredited: boolean } {
    if (!params.providerTxId || params.providerTxId.trim().length < 3) {
      throw new PaymentServiceError('Identificador da transação da operadora ausente.', 400, 'MISSING_PROVIDER_TX_ID');
    }
    if (params.responseCode !== 'INS-0' && params.responseCode !== 'PAID') {
      throw new PaymentServiceError('Estado da operadora não confirma pagamento.', 400, 'NOT_PAID');
    }

    const now = this.nowFn();
    const provider = this.gateway.getProviderName();

    const result = withDbTransaction(this.db, (): { deposit: SanitizedDepositRow; alreadyCredited: boolean; mismatchError?: string; mismatchCode?: string } => {
      const dep = this.db
        .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
        .get(params.depositId) as Record<string, unknown> | undefined;
      if (!dep) {
        throw new PaymentServiceError('Pedido de depósito não encontrado.', 404, 'NOT_FOUND');
      }

      const status = String(dep.status);
      if (status === 'CREDITED' || status === 'APPROVED') {
        return { deposit: sanitizeDepositRow(dep), alreadyCredited: true };
      }

      if (status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') {
        throw new PaymentServiceError(`Depósito em estado terminal (${status}); crédito recusado.`, 409, 'TERMINAL_STATE');
      }

      if (params.confirmedCurrency && params.confirmedCurrency.toUpperCase() !== 'MZN') {
        this.db
          .prepare(`UPDATE deposit_requests SET status = 'RECONCILIATION_REQUIRED', mpesa_response_desc = ? WHERE id = ?`)
          .run(`Moeda divergente: esperado MZN, recebido ${params.confirmedCurrency.toUpperCase()}.`, params.depositId);

        this.db
          .prepare(
            `INSERT INTO reconciliation_records (id, entity_type, entity_id, reference, reason, status, created_at)
             VALUES (?, 'DEPOSIT', ?, ?, ?, 'OPEN', ?)`
          )
          .run(
            generateId('rec'),
            params.depositId,
            String(dep.reference),
            `CURRENCY_MISMATCH: expected=MZN received=${params.confirmedCurrency.toUpperCase()}`,
            now
          );

        const updatedMismatch = this.db
          .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
          .get(params.depositId) as Record<string, unknown>;

        return {
          deposit: sanitizeDepositRow(updatedMismatch),
          alreadyCredited: false,
          mismatchError: 'Moeda recebida divergente da esperada (MZN). Encaminhado para reconciliação.',
          mismatchCode: 'CURRENCY_MISMATCH',
        };
      }

      const expectedMtCents =
        typeof dep.amount_mt_cents === 'number' ? dep.amount_mt_cents : toMinorUnits(Number(dep.amount_mt));
      const expectedUsdCents =
        typeof dep.amount_usd_cents === 'number' ? dep.amount_usd_cents : toMinorUnits(Number(dep.amount_usd));

      if (params.confirmedAmountMtCents !== undefined && params.confirmedAmountMtCents !== expectedMtCents) {
        this.db
          .prepare(`UPDATE deposit_requests SET status = 'RECONCILIATION_REQUIRED', mpesa_response_desc = ? WHERE id = ?`)
          .run(`Montante divergente: esperado ${expectedMtCents} centavos MT, recebido ${params.confirmedAmountMtCents}.`, params.depositId);

        this.db
          .prepare(
            `INSERT INTO reconciliation_records (id, entity_type, entity_id, reference, reason, status, created_at)
             VALUES (?, 'DEPOSIT', ?, ?, ?, 'OPEN', ?)`
          )
          .run(
            generateId('rec'),
            params.depositId,
            String(dep.reference),
            `AMOUNT_MISMATCH: expected=${expectedMtCents} received=${params.confirmedAmountMtCents}`,
            now
          );

        const updatedMismatch = this.db
          .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
          .get(params.depositId) as Record<string, unknown>;

        return {
          deposit: sanitizeDepositRow(updatedMismatch),
          alreadyCredited: false,
          mismatchError: 'Montante confirmado pela operadora diverge do pedido original. Encaminhado para reconciliação.',
          mismatchCode: 'AMOUNT_MISMATCH',
        };
      }

      // Replay guard across different deposits via UNIQUE(provider, provider_tx_id)
      const dupProviderTx = this.db
        .prepare(`SELECT entity_id FROM provider_transactions WHERE provider = ? AND provider_tx_id = ?`)
        .get(provider, params.providerTxId) as { entity_id: string } | undefined;

      if (dupProviderTx) {
        if (dupProviderTx.entity_id === params.depositId) {
          return { deposit: sanitizeDepositRow(dep), alreadyCredited: true };
        }
        throw new PaymentServiceError(
          'Transação M-Pesa já associada a outro depósito.',
          409,
          'DUPLICATE_PROVIDER_TX'
        );
      }

      const userId = String(dep.user_id);
      const creditUsd = fromMinorUnits(expectedUsdCents);

      const wallet = this.db
        .prepare(`SELECT available_balance FROM wallets WHERE user_id = ?`)
        .get(userId) as { available_balance: number } | undefined;
      if (!wallet) {
        throw new PaymentServiceError('Carteira do utilizador não encontrada.', 404, 'WALLET_NOT_FOUND');
      }

      const beforeUsdCents = toMinorUnits(wallet.available_balance);
      const afterUsd = fromMinorUnits(beforeUsdCents + expectedUsdCents);

      // Step 1: Record provider transaction (enforces uniqueness)
      this.db
        .prepare(
          `INSERT INTO provider_transactions (
             id, provider, direction, entity_id, reference, provider_tx_id, conversation_id,
             third_party_conversation_id, amount_mt_cents, currency, status, raw_payload_json, created_at
           )
           VALUES (?, ?, 'DEPOSIT', ?, ?, ?, ?, ?, ?, 'MZN', 'PAID', ?, ?)`
        )
        .run(
          generateId('ptx'),
          provider,
          params.depositId,
          String(dep.reference),
          params.providerTxId,
          params.conversationId || (dep.mpesa_conversation_id as string | null),
          (dep.mpesa_conversation_id as string | null) ?? null,
          expectedMtCents,
          JSON.stringify(params.rawPayload ?? {}),
          now
        );

      // Step 2: Transition deposit PAID -> CREDITED atomically
      const upd = this.db
        .prepare(
          `UPDATE deposit_requests
           SET status = 'CREDITED',
               provider_reference = ?,
               mpesa_transaction_id = ?,
               mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
               mpesa_response_code = ?,
               mpesa_response_desc = ?,
               reviewed_by = ?,
               reviewed_at = ?,
               confirmed_at = ?,
               credited_at = ?
           WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING', 'PAID', 'RECONCILIATION_REQUIRED', 'PENDING')`
        )
        .run(
          params.providerTxId,
          params.providerTxId,
          params.conversationId ?? null,
          params.responseCode,
          params.responseDesc || 'Confirmado',
          params.source,
          now,
          now,
          now,
          params.depositId
        );

      if (upd.changes === 0) {
        throw new PaymentServiceError('Concorrência detetada ao creditar depósito.', 409, 'CONCURRENT_UPDATE');
      }

      // Step 3: Credit available_balance once
      this.db
        .prepare(`UPDATE wallets SET available_balance = ?, updated_at = ? WHERE user_id = ?`)
        .run(afterUsd, now, userId);

      // Step 4: Single DEPOSIT_CREDIT ledger row
      this.db
        .prepare(
          `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
           VALUES (?, ?, ?, 'DEPOSIT_CREDIT', ?, ?, ?, ?, ?)`
        )
        .run(
          generateId('led'),
          generateReference('TXN'),
          userId,
          creditUsd,
          wallet.available_balance,
          afterUsd,
          `Crédito depósito M-Pesa ${dep.reference} (${params.providerTxId})`,
          now
        );

      // Step 5: Notification & Audit
      this.db
        .prepare(
          `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
           VALUES (?, ?, ?, ?, 'WALLET', 0, ?)`
        )
        .run(
          generateId('ntf'),
          userId,
          'Depósito M-Pesa Creditado',
          `O seu depósito ${dep.reference} de $${creditUsd.toFixed(2)} (${fromMinorUnits(expectedMtCents).toFixed(2)} MT) foi confirmado e creditado.`,
          now
        );

      logDbAudit(this.db, {
        actorId: userId,
        actorEmail: params.source,
        actorRole: 'SYSTEM',
        action: 'DEPOSIT_CREDITED',
        entityType: 'DEPOSIT_REQUEST',
        entityId: params.depositId,
        details: {
          reference: dep.reference,
          provider_tx_id: params.providerTxId,
          amount_usd: creditUsd,
          amount_mt: fromMinorUnits(expectedMtCents),
          source: params.source,
        },
      });

      const updated = this.db
        .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
        .get(params.depositId) as Record<string, unknown>;
      return { deposit: sanitizeDepositRow(updated), alreadyCredited: false };
    });

    if (result.mismatchError) {
      throw new PaymentServiceError(result.mismatchError, 422, result.mismatchCode || 'AMOUNT_MISMATCH');
    }

    return { deposit: result.deposit, alreadyCredited: result.alreadyCredited };
  }

  public processWebhook(params: {
    headers: Record<string, string | string[] | undefined>;
    querySecret?: string;
    rawBodyString: string;
    payload: Record<string, unknown>;
  }): { ok: boolean; duplicate?: boolean; status: string; message: string; userId?: string; depositId?: string } {
    const webhookSecret = (process.env.ZAASPAY_WEBHOOK_SECRET || '').trim();
    const sigHeader = typeof params.headers['x-mpesa-signature'] === 'string' ? params.headers['x-mpesa-signature'] : undefined;
    const secretHeader =
      typeof params.headers['x-mpesa-callback-secret'] === 'string'
        ? params.headers['x-mpesa-callback-secret']
        : undefined;

    const authOk = verifyMpesaWebhookAuth({
      secret: webhookSecret,
      requireSecret: true,
      providedSecretHeader: secretHeader,
      providedQuerySecret: params.querySecret,
      providedSignatureHeader: sigHeader,
      rawBodyString: params.rawBodyString,
    });

    if (!authOk) {
      logDbAudit(this.db, {
        actorId: null,
        actorEmail: 'mpesa-webhook',
        actorRole: 'EXTERNAL',
        action: 'WEBHOOK_AUTH_REJECTED',
        entityType: 'WEBHOOK',
        entityId: 'mpesa',
        details: { reason: 'Assinatura ou segredo inválido' },
      });
      throw new PaymentServiceError('Webhook não autorizado.', 403, 'WEBHOOK_UNAUTHORIZED');
    }

    const body = params.payload as {
      event_id?: string;
      reference?: string;
      input_TransactionReference?: string;
      input_ThirdPartyReference?: string;
      output_ThirdPartyReference?: string;
      input_ThirdPartyConversationID?: string;
      output_ThirdPartyConversationID?: string;
      output_ConversationID?: string;
      output_TransactionID?: string;
      output_ResponseCode?: string;
      output_ResponseDesc?: string;
      output_Amount?: number | string;
      amount_mt?: number | string;
      currency?: string;
    };

    const convId =
      body.output_ThirdPartyReference ||
      body.input_ThirdPartyReference ||
      body.output_ThirdPartyConversationID ||
      body.input_ThirdPartyConversationID ||
      body.output_ConversationID ||
      '';
    const refHint = body.reference || body.input_TransactionReference || '';
    const txId = body.output_TransactionID || '';
    const respCode = body.output_ResponseCode || '';
    const currency = (body.currency || 'MZN').toUpperCase();

    if (!convId && !refHint) {
      throw new PaymentServiceError('Referência ou ConversationID ausente no webhook.', 400, 'MISSING_REFERENCE');
    }

    const provider = this.gateway.getProviderName();
    const eventKey =
      body.event_id?.trim() ||
      (txId ? `${txId}:${respCode}:${refHint || convId}` : crypto.createHash('sha256').update(params.rawBodyString).digest('hex'));
    const now = this.nowFn();

    // Check & record webhook event atomically (replay protection)
    const dupCheck = this.db
      .prepare(`SELECT id, status FROM webhook_events WHERE provider = ? AND event_key = ?`)
      .get(provider, eventKey) as { id: string; status: string } | undefined;

    if (dupCheck) {
      return {
        ok: true,
        duplicate: true,
        status: dupCheck.status,
        message: 'Evento webhook já processado anteriormente (replay ignorado).',
      };
    }

    const dep = (refHint
      ? this.db.prepare(`SELECT * FROM deposit_requests WHERE reference = ?`).get(refHint)
      : undefined) ??
      (convId
        ? this.db.prepare(`SELECT * FROM deposit_requests WHERE mpesa_conversation_id = ?`).get(convId)
        : undefined);

    const depRow = dep as Record<string, unknown> | undefined;
    const rawAmountVal = body.output_Amount ?? body.amount_mt;
    const confirmedAmountMtCents =
      rawAmountVal !== undefined && rawAmountVal !== null && rawAmountVal !== ''
        ? toMinorUnits(Number(rawAmountVal))
        : undefined;

    if (!depRow) {
      this.db
        .prepare(
          `INSERT INTO webhook_events (id, provider, event_key, event_type, reference, provider_tx_id, amount_mt_cents, currency, status, signature_valid, raw_payload_json, processed_at, created_at)
           VALUES (?, ?, ?, 'C2B_CALLBACK', ?, ?, ?, ?, 'IGNORED_NOT_FOUND', 1, ?, ?, ?)`
        )
        .run(
          generateId('whk'),
          provider,
          eventKey,
          refHint || convId,
          txId || null,
          confirmedAmountMtCents ?? null,
          currency,
          params.rawBodyString || JSON.stringify(params.payload),
          now,
          now
        );
      return { ok: true, status: 'IGNORED_NOT_FOUND', message: 'Referência não encontrada.' };
    }

    const depId = String(depRow.id);

    if (respCode === 'INS-0' || respCode === 'PAID') {
      try {
        const res = this.verifyAndCreditDeposit({
          depositId: depId,
          providerTxId: txId || `WHK-${eventKey.slice(0, 16)}`,
          conversationId: convId || null,
          responseCode: respCode,
          responseDesc: body.output_ResponseDesc || 'Confirmado via Webhook',
          confirmedAmountMtCents,
          confirmedCurrency: currency,
          source: 'MPESA-WEBHOOK',
          rawPayload: params.payload,
        });

        try {
          this.db
            .prepare(
              `INSERT INTO webhook_events (id, provider, event_key, event_type, reference, provider_tx_id, amount_mt_cents, currency, status, signature_valid, raw_payload_json, processed_at, created_at)
               VALUES (?, ?, ?, 'C2B_CALLBACK', ?, ?, ?, ?, 'PROCESSED_CREDITED', 1, ?, ?, ?)`
            )
            .run(
              generateId('whk'),
              provider,
              eventKey,
              String(depRow.reference),
              txId || null,
              confirmedAmountMtCents ?? null,
              currency,
              params.rawBodyString || JSON.stringify(params.payload),
              now,
              now
            );
        } catch {
          // Concurrent duplicate webhook inserted event_key simultaneously
          return { ok: true, duplicate: true, status: 'PROCESSED_CREDITED', message: 'Evento concorrente deduplicado.' };
        }

        return {
          ok: true,
          duplicate: res.alreadyCredited,
          status: res.deposit.status,
          userId: String(depRow.user_id),
          depositId: depId,
          message: res.alreadyCredited ? 'Depósito já creditado anteriormente.' : 'Depósito creditado com sucesso.',
        };
      } catch (err) {
        if (err instanceof PaymentServiceError && (err.code === 'AMOUNT_MISMATCH' || err.code === 'CURRENCY_MISMATCH')) {
          try {
            this.db
              .prepare(
                `INSERT INTO webhook_events (id, provider, event_key, event_type, reference, provider_tx_id, amount_mt_cents, currency, status, signature_valid, raw_payload_json, processed_at, created_at)
                 VALUES (?, ?, ?, 'C2B_CALLBACK', ?, ?, ?, ?, 'RECONCILIATION_REQUIRED', 1, ?, ?, ?)`
              )
              .run(
                generateId('whk'),
                provider,
                eventKey,
                String(depRow.reference),
                txId || null,
                confirmedAmountMtCents ?? null,
                currency,
                params.rawBodyString || JSON.stringify(params.payload),
                now,
                now
              );
          } catch {
            // ignore duplicate event key
          }
          throw err;
        }
        throw err;
      }
    }

    // Failure or cancellation webhook -> update status only if not credited, NEVER touch wallet
    const nextStatus = respCode === 'INS-9' ? 'EXPIRED' : 'FAILED';
    withDbTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE deposit_requests
           SET status = ?, mpesa_response_code = ?, mpesa_response_desc = ?, reviewed_by = 'MPESA-WEBHOOK', reviewed_at = ?
           WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING', 'PENDING')`
        )
        .run(nextStatus, respCode || 'ERR', body.output_ResponseDesc || 'Falha no pagamento', now, depId);

      try {
        this.db
          .prepare(
            `INSERT INTO webhook_events (id, provider, event_key, event_type, reference, provider_tx_id, amount_mt_cents, currency, status, signature_valid, raw_payload_json, processed_at, created_at)
             VALUES (?, ?, ?, 'C2B_CALLBACK', ?, ?, ?, ?, ?, 1, ?, ?, ?)`
          )
          .run(
            generateId('whk'),
            provider,
            eventKey,
            String(depRow.reference),
            txId || null,
            confirmedAmountMtCents ?? null,
            currency,
            `PROCESSED_${nextStatus}`,
            params.rawBodyString || JSON.stringify(params.payload),
            now,
            now
          );
      } catch {
        // ignore if already recorded concurrently
      }

      logDbAudit(this.db, {
        actorId: String(depRow.user_id),
        actorEmail: 'mpesa-webhook',
        actorRole: 'EXTERNAL',
        action: `WEBHOOK_DEPOSIT_${nextStatus}`,
        entityType: 'DEPOSIT_REQUEST',
        entityId: depId,
        details: { reference: depRow.reference, code: respCode, desc: body.output_ResponseDesc },
      });
    });

    return { ok: true, status: nextStatus, userId: String(depRow.user_id), depositId: depId, message: `Depósito marcado como ${nextStatus}.` };
  }

  public async reconcileDepositViaGateway(params: { depositId: string; actor: ActorInfo }) {
    const dep = this.db
      .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
      .get(params.depositId) as Record<string, unknown> | undefined;
    if (!dep) {
      throw new PaymentServiceError('Depósito não encontrado.', 404, 'NOT_FOUND');
    }
    if (dep.status === 'CREDITED' || dep.status === 'APPROVED') {
      return { deposit: sanitizeDepositRow(dep), message: 'Depósito já confirmado e creditado.' };
    }
    if (
      dep.status === 'FAILED' ||
      dep.status === 'EXPIRED' ||
      dep.status === 'REJECTED' ||
      dep.status === 'CANCELLED'
    ) {
      return { deposit: sanitizeDepositRow(dep), message: `Depósito já encerrado com estado ${dep.status}.` };
    }
    if (!this.gateway.isConfigured() || !this.gateway.queryTransactionStatus) {
      throw new PaymentServiceError(
        'Gateway M-Pesa não configurado para consulta automática de estado.',
        503,
        'MPESA_NOT_CONFIGURED'
      );
    }

    const convId = (dep.mpesa_conversation_id as string | null) || null;
    const queryRef =
      convId && convId.startsWith('pay_')
        ? convId
        : (dep.mpesa_transaction_id as string | null) || convId || String(dep.reference);
    const res = await this.gateway.queryTransactionStatus({
      queryReference: queryRef,
      thirdPartyConversationId: String(dep.mpesa_conversation_id || dep.reference),
      reference: String(dep.reference),
    });

    if (res.ok && res.transactionId) {
      const expectedMtCents =
        typeof dep.amount_mt_cents === 'number' ? dep.amount_mt_cents : toMinorUnits(Number(dep.amount_mt));
      const credited = this.verifyAndCreditDeposit({
        depositId: params.depositId,
        providerTxId: res.transactionId,
        conversationId: res.conversationId,
        responseCode: res.responseCode,
        responseDesc: res.responseDesc,
        confirmedAmountMtCents: res.confirmedAmountMtCents ?? expectedMtCents,
        confirmedCurrency: res.confirmedCurrency ?? 'MZN',
        source: `${this.gateway.getProviderName()}-QUERY:${params.actor.email}`,
        rawPayload: res.rawPayload ?? {},
      });
      return { deposit: credited.deposit, message: 'Depósito confirmado via consulta oficial e creditado automaticamente.' };
    }

    if (res.acceptedPending) {
      const updated = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(params.depositId) as Record<string, unknown>;
      return { deposit: sanitizeDepositRow(updated), still_pending: true, message: res.friendlyMessage };
    }

    if (!res.uncertain && !res.ok) {
      const now = this.nowFn();
      const failStatus = res.responseCode === 'INS-9' ? 'EXPIRED' : 'FAILED';
      withDbTransaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE deposit_requests
             SET status = ?, mpesa_response_code = ?, mpesa_response_desc = ?, reviewed_by = ?, reviewed_at = ?
             WHERE id = ? AND status IN ('CREATED', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED', 'UNKNOWN')`
          )
          .run(failStatus, res.responseCode, res.responseDesc, `MPESA-QUERY:${params.actor.email}`, now, params.depositId);

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: `DEPOSIT_QUERY_${failStatus}`,
          entityType: 'DEPOSIT_REQUEST',
          entityId: params.depositId,
          details: { reference: dep.reference, code: res.responseCode, desc: res.responseDesc },
        });
      });
      const updated = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(params.depositId) as Record<string, unknown>;
      return { deposit: sanitizeDepositRow(updated), message: res.friendlyMessage || 'Consulta confirmou falha do pagamento.' };
    }

    const updated = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(params.depositId) as Record<string, unknown>;
    return { deposit: sanitizeDepositRow(updated), still_pending: true, message: res.friendlyMessage };
  }

  public adminReviewDeposit(params: {
    depositId: string;
    decision: 'APPROVED' | 'REJECTED';
    notes?: string;
    actor: ActorInfo;
  }) {
    const dep = this.db
      .prepare(`SELECT * FROM deposit_requests WHERE id = ?`)
      .get(params.depositId) as Record<string, unknown> | undefined;

    if (!dep) {
      throw new PaymentServiceError('Pedido de depósito não encontrado.', 404, 'NOT_FOUND');
    }

    // MPESA_ADMIN_BLOCK: Admins cannot arbitrarily approve M-Pesa deposits without verified gateway confirmation!
    if (String(dep.method) === 'M-Pesa' || String(dep.provider).includes('MPESA')) {
      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'MPESA_ADMIN_BLOCK',
        entityType: 'DEPOSIT_REQUEST',
        entityId: params.depositId,
        details: { attempted_decision: params.decision, current_status: dep.status },
      });
      throw new PaymentServiceError(
        'Bloqueado (MPESA_ADMIN_BLOCK): depósitos M-Pesa não podem ser aprovados manualmente sem confirmação verificada da operadora.',
        403,
        'MPESA_ADMIN_BLOCK'
      );
    }

    if (dep.status !== 'PENDING') {
      throw new PaymentServiceError('Pedido histórico já processado.', 400, 'INVALID_STATE');
    }

    const now = this.nowFn();
    const amountUsdCents =
      typeof dep.amount_usd_cents === 'number' ? dep.amount_usd_cents : toMinorUnits(Number(dep.amount_usd));
    const amountUsd = fromMinorUnits(amountUsdCents);

    withDbTransaction(this.db, () => {
      const userId = String(dep.user_id);
      const wallet = this.db
        .prepare(`SELECT available_balance, pending_balance FROM wallets WHERE user_id = ?`)
        .get(userId) as { available_balance: number; pending_balance: number };

      const walletPendingCents = toMinorUnits(wallet.pending_balance);
      const nextPending = walletPendingCents >= amountUsdCents ? fromMinorUnits(walletPendingCents - amountUsdCents) : wallet.pending_balance;
      const nextAvailable =
        params.decision === 'APPROVED'
          ? fromMinorUnits(toMinorUnits(wallet.available_balance) + amountUsdCents)
          : wallet.available_balance;

      this.db
        .prepare(`UPDATE wallets SET available_balance = ?, pending_balance = ?, updated_at = ? WHERE user_id = ?`)
        .run(nextAvailable, nextPending, now, userId);

      this.db
        .prepare(
          `UPDATE deposit_requests SET status = ?, notes = COALESCE(NULLIF(?, ''), notes), reviewed_by = ?, reviewed_at = ? WHERE id = ?`
        )
        .run(params.decision, (params.notes || '').trim(), params.actor.email, now, params.depositId);

      if (params.decision === 'APPROVED') {
        this.db
          .prepare(
            `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
             VALUES (?, ?, ?, 'DEPOSIT_CREDIT', ?, ?, ?, ?, ?)`
          )
          .run(
            generateId('led'),
            generateReference('TXN'),
            userId,
            amountUsd,
            wallet.available_balance,
            nextAvailable,
            `Depósito histórico aprovado (${dep.reference})`,
            now
          );
      }

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: `LEGACY_DEPOSIT_${params.decision}`,
        entityType: 'DEPOSIT_REQUEST',
        entityId: params.depositId,
        details: { reference: dep.reference, amount_usd: amountUsd, notes: params.notes },
      });
    });

    return { ok: true };
  }

  // ==================== WITHDRAWALS (RESERVE -> ADMIN APPROVAL -> B2C DISBURSEMENT) ====================

  public createWithdrawal(params: {
    actor: ActorInfo;
    destination_type?: string;
    destination_account?: string;
    amount_usd?: number;
    notes?: string;
    idempotencyKey?: string;
  }): { withdrawal: SanitizedWithdrawalRow; duplicate?: boolean; message: string } {
    if (params.destination_type && params.destination_type !== 'M-Pesa') {
      throw new PaymentServiceError(
        'Os levantamentos funcionam exclusivamente para carteiras M-Pesa.',
        400,
        'UNSUPPORTED_METHOD'
      );
    }

    const normalizedMsisdn = normalizeMozMpesaMsisdn((params.destination_account || '').trim());
    if (!normalizedMsisdn) {
      throw new PaymentServiceError(
        'Indique um número M-Pesa Vodacom válido (prefixos 84 ou 85) para receber o levantamento.',
        400,
        'INVALID_MSISDN'
      );
    }

    const settings = getSettingsFromDb(this.db);
    const rawAmount = Number(params.amount_usd);
    if (!Number.isFinite(rawAmount) || rawAmount < settings.min_withdrawal_usd) {
      throw new PaymentServiceError(
        `O valor mínimo para levantamento via M-Pesa é $${settings.min_withdrawal_usd.toFixed(2)}.`,
        400,
        'MIN_WITHDRAWAL'
      );
    }

    const amountUsdCents = toMinorUnits(rawAmount);
    if (amountUsdCents < toMinorUnits(settings.min_withdrawal_usd)) {
      throw new PaymentServiceError(
        `O levantamento mínimo é $${settings.min_withdrawal_usd.toFixed(2)}.`,
        400,
        'MIN_WITHDRAWAL'
      );
    }

    const cleanAmountUsd = fromMinorUnits(amountUsdCents);
    const amountMtCents = usdCentsToMtCents(amountUsdCents, settings.usd_to_mt_rate);
    const amountMt = fromMinorUnits(amountMtCents);
    const maskedMsisdn = maskMsisdn(normalizedMsisdn);
    const idemKey = params.idempotencyKey?.trim() || null;

    if (idemKey) {
      const existing = this.db
        .prepare(`SELECT entity_id FROM idempotency_keys WHERE scope = 'WITHDRAWAL' AND user_id = ? AND idempotency_key = ?`)
        .get(params.actor.id, idemKey) as { entity_id?: string } | undefined;
      if (existing?.entity_id) {
        const wRow = this.db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(existing.entity_id) as Record<string, unknown> | undefined;
        if (wRow) {
          return {
            withdrawal: sanitizeWithdrawalRow(wRow),
            duplicate: true,
            message: `Pedido de levantamento ${wRow.reference} já registado.`,
          };
        }
      }
    }

    const now = this.nowFn();
    const id = generateId('wdr');
    const reference = generateReference('MPW');
    const thirdPartyConvId = crypto.randomBytes(12).toString('hex');
    const providerName = this.gateway.getProviderName();

    withDbTransaction(this.db, () => {
      const wallet = this.db
        .prepare(`SELECT available_balance, reserved_balance FROM wallets WHERE user_id = ?`)
        .get(params.actor.id) as { available_balance: number; reserved_balance: number } | undefined;
      if (!wallet) {
        throw new PaymentServiceError('Carteira não encontrada.', 404, 'WALLET_NOT_FOUND');
      }

      const availCents = toMinorUnits(wallet.available_balance);
      const resCents = toMinorUnits(wallet.reserved_balance);

      if (availCents < amountUsdCents) {
        throw new PaymentServiceError('Saldo disponível insuficiente para este levantamento.', 400, 'INSUFFICIENT_BALANCE');
      }

      // Compute risk indicators for admin review
      const userRow = this.db.prepare(`SELECT created_at FROM users WHERE id = ?`).get(params.actor.id) as
        | { created_at: string }
        | undefined;
      const recent24h = (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM withdrawal_requests WHERE user_id = ? AND created_at >= ?`
          )
          .get(params.actor.id, new Date(Date.now() - 86400_000).toISOString()) as { c: number }
      ).c;
      const riskFlags: string[] = [];
      let riskScore = 0;
      if (userRow && Date.now() - new Date(userRow.created_at).getTime() < 86400_000) {
        riskFlags.push('CONTA_RECENTE_24H');
        riskScore += 25;
      }
      if (recent24h >= 2) {
        riskFlags.push('MULTIPLOS_LEVANTAMENTOS_24H');
        riskScore += 25;
      }
      if (availCents > 0 && amountUsdCents >= availCents * 0.85) {
        riskFlags.push('LEVANTA_ACIMA_85PCT_SALDO');
        riskScore += 20;
      }
      if (cleanAmountUsd >= 500) {
        riskFlags.push('VALOR_ELEVADO');
        riskScore += 30;
      }

      const nextAvailable = fromMinorUnits(availCents - amountUsdCents);
      const nextReserved = fromMinorUnits(resCents + amountUsdCents);

      // Atomic conditional debit guarding against concurrent overdraft!
      const debited = this.db
        .prepare(
          `UPDATE wallets
           SET available_balance = ?, reserved_balance = ?, updated_at = ?
           WHERE user_id = ? AND CAST(ROUND(available_balance * 100) AS INTEGER) >= ?`
        )
        .run(nextAvailable, nextReserved, now, params.actor.id, amountUsdCents);

      if (debited.changes === 0) {
        throw new PaymentServiceError('Saldo disponível insuficiente para este levantamento.', 400, 'INSUFFICIENT_BALANCE');
      }

      if (idemKey) {
        this.db
          .prepare(
            `INSERT INTO idempotency_keys (idempotency_key, scope, user_id, entity_id, response_status, created_at)
             VALUES (?, 'WITHDRAWAL', ?, ?, 201, ?)`
          )
          .run(idemKey, params.actor.id, id, now);
      }

      this.db
        .prepare(
          `INSERT INTO withdrawal_requests (
             id, reference, user_id, destination_type, destination_account, provider, msisdn, msisdn_masked,
             idempotency_key, mpesa_conversation_id, amount_usd, amount_mt, amount_usd_cents, amount_mt_cents,
             exchange_rate_used, status, disbursement_status, risk_score, risk_flags, notes, created_at
           )
           VALUES (?, ?, ?, 'M-Pesa', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_APPROVAL', 'NOT_STARTED', ?, ?, ?, ?)`
        )
        .run(
          id,
          reference,
          params.actor.id,
          maskedMsisdn,
          providerName,
          normalizedMsisdn,
          maskedMsisdn,
          idemKey,
          thirdPartyConvId,
          cleanAmountUsd,
          amountMt,
          amountUsdCents,
          amountMtCents,
          settings.usd_to_mt_rate,
          riskScore,
          JSON.stringify(riskFlags),
          (params.notes || '').trim().slice(0, 200),
          now
        );

      this.db
        .prepare(
          `INSERT INTO withdrawal_reserves (id, withdrawal_id, user_id, amount_usd_cents, status, created_at)
           VALUES (?, ?, ?, ?, 'HELD', ?)`
        )
        .run(generateId('rsv'), id, params.actor.id, amountUsdCents, now);

      this.db
        .prepare(
          `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
           VALUES (?, ?, ?, 'WITHDRAW_HOLD', ?, ?, ?, ?, ?)`
        )
        .run(
          generateId('led'),
          generateReference('TXN'),
          params.actor.id,
          -cleanAmountUsd,
          wallet.available_balance,
          nextAvailable,
          `Reserva para levantamento M-Pesa ${reference} (${maskedMsisdn})`,
          now
        );

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'WITHDRAWAL_RESERVED_AWAITING_APPROVAL',
        entityType: 'WITHDRAWAL_REQUEST',
        entityId: id,
        details: {
          reference,
          msisdn_masked: maskedMsisdn,
          amount_usd: cleanAmountUsd,
          amount_mt: amountMt,
          risk_score: riskScore,
          risk_flags: riskFlags,
        },
      });
    });

    const wRow = this.db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(id) as Record<string, unknown>;
    return {
      withdrawal: sanitizeWithdrawalRow(wRow),
      message: `Levantamento ${reference} de $${cleanAmountUsd.toFixed(2)} (${amountMt.toFixed(2)} MT) reservado com sucesso. Aguardando aprovação administrativa.`,
    };
  }

  public async adminReviewWithdrawal(params: {
    withdrawalId: string;
    decision: 'APPROVED' | 'REJECTED';
    notes?: string;
    actor: ActorInfo;
  }): Promise<{ withdrawal: SanitizedWithdrawalRow; message: string }> {
    if (params.decision === 'REJECTED') {
      const now = this.nowFn();
      withDbTransaction(this.db, () => {
        const wdr = this.db
          .prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`)
          .get(params.withdrawalId) as Record<string, unknown> | undefined;
        if (!wdr) {
          throw new PaymentServiceError('Pedido de levantamento não encontrado.', 404, 'NOT_FOUND');
        }
        const st = String(wdr.status);
        if (st !== 'AWAITING_APPROVAL' && st !== 'PENDING') {
          throw new PaymentServiceError(
            `Levantamento em estado "${st}" não pode ser rejeitado.`,
            400,
            'INVALID_STATE'
          );
        }

        const existingDisb = this.db
          .prepare(`SELECT status FROM disbursement_orders WHERE withdrawal_id = ?`)
          .get(params.withdrawalId) as { status: string } | undefined;
        if (existingDisb && (existingDisb.status === 'PROCESSING' || existingDisb.status === 'PAID')) {
          throw new PaymentServiceError(
            'Não é possível rejeitar após início do desembolso.',
            409,
            'DISBURSEMENT_IN_PROGRESS'
          );
        }

        const userId = String(wdr.user_id);
        const amountUsdCents =
          typeof wdr.amount_usd_cents === 'number' ? wdr.amount_usd_cents : toMinorUnits(Number(wdr.amount_usd));
        const amountUsd = fromMinorUnits(amountUsdCents);

        const wallet = this.db
          .prepare(`SELECT available_balance, reserved_balance, pending_balance FROM wallets WHERE user_id = ?`)
          .get(userId) as { available_balance: number; reserved_balance: number; pending_balance: number };

        // Release reserve atomically (supports both withdrawal_reserves and legacy pending_balance rows)
        const reserveRow = this.db
          .prepare(`SELECT id, status FROM withdrawal_reserves WHERE withdrawal_id = ?`)
          .get(params.withdrawalId) as { id: string; status: string } | undefined;

        const nextAvailable = fromMinorUnits(toMinorUnits(wallet.available_balance) + amountUsdCents);

        if (reserveRow) {
          if (reserveRow.status !== 'HELD') {
            throw new PaymentServiceError('A reserva já foi libertada ou consumida.', 409, 'RESERVE_ALREADY_SETTLED');
          }
          const rUpd = this.db
            .prepare(`UPDATE withdrawal_reserves SET status = 'RELEASED', released_at = ? WHERE withdrawal_id = ? AND status = 'HELD'`)
            .run(now, params.withdrawalId);
          if (rUpd.changes === 0) throw new PaymentServiceError('Concorrência na libertação da reserva.', 409, 'CONCURRENT_RESERVE');

          const resCents = toMinorUnits(wallet.reserved_balance);
          if (resCents < amountUsdCents) {
            throw new PaymentServiceError('Inconsistência no saldo reservado da carteira.', 500, 'RESERVE_UNDERFLOW');
          }
          this.db
            .prepare(`UPDATE wallets SET available_balance = ?, reserved_balance = ?, updated_at = ? WHERE user_id = ?`)
            .run(nextAvailable, fromMinorUnits(resCents - amountUsdCents), now, userId);
        } else {
          const pendCents = toMinorUnits(wallet.pending_balance);
          if (pendCents < amountUsdCents) {
            throw new PaymentServiceError('Inconsistência no saldo pendente legado.', 500, 'PENDING_UNDERFLOW');
          }
          this.db
            .prepare(`UPDATE wallets SET available_balance = ?, pending_balance = ?, updated_at = ? WHERE user_id = ?`)
            .run(nextAvailable, fromMinorUnits(pendCents - amountUsdCents), now, userId);
        }

        this.db
          .prepare(
            `UPDATE withdrawal_requests
             SET status = 'REJECTED', disbursement_status = 'CANCELLED', notes = COALESCE(NULLIF(?, ''), notes), reviewed_by = ?, reviewed_at = ?
             WHERE id = ? AND status IN ('AWAITING_APPROVAL', 'PENDING')`
          )
          .run((params.notes || '').trim(), params.actor.email, now, params.withdrawalId);

        this.db
          .prepare(
            `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
             VALUES (?, ?, ?, 'WITHDRAW_RELEASE', ?, ?, ?, ?, ?)`
          )
          .run(
            generateId('led'),
            generateReference('TXN'),
            userId,
            amountUsd,
            wallet.available_balance,
            nextAvailable,
            `Levantamento ${wdr.reference} rejeitado · reserva libertada para saldo disponível`,
            now
          );

        this.db
          .prepare(
            `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
             VALUES (?, ?, ?, ?, 'WALLET', 0, ?)`
          )
          .run(
            generateId('ntf'),
            userId,
            `Levantamento ${wdr.reference} rejeitado`,
            `O levantamento ${wdr.reference} foi rejeitado e $${amountUsd.toFixed(2)} voltaram ao seu saldo disponível.`,
            now
          );

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'WITHDRAWAL_REJECTED_RESERVE_RELEASED',
          entityType: 'WITHDRAWAL_REQUEST',
          entityId: params.withdrawalId,
          details: { reference: wdr.reference, amount_usd: amountUsd, notes: params.notes },
        });
      });

      const updated = this.db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(params.withdrawalId) as Record<string, unknown>;
      return {
        withdrawal: sanitizeWithdrawalRow(updated),
        message: 'Levantamento rejeitado e saldo reservado devolvido ao utilizador.',
      };
    }

    // APPROVE FLOW:
    // Phase 1 (Inside SQLite TX): Mark APPROVED -> DISBURSEMENT_PENDING, keep funds reserved, persist 1 disbursement_orders row.
    const now = this.nowFn();
    let orderInfo!: {
      disbursementOrderId: string;
      withdrawalRef: string;
      userId: string;
      msisdn: string;
      amountUsdCents: number;
      amountMtCents: number;
      amountMt: number;
      thirdPartyConvId: string;
    };

    withDbTransaction(this.db, () => {
      const wdr = this.db
        .prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`)
        .get(params.withdrawalId) as Record<string, unknown> | undefined;
      if (!wdr) {
        throw new PaymentServiceError('Pedido de levantamento não encontrado.', 404, 'NOT_FOUND');
      }
      const st = String(wdr.status);
      if (st !== 'AWAITING_APPROVAL' && st !== 'PENDING') {
        throw new PaymentServiceError(
          `Levantamento em estado "${st}" não pode ser aprovado novamente.`,
          409,
          'INVALID_STATE'
        );
      }

      const existingOrder = this.db
        .prepare(`SELECT id FROM disbursement_orders WHERE withdrawal_id = ?`)
        .get(params.withdrawalId) as { id: string } | undefined;
      if (existingOrder) {
        throw new PaymentServiceError(
          'Já existe uma instrução de desembolso persistida para este levantamento.',
          409,
          'DUPLICATE_DISBURSEMENT'
        );
      }

      const msisdn = normalizeMozMpesaMsisdn(String(wdr.msisdn || wdr.destination_account || ''));
      if (!msisdn) {
        throw new PaymentServiceError('Número M-Pesa de destino inválido no pedido.', 400, 'INVALID_MSISDN');
      }

      const amountUsdCents =
        typeof wdr.amount_usd_cents === 'number' ? wdr.amount_usd_cents : toMinorUnits(Number(wdr.amount_usd));
      const amountMtCents =
        typeof wdr.amount_mt_cents === 'number' ? wdr.amount_mt_cents : toMinorUnits(Number(wdr.amount_mt));

      const disbId = generateId('dsb');
      const disbRef = generateReference('DSB');
      const thirdPartyConvId = String(wdr.mpesa_conversation_id || crypto.randomBytes(12).toString('hex'));
      const willDispatch = this.gateway.isConfigured();

      this.db
        .prepare(
          `INSERT INTO disbursement_orders (
             id, withdrawal_id, reference, provider, msisdn, amount_usd_cents, amount_mt_cents,
             exchange_rate_used, idempotency_key, status, attempts, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          disbId,
          params.withdrawalId,
          disbRef,
          this.gateway.getProviderName(),
          msisdn,
          amountUsdCents,
          amountMtCents,
          Number(wdr.exchange_rate_used),
          `disb_${params.withdrawalId}`,
          willDispatch ? 'PROCESSING' : 'PENDING',
          willDispatch ? 1 : 0,
          now,
          now
        );

      const upd = this.db
        .prepare(
          `UPDATE withdrawal_requests
           SET status = ?,
               disbursement_status = ?,
               notes = COALESCE(NULLIF(?, ''), notes),
               reviewed_by = ?,
               reviewed_at = ?,
               approved_by = ?,
               approved_at = ?
           WHERE id = ? AND status IN ('AWAITING_APPROVAL', 'PENDING')`
        )
        .run(
          willDispatch ? 'DISBURSEMENT_PENDING' : 'APPROVED',
          willDispatch ? 'PROCESSING' : 'PENDING',
          (params.notes || '').trim(),
          params.actor.email,
          now,
          params.actor.email,
          now,
          params.withdrawalId
        );

      if (upd.changes === 0) {
        throw new PaymentServiceError('Concorrência ao aprovar levantamento.', 409, 'CONCURRENT_APPROVAL');
      }

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'WITHDRAWAL_APPROVED_DISBURSEMENT_QUEUED',
        entityType: 'WITHDRAWAL_REQUEST',
        entityId: params.withdrawalId,
        details: {
          reference: wdr.reference,
          disbursement_order_id: disbId,
          disbursement_ref: disbRef,
          gateway_configured: willDispatch,
        },
      });

      orderInfo = {
        disbursementOrderId: disbId,
        withdrawalRef: String(wdr.reference),
        userId: String(wdr.user_id),
        msisdn,
        amountUsdCents,
        amountMtCents,
        amountMt: fromMinorUnits(amountMtCents),
        thirdPartyConvId,
      };
    });

    if (!this.gateway.isConfigured()) {
      const wRow = this.db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(params.withdrawalId) as Record<string, unknown>;
      return {
        withdrawal: sanitizeWithdrawalRow(wRow),
        message: 'Levantamento aprovado com reserva mantida e instrução de desembolso guardada. Configure a API M-Pesa B2C para liquidar automaticamente.',
      };
    }

    // Phase 2 (Outside SQLite transaction!): Invoke B2C API
    const gwRes = await this.gateway.initiateB2C({
      amountMt: orderInfo.amountMt,
      msisdn: orderInfo.msisdn,
      reference: orderInfo.withdrawalRef,
      thirdPartyConversationId: orderInfo.thirdPartyConvId,
    });

    // Phase 3: Finalize outcome atomically
    return this.finalizeDisbursementOutcome({
      withdrawalId: params.withdrawalId,
      disbursementOrderId: orderInfo.disbursementOrderId,
      gwRes,
      actor: params.actor,
    });
  }

  public finalizeDisbursementOutcome(params: {
    withdrawalId: string;
    disbursementOrderId: string;
    gwRes: MpesaGatewayResult;
    actor: ActorInfo;
  }): { withdrawal: SanitizedWithdrawalRow; message: string } {
    const now = this.nowFn();
    const provider = this.gateway.getProviderName();

    withDbTransaction(this.db, () => {
      const wdr = this.db
        .prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`)
        .get(params.withdrawalId) as Record<string, unknown> | undefined;
      if (!wdr) {
        throw new PaymentServiceError('Levantamento não encontrado.', 404, 'NOT_FOUND');
      }

      if (wdr.status === 'PAID' || wdr.status === 'FAILED' || wdr.status === 'REJECTED') {
        return;
      }

      const userId = String(wdr.user_id);
      const amountUsdCents =
        typeof wdr.amount_usd_cents === 'number' ? wdr.amount_usd_cents : toMinorUnits(Number(wdr.amount_usd));
      const amountMtCents =
        typeof wdr.amount_mt_cents === 'number' ? wdr.amount_mt_cents : toMinorUnits(Number(wdr.amount_mt));
      const amountUsd = fromMinorUnits(amountUsdCents);
      const amountMt = fromMinorUnits(amountMtCents);

      const wallet = this.db
        .prepare(`SELECT available_balance, reserved_balance, pending_balance FROM wallets WHERE user_id = ?`)
        .get(userId) as { available_balance: number; reserved_balance: number; pending_balance: number };

      const reserveRow = this.db
        .prepare(`SELECT id, status FROM withdrawal_reserves WHERE withdrawal_id = ?`)
        .get(params.withdrawalId) as { id: string; status: string } | undefined;

      if (params.gwRes.ok && params.gwRes.transactionId) {
        // CONFIRMED PAID: consume reserve once!
        if (reserveRow) {
          const rUpd = this.db
            .prepare(`UPDATE withdrawal_reserves SET status = 'CONSUMED', consumed_at = ? WHERE withdrawal_id = ? AND status = 'HELD'`)
            .run(now, params.withdrawalId);
          if (rUpd.changes === 0) throw new PaymentServiceError('Reserva já consumida.', 409, 'RESERVE_CONSUMED');
          const resCents = toMinorUnits(wallet.reserved_balance);
          if (resCents < amountUsdCents) throw new PaymentServiceError('Saldo reservado insuficiente.', 500, 'RESERVE_UNDERFLOW');
          this.db
            .prepare(`UPDATE wallets SET reserved_balance = ?, updated_at = ? WHERE user_id = ?`)
            .run(fromMinorUnits(resCents - amountUsdCents), now, userId);
        } else {
          const pendCents = toMinorUnits(wallet.pending_balance);
          if (pendCents < amountUsdCents) throw new PaymentServiceError('Saldo pendente insuficiente.', 500, 'PENDING_UNDERFLOW');
          this.db
            .prepare(`UPDATE wallets SET pending_balance = ?, updated_at = ? WHERE user_id = ?`)
            .run(fromMinorUnits(pendCents - amountUsdCents), now, userId);
        }

        this.db
          .prepare(
            `INSERT INTO provider_transactions (
               id, provider, direction, entity_id, reference, provider_tx_id, conversation_id,
               third_party_conversation_id, amount_mt_cents, currency, status, raw_payload_json, created_at
             )
             VALUES (?, ?, 'WITHDRAWAL', ?, ?, ?, ?, ?, ?, 'MZN', 'PAID', ?, ?)`
          )
          .run(
            generateId('ptx'),
            provider,
            params.withdrawalId,
            String(wdr.reference),
            params.gwRes.transactionId,
            params.gwRes.conversationId,
            params.gwRes.thirdPartyConversationId,
            amountMtCents,
            JSON.stringify(params.gwRes.rawPayload ?? {}),
            now
          );

        this.db
          .prepare(
            `UPDATE disbursement_orders
             SET status = 'PAID', provider_tx_id = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(params.gwRes.transactionId, now, params.disbursementOrderId);

        this.db
          .prepare(
            `UPDATE withdrawal_requests
             SET status = 'PAID',
                 disbursement_status = 'PAID',
                 mpesa_transaction_id = ?,
                 mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
                 mpesa_response_code = ?,
                 mpesa_response_desc = ?,
                 paid_at = ?
             WHERE id = ?`
          )
          .run(
            params.gwRes.transactionId,
            params.gwRes.conversationId,
            params.gwRes.responseCode,
            params.gwRes.responseDesc,
            now,
            params.withdrawalId
          );

        this.db
          .prepare(
            `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
             VALUES (?, ?, ?, 'WITHDRAW_COMPLETE', 0, ?, ?, ?, ?)`
          )
          .run(
            generateId('led'),
            generateReference('TXN'),
            userId,
            wallet.available_balance,
            wallet.available_balance,
            `Desembolso M-Pesa pago ${wdr.reference} (${params.gwRes.transactionId})`,
            now
          );

        this.db
          .prepare(
            `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
             VALUES (?, ?, ?, ?, 'WALLET', 0, ?)`
          )
          .run(
            generateId('ntf'),
            userId,
            'Levantamento M-Pesa Pago',
            `Enviámos ${amountMt.toFixed(2)} MT ($${amountUsd.toFixed(2)}) para a sua conta M-Pesa ${wdr.msisdn_masked || ''}.`,
            now
          );

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'WITHDRAWAL_B2C_PAID',
          entityType: 'WITHDRAWAL_REQUEST',
          entityId: params.withdrawalId,
          details: { reference: wdr.reference, provider_tx_id: params.gwRes.transactionId, amount_usd: amountUsd, amount_mt: amountMt },
        });
        return;
      }

      if (params.gwRes.uncertain) {
        // TIMEOUT / UNKNOWN: KEEP RESERVE HELD, DO NOT AUTO-RETRY OR REFUND!
        this.db
          .prepare(
            `UPDATE disbursement_orders
             SET status = 'RECONCILIATION_REQUIRED', last_error = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(`${params.gwRes.responseCode}: ${params.gwRes.responseDesc}`, now, params.disbursementOrderId);

        this.db
          .prepare(
            `UPDATE withdrawal_requests
             SET status = 'RECONCILIATION_REQUIRED',
                 disbursement_status = 'RECONCILIATION_REQUIRED',
                 mpesa_conversation_id = COALESCE(?, mpesa_conversation_id),
                 mpesa_response_code = ?,
                 mpesa_response_desc = ?
             WHERE id = ?`
          )
          .run(params.gwRes.conversationId, params.gwRes.responseCode, params.gwRes.responseDesc, params.withdrawalId);

        const existingRec = this.db
          .prepare(`SELECT id FROM reconciliation_records WHERE entity_type = 'WITHDRAWAL' AND entity_id = ? AND status = 'OPEN'`)
          .get(params.withdrawalId) as { id: string } | undefined;
        if (!existingRec) {
          this.db
            .prepare(
              `INSERT INTO reconciliation_records (id, entity_type, entity_id, reference, reason, status, created_at)
               VALUES (?, 'WITHDRAWAL', ?, ?, ?, 'OPEN', ?)`
            )
            .run(
              generateId('rec'),
              params.withdrawalId,
              String(wdr.reference),
              `B2C_UNCERTAIN: ${params.gwRes.responseCode} - ${params.gwRes.responseDesc}`,
              now
            );
        }

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'WITHDRAWAL_RECONCILIATION_REQUIRED',
          entityType: 'WITHDRAWAL_REQUEST',
          entityId: params.withdrawalId,
          details: { reference: wdr.reference, code: params.gwRes.responseCode, desc: params.gwRes.responseDesc },
        });
        return;
      }

      // DEFINITIVE FAILURE: release reserve once back to available_balance!
      const nextAvailable = fromMinorUnits(toMinorUnits(wallet.available_balance) + amountUsdCents);
      if (reserveRow) {
        const rUpd = this.db
          .prepare(`UPDATE withdrawal_reserves SET status = 'RELEASED', released_at = ? WHERE withdrawal_id = ? AND status = 'HELD'`)
          .run(now, params.withdrawalId);
        if (rUpd.changes === 0) throw new PaymentServiceError('Reserva já processada.', 409, 'RESERVE_ALREADY_SETTLED');
        const resCents = toMinorUnits(wallet.reserved_balance);
        if (resCents < amountUsdCents) throw new PaymentServiceError('Saldo reservado insuficiente.', 500, 'RESERVE_UNDERFLOW');
        this.db
          .prepare(`UPDATE wallets SET available_balance = ?, reserved_balance = ?, updated_at = ? WHERE user_id = ?`)
          .run(nextAvailable, fromMinorUnits(resCents - amountUsdCents), now, userId);
      } else {
        const pendCents = toMinorUnits(wallet.pending_balance);
        if (pendCents < amountUsdCents) throw new PaymentServiceError('Saldo pendente insuficiente.', 500, 'PENDING_UNDERFLOW');
        this.db
          .prepare(`UPDATE wallets SET available_balance = ?, pending_balance = ?, updated_at = ? WHERE user_id = ?`)
          .run(nextAvailable, fromMinorUnits(pendCents - amountUsdCents), now, userId);
      }

      this.db
        .prepare(
          `UPDATE disbursement_orders
           SET status = 'FAILED', last_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(`${params.gwRes.responseCode}: ${params.gwRes.responseDesc}`, now, params.disbursementOrderId);

      this.db
        .prepare(
          `UPDATE withdrawal_requests
           SET status = 'FAILED',
               disbursement_status = 'FAILED',
               mpesa_response_code = ?,
               mpesa_response_desc = ?
           WHERE id = ?`
        )
        .run(params.gwRes.responseCode, params.gwRes.responseDesc, params.withdrawalId);

      this.db
        .prepare(
          `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
           VALUES (?, ?, ?, 'WITHDRAW_RELEASE', ?, ?, ?, ?, ?)`
        )
        .run(
          generateId('led'),
          generateReference('TXN'),
          userId,
          amountUsd,
          wallet.available_balance,
          nextAvailable,
          `Desembolso falhado ${wdr.reference} · saldo devolvido ao disponível`,
          now
        );

      this.db
        .prepare(
          `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
           VALUES (?, ?, ?, ?, 'WALLET', 0, ?)`
        )
        .run(
          generateId('ntf'),
          userId,
          `Levantamento ${wdr.reference} falhou`,
          `O pagamento M-Pesa não foi concluído (${params.gwRes.responseCode}). $${amountUsd.toFixed(2)} voltaram ao seu saldo disponível.`,
          now
        );

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'WITHDRAWAL_B2C_FAILED_RESERVE_RELEASED',
        entityType: 'WITHDRAWAL_REQUEST',
        entityId: params.withdrawalId,
        details: { reference: wdr.reference, code: params.gwRes.responseCode, desc: params.gwRes.responseDesc },
      });
    });

    const updated = this.db.prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`).get(params.withdrawalId) as Record<string, unknown>;
    return {
      withdrawal: sanitizeWithdrawalRow(updated),
      message: params.gwRes.friendlyMessage,
    };
  }

  public async reconcileWithdrawalViaGateway(params: {
    withdrawalId: string;
    actor: ActorInfo;
  }): Promise<{ withdrawal: SanitizedWithdrawalRow; still_pending?: boolean; message: string }> {
    const wdr = this.db
      .prepare(`SELECT * FROM withdrawal_requests WHERE id = ?`)
      .get(params.withdrawalId) as Record<string, unknown> | undefined;
    if (!wdr) {
      throw new PaymentServiceError('Pedido de levantamento não encontrado.', 404, 'NOT_FOUND');
    }
    if (wdr.status === 'PAID' || wdr.status === 'FAILED' || wdr.status === 'REJECTED') {
      return {
        withdrawal: sanitizeWithdrawalRow(wdr),
        message: `Levantamento já encerrado com estado ${wdr.status}.`,
      };
    }

    const order = this.db
      .prepare(`SELECT id FROM disbursement_orders WHERE withdrawal_id = ?`)
      .get(params.withdrawalId) as { id: string } | undefined;
    if (!order) {
      throw new PaymentServiceError(
        'Levantamento ainda não tem ordem de desembolso emitida para consulta.',
        400,
        'NO_DISBURSEMENT_ORDER'
      );
    }

    if (!this.gateway.isConfigured() || !this.gateway.queryPayoutStatus) {
      throw new PaymentServiceError(
        'O gateway ativo não suporta consulta automática de estado de saque.',
        503,
        'PAYOUT_QUERY_UNAVAILABLE'
      );
    }

    const payoutId = (wdr.mpesa_conversation_id as string | null) || '';
    if (!payoutId) {
      throw new PaymentServiceError(
        'ID de saque da operadora ausente neste pedido; utilize a tabela de Reconciliação Operacional.',
        400,
        'MISSING_PAYOUT_ID'
      );
    }

    const gwRes = await this.gateway.queryPayoutStatus({
      payoutId,
      reference: String(wdr.reference),
    });

    if (gwRes.uncertain || gwRes.acceptedPending) {
      return {
        withdrawal: sanitizeWithdrawalRow(wdr),
        still_pending: true,
        message: gwRes.friendlyMessage,
      };
    }

    const finalized = this.finalizeDisbursementOutcome({
      withdrawalId: params.withdrawalId,
      disbursementOrderId: order.id,
      gwRes,
      actor: params.actor,
    });

    const outcome = gwRes.ok && gwRes.transactionId ? 'RESOLVED_CONFIRMED' : 'RESOLVED_FAILED';
    const now = this.nowFn();
    this.db
      .prepare(
        `UPDATE reconciliation_records
         SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = ?
         WHERE entity_type = 'WITHDRAWAL' AND entity_id = ? AND status = 'OPEN'`
      )
      .run(outcome, gwRes.friendlyMessage, `GATEWAY-QUERY:${params.actor.email}`, now, params.withdrawalId);

    return finalized;
  }

  public resolveReconciliation(params: {
    reconciliationId: string;
    outcome: 'RESOLVED_CONFIRMED' | 'RESOLVED_FAILED';
    providerTxId?: string;
    notes: string;
    actor: ActorInfo;
  }) {
    if (!params.notes || params.notes.trim().length < 5) {
      throw new PaymentServiceError('Indique notas justificativas da reconciliação (mín. 5 caracteres).', 400, 'INVALID_NOTES');
    }

    const rec = this.db
      .prepare(`SELECT * FROM reconciliation_records WHERE id = ?`)
      .get(params.reconciliationId) as
      | { id: string; entity_type: 'DEPOSIT' | 'WITHDRAWAL'; entity_id: string; reference: string; status: string }
      | undefined;
    if (!rec || rec.status !== 'OPEN') {
      throw new PaymentServiceError('Registo de reconciliação não encontrado ou já encerrado.', 404, 'NOT_FOUND');
    }

    const now = this.nowFn();

    if (rec.entity_type === 'DEPOSIT') {
      if (params.outcome === 'RESOLVED_CONFIRMED') {
        if (!params.providerTxId || params.providerTxId.trim().length < 4) {
          throw new PaymentServiceError('Para confirmar um depósito em reconciliação, informe o ID oficial da transação M-Pesa.', 400, 'MISSING_TX_ID');
        }
        const dep = this.db.prepare(`SELECT * FROM deposit_requests WHERE id = ?`).get(rec.entity_id) as Record<string, unknown>;
        this.verifyAndCreditDeposit({
          depositId: rec.entity_id,
          providerTxId: params.providerTxId.trim(),
          responseCode: 'INS-0',
          responseDesc: `Reconciliado: ${params.notes.trim()}`,
          confirmedAmountMtCents: typeof dep.amount_mt_cents === 'number' ? dep.amount_mt_cents : toMinorUnits(Number(dep.amount_mt)),
          confirmedCurrency: 'MZN',
          source: `RECONCILIATION:${params.actor.email}`,
        });
      } else {
        withDbTransaction(this.db, () => {
          this.db
            .prepare(`UPDATE deposit_requests SET status = 'FAILED', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'RECONCILIATION_REQUIRED'`)
            .run(params.actor.email, now, rec.entity_id);
        });
      }
    } else {
      const order = this.db
        .prepare(`SELECT id, reference FROM disbursement_orders WHERE withdrawal_id = ?`)
        .get(rec.entity_id) as { id: string; reference: string } | undefined;
      if (!order) {
        throw new PaymentServiceError('Ordem de desembolso associada não encontrada.', 404, 'ORDER_NOT_FOUND');
      }

      if (params.outcome === 'RESOLVED_CONFIRMED') {
        if (!params.providerTxId || params.providerTxId.trim().length < 4) {
          throw new PaymentServiceError('Para confirmar desembolso pago, informe o ID oficial da transação M-Pesa.', 400, 'MISSING_TX_ID');
        }
        this.finalizeDisbursementOutcome({
          withdrawalId: rec.entity_id,
          disbursementOrderId: order.id,
          actor: params.actor,
          gwRes: {
            ok: true,
            responseCode: 'INS-0',
            responseDesc: `Reconciliado: ${params.notes.trim()}`,
            transactionId: params.providerTxId.trim(),
            conversationId: null,
            thirdPartyConversationId: rec.reference,
            friendlyMessage: 'Desembolso confirmado em reconciliação.',
          },
        });
      } else {
        this.finalizeDisbursementOutcome({
          withdrawalId: rec.entity_id,
          disbursementOrderId: order.id,
          actor: params.actor,
          gwRes: {
            ok: false,
            uncertain: false,
            responseCode: 'RECONCILIATION_FAILED',
            responseDesc: params.notes.trim(),
            transactionId: null,
            conversationId: null,
            thirdPartyConversationId: rec.reference,
            friendlyMessage: 'Desembolso confirmado como falhado em reconciliação; reserva devolvida.',
          },
        });
      }
    }

    withDbTransaction(this.db, () => {
      this.db
        .prepare(`UPDATE reconciliation_records SET status = ?, resolution_notes = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
        .run(params.outcome, params.notes.trim(), params.actor.email, now, params.reconciliationId);

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: `RECONCILIATION_${params.outcome}`,
        entityType: rec.entity_type,
        entityId: rec.entity_id,
        details: { reconciliation_id: params.reconciliationId, provider_tx_id: params.providerTxId ?? null, notes: params.notes.trim() },
      });
    });

    return { ok: true };
  }

  // ==================== APP PROFIT (6% DEPOSIT / 2% WITHDRAWAL) & ADMIN THIRD-PARTY PAYOUT ====================

  public getAppFinancialSummary(): {
    completed_ops_count: number;
    gross_user_losses_usd: number;
    gross_user_wins_usd: number;
    net_ops_profit_usd: number;
    zeroed_profit_usd: number;
    zeroed_ops_count: number;
    winning_ops_count: number;
    total_deposited_usd: number;
    deposit_fee_pct: number;
    deposit_fees_usd: number;
    total_user_withdrawn_usd: number;
    withdrawal_fee_pct: number;
    user_withdrawal_fees_usd: number;
    admin_withdrawn_usd: number;
    admin_payout_fees_usd: number;
    pending_admin_payouts_usd: number;
    total_fees_deducted_usd: number;
    provider_fee_owner: 'ZaasTec';
    net_app_profit_usd: number;
    available_admin_payout_usd: number;
    max_withdrawable_before_fee_usd: number;
    exchange_rate_usd_mt: number;
  } {
    const settings = getSettingsFromDb(this.db);

    const profitStats = this.db
      .prepare(
        `SELECT
           COUNT(*) as completed_ops_count,
           COALESCE(SUM(CASE WHEN result_amount_usd < 0 THEN ABS(result_amount_usd) ELSE 0 END), 0) as gross_user_losses_usd,
           COALESCE(SUM(CASE WHEN result_amount_usd > 0 THEN result_amount_usd ELSE 0 END), 0) as gross_user_wins_usd,
           COALESCE(SUM(amount_usd - COALESCE(payout_amount_usd, 0)), 0) as net_ops_profit_usd,
           COALESCE(SUM(CASE WHEN COALESCE(payout_amount_usd, 0) <= 0 THEN amount_usd ELSE 0 END), 0) as zeroed_profit_usd,
           COALESCE(SUM(CASE WHEN COALESCE(payout_amount_usd, 0) <= 0 THEN 1 ELSE 0 END), 0) as zeroed_ops_count,
           COALESCE(SUM(CASE WHEN result_amount_usd > 0 THEN 1 ELSE 0 END), 0) as winning_ops_count
         FROM operations
         WHERE status = 'COMPLETED'`
      )
      .get() as {
      completed_ops_count: number;
      gross_user_losses_usd: number;
      gross_user_wins_usd: number;
      net_ops_profit_usd: number;
      zeroed_profit_usd: number;
      zeroed_ops_count: number;
      winning_ops_count: number;
    };

    const depSum = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('CREDITED', 'APPROVED') THEN amount_usd ELSE 0 END), 0) as total_deposited_usd
           FROM deposit_requests`
        )
        .get() as { total_deposited_usd: number }
    ).total_deposited_usd;

    const wdrSum = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('PAID', 'APPROVED') THEN amount_usd ELSE 0 END), 0) as total_withdrawn_usd
           FROM withdrawal_requests`
        )
        .get() as { total_withdrawn_usd: number }
    ).total_withdrawn_usd;

    const adminPayoutSums = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount_usd ELSE 0 END), 0) as admin_withdrawn_usd,
           COALESCE(SUM(CASE WHEN status = 'PAID' THEN fee_usd ELSE 0 END), 0) as admin_payout_fees_usd,
           COALESCE(SUM(CASE WHEN status IN ('PROCESSING', 'RECONCILIATION_REQUIRED') THEN total_deducted_usd ELSE 0 END), 0) as pending_admin_payouts_usd
         FROM admin_payouts`
      )
      .get() as {
      admin_withdrawn_usd: number;
      admin_payout_fees_usd: number;
      pending_admin_payouts_usd: number;
    };

    const depositFeePct = 6;
    const withdrawalFeePct = 2;

    const totalDepositedUsd = fromMinorUnits(toMinorUnits(depSum));
    const depositFeesUsd = fromMinorUnits(Math.round(toMinorUnits(totalDepositedUsd) * 0.06));
    const totalUserWithdrawnUsd = fromMinorUnits(toMinorUnits(wdrSum));
    const userWithdrawalFeesUsd = fromMinorUnits(Math.round(toMinorUnits(totalUserWithdrawnUsd) * 0.02));

    const adminWithdrawnUsd = fromMinorUnits(toMinorUnits(adminPayoutSums.admin_withdrawn_usd));
    const adminPayoutFeesUsd = fromMinorUnits(toMinorUnits(adminPayoutSums.admin_payout_fees_usd));
    const pendingAdminPayoutsUsd = fromMinorUnits(toMinorUnits(adminPayoutSums.pending_admin_payouts_usd));

    const netOpsProfitUsd = fromMinorUnits(toMinorUnits(profitStats.net_ops_profit_usd));
    const totalFeesDeductedUsd = fromMinorUnits(
      toMinorUnits(depositFeesUsd) + toMinorUnits(userWithdrawalFeesUsd) + toMinorUnits(adminPayoutFeesUsd)
    );
    const netAppProfitUsd = fromMinorUnits(
      toMinorUnits(netOpsProfitUsd) - toMinorUnits(totalFeesDeductedUsd)
    );
    const availableCents =
      toMinorUnits(netAppProfitUsd) - toMinorUnits(adminWithdrawnUsd) - toMinorUnits(pendingAdminPayoutsUsd);
    const availableAdminPayoutUsd = availableCents > 0 ? fromMinorUnits(availableCents) : 0;
    const maxWithdrawableBeforeFeeUsd =
      availableCents > 0 ? Math.floor((availableCents / 1.02)) / 100 : 0;

    return {
      completed_ops_count: profitStats.completed_ops_count,
      gross_user_losses_usd: fromMinorUnits(toMinorUnits(profitStats.gross_user_losses_usd)),
      gross_user_wins_usd: fromMinorUnits(toMinorUnits(profitStats.gross_user_wins_usd)),
      net_ops_profit_usd: netOpsProfitUsd,
      zeroed_profit_usd: fromMinorUnits(toMinorUnits(profitStats.zeroed_profit_usd)),
      zeroed_ops_count: profitStats.zeroed_ops_count,
      winning_ops_count: profitStats.winning_ops_count,
      total_deposited_usd: totalDepositedUsd,
      deposit_fee_pct: depositFeePct,
      deposit_fees_usd: depositFeesUsd,
      total_user_withdrawn_usd: totalUserWithdrawnUsd,
      withdrawal_fee_pct: withdrawalFeePct,
      user_withdrawal_fees_usd: userWithdrawalFeesUsd,
      admin_withdrawn_usd: adminWithdrawnUsd,
      admin_payout_fees_usd: adminPayoutFeesUsd,
      pending_admin_payouts_usd: pendingAdminPayoutsUsd,
      total_fees_deducted_usd: totalFeesDeductedUsd,
      provider_fee_owner: 'ZaasTec',
      net_app_profit_usd: netAppProfitUsd,
      available_admin_payout_usd: availableAdminPayoutUsd,
      max_withdrawable_before_fee_usd: maxWithdrawableBeforeFeeUsd,
      exchange_rate_usd_mt: settings.usd_to_mt_rate,
    };
  }

  public listAdminPayouts(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT id, reference, admin_id, admin_email, recipient_name, msisdn_masked,
                amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd,
                exchange_rate_used, status, provider, provider_payout_id,
                provider_transaction_id, response_code, response_desc, notes,
                created_at, paid_at
         FROM admin_payouts
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  public async createAdminThirdPartyPayout(params: {
    actor: ActorInfo;
    msisdn?: string;
    recipient_name?: string;
    amount_usd?: number;
    notes?: string;
    idempotencyKey?: string;
  }): Promise<{ payout: Record<string, unknown>; summary: ReturnType<PaymentService['getAppFinancialSummary']>; duplicate?: boolean; message: string }> {
    const normalizedMsisdn = normalizeMozMpesaMsisdn((params.msisdn || '').trim());
    if (!normalizedMsisdn) {
      throw new PaymentServiceError(
        'Indique um número M-Pesa Vodacom válido (prefixos 84 ou 85) para o saque como terceiro.',
        400,
        'INVALID_MSISDN'
      );
    }

    const rawAmount = Number(params.amount_usd);
    if (!Number.isFinite(rawAmount) || rawAmount < 1 || rawAmount > 100000) {
      throw new PaymentServiceError('O valor do saque deve estar entre $1.00 e $100,000.00.', 400, 'INVALID_AMOUNT');
    }

    const amountUsdCents = toMinorUnits(rawAmount);
    const feeUsdCents = Math.round(amountUsdCents * 0.02);
    const totalDeductedUsdCents = amountUsdCents + feeUsdCents;

    const cleanAmountUsd = fromMinorUnits(amountUsdCents);
    const feeUsd = fromMinorUnits(feeUsdCents);
    const totalDeductedUsd = fromMinorUnits(totalDeductedUsdCents);

    const settings = getSettingsFromDb(this.db);
    const amountMtCents = usdCentsToMtCents(amountUsdCents, settings.usd_to_mt_rate);
    const amountMt = fromMinorUnits(amountMtCents);
    const maskedMsisdn = maskMsisdn(normalizedMsisdn);
    const idemKey = params.idempotencyKey?.trim() || null;

    if (idemKey) {
      const existing = this.db
        .prepare(
          `SELECT id, reference, admin_id, admin_email, recipient_name, msisdn_masked,
                  amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd,
                  exchange_rate_used, status, provider, provider_payout_id,
                  provider_transaction_id, response_code, response_desc, notes,
                  created_at, paid_at
           FROM admin_payouts WHERE idempotency_key = ?`
        )
        .get(idemKey) as Record<string, unknown> | undefined;
      if (existing) {
        return {
          payout: existing,
          summary: this.getAppFinancialSummary(),
          duplicate: true,
          message: `Saque administrativo ${existing.reference} já registado (idempotência aplicada).`,
        };
      }
    }

    if (!this.gateway.isConfigured()) {
      const cfg = getZaasPayConfig();
      const problemMsg = !cfg.keyPresent
        ? 'Saque M-Pesa (ZaasPay) indisponível: configure a chave ZAASPAY_KEY no servidor para executar saques para terceiros.'
        : 'Saque M-Pesa (ZaasPay) indisponível: ZAASPAY_API_URL inválida no servidor.';
      throw new PaymentServiceError(problemMsg, 503, 'MPESA_NOT_CONFIGURED');
    }

    const now = this.nowFn();
    const id = generateId('apay');
    const reference = generateReference('APPW');
    const convId = crypto.randomBytes(8).toString('hex').toUpperCase();
    const providerName = this.gateway.getProviderName();

    withDbTransaction(this.db, () => {
      const summary = this.getAppFinancialSummary();
      const availCents = toMinorUnits(summary.available_admin_payout_usd);
      if (totalDeductedUsdCents > availCents) {
        throw new PaymentServiceError(
          `Lucro líquido disponível insuficiente ($${summary.available_admin_payout_usd.toFixed(2)}). O pedido de $${cleanAmountUsd.toFixed(2)} + taxa ZaasTec 2% ($${feeUsd.toFixed(2)}) exige $${totalDeductedUsd.toFixed(2)}.`,
          400,
          'INSUFFICIENT_APP_PROFIT'
        );
      }

      this.db
        .prepare(
          `INSERT INTO admin_payouts (
             id, reference, admin_id, admin_email, recipient_name, msisdn, msisdn_masked,
             amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd, exchange_rate_used,
             status, provider, notes, idempotency_key, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 'PROCESSING', ?, ?, ?, ?)`
        )
        .run(
          id,
          reference,
          params.actor.id,
          params.actor.email,
          (params.recipient_name || '').trim().slice(0, 120) || null,
          normalizedMsisdn,
          maskedMsisdn,
          cleanAmountUsd,
          amountMt,
          feeUsd,
          totalDeductedUsd,
          settings.usd_to_mt_rate,
          providerName,
          (params.notes || '').trim().slice(0, 240) || null,
          idemKey,
          now
        );

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: 'ADMIN_THIRD_PARTY_PAYOUT_INITIATED',
        entityType: 'ADMIN_PAYOUT',
        entityId: id,
        details: {
          reference,
          msisdn_masked: maskedMsisdn,
          amount_usd: cleanAmountUsd,
          fee_usd: feeUsd,
          total_deducted_usd: totalDeductedUsd,
          amount_mt: amountMt,
        },
      });
    });

    const gwRes = await this.gateway.initiateB2C({
      amountMt,
      msisdn: normalizedMsisdn,
      reference,
      thirdPartyConversationId: convId,
    });

    const afterAt = this.nowFn();
    let finalMessage = gwRes.friendlyMessage;

    withDbTransaction(this.db, () => {
      if (gwRes.ok && gwRes.transactionId) {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'PAID',
                 provider_payout_id = ?,
                 provider_transaction_id = ?,
                 response_code = ?,
                 response_desc = ?,
                 paid_at = ?
             WHERE id = ?`
          )
          .run(gwRes.conversationId, gwRes.transactionId, gwRes.responseCode, gwRes.responseDesc, afterAt, id);

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'ADMIN_THIRD_PARTY_PAYOUT_PAID',
          entityType: 'ADMIN_PAYOUT',
          entityId: id,
          details: { reference, provider_tx_id: gwRes.transactionId, amount_usd: cleanAmountUsd, amount_mt: amountMt },
        });
        finalMessage = `Saque de lucro ${reference} de $${cleanAmountUsd.toFixed(2)} (${amountMt.toFixed(2)} MT) enviado para ${maskedMsisdn} com sucesso.`;
      } else if (gwRes.uncertain || gwRes.acceptedPending) {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'RECONCILIATION_REQUIRED',
                 provider_payout_id = COALESCE(?, provider_payout_id),
                 response_code = ?,
                 response_desc = ?
             WHERE id = ?`
          )
          .run(gwRes.conversationId, gwRes.responseCode, gwRes.responseDesc, id);

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'ADMIN_THIRD_PARTY_PAYOUT_RECONCILIATION',
          entityType: 'ADMIN_PAYOUT',
          entityId: id,
          details: { reference, code: gwRes.responseCode, desc: gwRes.responseDesc },
        });

        if (!gwRes.conversationId) {
          finalMessage = `${gwRes.friendlyMessage} Se o pagamento não saiu na ZaasPay, utilize "Marcar Falhado (Libertar Saldo)" no histórico abaixo.`;
        }
      } else {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'FAILED',
                 provider_payout_id = COALESCE(?, provider_payout_id),
                 response_code = ?,
                 response_desc = ?
             WHERE id = ?`
          )
          .run(gwRes.conversationId, gwRes.responseCode, gwRes.responseDesc, id);

        logDbAudit(this.db, {
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorRole: params.actor.role,
          action: 'ADMIN_THIRD_PARTY_PAYOUT_FAILED',
          entityType: 'ADMIN_PAYOUT',
          entityId: id,
          details: { reference, code: gwRes.responseCode, desc: gwRes.responseDesc },
        });
        finalMessage = `Saque ${reference} recusado pela ZaasPay (${gwRes.responseCode}): ${gwRes.responseDesc}. Nenhum saldo foi descontado.`;
      }
    });

    const payout = this.db
      .prepare(
        `SELECT id, reference, admin_id, admin_email, recipient_name, msisdn_masked,
                amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd,
                exchange_rate_used, status, provider, provider_payout_id,
                provider_transaction_id, response_code, response_desc, notes,
                created_at, paid_at
         FROM admin_payouts WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;

    return {
      payout,
      summary: this.getAppFinancialSummary(),
      message: finalMessage,
    };
  }

  public async reconcileAdminThirdPartyPayout(params: {
    payoutId: string;
    actor: ActorInfo;
  }): Promise<{ payout: Record<string, unknown>; summary: ReturnType<PaymentService['getAppFinancialSummary']>; still_pending?: boolean; message: string }> {
    const row = this.db
      .prepare(`SELECT * FROM admin_payouts WHERE id = ?`)
      .get(params.payoutId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new PaymentServiceError('Registo de saque administrativo não encontrado.', 404, 'NOT_FOUND');
    }
    if (row.status === 'PAID' || row.status === 'FAILED') {
      const sanitized = this.listAdminPayouts(50).find((p) => p.id === params.payoutId) || row;
      return {
        payout: sanitized,
        summary: this.getAppFinancialSummary(),
        message: `Saque já encerrado com estado ${row.status}.`,
      };
    }

    const payoutExtId = (row.provider_payout_id as string | null) || '';
    if (!payoutExtId) {
      throw new PaymentServiceError(
        'ID do saque na ZaasPay ausente (a API não criou ID de saque). Utilize "Marcar Falhado (Libertar Saldo)" se o pagamento não foi efetuado.',
        400,
        'MISSING_PAYOUT_ID'
      );
    }
    if (!this.gateway.isConfigured() || !this.gateway.queryPayoutStatus) {
      throw new PaymentServiceError('Gateway ZaasPay indisponível para consulta.', 503, 'PAYOUT_QUERY_UNAVAILABLE');
    }

    const gwRes = await this.gateway.queryPayoutStatus({
      payoutId: payoutExtId,
      reference: String(row.reference),
    });

    if (gwRes.uncertain || gwRes.acceptedPending) {
      const sanitized = this.listAdminPayouts(50).find((p) => p.id === params.payoutId) || row;
      return {
        payout: sanitized,
        summary: this.getAppFinancialSummary(),
        still_pending: true,
        message: gwRes.friendlyMessage,
      };
    }

    const now = this.nowFn();
    withDbTransaction(this.db, () => {
      if (gwRes.ok && gwRes.transactionId) {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'PAID', provider_transaction_id = ?, response_code = ?, response_desc = ?, paid_at = ?
             WHERE id = ?`
          )
          .run(gwRes.transactionId, gwRes.responseCode, gwRes.responseDesc, now, params.payoutId);
      } else {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'FAILED', response_code = ?, response_desc = ?
             WHERE id = ?`
          )
          .run(gwRes.responseCode, gwRes.responseDesc, params.payoutId);
      }

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action: gwRes.ok ? 'ADMIN_THIRD_PARTY_PAYOUT_RECONCILED_PAID' : 'ADMIN_THIRD_PARTY_PAYOUT_RECONCILED_FAILED',
        entityType: 'ADMIN_PAYOUT',
        entityId: params.payoutId,
        details: { reference: row.reference, code: gwRes.responseCode, desc: gwRes.responseDesc },
      });
    });

    const updated = this.db
      .prepare(
        `SELECT id, reference, admin_id, admin_email, recipient_name, msisdn_masked,
                amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd,
                exchange_rate_used, status, provider, provider_payout_id,
                provider_transaction_id, response_code, response_desc, notes,
                created_at, paid_at
         FROM admin_payouts WHERE id = ?`
      )
      .get(params.payoutId) as Record<string, unknown>;

    return {
      payout: updated,
      summary: this.getAppFinancialSummary(),
      message: gwRes.friendlyMessage,
    };
  }

  public resolveAdminThirdPartyPayout(params: {
    payoutId: string;
    decision: 'FAILED' | 'PAID';
    providerTxId?: string;
    notes?: string;
    actor: ActorInfo;
  }): { payout: Record<string, unknown>; summary: ReturnType<PaymentService['getAppFinancialSummary']>; message: string } {
    const row = this.db
      .prepare(`SELECT * FROM admin_payouts WHERE id = ?`)
      .get(params.payoutId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new PaymentServiceError('Registo de saque administrativo não encontrado.', 404, 'NOT_FOUND');
    }
    if (row.status === 'PAID' || row.status === 'FAILED') {
      const sanitized = this.listAdminPayouts(50).find((p) => p.id === params.payoutId) || row;
      return {
        payout: sanitized,
        summary: this.getAppFinancialSummary(),
        message: `Saque ${row.reference} já encerrado com estado ${row.status}.`,
      };
    }

    const now = this.nowFn();
    const cleanNote = (params.notes || '').trim();
    const cleanTx = (params.providerTxId || '').trim() || `ADM_CONF_${row.reference}`;

    withDbTransaction(this.db, () => {
      if (params.decision === 'PAID') {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'PAID',
                 provider_transaction_id = COALESCE(provider_transaction_id, ?),
                 response_code = COALESCE(response_code, 'ADMIN_CONFIRMED'),
                 response_desc = COALESCE(?, response_desc),
                 paid_at = ?
             WHERE id = ?`
          )
          .run(cleanTx, cleanNote || 'Confirmado manualmente pelo administrador.', now, params.payoutId);
      } else {
        this.db
          .prepare(
            `UPDATE admin_payouts
             SET status = 'FAILED',
                 response_code = COALESCE(response_code, 'ADMIN_RELEASED_FAILED'),
                 response_desc = ?
             WHERE id = ?`
          )
          .run(
            cleanNote || 'Saque marcado como falhado pelo administrador; saldo retido libertado.',
            params.payoutId
          );
      }

      logDbAudit(this.db, {
        actorId: params.actor.id,
        actorEmail: params.actor.email,
        actorRole: params.actor.role,
        action:
          params.decision === 'PAID'
            ? 'ADMIN_THIRD_PARTY_PAYOUT_MANUALLY_PAID'
            : 'ADMIN_THIRD_PARTY_PAYOUT_MANUALLY_FAILED',
        entityType: 'ADMIN_PAYOUT',
        entityId: params.payoutId,
        details: {
          reference: row.reference,
          decision: params.decision,
          total_deducted_usd: row.total_deducted_usd,
          notes: cleanNote || null,
        },
      });
    });

    const updated = this.db
      .prepare(
        `SELECT id, reference, admin_id, admin_email, recipient_name, msisdn_masked,
                amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd,
                exchange_rate_used, status, provider, provider_payout_id,
                provider_transaction_id, response_code, response_desc, notes,
                created_at, paid_at
         FROM admin_payouts WHERE id = ?`
      )
      .get(params.payoutId) as Record<string, unknown>;

    return {
      payout: updated,
      summary: this.getAppFinancialSummary(),
      message:
        params.decision === 'FAILED'
          ? `Saque ${row.reference} marcado como falhado. O saldo retido ($${Number(row.total_deducted_usd).toFixed(2)}) foi libertado para o lucro disponível.`
          : `Saque ${row.reference} confirmado manualmente como pago.`,
    };
  }
}
