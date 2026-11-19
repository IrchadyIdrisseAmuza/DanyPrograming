import { toMinorUnits } from './db.ts';
import type { MpesaGatewayAdapter, MpesaGatewayResult } from './mpesa.ts';

export interface ZaasPayConfig {
  configured: boolean;
  apiUrl: string;
  apiUrlExplicit: boolean;
  apiUrlValid: boolean;
  key: string;
  keyPresent: boolean;
  keyFormatValid: boolean;
  environment: 'test' | 'live';
  missingVars: string[];
  invalidVars: string[];
}

function isValidZaasPayUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getZaasPayConfig(): ZaasPayConfig {
  const key = (process.env.ZAASPAY_KEY || process.env.ZAASPAY_API_KEY || '').trim();
  const explicitRawUrl = (process.env.ZAASPAY_API_URL || '').trim();
  const apiUrlExplicit = Boolean(explicitRawUrl);
  const apiUrl = (explicitRawUrl || 'https://pay.zaastec.co.mz/v1').replace(/\/+$/, '');
  const apiUrlValid = isValidZaasPayUrl(apiUrl);
  const keyPresent = Boolean(key);
  const keyFormatValid = key.startsWith('sk_test_') || key.startsWith('sk_live_');
  const environment: 'test' | 'live' = key.startsWith('sk_live_') ? 'live' : 'test';

  const missingVars: string[] = [];
  if (!keyPresent) missingVars.push('ZAASPAY_KEY');

  const invalidVars: string[] = [];
  if (keyPresent && !keyFormatValid) invalidVars.push('ZAASPAY_KEY');
  if (apiUrlExplicit && !apiUrlValid) invalidVars.push('ZAASPAY_API_URL');

  return {
    configured: keyPresent && apiUrlValid,
    apiUrl,
    apiUrlExplicit,
    apiUrlValid,
    key,
    keyPresent,
    keyFormatValid,
    environment,
    missingVars,
    invalidVars,
  };
}

function sanitizeZaasPayReference(ref: string): string {
  const cleaned = ref.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
  return cleaned || `MIL-${Date.now().toString().slice(-8)}`;
}

function mapZaasPayErrorMessage(code: string, fallbackMessage?: string): string {
  switch (code) {
    case 'invalid_amount':
      return 'Montante inválido para a ZaasPay. Os pagamentos M-Pesa exigem valor inteiro positivo em Meticais (MT).';
    case 'invalid_phone':
      return 'Número de telefone inválido na ZaasPay. Utilize formato moçambicano válido (25884xxxxxxx ou 25885xxxxxxx).';
    case 'invalid_reference':
      return 'Referência da transação inválida (use até 20 caracteres alfanuméricos ou hífen).';
    case 'invalid_api_key':
      return 'Chave API ZaasPay inválida ou expirada no servidor.';
    case 'account_not_active':
      return 'A conta comerciante ZaasPay encontra-se pendente de ativação ou suspensa.';
    case 'wallet_unavailable':
      return 'Carteira indisponível na ZaasPay para o prefixo indicado (apenas M-Pesa 84/85 ativo).';
    case 'payment_cancelled':
      return 'Pagamento M-Pesa cancelado ou rejeitado pelo cliente no telemóvel.';
    case 'insufficient_funds':
      return 'Saldo insuficiente na carteira M-Pesa do cliente para concluir o pagamento.';
    case 'timeout':
      return 'Tempo limite excedido (120s) enquanto se aguardava o PIN M-Pesa. A verificar estado oficial na ZaasPay.';
    case 'service_unavailable':
      return 'Serviço M-Pesa / ZaasPay temporariamente indisponível. Verifique o estado antes de repetir.';
    case 'payment_not_found':
      return 'Pagamento não encontrado na ZaasPay com esta referência.';
    case 'min_payout_not_met':
      return 'O valor solicitado está abaixo do mínimo permitido para saque na ZaasPay.';
    case 'daily_limit_exceeded':
      return 'Limite diário de saques da conta ZaasPay excedido.';
    case 'insufficient_balance':
      return 'Saldo insuficiente na conta ZaasPay da plataforma (inclui comissão de 2% sobre saques).';
    default:
      return fallbackMessage || `Resposta ZaasPay (${code || 'DESCONHECIDO'}).`;
  }
}

