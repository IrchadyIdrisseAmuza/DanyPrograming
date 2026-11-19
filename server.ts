import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { WebSocketServer, WebSocket } from 'ws';
import {
  db,
  generateId,
  generatePublicCode,
  generateReference,
  getPlatformSettings,
  hashPassword,
  initDatabase,
  logAudit,
  verifyPassword,
  withTransaction,
  type MarketControlMode,
} from './server/db.ts';
import {
  createSessionToken,
  getUserFromToken,
  requireAdmin,
  requireAuth,
  requireAuthAllowPending,
  requireSuperAdmin,
  revokeSessionToken,
  type AuthenticatedRequest,
  type AuthUser,
} from './server/auth.ts';
import { MarketEngine, type SettledOperationEvent } from './server/marketEngine.ts';
import {
  getZaasPayConfig,
  zaaspayGateway,
} from './server/zaaspay.ts';
import {
  PaymentService,
  PaymentServiceError,
  sanitizeDepositRow,
  sanitizeWithdrawalRow,
  type SanitizedDepositRow,
  type SanitizedWithdrawalRow,
} from './server/paymentService.ts';
import {
  isResendConfigured,
  sendAccountConfirmationEmail,
  sendAdminTransferNotificationEmail,
  sendOperationSettledEmail,
  sendPasswordRecoveryEmail,
  sendSecurityNotificationEmail,
  sendTransferStatusEmail,
  sendVerificationCodeEmail,
} from './server/emailService.ts';

const PORT = Number(process.env.PORT || 3000);
const DESIGNATED_ADMIN_EMAIL = 'danysavio15@gmail.com';
const DESIGNATED_ADMIN_EMAILS = new Set<string>([
  DESIGNATED_ADMIN_EMAIL,
  'sadacsulda@gmail.com',
]);

function isDesignatedAdminEmail(email: string): boolean {
  return DESIGNATED_ADMIN_EMAILS.has((email || '').trim().toLowerCase());
}

function resolveFirebaseProjectId(): string {
  const envProjectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (envProjectId) return envProjectId;
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectId?: string };
      if (parsed.projectId?.trim()) return parsed.projectId.trim();
    }
  } catch {
    // Fall back to configured project ID
  }
  return 'milion-space-774d4';
}

const FIREBASE_PROJECT_ID = resolveFirebaseProjectId();

initDatabase();
for (const adminEmail of DESIGNATED_ADMIN_EMAILS) {
  db.prepare(`UPDATE users SET role = 'SUPER_ADMIN' WHERE LOWER(email) = ? AND role != 'SUPER_ADMIN'`).run(
    adminEmail
  );
}

const paymentService = new PaymentService({
  db,
  gateway: zaaspayGateway,
});

// Simple sliding-window rate limiter for payment & webhook endpoints
function createRateLimiter(maxHits: number, windowMs: number) {
  const buckets = new Map<string, number[]>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    const key = authReq.user?.id || req.ip || 'anon';
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((ts) => now - ts < windowMs);
    if (hits.length >= maxHits) {
      res.status(429).json({ error: 'Muitas tentativas em sequência. Aguarde alguns segundos antes de tentar novamente.' });
      return;
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

const paymentRateLimit = createRateLimiter(12, 60_000);
const webhookRateLimit = createRateLimiter(60, 60_000);
const authRateLimit = createRateLimiter(25, 60_000);

function isValidEmailAddress(email: string): boolean {
  if (!email || email.length > 254 || email.includes('..')) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

type EmailTokenPurpose = 'ACCOUNT_CONFIRMATION' | 'PASSWORD_RECOVERY' | 'VERIFICATION_CODE';

function normalizeEmailCode(purpose: EmailTokenPurpose, rawCode: string): string {
  const clean = (rawCode || '').trim().toUpperCase();
  if (purpose === 'PASSWORD_RECOVERY' && /^[0-9]{6}$/.test(clean)) {
    return `REC-${clean}`;
  }
  return clean;
}

function hashEmailCode(userId: string, purpose: EmailTokenPurpose, rawCode: string): string {
  return crypto
    .createHash('sha256')
    .update(`${userId}:${purpose}:${normalizeEmailCode(purpose, rawCode)}`)
    .digest('hex');
}

function getRelatedPurposes(purpose: EmailTokenPurpose): EmailTokenPurpose[] {
  if (purpose === 'PASSWORD_RECOVERY') return ['PASSWORD_RECOVERY'];
  return ['ACCOUNT_CONFIRMATION', 'VERIFICATION_CODE'];
}

function checkEmailResendAllowed(
  userId: string,
  purposes: EmailTokenPurpose[]
): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const windowStartIso = new Date(now - 15 * 60_000).toISOString();
  const burstStartIso = new Date(now - 60_000).toISOString();
  const placeholders = purposes.map(() => '?').join(', ');

  const recentRows = db
    .prepare(
      `SELECT created_at FROM auth_email_tokens
       WHERE user_id = ? AND purpose IN (${placeholders}) AND created_at >= ? AND attempts >= 0
       ORDER BY created_at DESC`
    )
    .all(userId, ...purposes, windowStartIso) as Array<{ created_at: string }>;

  if (recentRows.length >= 5) {
    return {
      ok: false,
      error: 'Limite de reenvios atingido (máx. 5 códigos em 15 minutos). Aguarde antes de solicitar um novo código.',
    };
  }

  const lastMinute = recentRows.filter((r) => r.created_at >= burstStartIso);
  if (lastMinute.length >= 2) {
    const newestMs = new Date(lastMinute[0].created_at).getTime();
    const waitSec = Math.max(1, Math.ceil((newestMs + 30_000 - now) / 1000));
    if (now - newestMs < 30_000) {
      return {
        ok: false,
        error: `Aguarde ${waitSec}s antes de reenviar outro código.`,
      };
    }
  }

  return { ok: true };
}

function issueEmailToken(
  userId: string,
  purpose: EmailTokenPurpose,
  ttlMinutes: number
): { tokenId: string; code: string } {
  const code =
    purpose === 'PASSWORD_RECOVERY'
      ? `REC-${crypto.randomInt(100000, 999999)}`
      : String(crypto.randomInt(100000, 999999));
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const codeHash = hashEmailCode(userId, purpose, code);
  const tokenId = generateId('emtok');
  const related = getRelatedPurposes(purpose);
  const placeholders = related.map(() => '?').join(', ');

  withTransaction(() => {
    db.prepare(
      `UPDATE auth_email_tokens SET used_at = ?
       WHERE user_id = ? AND purpose IN (${placeholders}) AND used_at IS NULL`
    ).run(nowIso, userId, ...related);

    db.prepare(
      `INSERT INTO auth_email_tokens (id, user_id, purpose, code_hash, expires_at, used_at, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`
    ).run(tokenId, userId, purpose, codeHash, expiresIso, nowIso);
  });

  return { tokenId, code };
}

function invalidateFailedEmailToken(tokenId: string) {
  db.prepare(`UPDATE auth_email_tokens SET used_at = ?, attempts = -1 WHERE id = ?`).run(
    new Date().toISOString(),
    tokenId
  );
}

function verifyAndConsumeEmailToken(
  userId: string,
  purposes: EmailTokenPurpose[],
  submittedCode: string
): { ok: true; purpose: EmailTokenPurpose } | { ok: false; error: string } {
  const cleanCode = (submittedCode || '').trim().toUpperCase();
  if (!cleanCode) {
    return { ok: false, error: 'Introduza o código de verificação.' };
  }
  const placeholders = purposes.map(() => '?').join(', ');
  const tokenRow = db
    .prepare(
      `SELECT id, purpose, code_hash, expires_at, attempts
       FROM auth_email_tokens
       WHERE user_id = ? AND purpose IN (${placeholders}) AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId, ...purposes) as
    | {
        id: string;
        purpose: EmailTokenPurpose;
        code_hash: string;
        expires_at: string;
        attempts: number;
      }
    | undefined;

  if (!tokenRow) {
    return { ok: false, error: 'Código inválido ou inexistente. Solicite um novo código.' };
  }
  const maxAttempts = 5;
  if (tokenRow.attempts >= maxAttempts) {
    return { ok: false, error: 'Número máximo de tentativas excedido. Clique em "Reenviar código" para obter um novo.' };
  }
  if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: 'Código expirado. Clique em "Reenviar código" para obter um novo.' };
  }

  const expectedHash = hashEmailCode(userId, tokenRow.purpose, cleanCode);
  const a = Buffer.from(tokenRow.code_hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const nextAttempts = tokenRow.attempts + 1;
    db.prepare(`UPDATE auth_email_tokens SET attempts = ? WHERE id = ?`).run(nextAttempts, tokenRow.id);
    const remaining = Math.max(0, maxAttempts - nextAttempts);
    return {
      ok: false,
      error:
        remaining > 0
          ? `Código incorreto. Verifique o e-mail e tente novamente (${remaining} ${remaining === 1 ? 'tentativa restante' : 'tentativas restantes'}).`
          : 'Número máximo de tentativas excedido. Clique em "Reenviar código" para obter um novo.',
    };
  }

  db.prepare(`UPDATE auth_email_tokens SET used_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    tokenRow.id
  );
  return { ok: true, purpose: tokenRow.purpose };
}

function getAdminNotificationRecipients(): string[] {
  const recipients = new Set<string>();
  const envAdmin = process.env.ADMIN_NOTIFICATION_EMAIL?.trim().toLowerCase();
  if (envAdmin && isValidEmailAddress(envAdmin)) {
    recipients.add(envAdmin);
  }
  recipients.add(DESIGNATED_ADMIN_EMAIL);

  const dbAdmins = db
    .prepare(`SELECT email FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND status = 'ACTIVE'`)
    .all() as Array<{ email: string }>;
  for (const row of dbAdmins) {
    const em = (row.email || '').trim().toLowerCase();
    if (isValidEmailAddress(em) && em !== 'admin@milion.space') {
      recipients.add(em);
    }
  }
  return Array.from(recipients);
}

async function notifyAdminsAboutDeposit(deposit: SanitizedDepositRow, actor: AuthUser) {
  const settings = getPlatformSettings();
  const recipients = getAdminNotificationRecipients();
  const statusLabel =
    deposit.status === 'CREDITED' || deposit.status === 'APPROVED'
      ? 'Creditado automaticamente'
      : 'Pendente de confirmação M-Pesa';

  await Promise.allSettled(
    recipients.map((to) =>
      sendAdminTransferNotificationEmail({
        to,
        transferType: 'DEPOSIT',
        entityId: deposit.id,
        reference: deposit.reference,
        userId: actor.id,
        userFullName: actor.full_name,
        userPublicCode: actor.public_code,
        userEmail: actor.email,
        amountUsd: deposit.amount_usd,
        amountMt: deposit.amount_mt,
        exchangeRate: deposit.exchange_rate_used || settings.usd_to_mt_rate || 70,
        method: deposit.method || 'M-Pesa',
        msisdnMasked: deposit.msisdn_masked || null,
        statusLabel,
        createdAtIso: deposit.created_at,
      })
    )
  );
}

async function notifyAdminsAboutWithdrawal(withdrawal: SanitizedWithdrawalRow, actor: AuthUser) {
  const settings = getPlatformSettings();
  const recipients = getAdminNotificationRecipients();
  await Promise.allSettled(
    recipients.map((to) =>
      sendAdminTransferNotificationEmail({
        to,
        transferType: 'WITHDRAWAL',
        entityId: withdrawal.id,
        reference: withdrawal.reference,
        userId: actor.id,
        userFullName: actor.full_name,
        userPublicCode: actor.public_code,
        userEmail: actor.email,
        amountUsd: withdrawal.amount_usd,
        amountMt: withdrawal.amount_mt,
        exchangeRate: withdrawal.exchange_rate_used || settings.usd_to_mt_rate || 70,
        method: withdrawal.destination_type || 'M-Pesa',
        msisdnMasked: withdrawal.msisdn_masked || withdrawal.destination_account,
        statusLabel: 'Pendente de aprovação',
        riskScore: withdrawal.risk_score,
        riskFlags: withdrawal.risk_flags,
        createdAtIso: withdrawal.created_at,
      })
    )
  );
}

async function notifyUserAboutDepositOutcome(depositId: string) {
  const row = db
    .prepare(
      `SELECT d.*, u.full_name, u.email
       FROM deposit_requests d
       JOIN users u ON u.id = d.user_id
       WHERE d.id = ?`
    )
    .get(depositId) as Record<string, unknown> | undefined;
  if (!row || !row.email) return;
  const status = String(row.status);
  if (!['CREDITED', 'APPROVED', 'REJECTED', 'FAILED', 'EXPIRED'].includes(status)) return;

  const isSuccess = status === 'CREDITED' || status === 'APPROVED';
  const statusLabel = isSuccess
    ? 'Aprovado e Creditado'
    : status === 'REJECTED'
      ? 'Rejeitado'
      : status === 'EXPIRED'
        ? 'Expirado'
        : 'Falhado';
  const outcomeSummary = isSuccess
    ? 'O seu depósito foi confirmado e o valor já se encontra disponível na sua carteira MILION.SPACE.'
    : 'O seu pedido de depósito não foi concluído. Nenhum valor foi perdido na sua carteira.';

  await sendTransferStatusEmail({
    userId: String(row.user_id),
    to: String(row.email),
    fullName: String(row.full_name || 'Cliente'),
    transferType: 'DEPOSIT',
    reference: String(row.reference),
    amountUsd: Number(row.amount_usd),
    amountMt: Number(row.amount_mt),
    exchangeRate: Number(row.exchange_rate_used || 70),
    method: String(row.method || 'M-Pesa'),
    statusLabel,
    outcomeSummary,
    notes: typeof row.notes === 'string' ? row.notes : null,
  });
}

async function notifyUserAboutWithdrawalOutcome(withdrawalId: string) {
  const row = db
    .prepare(
      `SELECT w.*, u.full_name, u.email
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       WHERE w.id = ?`
    )
    .get(withdrawalId) as Record<string, unknown> | undefined;
  if (!row || !row.email) return;
  const status = String(row.status);
  if (!['PAID', 'APPROVED', 'DISBURSEMENT_PENDING', 'REJECTED', 'FAILED'].includes(status)) return;

  const statusLabel =
    status === 'PAID'
      ? 'Aprovado e Pago via M-Pesa'
      : status === 'APPROVED' || status === 'DISBURSEMENT_PENDING'
        ? 'Aprovado · Desembolso em processamento'
        : status === 'REJECTED'
          ? 'Rejeitado (Saldo devolvido)'
          : 'Falhado (Saldo devolvido)';
  const outcomeSummary =
    status === 'PAID'
      ? 'O seu levantamento foi aprovado pela administração e liquidado via M-Pesa.'
      : status === 'APPROVED' || status === 'DISBURSEMENT_PENDING'
        ? 'O seu pedido de levantamento foi aprovado pela administração e encontra-se em fila de desembolso M-Pesa.'
        : 'O seu pedido de levantamento foi rejeitado ou não pôde ser concluído. O saldo reservado foi devolvido à sua carteira disponível.';

  await sendTransferStatusEmail({
    userId: String(row.user_id),
    to: String(row.email),
    fullName: String(row.full_name || 'Cliente'),
    transferType: 'WITHDRAWAL',
    reference: String(row.reference),
    amountUsd: Number(row.amount_usd),
    amountMt: Number(row.amount_mt),
    exchangeRate: Number(row.exchange_rate_used || 70),
    method: String(row.destination_type || 'M-Pesa'),
    statusLabel,
    outcomeSummary,
    notes: typeof row.notes === 'string' ? row.notes : null,
  });
}

const app = express();
app.set('trust proxy', 1);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://million.space',
  'https://www.million.space',
  'https://milion.space',
  'https://www.milion.space',
];
const envCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const appUrlOrigin = process.env.APP_URL?.trim();
const allowedOriginsSet = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...envCorsOrigins,
  ...(appUrlOrigin ? [appUrlOrigin.replace(/\/$/, '')] : []),
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const normalizedOrigin = origin.replace(/\/$/, '');
    const isLocalOrigin =
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalizedOrigin);
    const isAiStudioRunApp =
      /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/i.test(normalizedOrigin);
    if (allowedOriginsSet.has(normalizedOrigin) || isLocalOrigin || isAiStudioRunApp) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastWs(event: string, payload: unknown) {
  const message = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function computeLiveOperationMetrics(
  op: {
    direction: 'SUBIDA' | 'DESCIDA';
    amount_usd: number;
    entry_price: number;
    expires_at: string;
    duration_seconds: number;
  },
  currentPrice: number,
  multiplier: number,
  nowMs: number
) {
  const pct = op.entry_price > 0 ? (currentPrice - op.entry_price) / op.entry_price : 0;
  const signed = op.direction === 'SUBIDA' ? pct : -pct;
  const boundedReturn = Math.max(-1.0, signed * multiplier);
  const floatingPnlUsd = Number((op.amount_usd * boundedReturn).toFixed(2));
  const floatingValueUsd = Math.max(0, Number((op.amount_usd + floatingPnlUsd).toFixed(2)));
  const floatingReturnPct = Number((boundedReturn * 100).toFixed(2));
  const remainingSeconds = Math.max(
    0,
    Math.floor((new Date(op.expires_at).getTime() - nowMs) / 1000)
  );
  return {
    floating_pnl_usd: floatingPnlUsd,
    floating_return_pct: floatingReturnPct,
    floating_value_usd: floatingValueUsd,
    current_price: currentPrice,
    remaining_seconds: remainingSeconds,
  };
}

const marketEngine = new MarketEngine(broadcastWs, {
  onOperationSettled: (evt: SettledOperationEvent) => {
    try {
      const row = db
        .prepare(`SELECT email, full_name FROM users WHERE id = ?`)
        .get(evt.userId) as { email?: string; full_name?: string } | undefined;
      if (!row?.email) return;
      void sendOperationSettledEmail({
        userId: evt.userId,
        to: row.email,
        fullName: row.full_name || 'Investidor',
        reference: evt.reference,
        direction: evt.direction,
        amountUsd: evt.amountUsd,
        payoutUsd: evt.payout,
        netResultUsd: evt.netResult,
        returnPct: evt.returnPct,
        entryPrice: evt.entryPrice,
        exitPrice: evt.exitPrice,
        terminationReason: evt.terminationReason,
      });
    } catch (err) {
      console.error('[MarketEngine] Falha ao enviar e-mail de liquidação de operação:', err);
    }
  },
});
marketEngine.init();

wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      event: 'market:init',
      payload: marketEngine.getGlobalMarketSnapshot(120),
    })
  );
});

