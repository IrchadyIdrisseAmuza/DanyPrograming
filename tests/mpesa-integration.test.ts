import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  fromMinorUnits,
  generateId,
  initSchema,
  toMinorUnits,
  usdCentsToMtCents,
} from '../server/db.ts';
import type { MpesaGatewayAdapter, MpesaGatewayResult } from '../server/mpesa.ts';
import { PaymentService, PaymentServiceError } from '../server/paymentService.ts';
import { zaaspayGateway } from '../server/zaaspay.ts';

class MockMpesaGateway implements MpesaGatewayAdapter {
  public configured = true;
  public c2bCalls = 0;
  public b2cCalls = 0;
  public queryCalls = 0;
  public c2bHandler: (params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }) => Promise<MpesaGatewayResult>;
  public b2cHandler: (params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }) => Promise<MpesaGatewayResult>;
  public queryHandler: (params: {
    queryReference: string;
    thirdPartyConversationId: string;
  }) => Promise<MpesaGatewayResult>;

  constructor() {
    this.c2bHandler = async (p) => ({
      ok: false,
      acceptedPending: true,
      responseCode: 'PENDING',
      responseDesc: 'Aguardar confirmação PIN no telemóvel',
      transactionId: null,
      conversationId: `CONV-${p.reference}`,
      thirdPartyConversationId: p.thirdPartyConversationId,
      friendlyMessage: 'Pedido enviado para o telemóvel.',
    });

    this.b2cHandler = async (p) => ({
      ok: true,
      responseCode: 'INS-0',
      responseDesc: 'Request processed successfully',
      transactionId: `B2C-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      conversationId: `BCONV-${p.reference}`,
      thirdPartyConversationId: p.thirdPartyConversationId,
      friendlyMessage: 'Transação M-Pesa processada e confirmada com sucesso.',
    });

    this.queryHandler = async (p) => ({
      ok: true,
      responseCode: 'INS-0',
      responseDesc: 'Completed',
      transactionId: `QTX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      conversationId: p.thirdPartyConversationId,
      thirdPartyConversationId: p.thirdPartyConversationId,
      friendlyMessage: 'Transação confirmada.',
    });
  }

  isConfigured() {
    return this.configured;
  }

  getProviderName() {
    return 'MPESA_VODACOM_MZ';
  }

  async initiateC2B(params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }) {
    this.c2bCalls++;
    return this.c2bHandler(params);
  }

  async initiateB2C(params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }) {
    this.b2cCalls++;
    return this.b2cHandler(params);
  }

  async queryTransactionStatus(params: {
    queryReference: string;
    thirdPartyConversationId: string;
  }) {
    this.queryCalls++;
    return this.queryHandler(params);
  }
}

function createTempDb(tmpDir: string, name: string): { dbPath: string; db: DatabaseSync } {
  const dbPath = path.join(tmpDir, `${name}.db`);
  const conn = new DatabaseSync(dbPath);
  conn.exec('PRAGMA busy_timeout = 5000;');
  conn.exec('PRAGMA foreign_keys = ON;');
  initSchema(conn, false);
  return { dbPath, db: conn };
}

function seedUser(
  db: DatabaseSync,
  opts: { id: string; email: string; role?: 'USER' | 'ADMIN' | 'SUPER_ADMIN'; balanceUsd?: number; phone?: string }
) {
  const now = new Date().toISOString();
  const code = `MIL-${crypto.randomInt(100000, 999999)}`;
  db.prepare(
    `INSERT INTO users (id, public_code, full_name, username, phone, email, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'salt:hash', ?, 'ACTIVE', ?, ?)`
  ).run(
    opts.id,
    code,
    `User ${opts.id}`,
    `user_${opts.id}`,
    opts.phone || '+258841234567',
    opts.email,
    opts.role || 'USER',
    now,
    now
  );

  db.prepare(
    `INSERT INTO wallets (user_id, available_balance, locked_balance, pending_balance, reserved_balance, updated_at)
     VALUES (?, ?, 0, 0, 0, ?)`
  ).run(opts.id, opts.balanceUsd ?? 0, now);
}

function getWallet(db: DatabaseSync, userId: string) {
  return db
    .prepare(`SELECT available_balance, locked_balance, pending_balance, reserved_balance FROM wallets WHERE user_id = ?`)
    .get(userId) as {
    available_balance: number;
    locked_balance: number;
    pending_balance: number;
    reserved_balance: number;
  };
}