interface ZaasPayPaymentResponse {
  id?: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | string;
  amount?: number;
  fee?: number;
  net?: number;
  currency?: string;
  phone?: string;
  provider?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
  provider_transaction_id?: string | null;
  created_at?: string;
  error?: {
    code?: string;
    message?: string;
    payment_id?: string;
  };
}

interface ZaasPayPayoutResponse {
  id?: string;
  mode?: string;
  amount?: number;
  fee?: number;
  net?: number;
  msisdn?: string;
  wallet?: string;
  status?: 'concluido' | 'em_processamento' | 'falhado' | string;
  provider_transaction_id?: string | null;
  failure_reason?: string | null;
  created_at?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

function mapZaasPayPaymentPayload(
  resStatus: number,
  data: ZaasPayPaymentResponse,
  thirdPartyConversationId: string
): MpesaGatewayResult {
  if (resStatus >= 200 && resStatus < 300 && !data.error) {
    const status = (data.status || '').toLowerCase();
    const confirmedAmountMtCents =
      typeof data.amount === 'number' && Number.isFinite(data.amount)
        ? toMinorUnits(data.amount)
        : undefined;
    const confirmedCurrency = (data.currency || 'MZN').toUpperCase();
    const txId = data.provider_transaction_id || data.id || null;

    if (status === 'succeeded' && txId) {
      return {
        ok: true,
        responseCode: 'INS-0',
        responseDesc: 'ZaasPay M-Pesa payment succeeded',
        transactionId: txId,
        conversationId: data.id || null,
        thirdPartyConversationId,
        confirmedAmountMtCents,
        confirmedCurrency,
        friendlyMessage: 'Pagamento M-Pesa confirmado pela ZaasPay com sucesso.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    if (status === 'unknown') {
      return {
        ok: false,
        acceptedPending: true,
        uncertain: false,
        responseCode: 'UNKNOWN',
        responseDesc: 'Estado provisório unknown na ZaasPay; a aguardar confirmação final.',
        transactionId: data.provider_transaction_id || null,
        conversationId: data.id || null,
        thirdPartyConversationId,
        confirmedAmountMtCents,
        confirmedCurrency,
        friendlyMessage: 'Solicitação M-Pesa ainda em processamento na ZaasPay. A verificar estado...',
        rawPayload: data as Record<string, unknown>,
      };
    }

    if (status === 'failed' || status === 'cancelled') {
      return {
        ok: false,
        acceptedPending: false,
        uncertain: false,
        responseCode: status === 'cancelled' ? 'payment_cancelled' : 'payment_failed',
        responseDesc: `ZaasPay status: ${status}`,
        transactionId: data.provider_transaction_id || null,
        conversationId: data.id || null,
        thirdPartyConversationId,
        friendlyMessage:
          status === 'cancelled'
            ? 'Pagamento M-Pesa cancelado ou rejeitado pelo cliente no telemóvel.'
            : 'O pagamento M-Pesa falhou na operadora.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    return {
      ok: false,
      uncertain: true,
      responseCode: status || 'INDETERMINATE',
      responseDesc: 'Estado indeterminado devolvido pela ZaasPay.',
      transactionId: null,
      conversationId: data.id || null,
      thirdPartyConversationId,
      friendlyMessage: 'Estado indeterminado na ZaasPay. Encaminhado para consulta oficial.',
      rawPayload: data as Record<string, unknown>,
    };
  }

  const errCode = data.error?.code || `HTTP-${resStatus}`;
  const errMessage = data.error?.message || `Erro HTTP ${resStatus} na ZaasPay`;
  const isUncertain =
    resStatus === 408 ||
    resStatus === 503 ||
    resStatus >= 500 ||
    errCode === 'timeout' ||
    errCode === 'service_unavailable';

  return {
    ok: false,
    acceptedPending: false,
    uncertain: isUncertain,
    responseCode: errCode,
    responseDesc: errMessage,
    transactionId: null,
    conversationId: data.error?.payment_id || data.id || null,
    thirdPartyConversationId,
    friendlyMessage: mapZaasPayErrorMessage(errCode, errMessage),
    rawPayload: data as Record<string, unknown>,
  };
}

export async function initiateZaasPayC2B(params: {
  amountMt: number;
  msisdn: string;
  reference: string;
  thirdPartyConversationId: string;
}): Promise<MpesaGatewayResult> {
  const cfg = getZaasPayConfig();
  if (!cfg.configured) {
    throw new Error('MPESA_NOT_CONFIGURED');
  }

  const roundedMt = Math.round(params.amountMt);
  if (!Number.isInteger(params.amountMt) && Math.abs(params.amountMt - roundedMt) > 0.001) {
    return {
      ok: false,
      uncertain: false,
      responseCode: 'invalid_amount',
      responseDesc: `ZaasPay exige valor inteiro em MT (recebido ${params.amountMt}).`,
      transactionId: null,
      conversationId: null,
      thirdPartyConversationId: params.thirdPartyConversationId,
      friendlyMessage: 'A ZaasPay aceita apenas montantes inteiros em Meticais (MT).',
    };
  }

  if (roundedMt < 1 || roundedMt > 10_000_000) {
    return {
      ok: false,
      uncertain: false,
      responseCode: 'invalid_amount',
      responseDesc: `Montante fora dos limites ZaasPay (1 a 10.000.000 MT): ${roundedMt}`,
      transactionId: null,
      conversationId: null,
      thirdPartyConversationId: params.thirdPartyConversationId,
      friendlyMessage: 'O valor do depósito deve estar entre 1 MT e 10.000.000 MT.',
    };
  }

  const controller = new AbortController();
  // Official ZaasPay docs recommend 130,000 ms timeout because C2B awaits customer PIN up to 120s
  const timeout = setTimeout(() => controller.abort(), 130_000);

  try {
    const res = await fetch(`${cfg.apiUrl}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        amount: roundedMt,
        phone: params.msisdn,
        reference: sanitizeZaasPayReference(params.reference),
        metadata: {
          platform: 'MILION.SPACE',
          third_party_ref: params.thirdPartyConversationId,
        },
      }),
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as ZaasPayPaymentResponse;
    return mapZaasPayPaymentPayload(res.status, data, params.thirdPartyConversationId);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      uncertain: true,
      responseCode: isTimeout ? 'timeout' : 'NETWORK_ERROR',
      responseDesc: err instanceof Error ? err.message : 'Falha na comunicação com a API ZaasPay.',
      transactionId: null,
      conversationId: null,
      thirdPartyConversationId: params.thirdPartyConversationId,
      friendlyMessage: isTimeout
        ? 'A ZaasPay não respondeu dentro do limite de 130s. A consultar o estado pela referência...'
        : 'Falha de comunicação com a API ZaasPay. A verificar estado da transação...',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryZaasPayPaymentStatus(params: {
  queryReference: string;
  thirdPartyConversationId: string;
  reference?: string;
}): Promise<MpesaGatewayResult> {
  const cfg = getZaasPayConfig();
  if (!cfg.configured) {
    throw new Error('MPESA_NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const isPaymentId = params.queryReference.startsWith('pay_');
    const url = isPaymentId
      ? `${cfg.apiUrl}/payments/${encodeURIComponent(params.queryReference)}`
      : `${cfg.apiUrl}/payments/by-reference/${encodeURIComponent(
          sanitizeZaasPayReference(params.reference || params.queryReference || params.thirdPartyConversationId)
        )}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as ZaasPayPaymentResponse;
    if (res.status === 404) {
      return {
        ok: false,
        acceptedPending: false,
        uncertain: false,
        responseCode: data.error?.code || 'payment_not_found',
        responseDesc: data.error?.message || 'Pagamento não encontrado na ZaasPay.',
        transactionId: null,
        conversationId: null,
        thirdPartyConversationId: params.thirdPartyConversationId,
        friendlyMessage: 'Pagamento não encontrado ou expirado na ZaasPay.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    return mapZaasPayPaymentPayload(res.status, data, params.thirdPartyConversationId);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      uncertain: true,
      responseCode: isTimeout ? 'timeout' : 'NETWORK_ERROR',
      responseDesc: err instanceof Error ? err.message : 'Erro ao consultar pagamento ZaasPay.',
      transactionId: null,
      conversationId: null,
      thirdPartyConversationId: params.thirdPartyConversationId,
      friendlyMessage: 'Não foi possível confirmar o estado na ZaasPay neste momento; a manter em reconciliação.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mapZaasPayPayoutPayload(
  resStatus: number,
  data: ZaasPayPayoutResponse,
  thirdPartyConversationId: string
): MpesaGatewayResult {
  if (resStatus >= 200 && resStatus < 300 && !data.error) {
    const status = (data.status || '').toLowerCase();
    const txId = data.provider_transaction_id || data.id || null;

    if (
      (status === 'concluido' ||
        status === 'completed' ||
        status === 'succeeded' ||
        status === 'paid') &&
      txId
    ) {
      return {
        ok: true,
        responseCode: 'INS-0',
        responseDesc: 'Saque M-Pesa ZaasPay concluído com sucesso.',
        transactionId: txId,
        conversationId: data.id || null,
        thirdPartyConversationId,
        confirmedAmountMtCents:
          typeof data.net === 'number' && Number.isFinite(data.net) ? toMinorUnits(data.net) : undefined,
        confirmedCurrency: 'MZN',
        friendlyMessage: 'Saque para terceiros concluído via ZaasPay M-Pesa com sucesso.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    if (
      status === 'em_processamento' ||
      status === 'processing' ||
      status === 'pending' ||
      status === 'unknown'
    ) {
      return {
        ok: false,
        acceptedPending: true,
        uncertain: true,
        responseCode: 'EM_PROCESSAMENTO',
        responseDesc: `Saque ZaasPay (${data.id || 'sem-id'}) em processamento na operadora.`,
        transactionId: data.provider_transaction_id || null,
        conversationId: data.id || null,
        thirdPartyConversationId,
        friendlyMessage:
          'Saque submetido à ZaasPay em processamento ("em_processamento"). A reserva permanece retida até confirmação final.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    if (
      status === 'falhado' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'rejected'
    ) {
      return {
        ok: false,
        acceptedPending: false,
        uncertain: false,
        responseCode: 'PAYOUT_FAILED',
        responseDesc: data.failure_reason || 'Saque M-Pesa rejeitado ou falhado na operadora.',
        transactionId: null,
        conversationId: data.id || null,
        thirdPartyConversationId,
        friendlyMessage: data.failure_reason || 'Saque falhado na ZaasPay; saldo libertado.',
        rawPayload: data as Record<string, unknown>,
      };
    }

    return {
      ok: false,
      uncertain: true,
      responseCode: status || 'INDETERMINATE',
      responseDesc: 'Estado indeterminado no saque ZaasPay.',
      transactionId: null,
      conversationId: data.id || null,
      thirdPartyConversationId,
      friendlyMessage: 'Estado indeterminado no saque ZaasPay; a aguardar reconciliação.',
      rawPayload: data as Record<string, unknown>,
    };
  }

  const errCode = data.error?.code || `HTTP-${resStatus}`;
  const errMessage = data.error?.message || `Erro HTTP ${resStatus} ao executar saque na ZaasPay`;
  const hasExplicitProviderRejection =
    Boolean(data.error?.code) &&
    !data.id &&
    errCode !== 'timeout' &&
    errCode !== 'service_unavailable';
  const isUncertain =
    !hasExplicitProviderRejection &&
    (resStatus === 408 ||
      resStatus === 503 ||
      resStatus >= 500 ||
      errCode === 'timeout' ||
      errCode === 'service_unavailable');

  return {
    ok: false,
    acceptedPending: false,
    uncertain: isUncertain,
    responseCode: errCode,
    responseDesc: errMessage,
    transactionId: null,
    conversationId: data.id || null,
    thirdPartyConversationId,
    friendlyMessage: mapZaasPayErrorMessage(errCode, errMessage),
    rawPayload: data as Record<string, unknown>,
  };
}

export async function initiateZaasPayB2CPayout(params: {
  amountMt: number;
  msisdn: string;
  reference: string;
  thirdPartyConversationId: string;
}): Promise<MpesaGatewayResult> {
  const cfg = getZaasPayConfig();
  if (!cfg.configured) {
    throw new Error('MPESA_NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(`${cfg.apiUrl}/payouts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        amount: Number(params.amountMt.toFixed(2)),
        phone: params.msisdn,
      }),
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as ZaasPayPayoutResponse;
    return mapZaasPayPayoutPayload(res.status, data, params.thirdPartyConversationId);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      uncertain: true,
      responseCode: isTimeout ? 'timeout' : 'NETWORK_ERROR',
      responseDesc: err instanceof Error ? err.message : 'Falha na ligação ao endpoint de saques ZaasPay.',
      transactionId: null,
      conversationId: null,
      thirdPartyConversationId: params.thirdPartyConversationId,
      friendlyMessage: 'Timeout ou falha de rede no saque ZaasPay. Reserva mantida em reconciliação para evitar envio duplo.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryZaasPayPayoutStatus(params: {
  payoutId: string;
  reference?: string;
}): Promise<MpesaGatewayResult> {
  const cfg = getZaasPayConfig();
  if (!cfg.configured) {
    throw new Error('MPESA_NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(`${cfg.apiUrl}/payouts/${encodeURIComponent(params.payoutId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => ({}))) as ZaasPayPayoutResponse;
    if (res.status === 404) {
      return {
        ok: false,
        uncertain: true,
        responseCode: 'payout_not_found',
        responseDesc: data.error?.message || 'Saque não encontrado na ZaasPay.',
        transactionId: null,
        conversationId: params.payoutId,
        thirdPartyConversationId: params.reference || params.payoutId,
        friendlyMessage: 'Registo de saque não encontrado na ZaasPay; verifique manualmente antes de libertar reserva.',
        rawPayload: data as Record<string, unknown>,
      };
    }
    return mapZaasPayPayoutPayload(res.status, data, params.reference || params.payoutId);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      uncertain: true,
      responseCode: isTimeout ? 'timeout' : 'NETWORK_ERROR',
      responseDesc: err instanceof Error ? err.message : 'Erro ao consultar saque ZaasPay.',
      transactionId: null,
      conversationId: params.payoutId,
      thirdPartyConversationId: params.reference || params.payoutId,
      friendlyMessage: 'Falha ao consultar estado do saque na ZaasPay.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const zaaspayGateway: MpesaGatewayAdapter = {
  isConfigured: () => getZaasPayConfig().configured,
  getProviderName: () => 'ZAASPAY_MPESA',
  requiresIntegerMt: () => true,
  initiateC2B: initiateZaasPayC2B,
  initiateB2C: initiateZaasPayB2CPayout,
  queryTransactionStatus: queryZaasPayPaymentStatus,
  queryPayoutStatus: queryZaasPayPayoutStatus,
};