// ==================== HEALTH & PUBLIC MARKET ====================

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'MILION.SPACE', timestamp: new Date().toISOString() });
});

app.get('/api/market/state', (_req, res) => {
  res.json(marketEngine.getGlobalMarketSnapshot(160));
});

app.get('/api/market/sessions', (_req, res) => {
  const sessions = db
    .prepare(`SELECT * FROM market_sessions ORDER BY session_number DESC LIMIT 20`)
    .all();
  res.json({ sessions });
});

// ==================== AUTHENTICATION ====================

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const { full_name, phone, email, password, confirm_password } = req.body as {
    full_name?: string;
    phone?: string;
    email?: string;
    password?: string;
    confirm_password?: string;
  };

  const cleanName = (full_name || '').trim();
  const cleanPhone = (phone || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (cleanName.length < 3) {
    res.status(400).json({ error: 'Indique o nome completo (mínimo 3 caracteres).' });
    return;
  }
  if (cleanPhone.length < 7) {
    res.status(400).json({ error: 'Indique um número M-Pesa válido.' });
    return;
  }
  if (!isValidEmailAddress(cleanEmail)) {
    res.status(400).json({
      error: 'Indique um endereço de e-mail válido (ex.: nome@dominio.com).',
    });
    return;
  }

  const emailDomain = cleanEmail.split('@')[1];
  try {
    const mx = await dns.resolveMx(emailDomain);
    if (!mx || mx.length === 0) {
      res.status(400).json({ error: 'O domínio de e-mail indicado não possui registo MX válido.' });
      return;
    }
  } catch {
    // Allow if sandbox DNS is restricted while preserving syntax validation
  }

  if (!password || password.length < 6) {
    res.status(400).json({ error: 'A palavra-passe deve ter pelo menos 6 caracteres.' });
    return;
  }
  if (password !== confirm_password) {
    res.status(400).json({ error: 'As palavras-passe não coincidem.' });
    return;
  }

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
  if (existing) {
    res.status(409).json({ error: 'Este e-mail já se encontra registado.' });
    return;
  }

  const now = new Date().toISOString();
  const userId = generateId('usr');
  const publicCode = generatePublicCode();
  const baseUsername = cleanEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 14) || 'user';
  const username = `${baseUsername}_${crypto.randomInt(100, 999)}`;
  const initialBalance = 0.0;
  const assignedRole = isDesignatedAdminEmail(cleanEmail) ? 'SUPER_ADMIN' : 'USER';

  withTransaction(() => {
    db.prepare(
      `INSERT INTO users (id, public_code, full_name, username, phone, email, password_hash, role, status, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_VERIFICATION', 0, ?, ?)`
    ).run(
      userId,
      publicCode,
      cleanName,
      username,
      cleanPhone,
      cleanEmail,
      hashPassword(password),
      assignedRole,
      now,
      now
    );

    db.prepare(
      `INSERT INTO wallets (user_id, available_balance, locked_balance, pending_balance, updated_at)
       VALUES (?, ?, 0, 0, ?)`
    ).run(userId, initialBalance, now);

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
       VALUES (?, ?, ?, ?, 'INFO', 0, ?)`
    ).run(
      generateId('ntf'),
      userId,
      'Conta criada na MILION.SPACE',
      `O seu código público é ${publicCode}. Confirme o seu endereço de e-mail para desbloquear a carteira digital.`,
      now
    );

    logAudit({
      actorId: userId,
      actorEmail: cleanEmail,
      actorRole: assignedRole,
      action: 'USER_REGISTERED',
      entityType: 'USER',
      entityId: userId,
      details: { public_code: publicCode, role: assignedRole, status: 'PENDING_VERIFICATION' },
    });
  });

  const userRow = db
    .prepare(
      `SELECT id, public_code, full_name, username, phone, email, role, status, COALESCE(email_verified, 0) as email_verified, created_at FROM users WHERE id = ?`
    )
    .get(userId) as {
    id: string;
    public_code: string;
    full_name: string;
    username: string;
    phone: string;
    email: string;
    role: string;
    status: string;
    email_verified: number;
    created_at: string;
  };
  const token = createSessionToken(userId);
  const issued = issueEmailToken(userId, 'ACCOUNT_CONFIRMATION', 30);
  const confirmationEmail = await sendAccountConfirmationEmail({
    userId,
    to: cleanEmail,
    fullName: cleanName,
    publicCode,
    verificationCode: issued.code,
    expiresMinutes: 30,
  });

  if (!confirmationEmail.ok) {
    invalidateFailedEmailToken(issued.tokenId);
  }

  res.status(201).json({
    token,
    user: {
      ...userRow,
      email_verified: Boolean(userRow.email_verified),
    },
    requires_email_verification: true,
    confirmation_email_sent: confirmationEmail.ok,
    confirmation_email_error: confirmationEmail.ok ? null : confirmationEmail.error || null,
  });
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !password) {
    res.status(400).json({ error: 'Informe o e-mail e a palavra-passe.' });
    return;
  }

  const userRow = db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .get(cleanEmail) as
    | {
        id: string;
        public_code: string;
        full_name: string;
        username: string;
        phone: string;
        email: string;
        password_hash: string;
        role: string;
        status: string;
        created_at: string;
      }
    | undefined;

  if (!userRow || !verifyPassword(password, userRow.password_hash)) {
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }

  if (userRow.status === 'SUSPENDED') {
    res.status(403).json({ error: 'Esta conta encontra-se suspensa. Contacte o suporte.' });
    return;
  }

  let effectiveRole = userRow.role;
  if (isDesignatedAdminEmail(cleanEmail) && effectiveRole !== 'SUPER_ADMIN') {
    effectiveRole = 'SUPER_ADMIN';
    db.prepare(`UPDATE users SET role = 'SUPER_ADMIN', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      userRow.id
    );
  }

  const token = createSessionToken(userRow.id);
  logAudit({
    actorId: userRow.id,
    actorEmail: userRow.email,
    actorRole: effectiveRole,
    action: 'USER_LOGIN',
    entityType: 'USER',
    entityId: userRow.id,
    details: { method: 'password' },
  });

  if (isResendConfigured() && userRow.status === 'ACTIVE') {
    void sendSecurityNotificationEmail({
      userId: userRow.id,
      to: userRow.email,
      fullName: userRow.full_name,
      eventTitle: 'Novo início de sessão na sua conta',
      eventSummary: 'Foi realizado um acesso à sua conta MILION.SPACE utilizando e-mail e palavra-passe.',
      ipAddress: req.ip,
    });
  }

  res.json({
    token,
    requires_email_verification: userRow.status === 'PENDING_VERIFICATION',
    user: {
      id: userRow.id,
      public_code: userRow.public_code,
      full_name: userRow.full_name,
      username: userRow.username,
      phone: userRow.phone,
      email: userRow.email,
      role: effectiveRole,
      status: userRow.status,
      email_verified: Boolean((userRow as { email_verified?: number }).email_verified),
      created_at: userRow.created_at,
    },
  });
});

let cachedGoogleCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getGoogleSecureTokenCerts(): Promise<Record<string, string>> {
  if (cachedGoogleCerts && Date.now() < cachedGoogleCerts.expiresAt) {
    return cachedGoogleCerts.certs;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error('Não foi possível obter os certificados públicos da Firebase.');
  }
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  const certs = (await resp.json()) as Record<string, string>;
  cachedGoogleCerts = {
    certs,
    expiresAt: Date.now() + Math.max(60, maxAgeSec - 30) * 1000,
  };
  return certs;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(padded, 'base64');
  return JSON.parse(buf.toString('utf8')) as T;
}

async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  name: string;
  email_verified: boolean;
}> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Token Firebase inválido.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = decodeBase64UrlJson<{
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  }>(payloadB64);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Cabeçalho de token Firebase inválido.');
  }

  const certs = await getGoogleSecureTokenCerts();
  const cert = certs[header.kid];
  if (!cert) {
    throw new Error('Certificado de assinatura Firebase não encontrado.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const sigBuf = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!verifier.verify(cert, sigBuf)) {
    throw new Error('Assinatura do token Firebase inválida.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID) {
    throw new Error('Projeto Firebase inválido no token.');
  }
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new Error('Emissor Firebase inválido no token.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Sessão Google expirada. Tente novamente.');
  }
  if (!payload.iat || payload.iat > nowSec + 300) {
    throw new Error('Token Firebase com timestamp inválido.');
  }
  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('A conta Google precisa de ter um e-mail verificado.');
  }

  return {
    uid: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: (payload.name || payload.email.split('@')[0]).trim(),
    email_verified: true,
  };
}

app.post('/api/auth/firebase-google', authRateLimit, async (req, res) => {
  const { id_token, phone } = req.body as { id_token?: string; phone?: string };
  if (!id_token || typeof id_token !== 'string') {
    res.status(400).json({ error: 'Token Google inválido.' });
    return;
  }

  try {
    const verified = await verifyFirebaseIdToken(id_token);
    if (!isValidEmailAddress(verified.email)) {
      res.status(400).json({
        error: 'O e-mail da conta Google não apresenta um formato válido.',
      });
      return;
    }

    let userRow = db
      .prepare(`SELECT * FROM users WHERE email = ?`)
      .get(verified.email) as
      | {
          id: string;
          public_code: string;
          full_name: string;
          username: string;
          phone: string;
          email: string;
          role: string;
          status: string;
          created_at: string;
        }
      | undefined;

    if (!userRow) {
      const now = new Date().toISOString();
      const userId = generateId('usr');
      const publicCode = generatePublicCode();
      const baseUsername =
        verified.email.split('@')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 14) || 'user';
      const username = `${baseUsername}_${crypto.randomInt(100, 999)}`;
      const assignedRole =
        isDesignatedAdminEmail(verified.email) ? 'SUPER_ADMIN' : 'USER';
      const cleanPhone =
        phone && phone.trim().length >= 7 ? phone.trim().slice(0, 32) : 'Conta Google';
      const cleanName = verified.name.length >= 3 ? verified.name.slice(0, 120) : 'Utilizador MILION';

      withTransaction(() => {
        db.prepare(
          `INSERT INTO users (id, public_code, full_name, username, phone, email, password_hash, role, status, email_verified, email_verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`
        ).run(
          userId,
          publicCode,
          cleanName,
          username,
          cleanPhone,
          verified.email,
          hashPassword(crypto.randomBytes(24).toString('hex')),
          assignedRole,
          now,
          now,
          now
        );

        db.prepare(
          `INSERT INTO wallets (user_id, available_balance, locked_balance, pending_balance, updated_at)
           VALUES (?, 0, 0, 0, ?)`
        ).run(userId, now);

        db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
           VALUES (?, ?, ?, ?, 'INFO', 0, ?)`
        ).run(
          generateId('ntf'),
          userId,
          'Conta Google vinculada à MILION.SPACE',
          `Bem-vindo à MILION.SPACE. Utilize a carteira digital para efetuar depósitos e levantamentos via M-Pesa.`,
          now
        );

        logAudit({
          actorId: userId,
          actorEmail: verified.email,
          actorRole: assignedRole,
          action: 'USER_REGISTERED_GOOGLE',
          entityType: 'USER',
          entityId: userId,
          details: { public_code: publicCode, firebase_uid: verified.uid, role: assignedRole },
        });
      });

      userRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as typeof userRow;
    } else {
      if (userRow.status === 'SUSPENDED') {
        res.status(403).json({ error: 'Esta conta encontra-se suspensa. Contacte o suporte.' });
        return;
      }
      if (isDesignatedAdminEmail(verified.email) && userRow.role !== 'SUPER_ADMIN') {
        db.prepare(`UPDATE users SET role = 'SUPER_ADMIN', updated_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          userRow.id
        );
        userRow.role = 'SUPER_ADMIN';
      }
      if (!(userRow as { email_verified?: number }).email_verified) {
        const nowIso = new Date().toISOString();
        db.prepare(`UPDATE users SET email_verified = 1, email_verified_at = ?, updated_at = ? WHERE id = ?`).run(
          nowIso,
          nowIso,
          userRow.id
        );
      }
      logAudit({
        actorId: userRow.id,
        actorEmail: userRow.email,
        actorRole: userRow.role,
        action: 'USER_LOGIN_GOOGLE',
        entityType: 'USER',
        entityId: userRow.id,
        details: { firebase_uid: verified.uid },
      });
    }

    if (isResendConfigured()) {
      void sendSecurityNotificationEmail({
        userId: userRow!.id,
        to: userRow!.email,
        fullName: userRow!.full_name,
        eventTitle: 'Acesso com conta Google',
        eventSummary: 'A sua conta MILION.SPACE foi acedida através da autenticação Google.',
        ipAddress: req.ip,
      });
    }

    const token = createSessionToken(userRow!.id);
    res.json({
      token,
      user: {
        id: userRow!.id,
        public_code: userRow!.public_code,
        full_name: userRow!.full_name,
        username: userRow!.username,
        phone: userRow!.phone,
        email: userRow!.email,
        role: userRow!.role,
        status: userRow!.status,
        email_verified: true,
        created_at: userRow!.created_at,
      },
    });
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Falha na autenticação Google.',
    });
  }
});

app.post('/api/auth/send-verification-code', authRateLimit, async (req: AuthenticatedRequest, res) => {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const targetEmail = (req.body as { email?: string })?.email?.trim().toLowerCase() || '';

  let user:
    | { id: string; full_name: string; email: string; role: string; status: string; email_verified: number }
    | undefined;

  if (bearerToken) {
    const authed = getUserFromToken(bearerToken);
    if (authed) {
      user = db
        .prepare(`SELECT id, full_name, email, role, status, COALESCE(email_verified, 0) as email_verified FROM users WHERE id = ?`)
        .get(authed.id) as typeof user;
    }
  }
  if (!user && targetEmail) {
    user = db
      .prepare(`SELECT id, full_name, email, role, status, COALESCE(email_verified, 0) as email_verified FROM users WHERE email = ?`)
      .get(targetEmail) as typeof user;
  }

  if (!user) {
    res.status(404).json({ error: 'Nenhuma conta encontrada para enviar o código de verificação.' });
    return;
  }
  if (user.email_verified && user.status !== 'PENDING_VERIFICATION') {
    res.json({
      ok: true,
      already_verified: true,
      message: 'Este endereço de e-mail já se encontra verificado.',
    });
    return;
  }

  const rateCheck = checkEmailResendAllowed(user.id, ['ACCOUNT_CONFIRMATION', 'VERIFICATION_CODE']);
  if (rateCheck.ok === false) {
    res.status(429).json({ error: rateCheck.error });
    return;
  }

  const issued = issueEmailToken(user.id, 'VERIFICATION_CODE', 15);
  const emailResult = await sendVerificationCodeEmail({
    userId: user.id,
    to: user.email,
    fullName: user.full_name,
    code: issued.code,
    expiresMinutes: 15,
  });

  if (!emailResult.configured) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(503).json({
      error: emailResult.error || 'RESEND_API_KEY não está configurada no servidor.',
    });
    return;
  }
  if (!emailResult.ok) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(502).json({
      error: emailResult.error || 'Falha ao enviar o código de verificação através do Resend.',
    });
    return;
  }

  res.json({
    ok: true,
    message: 'Novo código de verificação enviado para o seu e-mail.',
    email_id: emailResult.id || null,
  });
});