function signWebhook(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

async function runSuite() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'milion-mpesa-suite-'));
  const prevWebhookSecret = process.env.ZAASPAY_WEBHOOK_SECRET;
  const prevZaasKey = process.env.ZAASPAY_KEY;
  const prevZaasUrl = process.env.ZAASPAY_API_URL;
  const testSecret = 'zaaspay-unit-test-secret-key-2026';
  process.env.ZAASPAY_WEBHOOK_SECRET = testSecret;

  let passed = 0;
  let failed = 0;

  async function testCase(index: number, title: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      passed++;
      console.log(`PASS [${String(index).padStart(2, '0')}/33] ${title}`);
    } catch (err) {
      failed++;
      console.error(`FAIL [${String(index).padStart(2, '0')}/33] ${title}:`, err);
    }
  }

  try {
    // 1. Pending deposit created WITHOUT touching available_balance or pending_balance
    await testCase(1, 'Criação de depósito pendente sem crédito em saldo disponível ou pendente', async () => {
      const { db } = createTempDb(tmpDir, 't01');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 10 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const res = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER', phone: '841234567' },
        method: 'M-Pesa',
        msisdn: '841234567',
        amount_usd: 20,
        idempotencyKey: 'idem-dep-1',
      });

      assert.equal(res.deposit.status, 'PAYMENT_PENDING');
      assert.equal(res.deposit.amount_usd, 20);
      assert.equal(res.deposit.amount_mt, 1400);
      assert.equal(res.deposit.exchange_rate_used, 70);
      assert.equal(res.deposit.msisdn_masked, '+258 84 *** 4567');

      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 10);
      assert.equal(w.pending_balance, 0);
      assert.equal(w.reserved_balance, 0);
      db.close();
    });

    // 2. Valid confirmation credits wallet once + 1 DEPOSIT_CREDIT ledger + audit + notification
    await testCase(2, 'Confirmação válida de depósito com crédito único, ledger, auditoria e notificação', async () => {
      const { db } = createTempDb(tmpDir, 't02');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 5 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '+258845551234',
        amount_usd: 10,
      });

      const payload = {
        event_id: 'evt-ok-1',
        reference: created.deposit.reference,
        output_TransactionID: 'MPESA-TX-002',
        output_ResponseCode: 'INS-0',
        output_ResponseDesc: 'Processed',
        output_Amount: 700,
        currency: 'MZN',
      };
      const raw = JSON.stringify(payload);
      const whkRes = svc.processWebhook({
        headers: { 'x-mpesa-signature': signWebhook(raw, testSecret) },
        rawBodyString: raw,
        payload,
      });

      assert.equal(whkRes.ok, true);
      assert.equal(whkRes.status, 'CREDITED');

      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 15);

      const ledgers = db
        .prepare(`SELECT * FROM wallet_ledger WHERE user_id = 'u1' AND type = 'DEPOSIT_CREDIT'`)
        .all();
      assert.equal(ledgers.length, 1);

      const ntfs = db.prepare(`SELECT * FROM notifications WHERE user_id = 'u1'`).all();
      assert.equal(ntfs.length, 1);
      db.close();
    });

    // 3. Replaying same webhook 10 times does NOT duplicate balance
    await testCase(3, 'Reenvio do mesmo webhook 10 vezes sem duplicar saldo', async () => {
      const { db } = createTempDb(tmpDir, 't03');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '849998877',
        amount_usd: 50,
      });

      const payload = {
        event_id: 'evt-replay-1',
        reference: created.deposit.reference,
        output_TransactionID: 'MPESA-TX-003',
        output_ResponseCode: 'INS-0',
        output_Amount: 3500,
        currency: 'MZN',
      };
      const raw = JSON.stringify(payload);
      const sig = signWebhook(raw, testSecret);

      for (let i = 0; i < 10; i++) {
        const res = svc.processWebhook({
          headers: { 'x-mpesa-signature': sig },
          rawBodyString: raw,
          payload,
        });
        assert.equal(res.ok, true);
        if (i > 0) assert.equal(res.duplicate, true);
      }

      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 50);
      const ledCount = (
        db.prepare(`SELECT COUNT(*) as c FROM wallet_ledger WHERE type = 'DEPOSIT_CREDIT'`).get() as { c: number }
      ).c;
      assert.equal(ledCount, 1);
      db.close();
    });

    // 4. Failed or cancelled payment webhook does not credit
    await testCase(4, 'Webhook de pagamento falhado ou cancelado não credita qualquer valor', async () => {
      const { db } = createTempDb(tmpDir, 't04');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 12 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '851112233',
        amount_usd: 25,
      });

      const payload = {
        event_id: 'evt-fail-1',
        reference: created.deposit.reference,
        output_TransactionID: '',
        output_ResponseCode: 'INS-5',
        output_ResponseDesc: 'Transaction cancelled by customer',
        output_Amount: 1750,
        currency: 'MZN',
      };
      const raw = JSON.stringify(payload);
      const res = svc.processWebhook({
        headers: { 'x-mpesa-signature': signWebhook(raw, testSecret) },
        rawBodyString: raw,
        payload,
      });

      assert.equal(res.status, 'FAILED');
      assert.equal(getWallet(db, 'u1').available_balance, 12);
      const depRow = db.prepare(`SELECT status FROM deposit_requests WHERE id = ?`).get(created.deposit.id) as {
        status: string;
      };
      assert.equal(depRow.status, 'FAILED');
      db.close();
    });

    // 5. Fake / invalid signature webhook rejected (403)
    await testCase(5, 'Webhook falso ou com assinatura inválida rejeitado (403)', async () => {
      const { db } = createTempDb(tmpDir, 't05');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841112233',
        amount_usd: 100,
      });

      const payload = {
        reference: created.deposit.reference,
        output_TransactionID: 'FAKE-TX',
        output_ResponseCode: 'INS-0',
        output_Amount: 7000,
        currency: 'MZN',
      };
      const raw = JSON.stringify(payload);

      assert.throws(
        () =>
          svc.processWebhook({
            headers: { 'x-mpesa-signature': 'deadbeef0000' },
            rawBodyString: raw,
            payload,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 403 && err.code === 'WEBHOOK_UNAUTHORIZED'
      );

      assert.equal(getWallet(db, 'u1').available_balance, 0);
      db.close();
    });

    // 6. Divergent amount or currency moves to RECONCILIATION_REQUIRED without crediting
    await testCase(6, 'Webhook com montante ou moeda divergente envia para reconciliação sem creditar', async () => {
      const { db } = createTempDb(tmpDir, 't06');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const depAmt = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '842223344',
        amount_usd: 10, // expects 700 MT
      });

      const payloadMismatchAmt = {
        event_id: 'evt-mismatch-amt',
        reference: depAmt.deposit.reference,
        output_TransactionID: 'TX-MISMATCH-AMT',
        output_ResponseCode: 'INS-0',
        output_Amount: 350, // only 350 MT instead of 700 MT
        currency: 'MZN',
      };
      const rawAmt = JSON.stringify(payloadMismatchAmt);

      assert.throws(
        () =>
          svc.processWebhook({
            headers: { 'x-mpesa-signature': signWebhook(rawAmt, testSecret) },
            rawBodyString: rawAmt,
            payload: payloadMismatchAmt,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 422 && err.code === 'AMOUNT_MISMATCH'
      );

      const depAfterAmt = db
        .prepare(`SELECT status FROM deposit_requests WHERE id = ?`)
        .get(depAmt.deposit.id) as { status: string };
      assert.equal(depAfterAmt.status, 'RECONCILIATION_REQUIRED');
      assert.equal(getWallet(db, 'u1').available_balance, 0);

      const depCur = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '842223344',
        amount_usd: 5,
      });

      const payloadMismatchCur = {
        event_id: 'evt-mismatch-cur',
        reference: depCur.deposit.reference,
        output_TransactionID: 'TX-MISMATCH-CUR',
        output_ResponseCode: 'INS-0',
        output_Amount: 350,
        currency: 'ZAR',
      };
      const rawCur = JSON.stringify(payloadMismatchCur);

      assert.throws(
        () =>
          svc.processWebhook({
            headers: { 'x-mpesa-signature': signWebhook(rawCur, testSecret) },
            rawBodyString: rawCur,
            payload: payloadMismatchCur,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 422 && err.code === 'CURRENCY_MISMATCH'
      );

      const recCount = (
        db.prepare(`SELECT COUNT(*) as c FROM reconciliation_records WHERE status = 'OPEN'`).get() as { c: number }
      ).c;
      assert.equal(recCount, 2);
      assert.equal(getWallet(db, 'u1').available_balance, 0);
      db.close();
    });

    // 7. Two concurrent webhooks for the same deposit result in a single credit
    await testCase(7, 'Dois webhooks simultâneos para o mesmo depósito resultam em apenas 1 crédito', async () => {
      const { db } = createTempDb(tmpDir, 't07');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '843334455',
        amount_usd: 20,
      });

      const p1 = {
        event_id: 'evt-conc-a',
        reference: created.deposit.reference,
        output_TransactionID: 'TX-CONC-777',
        output_ResponseCode: 'INS-0',
        output_Amount: 1400,
        currency: 'MZN',
      };
      const p2 = {
        event_id: 'evt-conc-b',
        reference: created.deposit.reference,
        output_TransactionID: 'TX-CONC-777',
        output_ResponseCode: 'INS-0',
        output_Amount: 1400,
        currency: 'MZN',
      };
      const r1 = JSON.stringify(p1);
      const r2 = JSON.stringify(p2);

      const [res1, res2] = await Promise.all([
        Promise.resolve().then(() =>
          svc.processWebhook({ headers: { 'x-mpesa-signature': signWebhook(r1, testSecret) }, rawBodyString: r1, payload: p1 })
        ),
        Promise.resolve().then(() =>
          svc.processWebhook({ headers: { 'x-mpesa-signature': signWebhook(r2, testSecret) }, rawBodyString: r2, payload: p2 })
        ),
      ]);

      assert.equal(res1.ok, true);
      assert.equal(res2.ok, true);
      assert.equal(getWallet(db, 'u1').available_balance, 20);
      const ledCount = (
        db.prepare(`SELECT COUNT(*) as c FROM wallet_ledger WHERE type = 'DEPOSIT_CREDIT'`).get() as { c: number }
      ).c;
      assert.equal(ledCount, 1);
      db.close();
    });

    // 8. Withdrawal creation reserves immediately without invoking B2C
    await testCase(8, 'Levantamento solicitado reserva saldo atomicamente (AWAITING_APPROVAL) sem B2C', () => {
      const { db } = createTempDb(tmpDir, 't08');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const res = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_type: 'M-Pesa',
        destination_account: '845001122',
        amount_usd: 30,
      });

      assert.equal(res.withdrawal.status, 'AWAITING_APPROVAL');
      assert.equal(res.withdrawal.amount_mt, 2100);
      assert.equal(gw.b2cCalls, 0);

      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 70);
      assert.equal(w.reserved_balance, 30);

      const rsv = db
        .prepare(`SELECT status, amount_usd_cents FROM withdrawal_reserves WHERE withdrawal_id = ?`)
        .get(res.withdrawal.id) as { status: string; amount_usd_cents: number };
      assert.equal(rsv.status, 'HELD');
      assert.equal(rsv.amount_usd_cents, 3000);
      db.close();
    });

    // 9. Concurrent withdrawals competing for the same balance cannot overdraft
    await testCase(9, 'Dois levantamentos simultâneos competindo pelo mesmo saldo bloqueiam excesso', async () => {
      const { db } = createTempDb(tmpDir, 't09');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          svc.createWithdrawal({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            destination_account: '845001122',
            amount_usd: 70,
          })
        ),
        Promise.resolve().then(() =>
          svc.createWithdrawal({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            destination_account: '845001122',
            amount_usd: 70,
          })
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 30);
      assert.equal(w.reserved_balance, 70);
      db.close();
    });

    // 10. Admin rejection returns reserve once
    await testCase(10, 'Rejeição pelo administrador devolve saldo reservado uma única vez', async () => {
      const { db } = createTempDb(tmpDir, 't10');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '845001122',
        amount_usd: 40,
      });

      const rej = await svc.adminReviewWithdrawal({
        withdrawalId: created.withdrawal.id,
        decision: 'REJECTED',
        notes: 'Conta não verificada',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
      });

      assert.equal(rej.withdrawal.status, 'REJECTED');
      assert.equal(getWallet(db, 'u1').available_balance, 100);
      assert.equal(getWallet(db, 'u1').reserved_balance, 0);

      // Second rejection must fail
      await assert.rejects(
        () =>
          svc.adminReviewWithdrawal({
            withdrawalId: created.withdrawal.id,
            decision: 'REJECTED',
            actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'INVALID_STATE'
      );

      assert.equal(getWallet(db, 'u1').available_balance, 100);
      db.close();
    });

    // 11. Admin approval creates single persistent disbursement order; duplicate approval blocked
    await testCase(11, 'Aprovação cria única instrução persistente de desembolso e bloqueia duplicação', async () => {
      const { db } = createTempDb(tmpDir, 't11');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '846001122',
        amount_usd: 25,
      });

      await svc.adminReviewWithdrawal({
        withdrawalId: created.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
      });

      const orders = db
        .prepare(`SELECT * FROM disbursement_orders WHERE withdrawal_id = ?`)
        .all(created.withdrawal.id);
      assert.equal(orders.length, 1);

      await assert.rejects(
        () =>
          svc.adminReviewWithdrawal({
            withdrawalId: created.withdrawal.id,
            decision: 'APPROVED',
            actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 409
      );
      assert.equal(gw.b2cCalls, 1);
      db.close();
    });

    // 12. B2C timeout/uncertain keeps reserve held and moves to RECONCILIATION_REQUIRED
    await testCase(12, 'Timeout ou estado incerto no B2C retém reserva em reconciliação sem reenvio automático', async () => {
      const { db } = createTempDb(tmpDir, 't12');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      gw.b2cHandler = async (p) => ({
        ok: false,
        uncertain: true,
        responseCode: 'INS-9',
        responseDesc: 'Request timeout',
        transactionId: null,
        conversationId: null,
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Timeout.',
      });
      const svc = new PaymentService({ db, gateway: gw });

      const created = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '847001122',
        amount_usd: 35,
      });

      const approved = await svc.adminReviewWithdrawal({
        withdrawalId: created.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'ADMIN' },
      });

      assert.equal(approved.withdrawal.status, 'RECONCILIATION_REQUIRED');
      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 65);
      assert.equal(w.reserved_balance, 35); // Still held!
      assert.equal(gw.b2cCalls, 1);

      const rec = db
        .prepare(`SELECT status FROM reconciliation_records WHERE entity_id = ?`)
        .get(created.withdrawal.id) as { status: string };
      assert.equal(rec.status, 'OPEN');
      db.close();
    });

    // 13. Confirmed B2C paid consumes reserve once & logs WITHDRAW_COMPLETE
    await testCase(13, 'Confirmação oficial B2C consome reserva uma única vez e conclui levantamento', async () => {
      const { db } = createTempDb(tmpDir, 't13');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      const svc = new PaymentService({ db, gateway: gw });

      const created = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '848001122',
        amount_usd: 20,
      });

      const res = await svc.adminReviewWithdrawal({
        withdrawalId: created.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'ADMIN' },
      });

      assert.equal(res.withdrawal.status, 'PAID');
      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 80);
      assert.equal(w.reserved_balance, 0);

      const rsv = db
        .prepare(`SELECT status FROM withdrawal_reserves WHERE withdrawal_id = ?`)
        .get(created.withdrawal.id) as { status: string };
      assert.equal(rsv.status, 'CONSUMED');

      const completeLed = db
        .prepare(`SELECT COUNT(*) as c FROM wallet_ledger WHERE user_id = 'u1' AND type = 'WITHDRAW_COMPLETE'`)
        .get() as { c: number };
      assert.equal(completeLed.c, 1);
      db.close();
    });

    // 14. Definitive B2C failure releases reserve once
    await testCase(14, 'Falha definitiva de desembolso B2C liberta a reserva uma única vez', async () => {
      const { db } = createTempDb(tmpDir, 't14');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const gw = new MockMpesaGateway();
      gw.b2cHandler = async (p) => ({
        ok: false,
        uncertain: false,
        responseCode: 'INS-996',
        responseDesc: 'Customer account invalid',
        transactionId: null,
        conversationId: null,
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Número M-Pesa inválido.',
      });
      const svc = new PaymentService({ db, gateway: gw });

      const created = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '849001122',
        amount_usd: 45,
      });

      const res = await svc.adminReviewWithdrawal({
        withdrawalId: created.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'ADMIN' },
      });

      assert.equal(res.withdrawal.status, 'FAILED');
      const w = getWallet(db, 'u1');
      assert.equal(w.available_balance, 100);
      assert.equal(w.reserved_balance, 0);

      const rsv = db
        .prepare(`SELECT status FROM withdrawal_reserves WHERE withdrawal_id = ?`)
        .get(created.withdrawal.id) as { status: string };
      assert.equal(rsv.status, 'RELEASED');
      db.close();
    });

    // 15. Simulated process restart preserves idempotency and webhook replay protection
    await testCase(15, 'Reinício simulado preserva proteção contra duplicação e replay de webhooks', async () => {
      const { dbPath, db } = createTempDb(tmpDir, 't15');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 10 });
      const gw1 = new MockMpesaGateway();
      const svc1 = new PaymentService({ db, gateway: gw1 });

      const dep = await svc1.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841231234',
        amount_usd: 15,
        idempotencyKey: 'restart-idem-dep',
      });

      const payload = {
        event_id: 'evt-restart-01',
        reference: dep.deposit.reference,
        output_TransactionID: 'TX-RESTART-900',
        output_ResponseCode: 'INS-0',
        output_Amount: 1050,
        currency: 'MZN',
      };
      const raw = JSON.stringify(payload);
      svc1.processWebhook({
        headers: { 'x-mpesa-signature': signWebhook(raw, testSecret) },
        rawBodyString: raw,
        payload,
      });
      db.close();

      // Reopen database with brand-new PaymentService instance
      const dbReopened = new DatabaseSync(dbPath);
      dbReopened.exec('PRAGMA busy_timeout = 5000;');
      const svc2 = new PaymentService({ db: dbReopened, gateway: new MockMpesaGateway() });

      const depDup = await svc2.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841231234',
        amount_usd: 15,
        idempotencyKey: 'restart-idem-dep',
      });
      assert.equal(depDup.duplicate, true);
      assert.equal(depDup.deposit.id, dep.deposit.id);

      const whkReplay = svc2.processWebhook({
        headers: { 'x-mpesa-signature': signWebhook(raw, testSecret) },
        rawBodyString: raw,
        payload,
      });
      assert.equal(whkReplay.duplicate, true);
      assert.equal(getWallet(dbReopened, 'u1').available_balance, 25);
      dbReopened.close();
    });

    // 16. Deterministic minor-unit math (1 USD = 70 MT), min/max limits, legacy method block
    await testCase(16, 'Cálculo determinístico 1 USD = 70 MT em centavos, limites e bloqueio de métodos legados', async () => {
      assert.equal(fromMinorUnits(usdCentsToMtCents(toMinorUnits(1), 70)), 70);
      assert.equal(fromMinorUnits(usdCentsToMtCents(toMinorUnits(5), 70)), 350);
      assert.equal(fromMinorUnits(usdCentsToMtCents(toMinorUnits(10), 70)), 700);
      assert.equal(fromMinorUnits(usdCentsToMtCents(toMinorUnits(12.34), 70)), 863.8);
      assert.equal(fromMinorUnits(usdCentsToMtCents(toMinorUnits(1000), 70)), 70000);

      const { db } = createTempDb(tmpDir, 't16');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });
      const svc = new PaymentService({ db, gateway: new MockMpesaGateway() });

      await assert.rejects(
        () =>
          svc.createDeposit({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            method: 'e-Mola',
            msisdn: '841234567',
            amount_usd: 10,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'UNSUPPORTED_METHOD'
      );

      await assert.rejects(
        () =>
          svc.createDeposit({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            method: 'M-Pesa',
            msisdn: '841234567',
            amount_usd: 0.99,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'INVALID_AMOUNT'
      );

      assert.throws(
        () =>
          svc.createWithdrawal({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            destination_type: 'Transferência Bancária',
            destination_account: '841234567',
            amount_usd: 5,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'UNSUPPORTED_METHOD'
      );

      assert.throws(
        () =>
          svc.createWithdrawal({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            destination_type: 'M-Pesa',
            destination_account: '841234567',
            amount_usd: 1.5,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'MIN_WITHDRAWAL'
      );
      db.close();
    });

    // 17. Manual admin approval of M-Pesa deposit blocked (MPESA_ADMIN_BLOCK)
    await testCase(17, 'Bloqueio de aprovação manual administrativa de depósito M-Pesa (MPESA_ADMIN_BLOCK)', async () => {
      const { db } = createTempDb(tmpDir, 't17');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const svc = new PaymentService({ db, gateway: new MockMpesaGateway() });

      const dep = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841234567',
        amount_usd: 100,
      });

      assert.throws(
        () =>
          svc.adminReviewDeposit({
            depositId: dep.deposit.id,
            decision: 'APPROVED',
            actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 403 && err.code === 'MPESA_ADMIN_BLOCK'
      );

      assert.equal(getWallet(db, 'u1').available_balance, 0);
      const blockAudit = db
        .prepare(`SELECT COUNT(*) as c FROM audit_logs WHERE action = 'MPESA_ADMIN_BLOCK'`)
        .get() as { c: number };
      assert.equal(blockAudit.c, 1);
      db.close();
    });

    // 18 & 19. Auth + Cross-user ownership + Admin RBAC via real Express HTTP routes
    await testCase(18, 'Utilizador sem autenticação (401) e acesso cross-user rejeitados (403)', async () => {
      const { db } = createTempDb(tmpDir, 't18');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', role: 'USER', balanceUsd: 50 });
      seedUser(db, { id: 'u2', email: 'u2@test.mz', role: 'USER', balanceUsd: 50 });
      seedUser(db, { id: 'adm1', email: 'adm@test.mz', role: 'ADMIN', balanceUsd: 0 });
      const svc = new PaymentService({ db, gateway: new MockMpesaGateway() });

      const depU1 = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841234567',
        amount_usd: 10,
      });

      const app = express();
      app.use(express.json());
      const authMw = (req: express.Request & { testUser?: { id: string; email: string; role: string } }, res: express.Response, next: express.NextFunction) => {
        const uid = req.header('x-test-user-id');
        if (!uid) {
          res.status(401).json({ error: 'Não autenticado.' });
          return;
        }
        const row = db.prepare(`SELECT id, email, role FROM users WHERE id = ?`).get(uid) as
          | { id: string; email: string; role: string }
          | undefined;
        if (!row) {
          res.status(401).json({ error: 'Sessão inválida.' });
          return;
        }
        req.testUser = row;
        next();
      };

      app.post('/api/deposits', authMw, async (req: express.Request & { testUser?: { id: string; email: string; role: string } }, res) => {
        try {
          const r = await svc.createDeposit({ actor: req.testUser!, ...req.body });
          res.status(201).json(r);
        } catch (e) {
          if (e instanceof PaymentServiceError) res.status(e.statusCode).json({ error: e.message, code: e.code });
          else res.status(500).json({ error: 'error' });
        }
      });

      app.post('/api/deposits/:id/reconcile', authMw, async (req: express.Request & { testUser?: { id: string; email: string; role: string } }, res) => {
        const dep = db.prepare(`SELECT user_id FROM deposit_requests WHERE id = ?`).get(req.params.id) as { user_id: string } | undefined;
        if (!dep) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const isAdmin = req.testUser!.role === 'ADMIN' || req.testUser!.role === 'SUPER_ADMIN';
        if (dep.user_id !== req.testUser!.id && !isAdmin) {
          res.status(403).json({ error: 'Acesso negado.' });
          return;
        }
        const r = await svc.reconcileDepositViaGateway({ depositId: req.params.id, actor: req.testUser! });
        res.json(r);
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;

      try {
        const unauthRes = await fetch(`${base}/api/deposits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn: '841234567', amount_usd: 10 }),
        });
        assert.equal(unauthRes.status, 401);

        const crossRes = await fetch(`${base}/api/deposits/${depU1.deposit.id}/reconcile`, {
          method: 'POST',
          headers: { 'x-test-user-id': 'u2' },
        });
        assert.equal(crossRes.status, 403);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
      }
    });

    // 19. Admin RBAC enforcement: USER blocked (403), ADMIN allowed
    await testCase(19, 'Permissões administrativas aplicadas corretamente (USER bloqueado 403, ADMIN autorizado)', async () => {
      const { db } = createTempDb(tmpDir, 't19');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', role: 'USER', balanceUsd: 50 });
      seedUser(db, { id: 'adm1', email: 'adm@test.mz', role: 'ADMIN', balanceUsd: 0 });
      const svc = new PaymentService({ db, gateway: new MockMpesaGateway() });

      const wdr = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '841234567',
        amount_usd: 15,
      });

      const app = express();
      app.use(express.json());
      app.post('/api/admin/withdrawals/:id/review', async (req, res) => {
        const uid = req.header('x-test-user-id');
        if (!uid) {
          res.status(401).json({ error: 'Não autenticado.' });
          return;
        }
        const actor = db.prepare(`SELECT id, email, role FROM users WHERE id = ?`).get(uid) as {
          id: string;
          email: string;
          role: string;
        };
        if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') {
          res.status(403).json({ error: 'Acesso restrito a administradores.' });
          return;
        }
        const r = await svc.adminReviewWithdrawal({
          withdrawalId: req.params.id,
          decision: req.body.decision,
          actor,
        });
        res.json(r);
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;

      try {
        const userAttempt = await fetch(`${base}/api/admin/withdrawals/${wdr.withdrawal.id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-user-id': 'u1' },
          body: JSON.stringify({ decision: 'APPROVED' }),
        });
        assert.equal(userAttempt.status, 403);

        const adminAttempt = await fetch(`${base}/api/admin/withdrawals/${wdr.withdrawal.id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-user-id': 'adm1' },
          body: JSON.stringify({ decision: 'APPROVED' }),
        });
        assert.equal(adminAttempt.status, 200);
        const json = (await adminAttempt.json()) as { withdrawal: { status: string } };
        assert.equal(json.withdrawal.status, 'PAID');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
      }
    });

    // 20. Historical legacy DB migration preserves old e-Mola / Bank orders & reconciles cleanly
    await testCase(20, 'Migração de base legada preserva pedidos históricos e conclui reconciliação manual', async () => {
      const legacyPath = path.join(tmpDir, 'legacy.db');
      const legacyDb = new DatabaseSync(legacyPath);
      // Simulate old pre-migration schema without reserved_balance and with strict legacy CHECK constraints
      legacyDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          public_code TEXT UNIQUE NOT NULL,
          full_name TEXT NOT NULL,
          username TEXT UNIQUE NOT NULL,
          phone TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE wallets (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          available_balance REAL NOT NULL DEFAULT 0,
          locked_balance REAL NOT NULL DEFAULT 0,
          pending_balance REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE wallet_ledger (
          id TEXT PRIMARY KEY,
          reference TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          balance_before REAL NOT NULL,
          balance_after REAL NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE deposit_requests (
          id TEXT PRIMARY KEY,
          reference TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id),
          method TEXT NOT NULL,
          amount_usd REAL NOT NULL,
          amount_mt REAL NOT NULL,
          exchange_rate_used REAL NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
          notes TEXT,
          reviewed_by TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE withdrawal_requests (
          id TEXT PRIMARY KEY,
          reference TEXT UNIQUE NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id),
          destination_type TEXT NOT NULL,
          destination_account TEXT NOT NULL,
          amount_usd REAL NOT NULL,
          amount_mt REAL NOT NULL,
          exchange_rate_used REAL NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
          notes TEXT,
          reviewed_by TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          actor_id TEXT,
          actor_email TEXT,
          actor_role TEXT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          type TEXT NOT NULL,
          is_read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);

      const now = new Date().toISOString();
      legacyDb
        .prepare(
          `INSERT INTO users (id, public_code, full_name, username, phone, email, password_hash, role, status, created_at, updated_at)
           VALUES ('leg_u1', 'MIL-000111', 'Legacy User', 'legacy_u1', '+258841112223', 'legacy@test.mz', 's:h', 'USER', 'ACTIVE', ?, ?)`
        )
        .run(now, now);
      legacyDb
        .prepare(`INSERT INTO wallets (user_id, available_balance, locked_balance, pending_balance, updated_at) VALUES ('leg_u1', 50, 0, 10, ?)`)
        .run(now);
      legacyDb
        .prepare(
          `INSERT INTO deposit_requests (id, reference, user_id, method, amount_usd, amount_mt, exchange_rate_used, status, notes, created_at)
           VALUES ('leg_dep_1', 'DEP-LEGACY-1', 'leg_u1', 'e-Mola', 25, 1750, 70, 'APPROVED', 'Histórico e-Mola', ?)`
        )
        .run(now);
      legacyDb
        .prepare(
          `INSERT INTO withdrawal_requests (id, reference, user_id, destination_type, destination_account, amount_usd, amount_mt, exchange_rate_used, status, notes, created_at)
           VALUES ('leg_wdr_1', 'WDR-LEGACY-1', 'leg_u1', 'Transferência Bancária', '0011223344', 10, 700, 70, 'PENDING', 'Histórico pendente', ?)`
        )
        .run(now);

      // Run idempotent schema migration!
      initSchema(legacyDb, false);

      const check = legacyDb.prepare(`PRAGMA integrity_check;`).get() as { integrity_check: string };
      assert.equal(check.integrity_check, 'ok');

      const legDep = legacyDb.prepare(`SELECT status, method FROM deposit_requests WHERE id = 'leg_dep_1'`).get() as {
        status: string;
        method: string;
      };
      assert.equal(legDep.status, 'APPROVED');
      assert.equal(legDep.method, 'e-Mola');

      // Reconcile uncertain B2C item end-to-end as RESOLVED_CONFIRMED
      const gw = new MockMpesaGateway();
      gw.b2cHandler = async (p) => ({
        ok: false,
        uncertain: true,
        responseCode: 'INS-1',
        responseDesc: 'Internal Error',
        transactionId: null,
        conversationId: null,
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Incerto.',
      });
      const svc = new PaymentService({ db: legacyDb, gateway: gw });

      const newWdr = svc.createWithdrawal({
        actor: { id: 'leg_u1', email: 'legacy@test.mz', role: 'USER' },
        destination_account: '841112223',
        amount_usd: 10,
      });
      await svc.adminReviewWithdrawal({
        withdrawalId: newWdr.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
      });

      const rec = legacyDb
        .prepare(`SELECT id FROM reconciliation_records WHERE entity_id = ? AND status = 'OPEN'`)
        .get(newWdr.withdrawal.id) as { id: string };
      assert.ok(rec?.id);

      svc.resolveReconciliation({
        reconciliationId: rec.id,
        outcome: 'RESOLVED_CONFIRMED',
        providerTxId: 'MPESA-CONFIRMED-RECON-1',
        notes: 'Confirmado no portal M-Pesa da operadora',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
      });

      const finalWdr = legacyDb
        .prepare(`SELECT status FROM withdrawal_requests WHERE id = ?`)
        .get(newWdr.withdrawal.id) as { status: string };
      assert.equal(finalWdr.status, 'PAID');
      assert.equal(getWallet(legacyDb, 'leg_u1').reserved_balance, 0);
      legacyDb.close();
    });

    // 21. Unconfigured gateway rejects deposit immediately (503) without creating dead PAYMENT_PENDING row
    await testCase(21, 'Gateway M-Pesa sem credenciais falha com 503 sem criar referência falsa pendente', async () => {
      const { db } = createTempDb(tmpDir, 't21');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      gw.configured = false;
      const svc = new PaymentService({ db, gateway: gw });

      await assert.rejects(
        () =>
          svc.createDeposit({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            msisdn: '841234567',
            amount_usd: 10,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 503 && err.code === 'MPESA_NOT_CONFIGURED'
      );

      const depCount = (db.prepare(`SELECT COUNT(*) as c FROM deposit_requests`).get() as { c: number }).c;
      assert.equal(depCount, 0);
      assert.equal(gw.c2bCalls, 0);
      db.close();
    });

    // 22. Synchronous Vodacom MZ C2B (INS-0 + output_TransactionID) credits 10 USD (700 MT) immediately
    await testCase(22, 'Cobrança C2B síncrona confirmada (INS-0 + TransactionID) credita 10 USD automaticamente', async () => {
      const { db } = createTempDb(tmpDir, 't22');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 2 });
      const gw = new MockMpesaGateway();
      gw.c2bHandler = async (p) => {
        assert.equal(p.amountMt, 700);
        assert.equal(p.msisdn, '258845556666');
        return {
          ok: true,
          responseCode: 'INS-0',
          responseDesc: 'Request processed successfully',
          transactionId: 'MPESA-SYNC-700MT',
          conversationId: 'CONV-SYNC-1',
          thirdPartyConversationId: p.thirdPartyConversationId,
          friendlyMessage: 'Transação M-Pesa processada e confirmada com sucesso.',
        };
      };
      const svc = new PaymentService({ db, gateway: gw });

      const res = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '+258 84 555 6666',
        amount_usd: 10,
      });

      assert.equal(gw.c2bCalls, 1);
      assert.equal(res.deposit.status, 'CREDITED');
      assert.equal(res.deposit.amount_usd, 10);
      assert.equal(res.deposit.amount_mt, 700);
      assert.equal(getWallet(db, 'u1').available_balance, 12);
      db.close();
    });

    // 23. queryTransactionStatus returning Pending stays PAYMENT_PENDING; Completed credits once
    await testCase(23, 'Consulta de estado Pending mantém pendente; Completed credita uma única vez', async () => {
      const { db } = createTempDb(tmpDir, 't23');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      let queryPhase: 'PENDING' | 'COMPLETED' = 'PENDING';
      gw.queryHandler = async (p) => {
        if (queryPhase === 'PENDING') {
          return {
            ok: false,
            acceptedPending: true,
            uncertain: false,
            responseCode: 'PENDING',
            responseDesc: 'Pending PIN',
            transactionId: null,
            conversationId: 'CONV-1',
            thirdPartyConversationId: p.thirdPartyConversationId,
            friendlyMessage: 'Aguardando PIN.',
          };
        }
        return {
          ok: true,
          responseCode: 'INS-0',
          responseDesc: 'Completed',
          transactionId: 'MPESA-Q-991',
          conversationId: 'CONV-1',
          thirdPartyConversationId: p.thirdPartyConversationId,
          friendlyMessage: 'Confirmado.',
        };
      };
      const svc = new PaymentService({ db, gateway: gw });

      const dep = await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '849990001',
        amount_usd: 10,
      });
      assert.equal(dep.deposit.status, 'PAYMENT_PENDING');

      const checkPending = await svc.reconcileDepositViaGateway({
        depositId: dep.deposit.id,
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
      });
      assert.equal(checkPending.deposit.status, 'PAYMENT_PENDING');
      assert.equal(getWallet(db, 'u1').available_balance, 0);

      queryPhase = 'COMPLETED';
      const checkDone = await svc.reconcileDepositViaGateway({
        depositId: dep.deposit.id,
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
      });
      assert.equal(checkDone.deposit.status, 'CREDITED');
      assert.equal(getWallet(db, 'u1').available_balance, 10);
      db.close();
    });

    // 24. Uncertain C2B probes queryTransactionStatus automatically; customer PIN cancellation (INS-5) fails without credit
    await testCase(24, 'Timeout C2B consulta operadora automaticamente e rejeição INS-5 falha sem creditar', async () => {
      const { db } = createTempDb(tmpDir, 't24');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 5 });
      const gw = new MockMpesaGateway();
      gw.c2bHandler = async (p) => ({
        ok: false,
        uncertain: true,
        responseCode: 'INS-9',
        responseDesc: 'Request timeout',
        transactionId: null,
        conversationId: 'CONV-TO-1',
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Timeout.',
      });
      gw.queryHandler = async (p) => ({
        ok: false,
        acceptedPending: false,
        uncertain: false,
        responseCode: 'INS-5',
        responseDesc: 'Transaction cancelled by customer',
        transactionId: null,
        conversationId: 'CONV-TO-1',
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Transação M-Pesa cancelada pelo utilizador no telemóvel.',
      });
      const svc = new PaymentService({ db, gateway: gw });

      await assert.rejects(
        () =>
          svc.createDeposit({
            actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
            msisdn: '852223334',
            amount_usd: 15,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.statusCode === 400 && err.code === 'INS-5'
      );

      assert.equal(gw.queryCalls, 1);
      assert.equal(getWallet(db, 'u1').available_balance, 5);
      const depRow = db.prepare(`SELECT status FROM deposit_requests WHERE user_id = 'u1'`).get() as { status: string };
      assert.equal(depRow.status, 'FAILED');
      db.close();
    });

    // 25. ZaasPay real adapter: POST /v1/payments synchronous succeeded credits 10 USD (700 MT) + blocks non-integer MT
    await testCase(25, 'ZaasPay POST /v1/payments síncrono (succeeded) credita 10 USD e valida inteiro MT', async () => {
      const { db } = createTempDb(tmpDir, 't25');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 3 });

      const app = express();
      app.use(express.json());
      let seenAuth = '';
      let seenBody: Record<string, unknown> = {};

      app.post('/v1/payments', (req, res) => {
        seenAuth = req.header('authorization') || '';
        seenBody = req.body as Record<string, unknown>;
        res.status(200).json({
          id: 'pay_zaas_001',
          status: 'succeeded',
          amount: 700,
          fee: 42,
          net: 658,
          currency: 'MZN',
          phone: seenBody.phone,
          provider: 'mpesa',
          reference: seenBody.reference,
          provider_transaction_id: 'MPESA_ZP_700MT',
          created_at: new Date().toISOString(),
        });
      });

      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const addr = srv.address() as { port: number };
      process.env.ZAASPAY_KEY = 'sk_test_mock_zaaspay_key';
      process.env.ZAASPAY_API_URL = `http://127.0.0.1:${addr.port}/v1`;

      try {
        const svc = new PaymentService({ db, gateway: zaaspayGateway });

        // Reject fractional MT ($1.25 = 87.50 MT) cleanly before calling ZaasPay
        await assert.rejects(
          () =>
            svc.createDeposit({
              actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
              msisdn: '841234567',
              amount_usd: 1.25,
            }),
          (err: unknown) => err instanceof PaymentServiceError && err.code === 'INTEGER_MT_REQUIRED'
        );

        const res = await svc.createDeposit({
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
          msisdn: '841234567',
          amount_usd: 10,
        });

        assert.equal(seenAuth, 'Bearer sk_test_mock_zaaspay_key');
        assert.equal(seenBody.amount, 700);
        assert.equal(seenBody.phone, '258841234567');
        assert.equal(res.deposit.status, 'CREDITED');
        assert.equal(res.deposit.provider, 'ZAASPAY_MPESA');
        assert.equal(res.deposit.mpesa_transaction_id, 'MPESA_ZP_700MT');
        assert.equal(res.deposit.mpesa_conversation_id, 'pay_zaas_001');
        assert.equal(getWallet(db, 'u1').available_balance, 13);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        db.close();
      }
    });

    // 26. ZaasPay 402 payment_cancelled & insufficient_funds fail cleanly without crediting
    await testCase(26, 'ZaasPay 402 (payment_cancelled / insufficient_funds) falha sem creditar saldo', async () => {
      const { db } = createTempDb(tmpDir, 't26');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 5 });

      const app = express();
      app.use(express.json());
      let mode: 'cancelled' | 'insufficient' = 'cancelled';
      app.post('/v1/payments', (_req, res) => {
        if (mode === 'cancelled') {
          res.status(402).json({
            error: {
              code: 'payment_cancelled',
              message: 'Customer cancelled USSD prompt',
              payment_id: 'pay_cancel_01',
            },
          });
          return;
        }
        res.status(402).json({
          error: {
            code: 'insufficient_funds',
            message: 'Insufficient customer M-Pesa balance',
            payment_id: 'pay_insuff_02',
          },
        });
      });

      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const addr = srv.address() as { port: number };
      process.env.ZAASPAY_KEY = 'sk_test_mock_zaaspay_key';
      process.env.ZAASPAY_API_URL = `http://127.0.0.1:${addr.port}/v1`;

      try {
        const svc = new PaymentService({ db, gateway: zaaspayGateway });

        await assert.rejects(
          () =>
            svc.createDeposit({
              actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
              msisdn: '849991122',
              amount_usd: 10,
            }),
          (err: unknown) => err instanceof PaymentServiceError && err.code === 'payment_cancelled'
        );

        mode = 'insufficient';
        await assert.rejects(
          () =>
            svc.createDeposit({
              actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
              msisdn: '859991122',
              amount_usd: 20,
            }),
          (err: unknown) => err instanceof PaymentServiceError && err.code === 'insufficient_funds'
        );

        assert.equal(getWallet(db, 'u1').available_balance, 5);
        const statuses = db.prepare(`SELECT status FROM deposit_requests ORDER BY created_at`).all() as Array<{ status: string }>;
        assert.deepEqual(statuses.map((s) => s.status), ['FAILED', 'FAILED']);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        db.close();
      }
    });

    // 27. ZaasPay 408 timeout probes /payments/by-reference/:ref -> unknown -> reconcile -> succeeded credits once
    await testCase(27, 'ZaasPay 408 timeout consulta by-reference (unknown -> succeeded) sem duplicar', async () => {
      const { db } = createTempDb(tmpDir, 't27');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });

      const app = express();
      app.use(express.json());
      let queryPhase: 'unknown' | 'succeeded' = 'unknown';

      app.post('/v1/payments', (_req, res) => {
        res.status(408).json({
          error: { code: 'timeout', message: 'Request timed out waiting for PIN' },
        });
      });

      app.get('/v1/payments/by-reference/:ref', (req, res) => {
        res.status(200).json({
          id: 'pay_rec_777',
          status: queryPhase,
          amount: 1400,
          fee: 84,
          net: 1316,
          currency: 'MZN',
          phone: '258847778899',
          provider: 'mpesa',
          reference: req.params.ref,
          provider_transaction_id: queryPhase === 'succeeded' ? 'MPESA_REC_777' : null,
          created_at: new Date().toISOString(),
        });
      });

      app.get('/v1/payments/:id', (req, res) => {
        res.status(200).json({
          id: req.params.id,
          status: queryPhase,
          amount: 1400,
          fee: 84,
          net: 1316,
          currency: 'MZN',
          phone: '258847778899',
          provider: 'mpesa',
          provider_transaction_id: queryPhase === 'succeeded' ? 'MPESA_REC_777' : null,
          created_at: new Date().toISOString(),
        });
      });

      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const addr = srv.address() as { port: number };
      process.env.ZAASPAY_KEY = 'sk_test_mock_zaaspay_key';
      process.env.ZAASPAY_API_URL = `http://127.0.0.1:${addr.port}/v1`;

      try {
        const svc = new PaymentService({ db, gateway: zaaspayGateway });

        const created = await svc.createDeposit({
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
          msisdn: '847778899',
          amount_usd: 20,
        });
        assert.equal(created.deposit.status, 'PAYMENT_PENDING');
        assert.equal(created.deposit.mpesa_conversation_id, 'pay_rec_777');
        assert.equal(getWallet(db, 'u1').available_balance, 0);

        queryPhase = 'succeeded';
        const recRes = await svc.reconcileDepositViaGateway({
          depositId: created.deposit.id,
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        });
        assert.equal(recRes.deposit.status, 'CREDITED');
        assert.equal(recRes.deposit.mpesa_transaction_id, 'MPESA_REC_777');
        assert.equal(getWallet(db, 'u1').available_balance, 20);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        db.close();
      }
    });

    // 28. ZaasPay third-party payouts: concluido, em_processamento -> GET /v1/payouts/:id -> concluido, and 422 failure
    await testCase(28, 'ZaasPay POST /v1/payouts (concluido, em_processamento + reconcile, e 422 falha)', async () => {
      const { db } = createTempDb(tmpDir, 't28');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 100 });

      const app = express();
      app.use(express.json());
      let payoutMode: 'concluido' | 'em_processamento' | 'insufficient_balance' = 'concluido';
      let queryStatus: 'em_processamento' | 'concluido' = 'em_processamento';

      app.post('/v1/payouts', (req, res) => {
        const body = req.body as { amount: number; phone: string };
        if (payoutMode === 'insufficient_balance') {
          res.status(422).json({
            error: { code: 'insufficient_balance', message: 'Merchant ZaasPay balance insufficient' },
          });
          return;
        }
        if (payoutMode === 'em_processamento') {
          res.status(200).json({
            id: 'wd_proc_555',
            mode: 'test',
            amount: Number((body.amount * 1.02).toFixed(2)),
            fee: Number((body.amount * 0.02).toFixed(2)),
            net: body.amount,
            msisdn: body.phone,
            wallet: 'mpesa',
            status: 'em_processamento',
            provider_transaction_id: null,
            failure_reason: null,
            created_at: new Date().toISOString(),
          });
          return;
        }
        res.status(200).json({
          id: 'wd_done_111',
          mode: 'test',
          amount: Number((body.amount * 1.02).toFixed(2)),
          fee: Number((body.amount * 0.02).toFixed(2)),
          net: body.amount,
          msisdn: body.phone,
          wallet: 'mpesa',
          status: 'concluido',
          provider_transaction_id: 'MPESA_WD_111',
          failure_reason: null,
          created_at: new Date().toISOString(),
        });
      });

      app.get('/v1/payouts/:id', (req, res) => {
        res.status(200).json({
          id: req.params.id,
          mode: 'test',
          amount: 1428,
          fee: 28,
          net: 1400,
          msisdn: '258845550000',
          wallet: 'mpesa',
          status: queryStatus,
          provider_transaction_id: queryStatus === 'concluido' ? 'MPESA_WD_555_FINAL' : null,
          failure_reason: null,
          created_at: new Date().toISOString(),
        });
      });

      const srv = http.createServer(app);
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
      const addr = srv.address() as { port: number };
      process.env.ZAASPAY_KEY = 'sk_test_mock_zaaspay_key';
      process.env.ZAASPAY_API_URL = `http://127.0.0.1:${addr.port}/v1`;

      try {
        const svc = new PaymentService({ db, gateway: zaaspayGateway });
        const adminActor = { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' };

        // 1) Synchronous concluido ($10 = 700 MT)
        const w1 = svc.createWithdrawal({
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
          destination_account: '845550000',
          amount_usd: 10,
        });
        const r1 = await svc.adminReviewWithdrawal({ withdrawalId: w1.withdrawal.id, decision: 'APPROVED', actor: adminActor });
        assert.equal(r1.withdrawal.status, 'PAID');
        assert.equal(r1.withdrawal.mpesa_transaction_id, 'MPESA_WD_111');
        assert.equal(getWallet(db, 'u1').available_balance, 90);
        assert.equal(getWallet(db, 'u1').reserved_balance, 0);

        // 2) em_processamento -> stays RECONCILIATION_REQUIRED with wd_proc_555 -> query becomes concluido -> PAID
        payoutMode = 'em_processamento';
        const w2 = svc.createWithdrawal({
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
          destination_account: '845550000',
          amount_usd: 20,
        });
        const r2 = await svc.adminReviewWithdrawal({ withdrawalId: w2.withdrawal.id, decision: 'APPROVED', actor: adminActor });
        assert.equal(r2.withdrawal.status, 'RECONCILIATION_REQUIRED');
        assert.equal(r2.withdrawal.mpesa_conversation_id, 'wd_proc_555');
        assert.equal(getWallet(db, 'u1').available_balance, 70);
        assert.equal(getWallet(db, 'u1').reserved_balance, 20);

        const r2Still = await svc.reconcileWithdrawalViaGateway({ withdrawalId: w2.withdrawal.id, actor: adminActor });
        assert.equal(r2Still.still_pending, true);
        assert.equal(getWallet(db, 'u1').reserved_balance, 20);

        queryStatus = 'concluido';
        const r2Done = await svc.reconcileWithdrawalViaGateway({ withdrawalId: w2.withdrawal.id, actor: adminActor });
        assert.equal(r2Done.withdrawal.status, 'PAID');
        assert.equal(r2Done.withdrawal.mpesa_transaction_id, 'MPESA_WD_555_FINAL');
        assert.equal(getWallet(db, 'u1').reserved_balance, 0);

        // 3) 422 insufficient_balance releases reserve back to available_balance
        payoutMode = 'insufficient_balance';
        const w3 = svc.createWithdrawal({
          actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
          destination_account: '845550000',
          amount_usd: 15,
        });
        const r3 = await svc.adminReviewWithdrawal({ withdrawalId: w3.withdrawal.id, decision: 'APPROVED', actor: adminActor });
        assert.equal(r3.withdrawal.status, 'FAILED');
        assert.equal(getWallet(db, 'u1').available_balance, 70);
        assert.equal(getWallet(db, 'u1').reserved_balance, 0);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        db.close();
      }
    });

    // 29. App profit summary accurately deducts 6% deposit fees & 2% withdrawal fees
    await testCase(29, 'Lucro da App deduz 6% sobre depósitos creditados e 2% sobre levantamentos pagos', async () => {
      const { db } = createTempDb(tmpDir, 't29');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 0 });
      const gw = new MockMpesaGateway();
      gw.c2bHandler = async (p) => ({
        ok: true,
        responseCode: 'INS-0',
        responseDesc: 'Completed',
        transactionId: `TX-${p.reference}`,
        conversationId: `CONV-${p.reference}`,
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Pago.',
      });
      const svc = new PaymentService({ db, gateway: gw });

      // Credit $100 deposit -> 6% fee = $6.00
      await svc.createDeposit({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        msisdn: '841112233',
        amount_usd: 100,
      });

      // Completed user operations: user loses $80, wins $20 -> gross ops profit = $60.00
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO operations (id, reference, user_id, idempotency_key, direction, amount_usd, duration_seconds, entry_price, exit_price, result_amount_usd, payout_amount_usd, return_pct, status, termination_reason, opened_at, expires_at, settled_at, rule_snapshot)
         VALUES
         ('op_loss', 'OP-L1', 'u1', 'k1', 'SUBIDA', 80, 300, 2500, 2400, -80, 0, -100, 'COMPLETED', 'ZEROED_OUT', ?, ?, ?, '{}'),
         ('op_win', 'OP-W1', 'u1', 'k2', 'SUBIDA', 20, 300, 2500, 2550, 20, 40, 100, 'COMPLETED', 'EXPIRED', ?, ?, ?, '{}')`
      ).run(now, now, now, now, now, now);

      // Paid user withdrawal of $25 -> 2% fee = $0.50
      const wdr = svc.createWithdrawal({
        actor: { id: 'u1', email: 'u1@test.mz', role: 'USER' },
        destination_account: '841112233',
        amount_usd: 25,
      });
      await svc.adminReviewWithdrawal({
        withdrawalId: wdr.withdrawal.id,
        decision: 'APPROVED',
        actor: { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' },
      });

      const summary = svc.getAppFinancialSummary();
      assert.equal(summary.total_deposited_usd, 100);
      assert.equal(summary.deposit_fees_usd, 6);
      assert.equal(summary.total_user_withdrawn_usd, 25);
      assert.equal(summary.user_withdrawal_fees_usd, 0.5);
      assert.equal(summary.net_ops_profit_usd, 60);
      assert.equal(summary.total_fees_deducted_usd, 6.5);
      assert.equal(summary.net_app_profit_usd, 53.5);
      assert.equal(summary.available_admin_payout_usd, 53.5);
      db.close();
    });

    // 30. Admin Third-Party M-Pesa Payouts: limits, 2% fee hold, failure release, and reconciliation
    await testCase(30, 'Saque administrativo como terceiro M-Pesa (2% taxa, bloqueio de excesso e reconciliação)', async () => {
      const { db } = createTempDb(tmpDir, 't30');
      seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 200 });
      seedUser(db, { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN', balanceUsd: 0 });
      const now = new Date().toISOString();

      // Seed $100 gross profit from completed loss operation (no deposits/withdrawals so net profit = $100)
      db.prepare(
        `INSERT INTO operations (id, reference, user_id, idempotency_key, direction, amount_usd, duration_seconds, entry_price, exit_price, result_amount_usd, payout_amount_usd, return_pct, status, termination_reason, opened_at, expires_at, settled_at, rule_snapshot)
         VALUES ('op_p', 'OP-P1', 'u1', 'kp1', 'DESCIDA', 100, 300, 2500, 2600, -100, 0, -100, 'COMPLETED', 'ZEROED_OUT', ?, ?, ?, '{}')`
      ).run(now, now, now);

      const gw = new MockMpesaGateway();
      let queryStatus: 'em_processamento' | 'concluido' = 'em_processamento';
      (gw as MpesaGatewayAdapter).queryPayoutStatus = async ({ payoutId }) => ({
        ok: queryStatus === 'concluido',
        acceptedPending: queryStatus === 'em_processamento',
        responseCode: queryStatus === 'concluido' ? 'INS-0' : 'PENDING',
        responseDesc: queryStatus,
        transactionId: queryStatus === 'concluido' ? `MPESA_FIN_${payoutId}` : null,
        conversationId: payoutId,
        thirdPartyConversationId: payoutId,
        friendlyMessage: queryStatus === 'concluido' ? 'Pago.' : 'Em processamento.',
      });

      const svc = new PaymentService({ db, gateway: gw });
      const adminActor = { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' };

      // 1) Over-limit ($99 + 2% = $100.98 > $100) rejected
      await assert.rejects(
        () =>
          svc.createAdminThirdPartyPayout({
            actor: adminActor,
            msisdn: '841234567',
            amount_usd: 99,
          }),
        (err: unknown) => err instanceof PaymentServiceError && err.code === 'INSUFFICIENT_APP_PROFIT'
      );

      // 2) Failed B2C payout marks FAILED and keeps full $100 available
      gw.b2cHandler = async (p) => ({
        ok: false,
        uncertain: false,
        responseCode: 'ERR-FAIL',
        responseDesc: 'Rejected',
        transactionId: null,
        conversationId: 'wd_fail',
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Falhou.',
      });
      const failRes = await svc.createAdminThirdPartyPayout({
        actor: adminActor,
        msisdn: '841234567',
        amount_usd: 40,
      });
      assert.equal(failRes.payout.status, 'FAILED');
      assert.equal(failRes.summary.available_admin_payout_usd, 100);

      // 3) Pending B2C payout reserves amount + 2% ($50 + $1 = $51) until reconciled -> PAID
      gw.b2cHandler = async (p) => ({
        ok: false,
        acceptedPending: true,
        responseCode: 'PENDING',
        responseDesc: 'em_processamento',
        transactionId: null,
        conversationId: 'wd_pend_50',
        thirdPartyConversationId: p.thirdPartyConversationId,
        friendlyMessage: 'Em processamento.',
      });
      const pendRes = await svc.createAdminThirdPartyPayout({
        actor: adminActor,
        msisdn: '841234567',
        recipient_name: 'Sócio Operacional',
        amount_usd: 50,
      });
      assert.equal(pendRes.payout.status, 'RECONCILIATION_REQUIRED');
      assert.equal(pendRes.summary.pending_admin_payouts_usd, 51);
      assert.equal(pendRes.summary.available_admin_payout_usd, 49);

      queryStatus = 'concluido';
      const doneRes = await svc.reconcileAdminThirdPartyPayout({
        payoutId: String(pendRes.payout.id),
        actor: adminActor,
      });
      assert.equal(doneRes.payout.status, 'PAID');
      assert.equal(doneRes.summary.admin_withdrawn_usd, 50);
      assert.equal(doneRes.summary.admin_payout_fees_usd, 1);
      assert.equal(doneRes.summary.net_app_profit_usd, 99);
      assert.equal(doneRes.summary.available_admin_payout_usd, 49);
      db.close();
    });

    // 31. Notification reads track per-user read state for global (user_id IS NULL) broadcasts
    await testCase(31, 'Leitura automática de notificações regista estado por utilizador inclusive em avisos globais', () => {
      const { db } = createTempDb(tmpDir, 't31');
      seedUser(db, { id: 'u1', email: 'u1@test.mz' });
      seedUser(db, { id: 'u2', email: 'u2@test.mz' });
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
         VALUES
         ('ntf_global', NULL, 'Aviso Geral', 'Manutenção programada', 'ADMIN', 0, ?),
         ('ntf_u1', 'u1', 'Depósito', 'Confirmado', 'WALLET', 0, ?)`
      ).run(now, now);

      // Mark all read for u1 only
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = 'u1'`).run();
      db.prepare(
        `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES ('ntf_global', 'u1', ?)`
      ).run(now);

      const unreadCountFor = (uid: string) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) as c
               FROM notifications n
               LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
               WHERE (n.user_id = ? OR n.user_id IS NULL)
                 AND (CASE WHEN n.user_id IS NULL THEN CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END ELSE n.is_read END) = 0`
            )
            .get(uid, uid) as { c: number }
        ).c;

      assert.equal(unreadCountFor('u1'), 0);
      assert.equal(unreadCountFor('u2'), 1);
      db.close();
    });

    // 32. Support ticket conversation threading (support_messages)
    await testCase(32, 'Suporte regista conversa encadeada bidirecional (support_messages)', () => {
      const { db } = createTempDb(tmpDir, 't32');
      seedUser(db, { id: 'u1', email: 'u1@test.mz' });
      seedUser(db, { id: 'adm1', email: 'admin@milion.space', role: 'ADMIN' });
      const t1 = '2026-11-18T10:00:00.000Z';
      const t2 = '2026-11-18T10:05:00.000Z';
      const t3 = '2026-11-18T10:10:00.000Z';

      db.prepare(
        `INSERT INTO support_tickets (id, reference, user_id, subject, category, message, status, created_at, updated_at)
         VALUES ('sup_1', 'SUP-001', 'u1', 'Dúvida M-Pesa', 'M-Pesa / Moçambique', 'Mensagem inicial', 'OPEN', ?, ?)`
      ).run(t1, t1);

      db.prepare(
        `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
         VALUES
         ('m1', 'sup_1', 'u1', 'USER', 'u1@test.mz', 'Mensagem inicial', ?),
         ('m2', 'sup_1', 'adm1', 'ADMIN', 'admin@milion.space', 'Resposta da equipa', ?),
         ('m3', 'sup_1', 'u1', 'USER', 'u1@test.mz', 'Obrigado, confirmado.', ?)`
      ).run(t1, t2, t3);

      const msgs = db
        .prepare(`SELECT sender_role, body FROM support_messages WHERE ticket_id = 'sup_1' ORDER BY created_at ASC`)
        .all() as Array<{ sender_role: string; body: string }>;

      assert.equal(msgs.length, 3);
      assert.deepEqual(
        msgs.map((m) => m.sender_role),
        ['USER', 'ADMIN', 'USER']
      );
      db.close();
    });

    // 33. ZaasTec provider fee ownership + explicit ZaasPay rejection without payout ID + manual resolution
    await testCase(
      33,
      'Taxas 6%/2% identificadas como ZaasTec, erro explícito ZaasPay sem ID não retém saldo e resolução manual liberta bloqueio',
      async () => {
        const { db } = createTempDb(tmpDir, 't33');
        seedUser(db, { id: 'u1', email: 'u1@test.mz', balanceUsd: 200 });
        seedUser(db, { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN', balanceUsd: 0 });
        const now = new Date().toISOString();

        // Seed $100 gross profit
        db.prepare(
          `INSERT INTO operations (id, reference, user_id, idempotency_key, direction, amount_usd, duration_seconds, entry_price, exit_price, result_amount_usd, payout_amount_usd, return_pct, status, termination_reason, opened_at, expires_at, settled_at, rule_snapshot)
           VALUES ('op_t33', 'OP-T33', 'u1', 'kt33', 'DESCIDA', 100, 300, 2500, 2600, -100, 0, -100, 'COMPLETED', 'ZEROED_OUT', ?, ?, ?, '{}')`
        ).run(now, now, now);

        // Mock HTTP ZaasPay server that rejects payout explicitly with HTTP 500 JSON error and NO data.id
        const mockServer = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (chunk) => {
            raw += chunk;
          });
          req.on('end', () => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: {
                  code: 'INSUFFICIENT_MERCHANT_BALANCE',
                  message: 'Saldo insuficiente na conta comerciante ZaasPay',
                },
              })
            );
          });
        });

        await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
        const addr = mockServer.address();
        assert.ok(addr && typeof addr === 'object');

        process.env.ZAASPAY_KEY = 'zaas_test_key';
        process.env.ZAASPAY_API_URL = `http://127.0.0.1:${addr.port}/api/v1`;

        try {
          const svc = new PaymentService({ db, gateway: zaaspayGateway });
          const adminActor = { id: 'adm1', email: 'admin@milion.space', role: 'SUPER_ADMIN' };

          // Verify provider_fee_owner is explicitly ZaasTec
          const summaryBefore = svc.getAppFinancialSummary();
          assert.equal(summaryBefore.provider_fee_owner, 'ZaasTec');
          assert.equal(summaryBefore.available_admin_payout_usd, 100);

          // Explicit ZaasPay error without payout ID MUST mark FAILED and keep full $100 available
          const rejectedRes = await svc.createAdminThirdPartyPayout({
            actor: adminActor,
            msisdn: '841234567',
            amount_usd: 50,
            idempotencyKey: 't33-explicit-reject',
          });
          assert.equal(rejectedRes.payout.status, 'FAILED');
          assert.equal(rejectedRes.summary.available_admin_payout_usd, 100);
          assert.equal(rejectedRes.summary.pending_admin_payouts_usd, 0);

          // Seed a stuck RECONCILIATION_REQUIRED payout without provider_payout_id (legacy bug scenario)
          db.prepare(
            `INSERT INTO admin_payouts (id, reference, admin_id, admin_email, recipient_name, msisdn, msisdn_masked, amount_usd, amount_mt, fee_pct, fee_usd, total_deducted_usd, exchange_rate_used, status, provider, response_code, response_desc, created_at)
             VALUES ('ap_stuck', 'AP-STUCK-33', 'adm1', 'admin@milion.space', 'Teste Preso', '258841234567', '+258 84 *** 4567', 50, 3500, 2, 1, 51, 70, 'RECONCILIATION_REQUIRED', 'ZAASPAY_MPESA', 'MISSING_PAYOUT_ID', 'Sem ID ZaasPay', ?)`
          ).run(now);

          const stuckSummary = svc.getAppFinancialSummary();
          assert.equal(stuckSummary.pending_admin_payouts_usd, 51);
          assert.equal(stuckSummary.available_admin_payout_usd, 49);

          // Manual admin resolution marks FAILED and restores full $100 available
          const resolvedRes = svc.resolveAdminThirdPartyPayout({
            payoutId: 'ap_stuck',
            decision: 'FAILED',
            notes: 'Confirmado não debitado na ZaasPay',
            actor: adminActor,
          });
          assert.equal(resolvedRes.payout.status, 'FAILED');
          assert.equal(resolvedRes.summary.pending_admin_payouts_usd, 0);
          assert.equal(resolvedRes.summary.available_admin_payout_usd, 100);
        } finally {
          mockServer.close();
          if (prevZaasKey === undefined) delete process.env.ZAASPAY_KEY;
          else process.env.ZAASPAY_KEY = prevZaasKey;
          if (prevZaasUrl === undefined) delete process.env.ZAASPAY_API_URL;
          else process.env.ZAASPAY_API_URL = prevZaasUrl;
          db.close();
        }
      }
    );

    console.log(`\nResumo da Bateria de Testes M-Pesa + ZaasPay: ${passed}/33 passaram, ${failed} falharam.`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (prevWebhookSecret === undefined) delete process.env.ZAASPAY_WEBHOOK_SECRET;
    else process.env.ZAASPAY_WEBHOOK_SECRET = prevWebhookSecret;
    if (prevZaasKey === undefined) delete process.env.ZAASPAY_KEY;
    else process.env.ZAASPAY_KEY = prevZaasKey;
    if (prevZaasUrl === undefined) delete process.env.ZAASPAY_API_URL;
    else process.env.ZAASPAY_API_URL = prevZaasUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runSuite().catch((err) => {
  console.error('Erro fatal na execução dos testes:', err);
  process.exit(1);
});
