import crypto from 'node:crypto';

export interface MpesaGatewayResult {
  ok: boolean;
  acceptedPending?: boolean;
  uncertain?: boolean;
  responseCode: string;
  responseDesc: string;
  transactionId: string | null;
  conversationId: string | null;
  thirdPartyConversationId: string;
  friendlyMessage: string;
  confirmedAmountMtCents?: number;
  confirmedCurrency?: string;
  rawPayload?: Record<string, unknown>;
}

export interface MpesaGatewayAdapter {
  isConfigured(): boolean;
  getProviderName(): string;
  requiresIntegerMt?(): boolean;
  initiateC2B(params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }): Promise<MpesaGatewayResult>;
  initiateB2C(params: {
    amountMt: number;
    msisdn: string;
    reference: string;
    thirdPartyConversationId: string;
  }): Promise<MpesaGatewayResult>;
  queryTransactionStatus?(params: {
    queryReference: string;
    thirdPartyConversationId: string;
    reference?: string;
  }): Promise<MpesaGatewayResult>;
  queryPayoutStatus?(params: {
    payoutId: string;
    reference?: string;
  }): Promise<MpesaGatewayResult>;
}

/**
 * Normalizes Mozambican M-Pesa numbers (prefixes 84 or 85) to `25884xxxxxxx` / `25885xxxxxxx`.
 */
export function normalizeMozMpesaMsisdn(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^(84|85)\d{7}$/.test(digits)) {
    return `258${digits}`;
  }
  if (/^258(84|85)\d{7}$/.test(digits)) {
    return digits;
  }
  if (/^00258(84|85)\d{7}$/.test(digits)) {
    return digits.slice(2);
  }
  return null;
}

export function formatMpesaDisplay(msisdn?: string | null): string {
  if (!msisdn) return '—';
  const norm = normalizeMozMpesaMsisdn(msisdn);
  if (!norm) return msisdn;
  return `+258 ${norm.slice(3, 5)} ${norm.slice(5, 8)} ${norm.slice(8)}`;
}

/**
 * Masks MSISDN for privacy in UI, admin views, and logs: `+258 84 *** 4567`.
 */
export function maskMsisdn(msisdn?: string | null): string {
  if (!msisdn) return '—';
  const norm = normalizeMozMpesaMsisdn(msisdn);
  if (norm && norm.length === 12) {
    return `+258 ${norm.slice(3, 5)} *** ${norm.slice(8)}`;
  }
  const digits = msisdn.replace(/\D/g, '');
  if (digits.length >= 6) {
    return `***${digits.slice(-4)}`;
  }
  return '***';
}

export function hashMsisdn(msisdn: string): string {
  return crypto.createHash('sha256').update(msisdn).digest('hex');
}

/**
 * Constant-time webhook authentication supporting HMAC-SHA256 signature (`x-mpesa-signature`)
 * or shared secret (`x-mpesa-callback-secret` / `?secret=...`).
 */
export function verifyMpesaWebhookAuth(params: {
  secret: string;
  requireSecret?: boolean;
  providedSecretHeader?: string;
  providedQuerySecret?: string;
  providedSignatureHeader?: string;
  rawBodyString?: string;
}): boolean {
  if (!params.secret) {
    return !params.requireSecret;
  }

  const candidateSecret = (params.providedSecretHeader || params.providedQuerySecret || '').trim();
  if (candidateSecret) {
    const a = Buffer.from(candidateSecret, 'utf8');
    const b = Buffer.from(params.secret, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  const sig = (params.providedSignatureHeader || '').trim().replace(/^sha256=/i, '');
  if (sig && params.rawBodyString !== undefined) {
    const expected = crypto
      .createHmac('sha256', params.secret)
      .update(params.rawBodyString, 'utf8')
      .digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  return false;
}