app.post('/api/auth/update-pending-email', authRateLimit, async (req, res) => {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const { new_email, current_email, password } = req.body as {
    new_email?: string;
    current_email?: string;
    password?: string;
  };
  const cleanNewEmail = (new_email || '').trim().toLowerCase();

  if (!isValidEmailAddress(cleanNewEmail)) {
    res.status(400).json({ error: 'Indique um endereço de e-mail válido (ex.: nome@dominio.com).' });
    return;
  }

  let user:
    | {
        id: string;
        public_code: string;
        full_name: string;
        username: string;
        phone: string;
        email: string;
        password_hash: string;
        role: string;
        status: string;
        email_verified: number;
        created_at: string;
      }
    | undefined;

  if (bearerToken) {
    const authed = getUserFromToken(bearerToken);
    if (authed) {
      user = db
        .prepare(
          `SELECT id, public_code, full_name, username, phone, email, password_hash, role, status, COALESCE(email_verified, 0) as email_verified, created_at
           FROM users WHERE id = ?`
        )
        .get(authed.id) as typeof user;
    }
  } else if (current_email && password) {
    const cleanCurr = current_email.trim().toLowerCase();
    const candidate = db
      .prepare(
        `SELECT id, public_code, full_name, username, phone, email, password_hash, role, status, COALESCE(email_verified, 0) as email_verified, created_at
         FROM users WHERE email = ?`
      )
      .get(cleanCurr) as typeof user;
    if (candidate && verifyPassword(password, candidate.password_hash)) {
      user = candidate;
    }
  }

  if (!user) {
    res.status(401).json({ error: 'Sessão inválida ou credenciais inválidas para corrigir o e-mail.' });
    return;
  }
  if (user.status !== 'PENDING_VERIFICATION' && user.email_verified) {
    res.status(403).json({ error: 'Esta conta já confirmou o e-mail anteriormente.' });
    return;
  }

  const emailDomain = cleanNewEmail.split('@')[1];
  try {
    const mx = await dns.resolveMx(emailDomain);
    if (!mx || mx.length === 0) {
      res.status(400).json({ error: 'O domínio de e-mail indicado não possui registo MX válido.' });
      return;
    }
  } catch {
    // Allow if DNS is unavailable while syntax check remains enforced
  }

  const conflict = db
    .prepare(`SELECT id FROM users WHERE email = ? AND id != ?`)
    .get(cleanNewEmail, user.id);
  if (conflict) {
    res.status(409).json({ error: 'Este endereço de e-mail já pertence a outra conta.' });
    return;
  }

  const rateCheck = checkEmailResendAllowed(user.id, ['ACCOUNT_CONFIRMATION', 'VERIFICATION_CODE']);
  if (rateCheck.ok === false) {
    res.status(429).json({ error: rateCheck.error });
    return;
  }

  const now = new Date().toISOString();
  const previousEmail = user.email;
  withTransaction(() => {
    db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`).run(
      cleanNewEmail,
      now,
      user!.id
    );
    db.prepare(
      `UPDATE auth_email_tokens SET used_at = ?
       WHERE user_id = ? AND purpose IN ('ACCOUNT_CONFIRMATION', 'VERIFICATION_CODE') AND used_at IS NULL`
    ).run(now, user!.id);

    logAudit({
      actorId: user!.id,
      actorEmail: cleanNewEmail,
      actorRole: user!.role,
      action: 'PENDING_EMAIL_UPDATED',
      entityType: 'USER',
      entityId: user!.id,
      details: { previous_email: previousEmail, new_email: cleanNewEmail },
    });
  });

  const updatedUser = {
    id: user.id,
    public_code: user.public_code,
    full_name: user.full_name,
    username: user.username,
    phone: user.phone,
    email: cleanNewEmail,
    role: user.role,
    status: user.status,
    email_verified: false,
    created_at: user.created_at,
  };

  const issued = issueEmailToken(user.id, 'ACCOUNT_CONFIRMATION', 30);
  const emailResult = await sendAccountConfirmationEmail({
    userId: user.id,
    to: cleanNewEmail,
    fullName: user.full_name,
    publicCode: user.public_code,
    verificationCode: issued.code,
    expiresMinutes: 30,
  });

  if (!emailResult.configured) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(503).json({
      error: emailResult.error || 'RESEND_API_KEY não está configurada no servidor.',
      email_updated: true,
      user: updatedUser,
    });
    return;
  }
  if (!emailResult.ok) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(502).json({
      error: emailResult.error || 'E-mail atualizado, mas falhou o envio pelo Resend.',
      email_updated: true,
      user: updatedUser,
    });
    return;
  }

  res.json({
    ok: true,
    email_updated: true,
    message: `E-mail atualizado para ${cleanNewEmail} e novo código enviado.`,
    user: updatedUser,
  });
});

app.post('/api/auth/verify-email', authRateLimit, async (req, res) => {
  const { email, code } = req.body as { email?: string; code?: string };
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !code) {
    res.status(400).json({ error: 'Informe o e-mail e o código de verificação.' });
    return;
  }

  const user = db
    .prepare(
      `SELECT id, public_code, full_name, username, phone, email, role, status, COALESCE(email_verified, 0) as email_verified, created_at
       FROM users WHERE email = ?`
    )
    .get(cleanEmail) as
    | {
        id: string;
        public_code: string;
        full_name: string;
        username: string;
        phone: string;
        email: string;
        role: string;
        status: string;
        email_verified: number;
        created_at: string;
      }
    | undefined;

  if (!user) {
    res.status(404).json({ error: 'Nenhuma conta encontrada com este e-mail.' });
    return;
  }

  const check = verifyAndConsumeEmailToken(
    user.id,
    ['ACCOUNT_CONFIRMATION', 'VERIFICATION_CODE'],
    code
  );
  if (check.ok === false) {
    res.status(400).json({ error: check.error });
    return;
  }

  const now = new Date().toISOString();
  const nextStatus = user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : user.status;
  db.prepare(
    `UPDATE users SET email_verified = 1, email_verified_at = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(now, nextStatus, now, user.id);

  logAudit({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'EMAIL_VERIFIED',
    entityType: 'USER',
    entityId: user.id,
    details: { purpose: check.purpose, status: nextStatus },
  });

  if (isResendConfigured()) {
    void sendSecurityNotificationEmail({
      userId: user.id,
      to: user.email,
      fullName: user.full_name,
      eventTitle: 'Endereço de e-mail confirmado',
      eventSummary: 'O endereço de e-mail associado à sua conta MILION.SPACE foi confirmado com sucesso.',
      ipAddress: req.ip,
      timestampIso: now,
    });
  }

  res.json({
    ok: true,
    message: 'E-mail verificado com sucesso.',
    user: {
      ...user,
      status: nextStatus,
      email_verified: true,
    },
  });
});

app.post('/api/auth/recover', authRateLimit, async (req, res) => {
  const { email } = req.body as { email?: string };
  const cleanEmail = (email || '').trim().toLowerCase();
  const user = db
    .prepare(`SELECT id, full_name, email, role FROM users WHERE email = ?`)
    .get(cleanEmail) as
    | { id: string; full_name: string; email: string; role: string }
    | undefined;

  if (!user) {
    res.status(404).json({ error: 'Nenhuma conta encontrada com este e-mail.' });
    return;
  }

  const rateCheck = checkEmailResendAllowed(user.id, ['PASSWORD_RECOVERY']);
  if (rateCheck.ok === false) {
    res.status(429).json({ error: rateCheck.error });
    return;
  }

  const issued = issueEmailToken(user.id, 'PASSWORD_RECOVERY', 15);
  db.prepare(`UPDATE users SET recovery_code = NULL, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    user.id
  );

  const emailResult = await sendPasswordRecoveryEmail({
    userId: user.id,
    to: user.email,
    fullName: user.full_name,
    recoveryCode: issued.code,
    expiresMinutes: 15,
  });

  logAudit({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'PASSWORD_RECOVERY_REQUESTED',
    entityType: 'USER',
    entityId: user.id,
    details: { email_sent: emailResult.ok, configured: emailResult.configured },
  });

  if (!emailResult.configured) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(503).json({
      error: emailResult.error || 'RESEND_API_KEY não está configurada no servidor.',
    });
    return;
  }
  if (!emailResult.ok) {
    invalidateFailedEmailToken(issued.tokenId);
    res.status(502).json({
      error: emailResult.error || 'Falha ao enviar o e-mail de recuperação pelo Resend.',
    });
    return;
  }

  res.json({
    message: 'Código de recuperação enviado para o seu e-mail.',
    email_sent: true,
  });
});

app.post('/api/auth/reset-password', authRateLimit, (req, res) => {
  const { email, recovery_code, new_password } = req.body as {
    email?: string;
    recovery_code?: string;
    new_password?: string;
  };
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!new_password || new_password.length < 6) {
    res.status(400).json({ error: 'A nova palavra-passe deve ter pelo menos 6 caracteres.' });
    return;
  }

  const user = db
    .prepare(`SELECT id, full_name, email, role FROM users WHERE email = ?`)
    .get(cleanEmail) as
    | { id: string; full_name: string; email: string; role: string }
    | undefined;

  if (!user) {
    res.status(400).json({ error: 'Código de recuperação inválido ou expirado.' });
    return;
  }

  const check = verifyAndConsumeEmailToken(
    user.id,
    ['PASSWORD_RECOVERY'],
    recovery_code || ''
  );
  if (check.ok === false) {
    res.status(400).json({ error: check.error });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users SET password_hash = ?, recovery_code = NULL, updated_at = ? WHERE id = ?`
  ).run(hashPassword(new_password), now, user.id);

  logAudit({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'PASSWORD_RESET',
    entityType: 'USER',
    entityId: user.id,
    details: { status: 'success' },
  });

  if (isResendConfigured()) {
    void sendSecurityNotificationEmail({
      userId: user.id,
      to: user.email,
      fullName: user.full_name,
      eventTitle: 'Palavra-passe redefinida',
      eventSummary: 'A palavra-passe da sua conta MILION.SPACE foi alterada com sucesso através do código de recuperação.',
      ipAddress: req.ip,
      timestampIso: now,
    });
  }

  res.json({ message: 'Palavra-passe atualizada com sucesso.' });
});

app.post('/api/auth/logout', requireAuthAllowPending, (req: AuthenticatedRequest, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  revokeSessionToken(token);
  logAudit({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: 'USER_LOGOUT',
    entityType: 'USER',
    entityId: req.user!.id,
    details: { status: 'revoked' },
  });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuthAllowPending, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

app.patch('/api/auth/profile', requireAuth, (req: AuthenticatedRequest, res) => {
  const { full_name, phone } = req.body as { full_name?: string; phone?: string };
  if (phone !== undefined && phone.trim() !== req.user!.phone) {
    res.status(400).json({ error: 'Não é permitido alterar o número de telefone no perfil.' });
    return;
  }
  const cleanName = (full_name || '').trim();
  if (cleanName.length < 3) {
    res.status(400).json({ error: 'O nome completo válido é obrigatório (mínimo 3 caracteres).' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?`).run(
    cleanName,
    now,
    req.user!.id
  );

  logAudit({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: 'PROFILE_UPDATED',
    entityType: 'USER',
    entityId: req.user!.id,
    details: { full_name: cleanName },
  });

  const updated = db
    .prepare(
      `SELECT id, public_code, full_name, username, phone, email, role, status, created_at FROM users WHERE id = ?`
    )
    .get(req.user!.id);
  res.json({ user: updated });
});

// ==================== WALLET & LEDGER ====================

app.get('/api/wallet', requireAuth, (req: AuthenticatedRequest, res) => {
  const wallet = db
    .prepare(`SELECT * FROM wallets WHERE user_id = ?`)
    .get(req.user!.id) as {
    user_id: string;
    available_balance: number;
    locked_balance: number;
    pending_balance: number;
    reserved_balance?: number;
    updated_at: string;
  };
  const settings = getPlatformSettings();
  const ledger = db
    .prepare(`SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(req.user!.id);

  const reservedBalance = Number((wallet.reserved_balance ?? 0).toFixed(2));
  const totalBalance = Number(
    (wallet.available_balance + wallet.locked_balance + wallet.pending_balance + reservedBalance).toFixed(2)
  );

  res.json({
    wallet: {
      ...wallet,
      reserved_balance: reservedBalance,
      total_balance: totalBalance,
      exchange_rate: settings.usd_to_mt_rate,
    },
    ledger,
  });
});

// ==================== DEPOSITS & WITHDRAWALS (M-PESA EXCLUSIVE) ====================

app.get('/api/payments/mpesa/status', requireAuth, (_req, res) => {
  const zaasCfg = getZaasPayConfig();
  res.json({
    provider: 'ZaasPay (M-Pesa)',
    configured: zaasCfg.configured,
    environment: zaasCfg.environment,
    key_format_valid: zaasCfg.keyFormatValid,
    api_url_configured: zaasCfg.apiUrlExplicit,
    api_url_valid: zaasCfg.apiUrlValid,
    missing_vars: zaasCfg.missingVars,
    invalid_vars: zaasCfg.invalidVars,
  });
});

app.get('/api/deposits', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(req.user!.id) as Array<Record<string, unknown>>;
  res.json({ deposits: rows.map(sanitizeDepositRow) });
});

app.post('/api/deposits', requireAuth, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  const { method, amount_usd, msisdn, notes, idempotency_key } = req.body as {
    method?: string;
    amount_usd?: number;
    msisdn?: string;
    notes?: string;
    idempotency_key?: string;
  };
  const headerIdem =
    typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;

  try {
    const result = await paymentService.createDeposit({
      actor: {
        id: req.user!.id,
        email: req.user!.email,
        role: req.user!.role,
        phone: req.user!.phone,
      },
      method,
      msisdn,
      amount_usd,
      notes,
      idempotencyKey: headerIdem || idempotency_key,
    });
    if (!result.duplicate) {
      void notifyAdminsAboutDeposit(result.deposit, req.user!);
      if (result.deposit.status === 'CREDITED') {
        void notifyUserAboutDepositOutcome(result.deposit.id);
      }
    }
    if (result.deposit.status === 'CREDITED') {
      broadcastWs('wallet:update', { userId: req.user!.id, reference: result.deposit.reference });
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Erro interno ao processar pedido de depósito M-Pesa.' });
  }
});

app.post('/api/deposits/:id/reconcile', requireAuth, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  const dep = db
    .prepare(`SELECT user_id FROM deposit_requests WHERE id = ?`)
    .get(req.params.id) as { user_id: string } | undefined;
  if (!dep) {
    res.status(404).json({ error: 'Depósito não encontrado.' });
    return;
  }
  if (dep.user_id !== req.user!.id && req.user!.role !== 'ADMIN' && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Sem permissão para consultar este depósito.' });
    return;
  }

  try {
    const result = await paymentService.reconcileDepositViaGateway({
      depositId: req.params.id,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    if (result.deposit.status === 'CREDITED' || result.deposit.status === 'FAILED' || result.deposit.status === 'EXPIRED') {
      broadcastWs('wallet:update', { userId: dep.user_id, reference: result.deposit.reference });
      void notifyUserAboutDepositOutcome(result.deposit.id);
    }
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Falha ao consultar estado M-Pesa.' });
  }
});

app.get('/api/withdrawals', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(req.user!.id) as Array<Record<string, unknown>>;
  res.json({ withdrawals: rows.map(sanitizeWithdrawalRow) });
});

app.post('/api/withdrawals', requireAuth, paymentRateLimit, (req: AuthenticatedRequest, res) => {
  const { destination_type, destination_account, amount_usd, notes, idempotency_key } = req.body as {
    destination_type?: string;
    destination_account?: string;
    amount_usd?: number;
    notes?: string;
    idempotency_key?: string;
  };
  const headerIdem =
    typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;

  try {
    const result = paymentService.createWithdrawal({
      actor: {
        id: req.user!.id,
        email: req.user!.email,
        role: req.user!.role,
        phone: req.user!.phone,
      },
      destination_type,
      destination_account,
      amount_usd,
      notes,
      idempotencyKey: headerIdem || idempotency_key,
    });
    if (!result.duplicate) {
      void notifyAdminsAboutWithdrawal(result.withdrawal, req.user!);
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Erro interno ao registar levantamento M-Pesa.' });
  }
});

app.post('/api/payments/mpesa/callback', webhookRateLimit, (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : undefined;

  try {
    const result = paymentService.processWebhook({
      headers: req.headers as Record<string, string | string[] | undefined>,
      querySecret,
      rawBodyString: rawBody,
      payload: (req.body ?? {}) as Record<string, unknown>,
    });
    if (result.userId) {
      broadcastWs('wallet:update', { userId: result.userId });
    }
    if (!result.duplicate && 'depositId' in result && typeof result.depositId === 'string') {
      void notifyUserAboutDepositOutcome(result.depositId);
    }
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Erro ao processar callback M-Pesa.' });
  }
});

// ==================== MILION OPERATIONS ====================

app.get('/api/operations', requireAuth, (req: AuthenticatedRequest, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  let rows: Array<Record<string, unknown>>;
  if (status && status !== 'ALL') {
    rows = db
      .prepare(`SELECT * FROM operations WHERE user_id = ? AND status = ? ORDER BY opened_at DESC LIMIT 150`)
      .all(req.user!.id, status) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(`SELECT * FROM operations WHERE user_id = ? ORDER BY opened_at DESC LIMIT 150`)
      .all(req.user!.id) as Array<Record<string, unknown>>;
  }
  const settings = getPlatformSettings();
  const currentPrice = marketEngine.getCurrentPrice();
  const nowMs = Date.now();
  const enriched = rows.map((op) => {
    if (op.status !== 'ACTIVE') return op;
    return {
      ...op,
      ...computeLiveOperationMetrics(
        {
          direction: op.direction as 'SUBIDA' | 'DESCIDA',
          amount_usd: Number(op.amount_usd),
          entry_price: Number(op.entry_price),
          expires_at: String(op.expires_at),
          duration_seconds: Number(op.duration_seconds),
        },
        currentPrice,
        settings.proportional_multiplier,
        nowMs
      ),
    };
  });
  res.json({ operations: enriched });
});

app.post('/api/operations', requireAuth, (req: AuthenticatedRequest, res) => {
  const { direction, amount_usd, duration_seconds, idempotency_key } = req.body as {
    direction?: 'SUBIDA' | 'DESCIDA';
    amount_usd?: number;
    duration_seconds?: number;
    idempotency_key?: string;
  };

  const settings = getPlatformSettings();
  if (settings.market_paused) {
    res.status(409).json({ error: 'O mercado encontra-se temporariamente pausado pelo administrador.' });
    return;
  }

  if (direction !== 'SUBIDA' && direction !== 'DESCIDA') {
    res.status(400).json({ error: 'Direção inválida. Escolha SUBIDA ou DESCIDA.' });
    return;
  }

  const amount = Number(Number(amount_usd).toFixed(2));
  if (!Number.isFinite(amount) || amount < 0.5 || amount > 50000) {
    res.status(400).json({ error: 'O valor virtual da operação deve estar entre $0.50 e $50,000.00.' });
    return;
  }

  const duration = Math.floor(Number(duration_seconds));
  const minDuration = amount < 5 ? 300 : 1200; // < $5 => 5 min; >= $5 => 20 min
  const maxDuration = settings.max_duration_days * 24 * 3600; // Up to 14 days

  if (!Number.isFinite(duration) || duration < minDuration || duration > maxDuration) {
    const minLabel = amount < 5 ? '5 minutos (300s)' : '20 minutos (1200s)';
    res.status(400).json({
      error: `Duração inválida. Para $${amount.toFixed(2)}, a duração mínima é ${minLabel} e a máxima é ${settings.max_duration_days} dias.`,
    });
    return;
  }

  const idemKey = (idempotency_key || generateId('idem')).trim();
  const duplicate = db.prepare(`SELECT * FROM operations WHERE idempotency_key = ?`).get(idemKey);
  if (duplicate) {
    res.status(200).json({ operation: duplicate, deduplicated: true });
    return;
  }

  const entryPrice = marketEngine.getCurrentPrice();
  const nowMs = Date.now();
  const openedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + duration * 1000).toISOString();
  const opId = generateId('op');
  const reference = generateReference('OP');
  const ruleSnapshot = JSON.stringify({
    model: 'PROPORTIONAL_UNCAPPED',
    proportional_multiplier: settings.proportional_multiplier,
    max_gain_pct: null,
    max_loss_pct: 100,
    min_duration_rule_sec: minDuration,
  });

  try {
    withTransaction(() => {
      const wallet = db
        .prepare(`SELECT available_balance, locked_balance FROM wallets WHERE user_id = ?`)
        .get(req.user!.id) as { available_balance: number; locked_balance: number };

      if (wallet.available_balance < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      const newAvailable = Number((wallet.available_balance - amount).toFixed(2));
      const newLocked = Number((wallet.locked_balance + amount).toFixed(2));

      db.prepare(
        `UPDATE wallets SET available_balance = ?, locked_balance = ?, updated_at = ? WHERE user_id = ?`
      ).run(newAvailable, newLocked, openedAt, req.user!.id);

      db.prepare(
        `INSERT INTO operations (id, reference, user_id, idempotency_key, direction, amount_usd, duration_seconds, entry_price, status, opened_at, expires_at, rule_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`
      ).run(
        opId,
        reference,
        req.user!.id,
        idemKey,
        direction,
        amount,
        duration,
        entryPrice,
        openedAt,
        expiresAt,
        ruleSnapshot
      );

      db.prepare(
        `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
         VALUES (?, ?, ?, 'OP_RESERVE', ?, ?, ?, ?, ?)`
      ).run(
        generateId('led'),
        generateReference('TXN'),
        req.user!.id,
        -amount,
        wallet.available_balance,
        newAvailable,
        `Reserva de capital para operação ${reference} (${direction} · Valor aplicado $${amount.toFixed(2)})`,
        openedAt
      );

      logAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        action: 'OPERATION_OPENED',
        entityType: 'OPERATION',
        entityId: opId,
        details: {
          reference,
          direction,
          amount_usd: amount,
          duration_seconds: duration,
          entry_price: entryPrice,
          expires_at: expiresAt,
        },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'INSUFFICIENT_BALANCE') {
      res.status(400).json({ error: 'Saldo disponível insuficiente para abrir esta operação.' });
      return;
    }
    throw err;
  }

  const operation = db.prepare(`SELECT * FROM operations WHERE id = ?`).get(opId);
  broadcastWs('market:update', marketEngine.getGlobalMarketSnapshot(80));
  res.status(201).json({ operation });
});

// ==================== NOTIFICATIONS & SUPPORT ====================

function attachMessagesToTickets(tickets: Array<Record<string, unknown>>) {
  if (tickets.length === 0) return [];
  const ids = tickets.map((t) => String(t.id));
  const placeholders = ids.map(() => '?').join(',');
  const rawMessages = db
    .prepare(
      `SELECT id, ticket_id, sender_id, sender_role, sender_email, body, created_at
       FROM support_messages
       WHERE ticket_id IN (${placeholders})
       ORDER BY created_at ASC`
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const msgMap = new Map<string, Array<Record<string, unknown>>>();
  for (const m of rawMessages) {
    const tid = String(m.ticket_id);
    const arr = msgMap.get(tid) || [];
    arr.push(m);
    msgMap.set(tid, arr);
  }

  return tickets.map((t) => {
    const tid = String(t.id);
    const msgs = msgMap.get(tid) || [];
    if (msgs.length === 0) {
      const synthesized: Array<Record<string, unknown>> = [
        {
          id: `${tid}_init`,
          ticket_id: tid,
          sender_id: t.user_id,
          sender_role: 'USER',
          sender_email: t.email || 'utilizador',
          body: t.message,
          created_at: t.created_at,
        },
      ];
      if (t.admin_reply) {
        synthesized.push({
          id: `${tid}_reply`,
          ticket_id: tid,
          sender_id: 'admin',
          sender_role: 'ADMIN',
          sender_email: t.replied_by || 'equipa@milion.space',
          body: t.admin_reply,
          created_at: t.updated_at || t.created_at,
        });
      }
      return { ...t, messages: synthesized };
    }
    return { ...t, messages: msgs };
  });
}

app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const notifications = db
    .prepare(
      `SELECT n.id, n.user_id, n.title, n.message, n.type, n.created_at,
              CASE
                WHEN n.user_id IS NULL THEN CASE WHEN nr.user_id IS NOT NULL THEN 1 ELSE 0 END
                ELSE n.is_read
              END as is_read
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = ?
       WHERE n.user_id = ? OR n.user_id IS NULL
       ORDER BY n.created_at DESC
       LIMIT 60`
    )
    .all(req.user!.id, req.user!.id);
  res.json({ notifications });
});

app.post('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
  const ntf = db
    .prepare(`SELECT id, user_id FROM notifications WHERE id = ?`)
    .get(req.params.id) as { id: string; user_id: string | null } | undefined;
  if (ntf) {
    if (ntf.user_id === req.user!.id) {
      db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(
        req.params.id,
        req.user!.id
      );
    } else if (ntf.user_id === null) {
      db.prepare(
        `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)`
      ).run(ntf.id, req.user!.id, new Date().toISOString());
    }
  }
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res) => {
  const now = new Date().toISOString();
  withTransaction(() => {
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`).run(req.user!.id);
    const globals = db
      .prepare(`SELECT id FROM notifications WHERE user_id IS NULL`)
      .all() as Array<{ id: string }>;
    const ins = db.prepare(
      `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)`
    );
    for (const g of globals) {
      ins.run(g.id, req.user!.id, now);
    }
  });
  res.json({ ok: true });
});

app.get('/api/support', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, u.email, u.full_name, u.public_code
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ?
       ORDER BY s.updated_at DESC, s.created_at DESC
       LIMIT 50`
    )
    .all(req.user!.id) as Array<Record<string, unknown>>;
  res.json({ tickets: attachMessagesToTickets(rows) });
});

app.post('/api/support', requireAuth, (req: AuthenticatedRequest, res) => {
  const { subject, category, message } = req.body as {
    subject?: string;
    category?: string;
    message?: string;
  };
  if (!subject || subject.trim().length < 4 || !message || message.trim().length < 8) {
    res.status(400).json({ error: 'Preencha o assunto e a descrição do pedido de suporte.' });
    return;
  }
  const now = new Date().toISOString();
  const id = generateId('sup');
  const reference = generateReference('SUP');
  const cleanMsg = message.trim().slice(0, 1500);

  withTransaction(() => {
    db.prepare(
      `INSERT INTO support_tickets (id, reference, user_id, subject, category, message, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`
    ).run(
      id,
      reference,
      req.user!.id,
      subject.trim().slice(0, 120),
      (category || 'Geral').trim(),
      cleanMsg,
      now,
      now
    );

    db.prepare(
      `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId('smsg'), id, req.user!.id, req.user!.role, req.user!.email, cleanMsg, now);

    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'SUPPORT_TICKET_CREATED',
      entityType: 'SUPPORT_TICKET',
      entityId: id,
      details: { reference, subject: subject.trim() },
    });
  });

  const row = db
    .prepare(
      `SELECT s.*, u.email, u.full_name, u.public_code
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(id) as Record<string, unknown>;
  res.status(201).json({ ticket: attachMessagesToTickets([row])[0] });
});

app.post('/api/support/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
  const { body } = req.body as { body?: string };
  const cleanBody = (body || '').trim();
  if (cleanBody.length < 2) {
    res.status(400).json({ error: 'Escreva uma mensagem válida.' });
    return;
  }

  const ticket = db
    .prepare(`SELECT * FROM support_tickets WHERE id = ?`)
    .get(req.params.id) as
    | { id: string; user_id: string; reference: string; status: string; message: string; admin_reply: string | null; replied_by: string | null; created_at: string; updated_at: string }
    | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Pedido de suporte não encontrado.' });
    return;
  }
  const isStaff = req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN';
  if (ticket.user_id !== req.user!.id && !isStaff) {
    res.status(403).json({ error: 'Sem permissão para responder a este pedido.' });
    return;
  }

  const now = new Date().toISOString();
  withTransaction(() => {
    const existingMsgCount = (
      db.prepare(`SELECT COUNT(*) as c FROM support_messages WHERE ticket_id = ?`).get(ticket.id) as { c: number }
    ).c;

    if (existingMsgCount === 0) {
      const owner = db.prepare(`SELECT email FROM users WHERE id = ?`).get(ticket.user_id) as { email?: string } | undefined;
      db.prepare(
        `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
         VALUES (?, ?, ?, 'USER', ?, ?, ?)`
      ).run(generateId('smsg'), ticket.id, ticket.user_id, owner?.email || 'utilizador', ticket.message, ticket.created_at);

      if (ticket.admin_reply) {
        db.prepare(
          `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
           VALUES (?, ?, 'admin', 'ADMIN', ?, ?, ?)`
        ).run(generateId('smsg'), ticket.id, ticket.replied_by || 'equipa@milion.space', ticket.admin_reply, ticket.updated_at || ticket.created_at);
      }
    }

    db.prepare(
      `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId('smsg'), ticket.id, req.user!.id, req.user!.role, req.user!.email, cleanBody.slice(0, 1500), now);

    const nextStatus = ticket.status === 'CLOSED' && !isStaff ? 'OPEN' : ticket.status === 'RESOLVED' && !isStaff ? 'IN_PROGRESS' : ticket.status;
    db.prepare(`UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?`).run(nextStatus, now, ticket.id);

    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'SUPPORT_MESSAGE_ADDED',
      entityType: 'SUPPORT_TICKET',
      entityId: ticket.id,
      details: { reference: ticket.reference, next_status: nextStatus },
    });
  });

  const updatedRow = db
    .prepare(
      `SELECT s.*, u.email, u.full_name, u.public_code
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(ticket.id) as Record<string, unknown>;
  res.status(201).json({ ticket: attachMessagesToTickets([updatedRow])[0] });
});

// ==================== ADMIN API ====================

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const userStats = db
    .prepare(
      `SELECT COUNT(*) as total_users,
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_users,
              SUM(CASE WHEN status = 'SUSPENDED' THEN 1 ELSE 0 END) as suspended_users
       FROM users`
    )
    .get() as Record<string, number>;

  const walletStats = db
    .prepare(
      `SELECT COALESCE(SUM(available_balance), 0) as total_available,
              COALESCE(SUM(locked_balance), 0) as total_locked,
              COALESCE(SUM(pending_balance), 0) as total_pending,
              COALESCE(SUM(reserved_balance), 0) as total_reserved
       FROM wallets`
    )
    .get() as Record<string, number>;

  const pendingDeposits = (
    db
      .prepare(`SELECT COUNT(*) as c FROM deposit_requests WHERE status IN ('PENDING', 'PAYMENT_PENDING', 'CREATED', 'RECONCILIATION_REQUIRED')`)
      .get() as { c: number }
  ).c;
  const pendingWithdrawals = (
    db
      .prepare(`SELECT COUNT(*) as c FROM withdrawal_requests WHERE status IN ('PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'DISBURSEMENT_PENDING', 'RECONCILIATION_REQUIRED')`)
      .get() as { c: number }
  ).c;
  const openTickets = (
    db
      .prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE status IN ('OPEN', 'IN_PROGRESS')`)
      .get() as { c: number }
  ).c;

  const opStats = db
    .prepare(
      `SELECT COUNT(*) as total_ops,
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_ops,
              SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_ops,
              COALESCE(SUM(amount_usd), 0) as total_volume
       FROM operations`
    )
    .get() as Record<string, number>;

  const depSums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('CREDITED', 'APPROVED') THEN amount_usd ELSE 0 END), 0) as total_deposited_usd,
         COALESCE(SUM(CASE WHEN status IN ('PENDING', 'PAYMENT_PENDING', 'CREATED', 'RECONCILIATION_REQUIRED') THEN amount_usd ELSE 0 END), 0) as pending_deposit_usd
       FROM deposit_requests`
    )
    .get() as { total_deposited_usd: number; pending_deposit_usd: number };

  const wdrSums = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('PAID', 'APPROVED') THEN amount_usd ELSE 0 END), 0) as total_withdrawn_usd,
         COALESCE(SUM(CASE WHEN status IN ('PENDING', 'AWAITING_APPROVAL', 'DISBURSEMENT_PENDING', 'RECONCILIATION_REQUIRED') THEN amount_usd ELSE 0 END), 0) as pending_withdrawal_usd
       FROM withdrawal_requests`
    )
    .get() as { total_withdrawn_usd: number; pending_withdrawal_usd: number };

  const activeDirStats = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'SUBIDA' THEN 1 ELSE 0 END), 0) as active_up_count,
         COALESCE(SUM(CASE WHEN direction = 'SUBIDA' THEN amount_usd ELSE 0 END), 0) as active_up_usd,
         COALESCE(SUM(CASE WHEN direction = 'DESCIDA' THEN 1 ELSE 0 END), 0) as active_down_count,
         COALESCE(SUM(CASE WHEN direction = 'DESCIDA' THEN amount_usd ELSE 0 END), 0) as active_down_usd
       FROM operations
       WHERE status = 'ACTIVE'`
    )
    .get() as {
    active_up_count: number;
    active_up_usd: number;
    active_down_count: number;
    active_down_usd: number;
  };

  const settings = getPlatformSettings();
  const currentPrice = marketEngine.getCurrentPrice();
  const nowMs = Date.now();
  const activeOpsRows = db
    .prepare(
      `SELECT id, direction, amount_usd, entry_price, expires_at, duration_seconds
       FROM operations
       WHERE status = 'ACTIVE'`
    )
    .all() as Array<{
    id: string;
    direction: 'SUBIDA' | 'DESCIDA';
    amount_usd: number;
    entry_price: number;
    expires_at: string;
    duration_seconds: number;
  }>;

  let activeCapitalUsd = 0;
  let activeLiveValueUsd = 0;
  let activeFloatingPnlUsd = 0;
  for (const op of activeOpsRows) {
    const metrics = computeLiveOperationMetrics(
      op,
      currentPrice,
      settings.proportional_multiplier,
      nowMs
    );
    activeCapitalUsd += op.amount_usd;
    activeLiveValueUsd += metrics.floating_value_usd;
    activeFloatingPnlUsd += metrics.floating_pnl_usd;
  }

  const appProfit = paymentService.getAppFinancialSummary();

  res.json({
    userStats,
    walletStats,
    pendingDeposits,
    pendingWithdrawals,
    openTickets,
    opStats,
    realFinancials: {
      total_deposited_usd: Number(depSums.total_deposited_usd.toFixed(2)),
      pending_deposit_usd: Number(depSums.pending_deposit_usd.toFixed(2)),
      total_withdrawn_usd: Number(wdrSums.total_withdrawn_usd.toFixed(2)),
      pending_withdrawal_usd: Number(wdrSums.pending_withdrawal_usd.toFixed(2)),
      active_up_count: activeDirStats.active_up_count,
      active_up_usd: Number(activeDirStats.active_up_usd.toFixed(2)),
      active_down_count: activeDirStats.active_down_count,
      active_down_usd: Number(activeDirStats.active_down_usd.toFixed(2)),
      active_capital_usd: Number(activeCapitalUsd.toFixed(2)),
      active_live_value_usd: Number(activeLiveValueUsd.toFixed(2)),
      active_floating_pnl_usd: Number(activeFloatingPnlUsd.toFixed(2)),
    },
    appProfit,
    settings,
  });
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.public_code, u.full_name, u.username, u.phone, u.email, u.role, u.status, u.created_at,
              w.available_balance, w.locked_balance, w.pending_balance, w.reserved_balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC`
    )
    .all();
  res.json({ users });
});

app.patch('/api/admin/users/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
  const { status, role } = req.body as {
    status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
    role?: 'USER' | 'ADMIN' | 'SUPER_ADMIN';
  };
  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id) as
    | { id: string; email: string; role: string; status: string }
    | undefined;
  if (!target) {
    res.status(404).json({ error: 'Utilizador não encontrado.' });
    return;
  }

  if (role && role !== target.role && req.user!.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Apenas o Super Administrador pode alterar permissões.' });
    return;
  }

  const nextStatus = status ?? target.status;
  const nextRole = role ?? target.role;
  const now = new Date().toISOString();

  db.prepare(`UPDATE users SET status = ?, role = ?, updated_at = ? WHERE id = ?`).run(
    nextStatus,
    nextRole,
    now,
    target.id
  );

  logAudit({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: 'ADMIN_USER_UPDATED',
    entityType: 'USER',
    entityId: target.id,
    details: { previous_status: target.status, next_status: nextStatus, previous_role: target.role, next_role: nextRole },
  });

  res.json({ ok: true });
});

app.post('/api/admin/wallets/:userId/adjust', requireAdmin, (req: AuthenticatedRequest, res) => {
  const { amount_usd, reason } = req.body as { amount_usd?: number; reason?: string };
  const delta = Number(Number(amount_usd).toFixed(2));
  if (!Number.isFinite(delta) || delta === 0 || !reason || reason.trim().length < 4) {
    res.status(400).json({ error: 'Indique um valor válido e um motivo para o ajuste auditado.' });
    return;
  }

  const now = new Date().toISOString();
  try {
    withTransaction(() => {
      const wallet = db
        .prepare(`SELECT available_balance FROM wallets WHERE user_id = ?`)
        .get(req.params.userId) as { available_balance: number } | undefined;
      if (!wallet) throw new Error('NOT_FOUND');

      const nextAvailable = Number((wallet.available_balance + delta).toFixed(2));
      if (nextAvailable < 0) throw new Error('NEGATIVE_BALANCE');

      db.prepare(`UPDATE wallets SET available_balance = ?, updated_at = ? WHERE user_id = ?`).run(
        nextAvailable,
        now,
        req.params.userId
      );

      db.prepare(
        `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
         VALUES (?, ?, ?, 'ADMIN_ADJUST', ?, ?, ?, ?, ?)`
      ).run(
        generateId('led'),
        generateReference('TXN'),
        req.params.userId,
        delta,
        wallet.available_balance,
        nextAvailable,
        `Ajuste administrativo: ${reason.trim()}`,
        now
      );

      logAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        action: 'ADMIN_WALLET_ADJUSTED',
        entityType: 'WALLET',
        entityId: req.params.userId,
        details: { delta, reason: reason.trim(), balance_before: wallet.available_balance, balance_after: nextAvailable },
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'NEGATIVE_BALANCE') {
      res.status(400).json({ error: 'Operação bloqueada: o sistema não permite saldos negativos.' });
      return;
    }
    res.status(404).json({ error: 'Carteira não encontrada.' });
    return;
  }

  res.json({ ok: true });
});

app.get('/api/admin/deposits', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT d.*, u.full_name, u.email, u.public_code
       FROM deposit_requests d
       JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC LIMIT 100`
    )
    .all() as Array<Record<string, unknown>>;
  res.json({ deposits: rows.map(sanitizeDepositRow) });
});

app.post('/api/admin/deposits/:id/review', requireAdmin, paymentRateLimit, (req: AuthenticatedRequest, res) => {
  const { decision, notes } = req.body as { decision?: 'APPROVED' | 'REJECTED'; notes?: string };
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    res.status(400).json({ error: 'Decisão inválida.' });
    return;
  }

  try {
    const result = paymentService.adminReviewDeposit({
      depositId: req.params.id,
      decision,
      notes,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    void notifyUserAboutDepositOutcome(req.params.id);
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(400).json({ error: 'Pedido não encontrado ou já processado.' });
  }
});

app.get('/api/admin/withdrawals', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT w.*, u.full_name, u.email, u.public_code
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       ORDER BY w.created_at DESC LIMIT 100`
    )
    .all() as Array<Record<string, unknown>>;
  res.json({ withdrawals: rows.map(sanitizeWithdrawalRow) });
});

app.post('/api/admin/withdrawals/:id/review', requireAdmin, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  const { decision, notes } = req.body as { decision?: 'APPROVED' | 'REJECTED'; notes?: string };
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    res.status(400).json({ error: 'Decisão inválida.' });
    return;
  }

  try {
    const result = await paymentService.adminReviewWithdrawal({
      withdrawalId: req.params.id,
      decision,
      notes,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    broadcastWs('wallet:update', { userId: result.withdrawal.user_id, reference: result.withdrawal.reference });
    void notifyUserAboutWithdrawalOutcome(result.withdrawal.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(400).json({ error: 'Pedido não encontrado ou já processado.' });
  }
});

app.post('/api/admin/withdrawals/:id/reconcile', requireAdmin, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await paymentService.reconcileWithdrawalViaGateway({
      withdrawalId: req.params.id,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    broadcastWs('wallet:update', { userId: result.withdrawal.user_id, reference: result.withdrawal.reference });
    void notifyUserAboutWithdrawalOutcome(result.withdrawal.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Falha ao consultar estado do saque na ZaasPay.' });
  }
});

app.get('/api/admin/reconciliation', requireAdmin, (_req, res) => {
  const records = db
    .prepare(`SELECT * FROM reconciliation_records ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, created_at DESC LIMIT 100`)
    .all();
  res.json({ records });
});

app.post('/api/admin/reconciliation/:id/resolve', requireAdmin, paymentRateLimit, (req: AuthenticatedRequest, res) => {
  const { outcome, provider_tx_id, notes } = req.body as {
    outcome?: 'RESOLVED_CONFIRMED' | 'RESOLVED_FAILED';
    provider_tx_id?: string;
    notes?: string;
  };
  if (outcome !== 'RESOLVED_CONFIRMED' && outcome !== 'RESOLVED_FAILED') {
    res.status(400).json({ error: 'Resultado de reconciliação inválido.' });
    return;
  }

  try {
    const result = paymentService.resolveReconciliation({
      reconciliationId: req.params.id,
      outcome,
      providerTxId: provider_tx_id,
      notes: notes || '',
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(400).json({ error: 'Erro ao resolver reconciliação.' });
  }
});

app.get('/api/admin/operations', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT o.*, u.full_name, u.email, u.public_code
       FROM operations o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.opened_at DESC LIMIT 200`
    )
    .all() as Array<Record<string, unknown>>;
  const settings = getPlatformSettings();
  const currentPrice = marketEngine.getCurrentPrice();
  const nowMs = Date.now();
  const operations = rows.map((o) => {
    if (o.status !== 'ACTIVE') return o;
    return {
      ...o,
      ...computeLiveOperationMetrics(
        {
          direction: o.direction as 'SUBIDA' | 'DESCIDA',
          amount_usd: Number(o.amount_usd),
          entry_price: Number(o.entry_price),
          expires_at: String(o.expires_at),
          duration_seconds: Number(o.duration_seconds),
        },
        currentPrice,
        settings.proportional_multiplier,
        nowMs
      ),
    };
  });
  res.json({ operations });
});

app.post('/api/admin/operations/:id/cancel', requireAdmin, (req: AuthenticatedRequest, res) => {
  const now = new Date().toISOString();
  try {
    withTransaction(() => {
      const op = db.prepare(`SELECT * FROM operations WHERE id = ?`).get(req.params.id) as
        | { id: string; reference: string; user_id: string; amount_usd: number; status: string }
        | undefined;
      if (!op || (op.status !== 'ACTIVE' && op.status !== 'PENDING')) throw new Error('INVALID_STATE');

      const wallet = db
        .prepare(`SELECT available_balance, locked_balance FROM wallets WHERE user_id = ?`)
        .get(op.user_id) as { available_balance: number; locked_balance: number };

      const nextLocked = Math.max(0, Number((wallet.locked_balance - op.amount_usd).toFixed(2)));
      const nextAvailable = Number((wallet.available_balance + op.amount_usd).toFixed(2));

      db.prepare(
        `UPDATE wallets SET available_balance = ?, locked_balance = ?, updated_at = ? WHERE user_id = ?`
      ).run(nextAvailable, nextLocked, now, op.user_id);

      db.prepare(`UPDATE operations SET status = 'CANCELLED', termination_reason = 'ADMIN_CANCELLED', settled_at = ? WHERE id = ?`).run(
        now,
        op.id
      );

      db.prepare(
        `INSERT INTO wallet_ledger (id, reference, user_id, type, amount, balance_before, balance_after, description, created_at)
         VALUES (?, ?, ?, 'OP_CANCEL_REFUND', ?, ?, ?, ?, ?)`
      ).run(
        generateId('led'),
        generateReference('TXN'),
        op.user_id,
        op.amount_usd,
        wallet.available_balance,
        nextAvailable,
        `Cancelamento administrativo da operação ${op.reference} · reembolso integral`,
        now
      );

      logAudit({
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        action: 'ADMIN_OPERATION_CANCELLED',
        entityType: 'OPERATION',
        entityId: op.id,
        details: { reference: op.reference, refunded_usd: op.amount_usd },
      });
    });
  } catch {
    res.status(400).json({ error: 'Operação não pode ser cancelada.' });
    return;
  }

  broadcastWs('market:update', marketEngine.getGlobalMarketSnapshot(80));
  res.json({ ok: true });
});

app.get('/api/admin/audit', requireAdmin, (_req, res) => {
  const logs = db
    .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250`)
    .all();
  res.json({ logs });
});

app.get('/api/admin/ledger', requireAdmin, (_req, res) => {
  const ledger = db
    .prepare(
      `SELECT l.*, u.public_code, u.email
       FROM wallet_ledger l
       JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT 200`
    )
    .all();
  res.json({ ledger });
});

app.get('/api/admin/reports', requireAdmin, (_req, res) => {
  const operationsByDirection = db
    .prepare(
      `SELECT direction, COUNT(*) as count, COALESCE(SUM(amount_usd), 0) as volume, COALESCE(SUM(result_amount_usd), 0) as net_pnl
       FROM operations GROUP BY direction`
    )
    .all();

  const operationsByStatus = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(amount_usd), 0) as volume
       FROM operations GROUP BY status`
    )
    .all();

  const depositsSummary = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(amount_usd), 0) as volume_usd
       FROM deposit_requests GROUP BY status`
    )
    .all();

  const withdrawalsSummary = db
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(amount_usd), 0) as volume_usd
       FROM withdrawal_requests GROUP BY status`
    )
    .all();

  res.json({
    operationsByDirection,
    operationsByStatus,
    depositsSummary,
    withdrawalsSummary,
  });
});

