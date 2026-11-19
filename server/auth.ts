import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';

const TOKEN_SECRET = process.env.SESSION_SECRET || 'milion-space-demo-hmac-secret-2026-audit';

export interface AuthUser {
  id: string;
  public_code: string;
  full_name: string;
  username: string;
  phone: string;
  email: string;
  role: 'USER' | 'ADMIN' | 'SUPER_ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
  email_verified: boolean;
  created_at: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function createSessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      uid: userId,
      jti: crypto.randomUUID(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function hashJti(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function verifySessionToken(token: string): { uid: string; jti?: string; exp: number } | null {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid: string;
      jti?: string;
      exp: number;
    };
    if (!parsed.uid || parsed.exp < Date.now()) return null;

    if (parsed.jti) {
      const revoked = db
        .prepare(`SELECT 1 as ok FROM revoked_tokens WHERE jti_hash = ?`)
        .get(hashJti(parsed.jti)) as { ok?: number } | undefined;
      if (revoked) return null;
    }

    return { uid: parsed.uid, jti: parsed.jti, exp: parsed.exp };
  } catch {
    return null;
  }
}

export function revokeSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const decoded = verifySessionToken(token);
  if (!decoded) return false;
  const key = hashJti(decoded.jti || token);
  const expIso = new Date(decoded.exp).toISOString();
  try {
    db.prepare(`INSERT OR IGNORE INTO revoked_tokens (jti_hash, expires_at) VALUES (?, ?)`).run(key, expIso);
    db.prepare(`DELETE FROM revoked_tokens WHERE expires_at < ?`).run(new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

export function getUserFromToken(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const decoded = verifySessionToken(token);
  if (!decoded) return null;
  const row = db
    .prepare(
      `SELECT id, public_code, full_name, username, phone, email, role, status, COALESCE(email_verified, 0) as email_verified, created_at
       FROM users WHERE id = ?`
    )
    .get(decoded.uid) as (Omit<AuthUser, 'email_verified'> & { email_verified: number }) | undefined;
  if (!row) return null;
  return {
    ...row,
    email_verified: Boolean(row.email_verified),
  };
}

export function requireAuthAllowPending(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const user = getUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: 'Sessão inválida ou expirada. Inicie sessão novamente.' });
    return;
  }
  if (user.status === 'SUSPENDED') {
    res.status(403).json({ error: 'Conta suspensa pelo administrador.' });
    return;
  }
  req.user = user;
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  requireAuthAllowPending(req, res, () => {
    if (req.user?.status === 'PENDING_VERIFICATION') {
      res.status(403).json({
        error: 'Confirme o seu endereço de e-mail para desbloquear o acesso à plataforma.',
        code: 'EMAIL_NOT_VERIFIED',
      });
      return;
    }
    next();
  });
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN')) {
      res.status(403).json({ error: 'Acesso restrito a administradores.' });
      return;
    }
    next();
  });
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!req.user || req.user.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Ação restrita ao Super Administrador.' });
      return;
    }
    next();
  });
}
