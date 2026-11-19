import { logAudit } from './db.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';
export const DEFAULT_RESEND_FROM = 'MILION.SPACE <noreply@milion.space>';

export type EmailKind =
  | 'ACCOUNT_CONFIRMATION'
  | 'PASSWORD_RECOVERY'
  | 'VERIFICATION_CODE'
  | 'SECURITY_NOTIFICATION'
  | 'ADMIN_TRANSFER_NOTIFICATION'
  | 'TRANSFER_STATUS_NOTIFICATION'
  | 'OPERATION_SETTLED';

export interface SendEmailResult {
  ok: boolean;
  configured: boolean;
  id?: string;
  statusCode?: number;
  error?: string;
}

export function isResendConfigured(): boolean {
  const key = process.env.RESEND_API_KEY?.trim();
  return Boolean(key && key.length >= 8 && !key.startsWith('MY_'));
}

export function getResendFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_RESEND_FROM;
}

export function getAppPublicUrl(): string {
  const raw =
    process.env.APP_PUBLIC_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    'https://milion.space';
  return raw.replace(/\/$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailLayout(params: {
  preheader: string;
  title: string;
  greetingName: string;
  bodyHtml: string;
  footerNote?: string;
}): string {
  const safeTitle = escapeHtml(params.title);
  const safeName = escapeHtml(params.greetingName || 'Cliente');
  const safeFooter = escapeHtml(
    params.footerNote ||
      'Este e-mail foi enviado automaticamente pela plataforma MILION.SPACE. Nunca partilhe os seus códigos de verificação com terceiros.'
  );
  const appUrl = escapeHtml(getAppPublicUrl());

  return `<!doctype html>
<html lang="pt">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#090d16;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(params.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#090d16;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#101724;border:1px solid #1e293b;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #1e293b;background-color:#0c1320;">
                <div style="font-size:12px;letter-spacing:0.12em;color:#22d3ee;font-weight:700;">MILION.SPACE</div>
                <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3;color:#ffffff;font-weight:700;">${safeTitle}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#cbd5e1;">Olá, <strong style="color:#ffffff;">${safeName}</strong>,</p>
                ${params.bodyHtml}
                <div style="margin-top:24px;padding-top:18px;border-top:1px solid #1e293b;">
                  <a href="${appUrl}" style="display:inline-block;padding:10px 18px;background-color:#22d3ee;color:#06101d;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;">Aceder à MILION.SPACE</a>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background-color:#0b111c;border-top:1px solid #1e293b;font-size:12px;line-height:1.5;color:#64748b;">
                ${safeFooter}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: EmailKind;
  actorId?: string | null;
  actorRole?: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith('MY_')) {
    const errorMsg = 'RESEND_API_KEY não está configurada no backend.';
    logAudit({
      actorId: params.actorId ?? null,
      actorEmail: params.to,
      actorRole: params.actorRole || 'SYSTEM',
      action: 'EMAIL_SEND_UNCONFIGURED',
      entityType: 'EMAIL',
      entityId: params.kind,
      details: { to: params.to, kind: params.kind, error: errorMsg },
    });
    return { ok: false, configured: false, error: errorMsg };
  }

  const from = getResendFromAddress();
  const endpoint = process.env.RESEND_API_URL?.trim() || RESEND_API_URL;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });

    const rawText = await response.text();
    const parsed = ((): { id?: string; message?: string; name?: string; error?: string } | null => {
      if (!rawText) return null;
      try {
        return JSON.parse(rawText) as { id?: string; message?: string; name?: string; error?: string };
      } catch {
        return null;
      }
    })();

    if (!response.ok) {
      const errDetail =
        parsed?.message ||
        parsed?.error ||
        rawText ||
        `Erro HTTP ${response.status} ao comunicar com o Resend.`;
      logAudit({
        actorId: params.actorId ?? null,
        actorEmail: params.to,
        actorRole: params.actorRole || 'SYSTEM',
        action: 'EMAIL_SEND_FAILED',
        entityType: 'EMAIL',
        entityId: params.kind,
        details: {
          to: params.to,
          kind: params.kind,
          statusCode: response.status,
          error: errDetail,
        },
      });
      return {
        ok: false,
        configured: true,
        statusCode: response.status,
        error: errDetail,
      };
    }

    logAudit({
      actorId: params.actorId ?? null,
      actorEmail: params.to,
      actorRole: params.actorRole || 'SYSTEM',
      action: 'EMAIL_SENT',
      entityType: 'EMAIL',
      entityId: parsed?.id || params.kind,
      details: {
        to: params.to,
        from,
        kind: params.kind,
        resend_id: parsed?.id || null,
      },
    });

    return {
      ok: true,
      configured: true,
      id: parsed?.id,
      statusCode: response.status,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Falha de rede ao contactar a API do Resend.';
    logAudit({
      actorId: params.actorId ?? null,
      actorEmail: params.to,
      actorRole: params.actorRole || 'SYSTEM',
      action: 'EMAIL_SEND_ERROR',
      entityType: 'EMAIL',
      entityId: params.kind,
      details: { to: params.to, kind: params.kind, error: message },
    });
    return {
      ok: false,
      configured: true,
      error: message,
    };
  }
}

export async function sendAccountConfirmationEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  publicCode: string;
  verificationCode: string;
  expiresMinutes?: number;
}): Promise<SendEmailResult> {
  const expiresMinutes = params.expiresMinutes ?? 30;
  const safeCode = escapeHtml(params.verificationCode);
  const safePublicCode = escapeHtml(params.publicCode);

  const html = buildEmailLayout({
    preheader: `Código de confirmação da sua conta MILION.SPACE: ${params.verificationCode}`,
    title: 'Confirmação de Conta MILION.SPACE',
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        A sua conta <strong style="color:#ffffff;">${safePublicCode}</strong> foi criada na plataforma MILION.SPACE.
        Para confirmar o seu endereço de e-mail, utilize o código de verificação abaixo:
      </p>
      <div style="margin:20px 0;padding:16px;background-color:#090d16;border:1px solid #164e63;border-radius:10px;text-align:center;">
        <div style="font-size:11px;letter-spacing:0.12em;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;">Código de Verificação</div>
        <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:0.2em;color:#22d3ee;">${safeCode}</div>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
        Este código expira em <strong style="color:#e2e8f0;">${expiresMinutes} minutos</strong>. Se não criou esta conta, ignore esta mensagem.
      </p>
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    `A sua conta ${params.publicCode} foi criada na MILION.SPACE.`,
    `Código de verificação para confirmar o seu e-mail: ${params.verificationCode}`,
    `Este código expira em ${expiresMinutes} minutos.`,
    '',
    `Aceda em: ${getAppPublicUrl()}`,
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject: 'Confirme a sua conta — MILION.SPACE',
    html,
    text,
    kind: 'ACCOUNT_CONFIRMATION',
    actorId: params.userId,
    actorRole: 'USER',
  });
}

export async function sendPasswordRecoveryEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  recoveryCode: string;
  expiresMinutes?: number;
}): Promise<SendEmailResult> {
  const expiresMinutes = params.expiresMinutes ?? 15;
  const safeCode = escapeHtml(params.recoveryCode);

  const html = buildEmailLayout({
    preheader: `Código de recuperação de palavra-passe: ${params.recoveryCode}`,
    title: 'Recuperação de Palavra-Passe',
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        Recebemos um pedido para redefinir a palavra-passe da sua conta MILION.SPACE. Introduza o código abaixo na página de recuperação:
      </p>
      <div style="margin:20px 0;padding:16px;background-color:#090d16;border:1px solid #164e63;border-radius:10px;text-align:center;">
        <div style="font-size:11px;letter-spacing:0.12em;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;">Código de Recuperação</div>
        <div style="font-family:'Courier New',monospace;font-size:26px;font-weight:700;letter-spacing:0.16em;color:#22d3ee;">${safeCode}</div>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
        Válido por <strong style="color:#e2e8f0;">${expiresMinutes} minutos</strong> e de utilização única. Caso não tenha solicitado esta alteração, recomendamos que verifique a segurança da sua conta imediatamente.
      </p>
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    'Recebemos um pedido para redefinir a palavra-passe da sua conta MILION.SPACE.',
    `Código de recuperação: ${params.recoveryCode}`,
    `Validade: ${expiresMinutes} minutos (utilização única).`,
    '',
    'Se não solicitou esta alteração, ignore este e-mail.',
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject: 'Recuperação de palavra-passe — MILION.SPACE',
    html,
    text,
    kind: 'PASSWORD_RECOVERY',
    actorId: params.userId,
  });
}

export async function sendVerificationCodeEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  code: string;
  expiresMinutes?: number;
}): Promise<SendEmailResult> {
  const expiresMinutes = params.expiresMinutes ?? 15;
  const safeCode = escapeHtml(params.code);

  const html = buildEmailLayout({
    preheader: `O seu código de verificação MILION.SPACE é ${params.code}`,
    title: 'Código de Verificação',
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        Utilize o seguinte código de verificação para validar o seu endereço de e-mail na plataforma MILION.SPACE:
      </p>
      <div style="margin:20px 0;padding:16px;background-color:#090d16;border:1px solid #164e63;border-radius:10px;text-align:center;">
        <div style="font-size:11px;letter-spacing:0.12em;color:#94a3b8;text-transform:uppercase;margin-bottom:6px;">Código Único</div>
        <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:0.2em;color:#22d3ee;">${safeCode}</div>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
        Este código é válido durante <strong style="color:#e2e8f0;">${expiresMinutes} minutos</strong>.
      </p>
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    `O seu código de verificação MILION.SPACE é: ${params.code}`,
    `Válido durante ${expiresMinutes} minutos.`,
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject: 'Código de verificação — MILION.SPACE',
    html,
    text,
    kind: 'VERIFICATION_CODE',
    actorId: params.userId,
  });
}

export async function sendSecurityNotificationEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  eventTitle: string;
  eventSummary: string;
  ipAddress?: string;
  timestampIso?: string;
}): Promise<SendEmailResult> {
  const when = params.timestampIso || new Date().toISOString();
  const safeTitle = escapeHtml(params.eventTitle);
  const safeSummary = escapeHtml(params.eventSummary);
  const safeIp = escapeHtml(params.ipAddress || 'Não identificado');
  const safeWhen = escapeHtml(new Date(when).toLocaleString('pt-PT', { timeZone: 'UTC' }) + ' UTC');

  const html = buildEmailLayout({
    preheader: `Alerta de segurança MILION.SPACE: ${params.eventTitle}`,
    title: 'Notificação de Segurança',
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        Registámos o seguinte evento de segurança na sua conta MILION.SPACE:
      </p>
      <div style="margin:16px 0;padding:16px;background-color:#090d16;border:1px solid #334155;border-radius:10px;">
        <div style="font-size:15px;font-weight:700;color:#ffffff;margin-bottom:6px;">${safeTitle}</div>
        <div style="font-size:13px;line-height:1.6;color:#cbd5e1;margin-bottom:10px;">${safeSummary}</div>
        <div style="font-size:12px;color:#94a3b8;">Data/Hora: <span style="color:#e2e8f0;">${safeWhen}</span></div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Endereço IP: <span style="color:#e2e8f0;">${safeIp}</span></div>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
        Se reconhece esta atividade, não é necessária qualquer ação. Caso contrário, altere imediatamente a sua palavra-passe e contacte o suporte.
      </p>
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    `Notificação de Segurança MILION.SPACE: ${params.eventTitle}`,
    params.eventSummary,
    `Data/Hora: ${when}`,
    `IP: ${params.ipAddress || 'Não identificado'}`,
    '',
    'Se não reconhece esta atividade, redefina a sua palavra-passe imediatamente.',
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject: `Alerta de segurança: ${params.eventTitle} — MILION.SPACE`,
    html,
    text,
    kind: 'SECURITY_NOTIFICATION',
    actorId: params.userId,
  });
}

export function buildAdminReviewUrl(params: {
  transferType: 'DEPOSIT' | 'WITHDRAWAL';
  entityId: string;
  decision: 'APPROVED' | 'REJECTED';
}): string {
  const kind = params.transferType === 'DEPOSIT' ? 'deposit' : 'withdrawal';
  const query = new URLSearchParams({
    admin_action: 'review',
    kind,
    id: params.entityId,
    decision: params.decision,
  });
  return `${getAppPublicUrl()}/?${query.toString()}`;
}

export async function sendAdminTransferNotificationEmail(params: {
  to: string;
  transferType: 'DEPOSIT' | 'WITHDRAWAL';
  entityId: string;
  reference: string;
  userId: string;
  userFullName: string;
  userPublicCode: string;
  userEmail: string;
  amountUsd: number;
  amountMt?: number;
  exchangeRate?: number;
  method: string;
  msisdnMasked?: string | null;
  statusLabel: string;
  riskScore?: number;
  riskFlags?: string[];
  createdAtIso?: string;
}): Promise<SendEmailResult> {
  const rate = params.exchangeRate && params.exchangeRate > 0 ? params.exchangeRate : 70;
  const amountMt =
    typeof params.amountMt === 'number' && Number.isFinite(params.amountMt)
      ? params.amountMt
      : Number((params.amountUsd * rate).toFixed(2));
  const formattedUsd = `${params.amountUsd.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  const formattedMt = `${amountMt.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MT`;
  const isDeposit = params.transferType === 'DEPOSIT';
  const heading = isDeposit ? 'Novo pedido de depósito' : 'Novo pedido de levantamento';
  const approveUrl = buildAdminReviewUrl({
    transferType: params.transferType,
    entityId: params.entityId,
    decision: 'APPROVED',
  });
  const rejectUrl = buildAdminReviewUrl({
    transferType: params.transferType,
    entityId: params.entityId,
    decision: 'REJECTED',
  });
  const when = params.createdAtIso || new Date().toISOString();
  const safeMethod = escapeHtml(
    params.msisdnMasked ? `${params.method} (${params.msisdnMasked})` : params.method
  );
  const safeUserDisplay = escapeHtml(`${params.userFullName} (${params.userPublicCode})`);
  const safeUserEmail = escapeHtml(params.userEmail);
  const safeRef = escapeHtml(params.reference);
  const safeStatus = escapeHtml(params.statusLabel);
  const safeRisk =
    typeof params.riskScore === 'number'
      ? `${params.riskScore}/100${params.riskFlags && params.riskFlags.length > 0 ? ` (${params.riskFlags.join(', ')})` : ' (Normal)'}`
      : null;

  const html = buildEmailLayout({
    preheader: `${heading} · ${params.reference} · $${params.amountUsd.toFixed(2)} USD (${amountMt.toFixed(2)} MT)`,
    title: `MILION.SPACE — Administração · ${heading}`,
    greetingName: 'Equipa Administrativa',
    bodyHtml: `
      <div style="margin:0 0 14px;display:inline-block;padding:4px 10px;border-radius:6px;background-color:#422006;border:1px solid #f59e0b;color:#fcd34d;font-size:12px;font-weight:700;">
        Pendente · ${safeStatus}
      </div>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        Foi registado um novo pedido de <strong style="color:#ffffff;">${isDeposit ? 'depósito' : 'levantamento'}</strong> que requer acompanhamento administrativo:
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;border:1px solid #1e293b;border-radius:10px;background-color:#090d16;overflow:hidden;font-size:13px;">
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;width:36%;">Utilizador</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;font-weight:600;">${safeUserDisplay}<br/><span style="font-weight:400;color:#94a3b8;font-size:12px;">${safeUserEmail}</span></td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Referência</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#22d3ee;font-family:'Courier New',monospace;font-weight:700;">${safeRef}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Valor</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;font-weight:700;">${escapeHtml(formattedUsd)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Equivalente</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#e2e8f0;">${escapeHtml(formattedMt)} <span style="color:#64748b;">(1 USD = ${rate} MT)</span></td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Método</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#e2e8f0;">${safeMethod}</td>
        </tr>
        ${
          safeRisk
            ? `<tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Análise de Risco</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#fcd34d;">${escapeHtml(safeRisk)}</td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:10px 14px;color:#94a3b8;">Estado</td>
          <td style="padding:10px 14px;color:#fbbf24;font-weight:600;">${safeStatus}</td>
        </tr>
      </table>
      <div style="margin:20px 0 12px;">
        <a href="${escapeHtml(approveUrl)}" style="display:inline-block;margin-right:10px;margin-bottom:8px;padding:10px 18px;background-color:#10b981;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;">Aprovar</a>
        <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;margin-bottom:8px;padding:10px 18px;background-color:#ef4444;color:#ffffff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:700;">Rejeitar</a>
      </div>
      <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">
        Por segurança, abrir estas ligações direciona para o Painel Administrativo autenticado. Nenhuma operação é aprovada ou rejeitada automaticamente por pedido GET — é exigida autenticação administrativa e confirmação explícita no servidor. Data UTC: ${escapeHtml(when)}.
      </p>
    `,
  });

  const text = [
    `MILION.SPACE — Administração`,
    `${heading} (${params.statusLabel})`,
    `Utilizador: ${params.userFullName} (${params.userPublicCode}) <${params.userEmail}>`,
    `Referência: ${params.reference}`,
    `Valor: ${formattedUsd}`,
    `Equivalente: ${formattedMt} (1 USD = ${rate} MT)`,
    `Método: ${params.msisdnMasked ? `${params.method} (${params.msisdnMasked})` : params.method}`,
    `Estado: ${params.statusLabel}`,
    '',
    `Aprovar (painel seguro com autenticação e confirmação): ${approveUrl}`,
    `Rejeitar (painel seguro com autenticação e confirmação): ${rejectUrl}`,
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject: `[Admin] ${heading}: ${params.reference} (${formattedUsd}) — MILION.SPACE`,
    html,
    text,
    kind: 'ADMIN_TRANSFER_NOTIFICATION',
    actorId: params.userId,
    actorRole: 'ADMIN',
  });
}

export async function sendTransferStatusEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  transferType: 'DEPOSIT' | 'WITHDRAWAL';
  reference: string;
  amountUsd: number;
  amountMt?: number;
  exchangeRate?: number;
  method: string;
  statusLabel: string;
  outcomeSummary: string;
  notes?: string | null;
}): Promise<SendEmailResult> {
  const rate = params.exchangeRate && params.exchangeRate > 0 ? params.exchangeRate : 70;
  const amountMt =
    typeof params.amountMt === 'number' && Number.isFinite(params.amountMt)
      ? params.amountMt
      : Number((params.amountUsd * rate).toFixed(2));
  const label = params.transferType === 'DEPOSIT' ? 'Depósito' : 'Levantamento';
  const formattedUsd = `$${params.amountUsd.toFixed(2)} USD`;
  const formattedMt = `${amountMt.toFixed(2)} MT`;

  const html = buildEmailLayout({
    preheader: `${label} ${params.reference} — ${params.statusLabel}`,
    title: `Atualização de ${label} — ${params.reference}`,
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        ${escapeHtml(params.outcomeSummary)}
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;border:1px solid #1e293b;border-radius:10px;background-color:#090d16;overflow:hidden;font-size:13px;">
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;width:36%;">Referência</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#22d3ee;font-family:'Courier New',monospace;font-weight:700;">${escapeHtml(params.reference)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Valor</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;font-weight:700;">${escapeHtml(formattedUsd)} (${escapeHtml(formattedMt)})</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Método</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#e2e8f0;">${escapeHtml(params.method)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;color:#94a3b8;">Estado</td>
          <td style="padding:10px 14px;color:#ffffff;font-weight:700;">${escapeHtml(params.statusLabel)}</td>
        </tr>
      </table>
      ${
        params.notes
          ? `<p style="margin:0 0 12px;font-size:13px;color:#94a3b8;">Observação: <span style="color:#e2e8f0;">${escapeHtml(params.notes)}</span></p>`
          : ''
      }
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    params.outcomeSummary,
    `Referência: ${params.reference}`,
    `Valor: ${formattedUsd} (${formattedMt}, taxa 1 USD = ${rate} MT)`,
    `Método: ${params.method}`,
    `Estado: ${params.statusLabel}`,
    params.notes ? `Observação: ${params.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return sendResendEmail({
    to: params.to,
    subject: `${label} ${params.reference}: ${params.statusLabel} — MILION.SPACE`,
    html,
    text,
    kind: 'TRANSFER_STATUS_NOTIFICATION',
    actorId: params.userId,
    actorRole: 'USER',
  });
}

export async function sendOperationSettledEmail(params: {
  userId: string;
  to: string;
  fullName: string;
  reference: string;
  direction: 'SUBIDA' | 'DESCIDA';
  amountUsd: number;
  payoutUsd: number;
  netResultUsd: number;
  returnPct: number;
  entryPrice: number;
  exitPrice: number;
  terminationReason: 'ZEROED_OUT' | 'ZEROED_AT_EXPIRY' | 'EXPIRED';
}): Promise<SendEmailResult> {
  const isZeroed = params.terminationReason === 'ZEROED_OUT' || params.terminationReason === 'ZEROED_AT_EXPIRY' || params.payoutUsd <= 0;
  const isGain = !isZeroed && params.netResultUsd > 0;
  const isEarlyZero = params.terminationReason === 'ZEROED_OUT';

  const statusLabel = isZeroed
    ? isEarlyZero
      ? 'Zerou ($0.00) · Encerrada de imediato'
      : 'Terminou em $0.00 (Zerou no vencimento)'
    : isGain
      ? `Terminou com Ganho (+$${params.netResultUsd.toFixed(2)})`
      : params.netResultUsd < 0
        ? `Terminou com Perda (-$${Math.abs(params.netResultUsd).toFixed(2)})`
        : 'Terminou Neutro ($0.00)';

  const summaryText = isZeroed
    ? `A sua operação ${params.reference} (${params.direction}) atingiu $0.00 (zerou) no preço de $${params.exitPrice.toFixed(2)} e foi encerrada automaticamente.`
    : isGain
      ? `A sua operação ${params.reference} (${params.direction}) terminou com ganho de +$${params.netResultUsd.toFixed(2)} (${params.returnPct >= 0 ? '+' : ''}${params.returnPct.toFixed(2)}%). O valor de $${params.payoutUsd.toFixed(2)} foi creditado na sua carteira disponível.`
      : `A sua operação ${params.reference} (${params.direction}) terminou com resultado de ${params.netResultUsd < 0 ? `-$${Math.abs(params.netResultUsd).toFixed(2)}` : '$0.00'} (${params.returnPct.toFixed(2)}%). O valor final de $${params.payoutUsd.toFixed(2)} foi devolvido à sua carteira disponível.`;

  const signResult =
    params.netResultUsd > 0
      ? `+$${params.netResultUsd.toFixed(2)}`
      : params.netResultUsd < 0
        ? `-$${Math.abs(params.netResultUsd).toFixed(2)}`
        : '$0.00';

  const subject = isZeroed
    ? `Operação ${params.reference} zerou e terminou — MILION.SPACE`
    : isGain
      ? `Operação ${params.reference} terminou com ganho (${signResult}) — MILION.SPACE`
      : `Operação ${params.reference} terminou (${signResult}) — MILION.SPACE`;

  const resultColor = isGain ? '#34d399' : '#f87171';

  const html = buildEmailLayout({
    preheader: `${params.reference}: ${statusLabel}`,
    title: isZeroed
      ? `Operação Zerada — ${params.reference}`
      : `Operação Terminada — ${params.reference}`,
    greetingName: params.fullName,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
        ${escapeHtml(summaryText)}
      </p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;border:1px solid #1e293b;border-radius:10px;background-color:#090d16;overflow:hidden;font-size:13px;">
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;width:40%;">Referência</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#22d3ee;font-family:'Courier New',monospace;font-weight:700;">${escapeHtml(params.reference)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Direção</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;font-weight:700;">${escapeHtml(params.direction)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Valor Aplicado</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;">$${params.amountUsd.toFixed(2)} USD</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Entrada → Saída</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-family:'Courier New',monospace;">$${params.entryPrice.toFixed(2)} → $${params.exitPrice.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Resultado Líquido</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:${resultColor};font-weight:700;">${escapeHtml(signResult)} (${params.returnPct >= 0 ? '+' : ''}${params.returnPct.toFixed(2)}%)</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;">Valor Liquidado</td>
          <td style="padding:10px 14px;border-bottom:1px solid #1e293b;color:#ffffff;font-weight:700;">$${params.payoutUsd.toFixed(2)} USD</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;color:#94a3b8;">Estado</td>
          <td style="padding:10px 14px;color:${resultColor};font-weight:700;">${escapeHtml(statusLabel)}</td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;color:#94a3b8;">
        Consulte o extrato completo na sua conta em <a href="${escapeHtml(getAppPublicUrl())}" style="color:#22d3ee;">${escapeHtml(getAppPublicUrl())}</a>.
      </p>
    `,
  });

  const text = [
    `Olá, ${params.fullName},`,
    '',
    summaryText,
    `Referência: ${params.reference}`,
    `Direção: ${params.direction}`,
    `Aplicado: $${params.amountUsd.toFixed(2)} USD`,
    `Entrada → Saída: $${params.entryPrice.toFixed(2)} → $${params.exitPrice.toFixed(2)}`,
    `Resultado: ${signResult} (${params.returnPct >= 0 ? '+' : ''}${params.returnPct.toFixed(2)}%)`,
    `Valor liquidado: $${params.payoutUsd.toFixed(2)} USD`,
    `Estado: ${statusLabel}`,
  ].join('\n');

  return sendResendEmail({
    to: params.to,
    subject,
    html,
    text,
    kind: 'OPERATION_SETTLED',
    actorId: params.userId,
    actorRole: 'USER',
  });
}