app.post('/api/admin/notifications', requireAdmin, (req: AuthenticatedRequest, res) => {
  const { user_id, title, message } = req.body as {
    user_id?: string | null;
    title?: string;
    message?: string;
  };
  if (!title || title.trim().length < 3 || !message || message.trim().length < 5) {
    res.status(400).json({ error: 'Título e mensagem são obrigatórios.' });
    return;
  }

  const now = new Date().toISOString();
  const id = generateId('ntf');
  const targetUser = user_id && user_id.trim() !== '' ? user_id.trim() : null;

  db.prepare(
    `INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
     VALUES (?, ?, ?, ?, 'ADMIN', 0, ?)`
  ).run(id, targetUser, title.trim(), message.trim(), now);

  logAudit({
    actorId: req.user!.id,
    actorEmail: req.user!.email,
    actorRole: req.user!.role,
    action: 'ADMIN_NOTIFICATION_SENT',
    entityType: 'NOTIFICATION',
    entityId: id,
    details: { target_user_id: targetUser ?? 'ALL', title: title.trim() },
  });

  res.status(201).json({ ok: true });
});

app.get('/api/admin/app-payouts', requireAdmin, (_req, res) => {
  res.json({
    payouts: paymentService.listAdminPayouts(60),
    summary: paymentService.getAppFinancialSummary(),
  });
});

