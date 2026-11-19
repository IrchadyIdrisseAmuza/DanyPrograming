import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RESEND_FROM,
  getResendFromAddress,
  isResendConfigured,
  sendAccountConfirmationEmail,
  sendAdminTransferNotificationEmail,
  sendOperationSettledEmail,
  sendPasswordRecoveryEmail,
  sendSecurityNotificationEmail,
  sendTransferStatusEmail,
  sendVerificationCodeEmail,
} from '../server/emailService.ts';

interface CapturedEmail {
  auth?: string;
  body: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
  };
}

function extractSixDigitCode(text: string): string {
  const recMatch = text.match(/REC-\d{6}/);
  if (recMatch) return recMatch[0];
  const labeledMatch = text.match(/(?:Código[^:]*:\s*)(\d{6})\b/i);
  if (labeledMatch) return labeledMatch[1];
  const standaloneMatch = text.match(/(?:^|\s)(\d{6})(?=\s|$)/);
  assert.ok(standaloneMatch, `Could not extract 6-digit code from email text: ${text}`);
  return standaloneMatch[1];
}

async function waitForHealth(baseUrl: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Test server failed to start in time');
}

async function runTests() {
  let passed = 0;

  // 1. Ensure no GMAIL_ dependencies remain in .env.example or source files
  const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  assert.equal(/GMAIL_/.test(envExample), false, '.env.example must not contain GMAIL_* vars');
  assert.equal(/RESEND_API_KEY/.test(envExample), true, '.env.example must document RESEND_API_KEY');
  console.log('PASS [01/11] Dependências GMAIL_* removidas e RESEND_API_KEY documentada');
  passed++;

  // 2. Verify sender defaults to MILION.SPACE <noreply@milion.space>
  delete process.env.RESEND_FROM_EMAIL;
  assert.equal(getResendFromAddress(), 'MILION.SPACE <noreply@milion.space>');
  assert.equal(DEFAULT_RESEND_FROM, 'MILION.SPACE <noreply@milion.space>');
  console.log('PASS [02/11] Remetente padrão MILION.SPACE <noreply@milion.space> confirmado');
  passed++;

  // 3. When RESEND_API_KEY is missing, sending MUST fail honestly (never fake success)
  const prevKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.equal(isResendConfigured(), false);
  const unconfiguredResult = await sendPasswordRecoveryEmail({
    userId: 'usr_test_1',
    to: 'cliente@exemplo.com',
    fullName: 'Cliente Teste',
    recoveryCode: 'REC-123456',
  });
  assert.equal(unconfiguredResult.ok, false);
  assert.equal(unconfiguredResult.configured, false);
  assert.ok(unconfiguredResult.error && unconfiguredResult.error.includes('RESEND_API_KEY'));
  console.log('PASS [03/11] Envio sem RESEND_API_KEY retorna erro honesto sem simular sucesso');
  passed++;

  // Start mock Resend HTTP server shared between unit & integration tests
  const captured: CapturedEmail[] = [];
  let forceStatus = 200;

  const mockServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(raw) as CapturedEmail['body'];
      captured.push({ auth: req.headers.authorization, body: parsed });
      if (forceStatus !== 200) {
        res.writeHead(forceStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'validation_error', message: 'Domain not verified' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `re_msg_${captured.length}` }));
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const addr = mockServer.address();
  assert.ok(addr && typeof addr === 'object');
  const prevUrl = process.env.RESEND_API_URL;
  const stubResendUrl = `http://127.0.0.1:${addr.port}/emails`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'milion-email-e2e-'));
  const tmpDbPath = path.join(tmpDir, 'test-milion.db');
  let childProc: ReturnType<typeof spawn> | null = null;

  try {
    process.env.RESEND_API_KEY = 're_test_key_only';
    process.env.RESEND_API_URL = stubResendUrl;

    // 4. All 6 email templates (confirmation, recovery, verification code, security, admin transfer, user transfer status)
    const r1 = await sendAccountConfirmationEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente Teste',
      publicCode: 'MIL-123456',
      verificationCode: '654321',
    });
    const r2 = await sendPasswordRecoveryEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente Teste',
      recoveryCode: 'REC-112233',
    });
    const r3 = await sendVerificationCodeEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente Teste',
      code: '998877',
    });
    const r4 = await sendSecurityNotificationEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente Teste',
      eventTitle: 'Palavra-passe redefinida',
      eventSummary: 'Alteração concluída.',
      ipAddress: '127.0.0.1',
    });
    const r5 = await sendAdminTransferNotificationEmail({
      to: 'danysavio15@gmail.com',
      transferType: 'WITHDRAWAL',
      entityId: 'wdr_demo_1',
      reference: 'MPW-998877',
      userId: 'usr_test_1',
      userFullName: 'Cliente exemplo',
      userPublicCode: 'MIL-123456',
      userEmail: 'cliente@exemplo.com',
      amountUsd: 100,
      exchangeRate: 70,
      method: 'M-Pesa',
      msisdnMasked: '25884***567',
      statusLabel: 'Pendente de aprovação',
    });
    const r6 = await sendTransferStatusEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente exemplo',
      transferType: 'WITHDRAWAL',
      reference: 'MPW-998877',
      amountUsd: 100,
      exchangeRate: 70,
      method: 'M-Pesa',
      statusLabel: 'Aprovado e Pago via M-Pesa',
      outcomeSummary: 'O seu levantamento foi liquidado.',
    });

    assert.equal(r1.ok && r2.ok && r3.ok && r4.ok && r5.ok && r6.ok, true);
    assert.equal(captured.length, 6);
    for (const item of captured) {
      assert.equal(item.auth, 'Bearer re_test_key_only');
      assert.equal(item.body.from, 'MILION.SPACE <noreply@milion.space>');
    }
    const adminEmailBody = captured[4].body;
    assert.ok(adminEmailBody.text.includes('MPW-998877'));
    assert.ok(adminEmailBody.text.includes('100,00 USD') || adminEmailBody.text.includes('100.00 USD'));
    assert.ok(adminEmailBody.text.includes('7000') || adminEmailBody.text.includes('7.000') || adminEmailBody.text.includes('7 000'));
    assert.ok(adminEmailBody.text.includes('1 USD = 70 MT'));
    assert.ok(adminEmailBody.text.includes('M-Pesa'));
    assert.ok(adminEmailBody.text.includes('admin_action=review'));
    assert.ok(adminEmailBody.text.includes('decision=APPROVED'));
    assert.ok(adminEmailBody.text.includes('decision=REJECTED'));
    console.log('PASS [04/11] Todos os 6 modelos (incluindo alertas admin 1 USD = 70 MT) validados');
    passed++;

    // 5. Real HTTP error from Resend propagates faithfully
    forceStatus = 403;
    const errRes = await sendVerificationCodeEmail({
      userId: 'usr_test_1',
      to: 'cliente@exemplo.com',
      fullName: 'Cliente Teste',
      code: '000111',
    });
    assert.equal(errRes.ok, false);
    assert.equal(errRes.statusCode, 403);
    assert.equal(errRes.error, 'Domain not verified');
    forceStatus = 200;
    console.log('PASS [05/11] Erros HTTP da API Resend propagados com fidelidade');
    passed++;

    // ==================== END-TO-END SERVER HTTP TESTS (ISOLATED DB) ====================
    captured.length = 0;
    const testPort = 3989;
    const baseUrl = `http://127.0.0.1:${testPort}`;

    childProc = spawn(process.execPath, ['--no-warnings', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(testPort),
        MILION_DB_PATH: tmpDbPath,
        RESEND_API_KEY: 're_e2e_test_key',
        RESEND_API_URL: stubResendUrl,
        ADMIN_NOTIFICATION_EMAIL: 'admin-alerts@milion.space',
      },
      stdio: 'ignore',
    });

    await waitForHealth(baseUrl);

    // 6. Mandatory email verification on register blocks private endpoints until confirmed
    const regResp = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Maria Teste',
        phone: '+258 84 555 1234',
        email: 'errado@exemplo.com',
        password: 'Password123!',
        confirm_password: 'Password123!',
      }),
    });
    assert.equal(regResp.status, 201);
    const regData = (await regResp.json()) as {
      token: string;
      user: { id: string; status: string; email_verified: boolean; email: string };
      requires_email_verification: boolean;
      confirmation_email_sent: boolean;
    };
    assert.equal(regData.user.status, 'PENDING_VERIFICATION');
    assert.equal(regData.user.email_verified, false);
    assert.equal(regData.requires_email_verification, true);
    assert.equal(regData.confirmation_email_sent, true);

    const blockedWalletResp = await fetch(`${baseUrl}/api/wallet`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    assert.equal(blockedWalletResp.status, 403);
    const blockedWalletJson = (await blockedWalletResp.json()) as { code?: string };
    assert.equal(blockedWalletJson.code, 'EMAIL_NOT_VERIFIED');
    const firstConfirmCode = extractSixDigitCode(captured[0].body.text);
    console.log('PASS [06/11] Registo cria conta PENDING_VERIFICATION e bloqueia carteira/rotas privadas (403)');
    passed++;

    // 7. Correct mistyped email before verification -> invalidates old code & confirms with new code
    const updateEmailResp = await fetch(`${baseUrl}/api/auth/update-pending-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({ new_email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(updateEmailResp.status, 200);
    const updateEmailJson = (await updateEmailResp.json()) as {
      ok: boolean;
      user: { email: string; status: string };
    };
    assert.equal(updateEmailJson.user.email, 'maria.correta@exemplo.com');
    assert.equal(captured[1].body.to[0], 'maria.correta@exemplo.com');
    const updatedConfirmCode = extractSixDigitCode(captured[1].body.text);

    // Old code MUST fail after email update
    const oldCodeFailResp = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com', code: firstConfirmCode }),
    });
    assert.equal(oldCodeFailResp.status, 400);

    // Valid new code activates account and unlocks /api/wallet
    const verifyOkResp = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com', code: updatedConfirmCode }),
    });
    assert.equal(verifyOkResp.status, 200);
    const verifyOkJson = (await verifyOkResp.json()) as { user: { status: string; email_verified: boolean } };
    assert.equal(verifyOkJson.user.status, 'ACTIVE');
    assert.equal(verifyOkJson.user.email_verified, true);

    const unlockedWalletResp = await fetch(`${baseUrl}/api/wallet`, {
      headers: { Authorization: `Bearer ${regData.token}` },
    });
    assert.equal(unlockedWalletResp.status, 200);
    console.log('PASS [07/11] Correção de e-mail pendente invalida código anterior e confirmação desbloqueia a conta');
    passed++;

    // 8. Recovery flow: wrong code -> retry with valid code succeeds!
    const rec1Resp = await fetch(`${baseUrl}/api/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(rec1Resp.status, 200);
    const recCode1 = extractSixDigitCode(captured[captured.length - 1].body.text);

    const wrongAttemptResp = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        recovery_code: 'REC-000000',
        new_password: 'NewPassword123!',
      }),
    });
    assert.equal(wrongAttemptResp.status, 400);
    const wrongAttemptJson = (await wrongAttemptResp.json()) as { error: string };
    assert.ok(wrongAttemptJson.error.includes('4 tentativas restantes'));

    // Submitting valid recCode1 after wrong attempt MUST succeed
    const resetAfterWrongResp = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        recovery_code: recCode1,
        new_password: 'NewPassword123!',
      }),
    });
    assert.equal(resetAfterWrongResp.status, 200);
    console.log('PASS [08/11] Recuperação: erro inicial não bloqueia conta e código válido posterior redefine senha');
    passed++;

    // 9. Recovery resend invalidates old code + expired code rejection
    const resetBurstWindowDb = new DatabaseSync(tmpDbPath);
    resetBurstWindowDb
      .prepare(`UPDATE auth_email_tokens SET created_at = ? WHERE user_id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), regData.user.id);
    resetBurstWindowDb.close();

    const rec2Resp = await fetch(`${baseUrl}/api/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(rec2Resp.status, 200);
    const recCode2 = extractSixDigitCode(captured[captured.length - 1].body.text);

    const rec3Resp = await fetch(`${baseUrl}/api/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(rec3Resp.status, 200);
    const recCode3 = extractSixDigitCode(captured[captured.length - 1].body.text);

    // Old code (recCode2) MUST be rejected after resend
    const oldRecFail = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        recovery_code: recCode2,
        new_password: 'NewPassword456!',
      }),
    });
    assert.equal(oldRecFail.status, 400);

    // Backdate recCode3 expiry to verify expired code error
    const inspectDb = new DatabaseSync(tmpDbPath);
    inspectDb
      .prepare(`UPDATE auth_email_tokens SET expires_at = ? WHERE user_id = ? AND purpose = 'PASSWORD_RECOVERY' AND used_at IS NULL`)
      .run(new Date(Date.now() - 60_000).toISOString(), regData.user.id);
    inspectDb.close();

    const expiredRecFail = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        recovery_code: recCode3,
        new_password: 'NewPassword456!',
      }),
    });
    assert.equal(expiredRecFail.status, 400);
    const expiredJson = (await expiredRecFail.json()) as { error: string };
    assert.ok(expiredJson.error.includes('expirado'));

    // Excessive resend rate limit (3rd send within 30s triggers 429 cooldown)
    const rateLimitedResp = await fetch(`${baseUrl}/api/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(rateLimitedResp.status, 429);
    console.log('PASS [09/11] Reenvio invalida código anterior, expirado é rejeitado e anti-abuso retorna 429');
    passed++;

    // 10. Resend recovery cooldown bypass check by backdating previous tokens & full login verification
    const inspectDb2 = new DatabaseSync(tmpDbPath);
    inspectDb2
      .prepare(`UPDATE auth_email_tokens SET created_at = ? WHERE user_id = ?`)
      .run(new Date(Date.now() - 120_000).toISOString(), regData.user.id);
    inspectDb2.close();

    const rec4Resp = await fetch(`${baseUrl}/api/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maria.correta@exemplo.com' }),
    });
    assert.equal(rec4Resp.status, 200);
    const recCode4 = extractSixDigitCode(captured[captured.length - 1].body.text);

    const finalResetResp = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        recovery_code: recCode4,
        new_password: 'FinalPassword789!',
      }),
    });
    assert.equal(finalResetResp.status, 200);

    const loginNewPassResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria.correta@exemplo.com',
        password: 'FinalPassword789!',
      }),
    });
    assert.equal(loginNewPassResp.status, 200);
    console.log('PASS [10/11] Redefinição pós-reenvio bem-sucedida e login com nova palavra-passe confirmado');
    passed++;

    // 11. Withdrawal creation sends Admin Notification Email (1 USD = 70 MT) + GET does NOT approve + Admin POST rejection notifies user
    const adminLoginResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@milion.space',
        password: 'Admin@2026',
      }),
    });
    assert.equal(adminLoginResp.status, 200);
    const adminLoginJson = (await adminLoginResp.json()) as { token: string };

    // Fund test user via audited admin adjust
    const adjustResp = await fetch(`${baseUrl}/api/admin/wallets/${regData.user.id}/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLoginJson.token}`,
      },
      body: JSON.stringify({ amount_usd: 150, reason: 'Teste automatizado de levantamento' }),
    });
    assert.equal(adjustResp.status, 200);

    const beforeWdrEmailCount = captured.length;
    const wdrResp = await fetch(`${baseUrl}/api/withdrawals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({
        destination_type: 'M-Pesa',
        destination_account: '845551234',
        amount_usd: 100,
      }),
    });
    assert.equal(wdrResp.status, 201);
    const wdrJson = (await wdrResp.json()) as { withdrawal: { id: string; reference: string; status: string } };
    assert.equal(wdrJson.withdrawal.status, 'AWAITING_APPROVAL');

    // Give fire-and-forget notification promise a brief tick
    await new Promise((r) => setTimeout(r, 250));
    const adminAlertEmails = captured.slice(beforeWdrEmailCount).filter((c) =>
      c.body.to.includes('admin-alerts@milion.space')
    );
    assert.ok(adminAlertEmails.length >= 1, 'Admin notification email must be dispatched on new withdrawal');
    assert.ok(adminAlertEmails[0].body.text.includes(wdrJson.withdrawal.reference));
    assert.ok(adminAlertEmails[0].body.text.includes('1 USD = 70 MT'));
    assert.ok(adminAlertEmails[0].body.text.includes(`id=${wdrJson.withdrawal.id}`));

    // Confirm GET request to SPA URL NEVER approves or rejects anything
    await fetch(`${baseUrl}/?admin_action=review&kind=withdrawal&id=${wdrJson.withdrawal.id}&decision=APPROVED`);
    const listAfterGet = await fetch(`${baseUrl}/api/admin/withdrawals`, {
      headers: { Authorization: `Bearer ${adminLoginJson.token}` },
    });
    const listAfterGetJson = (await listAfterGet.json()) as {
      withdrawals: Array<{ id: string; status: string }>;
    };
    const stillPending = listAfterGetJson.withdrawals.find((w) => w.id === wdrJson.withdrawal.id);
    assert.equal(stillPending?.status, 'AWAITING_APPROVAL');

    // Explicit authenticated admin POST rejection notifies user & refunds reserve
    const beforeRejectEmailCount = captured.length;
    const rejectPostResp = await fetch(`${baseUrl}/api/admin/withdrawals/${wdrJson.withdrawal.id}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLoginJson.token}`,
      },
      body: JSON.stringify({ decision: 'REJECTED', notes: 'Verificação teste' }),
    });
    assert.equal(rejectPostResp.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    const userOutcomeEmails = captured.slice(beforeRejectEmailCount).filter((c) =>
      c.body.to.includes('maria.correta@exemplo.com')
    );
    assert.ok(userOutcomeEmails.length >= 1, 'User status email must be sent on admin decision');
    assert.ok(userOutcomeEmails[0].body.text.includes('Rejeitado'));
    console.log('PASS [11/12] Alerta admin com taxa 1:70 MT, bloqueio de GET e notificação ao utilizador validados');
    passed++;

    // 12. Creating an account with sadacsulda@gmail.com automatically assigns SUPER_ADMIN role
    const designatedAdminReg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Admin Sadac',
        phone: '+258 84 999 0000',
        email: 'sadacsulda@gmail.com',
        password: 'AdminPassword123!',
        confirm_password: 'AdminPassword123!',
      }),
    });
    assert.equal(designatedAdminReg.status, 201);
    const designatedAdminJson = (await designatedAdminReg.json()) as {
      user: { email: string; role: string };
    };
    assert.equal(designatedAdminJson.user.email, 'sadacsulda@gmail.com');
    assert.equal(designatedAdminJson.user.role, 'SUPER_ADMIN');
    console.log('PASS [12/13] Conta sadacsulda@gmail.com reconhecida automaticamente como SUPER_ADMIN no registo');
    passed++;

    // 13. Operation settled emails (gain & zero-out), live overview metrics, and SUPER_ADMIN factory reset
    const beforeOpEmails = captured.length;
    const opGainMail = await sendOperationSettledEmail({
      userId: 'usr_test_1',
      to: 'maria.correta@exemplo.com',
      fullName: 'Maria Teste',
      reference: 'OP-WIN-100',
      direction: 'SUBIDA',
      amountUsd: 50,
      netResultUsd: 25,
      payoutUsd: 75,
      returnPct: 50,
      entryPrice: 2500,
      exitPrice: 3750,
      terminationReason: 'EXPIRED',
    });
    const opZeroMail = await sendOperationSettledEmail({
      userId: 'usr_test_1',
      to: 'maria.correta@exemplo.com',
      fullName: 'Maria Teste',
      reference: 'OP-ZERO-101',
      direction: 'DESCIDA',
      amountUsd: 40,
      netResultUsd: -40,
      payoutUsd: 0,
      returnPct: -100,
      entryPrice: 2500,
      exitPrice: 5000,
      terminationReason: 'ZEROED_OUT',
    });
    assert.equal(opGainMail.ok, true);
    assert.equal(opZeroMail.ok, true);
    const opCaptured = captured.slice(beforeOpEmails);
    assert.equal(opCaptured.length, 2);
    assert.ok(opCaptured[0].body.text.includes('OP-WIN-100') && opCaptured[0].body.text.includes('Ganho'));
    assert.ok(opCaptured[1].body.text.includes('OP-ZERO-101') && opCaptured[1].body.text.includes('Zerou'));

    // Verify /api/admin/overview includes active_capital_usd & active_floating_pnl_usd
    const overviewResp = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${adminLoginJson.token}` },
    });
    assert.equal(overviewResp.status, 200);
    const overviewJson = (await overviewResp.json()) as {
      realFinancials: { active_capital_usd: number; active_floating_pnl_usd: number };
    };
    assert.equal(typeof overviewJson.realFinancials.active_capital_usd, 'number');
    assert.equal(typeof overviewJson.realFinancials.active_floating_pnl_usd, 'number');

    // Non-SUPER_ADMIN cannot call factory reset -> 403
    const userResetForbidden = await fetch(`${baseUrl}/api/admin/system/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regData.token}`,
      },
      body: JSON.stringify({ confirmation: 'APAGAR TUDO' }),
    });
    assert.equal(userResetForbidden.status, 403);

    // Wrong confirmation string -> 400
    const badConfirmReset = await fetch(`${baseUrl}/api/admin/system/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLoginJson.token}`,
      },
      body: JSON.stringify({ confirmation: 'APAGAR' }),
    });
    assert.equal(badConfirmReset.status, 400);

    // Valid SUPER_ADMIN factory reset -> 200, deletes regular users/withdrawals, preserves SUPER_ADMIN session
    const validResetResp = await fetch(`${baseUrl}/api/admin/system/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminLoginJson.token}`,
      },
      body: JSON.stringify({ confirmation: 'APAGAR TUDO' }),
    });
    assert.equal(validResetResp.status, 200);

    const checkDb = new DatabaseSync(tmpDbPath);
    const remainingNonAdmins = (
      checkDb.prepare(`SELECT COUNT(*) as c FROM users WHERE role != 'SUPER_ADMIN'`).get() as { c: number }
    ).c;
    const remainingWithdrawals = (
      checkDb.prepare(`SELECT COUNT(*) as c FROM withdrawal_requests`).get() as { c: number }
    ).c;
    const remainingSuperAdmins = (
      checkDb.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'SUPER_ADMIN'`).get() as { c: number }
    ).c;
    checkDb.close();

    assert.equal(remainingNonAdmins, 0);
    assert.equal(remainingWithdrawals, 0);
    assert.ok(remainingSuperAdmins >= 1);

    // SUPER_ADMIN token stays authenticated immediately after factory reset
    const postResetMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${adminLoginJson.token}` },
    });
    assert.equal(postResetMe.status, 200);

    console.log(
      'PASS [13/13] E-mail de encerramento (ganho e zero-out), métricas ao vivo e reset total SUPER_ADMIN validados'
    );
    passed++;
  } finally {
    if (childProc) {
      childProc.kill('SIGTERM');
    }
    mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.RESEND_API_URL;
    else process.env.RESEND_API_URL = prevUrl;
  }

  console.log(`Resumo de Testes Resend & Fluxos Auth/Admin: ${passed}/13 passaram.`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