app.post('/api/admin/app-payouts', requireAdmin, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  const { msisdn, recipient_name, amount_usd, notes, idempotency_key } = req.body as {
    msisdn?: string;
    recipient_name?: string;
    amount_usd?: number;
    notes?: string;
    idempotency_key?: string;
  };
  const headerIdem =
    typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;

  try {
    const result = await paymentService.createAdminThirdPartyPayout({
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
      msisdn,
      recipient_name,
      amount_usd,
      notes,
      idempotencyKey: headerIdem || idempotency_key,
    });
    res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Erro interno ao processar saque de lucro como terceiro.' });
  }
});

app.post('/api/admin/app-payouts/:id/reconcile', requireAdmin, paymentRateLimit, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await paymentService.reconcileAdminThirdPartyPayout({
      payoutId: req.params.id,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Falha ao consultar saque administrativo na ZaasPay.' });
  }
});

app.post('/api/admin/app-payouts/:id/resolve', requireAdmin, paymentRateLimit, (req: AuthenticatedRequest, res) => {
  const { decision, provider_tx_id, notes } = req.body as {
    decision?: 'FAILED' | 'PAID';
    provider_tx_id?: string;
    notes?: string;
  };
  if (decision !== 'FAILED' && decision !== 'PAID') {
    res.status(400).json({ error: 'Decisão inválida. Escolha FAILED ou PAID.' });
    return;
  }

  try {
    const result = paymentService.resolveAdminThirdPartyPayout({
      payoutId: req.params.id,
      decision,
      providerTxId: provider_tx_id,
      notes,
      actor: { id: req.user!.id, email: req.user!.email, role: req.user!.role },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Falha ao resolver estado do saque administrativo.' });
  }
});

app.get('/api/admin/support', requireAdmin, (_req, res) => {
  const tickets = db
    .prepare(
      `SELECT s.*, u.full_name, u.email, u.public_code
       FROM support_tickets s
       JOIN users u ON u.id = s.user_id
       ORDER BY s.updated_at DESC, s.created_at DESC LIMIT 100`
    )
    .all() as Array<Record<string, unknown>>;
  res.json({ tickets: attachMessagesToTickets(tickets) });
});

app.post('/api/admin/support/:id/reply', requireAdmin, (req: AuthenticatedRequest, res) => {
  const { admin_reply, status } = req.body as {
    admin_reply?: string;
    status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  };
  if (!admin_reply || admin_reply.trim().length < 2) {
    res.status(400).json({ error: 'Escreva uma resposta para o pedido de suporte.' });
    return;
  }

  const ticket = db
    .prepare(`SELECT * FROM support_tickets WHERE id = ?`)
    .get(req.params.id) as
    | { id: string; user_id: string; reference: string; message: string; admin_reply: string | null; replied_by: string | null; created_at: string; updated_at: string }
    | undefined;
  if (!ticket) {
    res.status(404).json({ error: 'Pedido de suporte não encontrado.' });
    return;
  }

  const now = new Date().toISOString();
  const nextStatus = status ?? 'RESOLVED';
  const cleanReply = admin_reply.trim().slice(0, 1500);

  withTransaction(() => {
    const existingMsgCount = (
      db.prepare(`SELECT COUNT(*) as c FROM support_messages WHERE ticket_id = ?`).get(ticket.id) as { c: number }
    ).c;

    if (existingMsgCount === 0) {
      const owner = db.prepare(`SELECT email FROM users WHERE id = ?`).get(ticket.user_id) as { email?: string } | undefined;
      db.prepare(
        `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
         VALUES (?, ?, ?, 'USER', ?, ?, ?)`
      ).run(generateId('smsg'), ticket.id, ticket.user_id, owner?.email || 'utilizador', ticket.message, ticket.created_at);

      if (ticket.admin_reply) {
        db.prepare(
          `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
           VALUES (?, ?, 'admin', 'ADMIN', ?, ?, ?)`
        ).run(generateId('smsg'), ticket.id, ticket.replied_by || 'equipa@milion.space', ticket.admin_reply, ticket.updated_at || ticket.created_at);
      }
    }

    db.prepare(
      `INSERT INTO support_messages (id, ticket_id, sender_id, sender_role, sender_email, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId('smsg'), ticket.id, req.user!.id, req.user!.role, req.user!.email, cleanReply, now);

    db.prepare(
      `UPDATE support_tickets SET admin_reply = ?, status = ?, replied_by = ?, updated_at = ? WHERE id = ?`
    ).run(cleanReply, nextStatus, req.user!.email, now, req.params.id);

    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'ADMIN_SUPPORT_REPLIED',
      entityType: 'SUPPORT_TICKET',
      entityId: req.params.id,
      details: { status: nextStatus },
    });
  });

  res.json({ ok: true });
});

app.post('/api/admin/market/control', requireAdmin, (req: AuthenticatedRequest, res) => {
  const { mode } = req.body as { mode?: MarketControlMode };
  if (mode !== 'AUTO' && mode !== 'FORCE_UP' && mode !== 'FORCE_DOWN' && mode !== 'HOUSE_WIN') {
    res.status(400).json({ error: 'Modo de controlo inválido. Escolha AUTO, FORCE_UP, FORCE_DOWN ou HOUSE_WIN.' });
    return;
  }

  const now = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('market_control_mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(mode, now);

    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'ADMIN_CHART_CONTROL',
      entityType: 'PLATFORM_SETTINGS',
      entityId: 'market_control_mode',
      details: { mode },
    });
  });

  marketEngine.applyControlModeNow();
  res.json({
    ok: true,
    mode,
    settings: getPlatformSettings(),
    snapshot: marketEngine.getGlobalMarketSnapshot(160),
  });
});

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({ settings: getPlatformSettings() });
});

app.patch('/api/admin/settings', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
  const body = req.body as Partial<{
    usd_to_mt_rate: number;
    min_deposit_usd: number;
    min_withdrawal_usd: number;
    proportional_multiplier: number;
    max_gain_pct: number;
    max_duration_days: number;
    market_base_volatility: number;
    market_paused: boolean;
    market_control_mode: MarketControlMode;
  }>;

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const updates: Record<string, string> = {};
  if (body.usd_to_mt_rate !== undefined && body.usd_to_mt_rate >= 1) {
    updates.usd_to_mt_rate = String(Number(body.usd_to_mt_rate));
  }
  if (body.min_deposit_usd !== undefined && body.min_deposit_usd >= 0.5) {
    updates.min_deposit_usd = String(Number(body.min_deposit_usd));
  }
  if (body.min_withdrawal_usd !== undefined && body.min_withdrawal_usd >= 1) {
    updates.min_withdrawal_usd = String(Number(body.min_withdrawal_usd));
  }
  if (body.proportional_multiplier !== undefined && body.proportional_multiplier >= 1 && body.proportional_multiplier <= 100) {
    updates.proportional_multiplier = String(Number(body.proportional_multiplier));
  }
  if (body.max_gain_pct !== undefined && body.max_gain_pct >= 20 && body.max_gain_pct <= 500) {
    updates.max_gain_pct = String(Number(body.max_gain_pct));
  }
  if (body.max_duration_days !== undefined && body.max_duration_days >= 1 && body.max_duration_days <= 30) {
    updates.max_duration_days = String(Number(body.max_duration_days));
  }
  if (body.market_base_volatility !== undefined && body.market_base_volatility >= 0.0002 && body.market_base_volatility <= 0.01) {
    updates.market_base_volatility = String(Number(body.market_base_volatility));
  }
  if (body.market_paused !== undefined) {
    updates.market_paused = body.market_paused ? '1' : '0';
  }
  if (
    body.market_control_mode === 'AUTO' ||
    body.market_control_mode === 'FORCE_UP' ||
    body.market_control_mode === 'FORCE_DOWN' ||
    body.market_control_mode === 'HOUSE_WIN'
  ) {
    updates.market_control_mode = body.market_control_mode;
  }

  withTransaction(() => {
    for (const [k, v] of Object.entries(updates)) {
      upsert.run(k, v, now);
    }
    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'ADMIN_SETTINGS_UPDATED',
      entityType: 'PLATFORM_SETTINGS',
      entityId: 'global',
      details: updates,
    });
  });

  broadcastWs('market:update', marketEngine.getGlobalMarketSnapshot(80));
  res.json({ settings: getPlatformSettings() });
});

app.post('/api/admin/system/reset', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
  const { confirmation } = req.body as { confirmation?: string };
  if ((confirmation || '').trim().toUpperCase() !== 'APAGAR TUDO') {
    res.status(400).json({
      error: 'Confirmação inválida. Escreva exatamente "APAGAR TUDO" para reiniciar os dados da plataforma.',
    });
    return;
  }

  const now = new Date().toISOString();
  withTransaction(() => {
    db.exec(`
      DELETE FROM support_messages;
      DELETE FROM support_tickets;
      DELETE FROM notification_reads;
      DELETE FROM notifications;
      DELETE FROM auth_email_tokens;
      DELETE FROM wallet_ledger;
      DELETE FROM operations;
      DELETE FROM webhook_events;
      DELETE FROM provider_transactions;
      DELETE FROM payment_attempts;
      DELETE FROM withdrawal_reserves;
      DELETE FROM disbursement_orders;
      DELETE FROM reconciliation_records;
      DELETE FROM idempotency_keys;
      DELETE FROM admin_payouts;
      DELETE FROM deposit_requests;
      DELETE FROM withdrawal_requests;
      DELETE FROM market_ticks;
      DELETE FROM market_sessions;
      DELETE FROM audit_logs;
      DELETE FROM revoked_tokens;
      DELETE FROM users WHERE role != 'SUPER_ADMIN';
    `);

    db.prepare(
      `UPDATE wallets
       SET available_balance = 0, locked_balance = 0, pending_balance = 0, reserved_balance = 0, updated_at = ?`
    ).run(now);

    const resetSetting = db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    resetSetting.run('market_paused', '0', now);
    resetSetting.run('market_control_mode', 'AUTO', now);

    logAudit({
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      actorRole: req.user!.role,
      action: 'SYSTEM_FACTORY_RESET',
      entityType: 'PLATFORM',
      entityId: 'milion.space',
      details: {
        message: 'Reinicialização completa executada pelo SUPER_ADMIN (contas SUPER_ADMIN preservadas com carteiras zeradas)',
        executed_at: now,
      },
    });
  });

  marketEngine.resetFresh();
  broadcastWs('market:update', marketEngine.getGlobalMarketSnapshot(120));
  broadcastWs('wallet:update', { userId: req.user!.id });

  res.json({
    ok: true,
    message:
      'Todos os dados operacionais, financeiros, históricos e contas comuns foram apagados do zero. Contas SUPER_ADMIN preservadas.',
  });
});

// ==================== FRONTEND SERVING (VITE DEV OR DIST PROD) ====================

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) {
        next();
        return;
      }
      try {
        const indexPath = path.resolve(process.cwd(), 'index.html');
        let html = fs.readFileSync(indexPath, 'utf-8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MILION.SPACE server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    marketEngine.stop();
    try {
      db.close();
    } catch {
      // ignore
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
