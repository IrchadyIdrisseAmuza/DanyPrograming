import React, { useEffect, useState } from 'react';
import type {
  AdminPayout,
  AppProfitSummary,
  AuditLog,
  DepositRequest,
  GlobalMarketSnapshot,
  LedgerEntry,
  Operation,
  PlatformSettings,
  ReconciliationRecord,
  SupportTicket,
  User,
  WithdrawalRequest,
} from '../types';
import { apiRequest, formatCountdown, formatDateTime, formatDurationLabel, formatMT, formatUSD } from '../lib/api';
import { MarketChart } from './MarketChart';

type MarketControlMode = 'AUTO' | 'FORCE_UP' | 'FORCE_DOWN' | 'HOUSE_WIN';

export type AdminSubTab =
  | 'overview'
  | 'chart-control'
  | 'app-profit'
  | 'users'
  | 'wallets'
  | 'transfers'
  | 'operations'
  | 'market'
  | 'reports'
  | 'comms'
  | 'audit'
  | 'settings';

export const ADMIN_SUB_TABS: Array<{ id: AdminSubTab; label: string }> = [
  { id: 'overview', label: 'Resumo' },
  { id: 'chart-control', label: 'Controle de Gráfico' },
  { id: 'app-profit', label: 'Lucro & Taxas ZaasTec' },
  { id: 'users', label: 'Utilizadores' },
  { id: 'wallets', label: 'Carteiras' },
  { id: 'transfers', label: 'Depósitos / Levantamentos' },
  { id: 'operations', label: 'Operações' },
  { id: 'market', label: 'Mercado & Dados Reais' },
  { id: 'reports', label: 'Relatórios & Extrato' },
  { id: 'comms', label: 'Notificações & Suporte' },
  { id: 'audit', label: 'Auditoria' },
  { id: 'settings', label: 'Configurações' },
];

export interface PendingAdminReviewAction {
  kind: 'deposit' | 'withdrawal';
  id: string;
  decision: 'APPROVED' | 'REJECTED';
}

interface AdminUserRow extends User {
  available_balance: number;
  locked_balance: number;
  pending_balance: number;
  reserved_balance?: number;
}

interface AdminPanelProps {
  currentUser: User;
  snapshot: GlobalMarketSnapshot | null;
  onRefreshGlobal: () => Promise<void>;
  activeTab?: AdminSubTab;
  onTabChange?: (tab: AdminSubTab) => void;
  pendingReviewAction?: PendingAdminReviewAction | null;
  onClearPendingReview?: () => void;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  currentUser,
  snapshot,
  onRefreshGlobal,
  activeTab,
  onTabChange,
  pendingReviewAction = null,
  onClearPendingReview,
}) => {
  const [internalTab, setInternalTab] = useState<AdminSubTab>('overview');
  const tab = activeTab ?? internalTab;
  const setTab = (next: AdminSubTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const [overview, setOverview] = useState<{
    userStats: Record<string, number>;
    walletStats: Record<string, number>;
    pendingDeposits: number;
    pendingWithdrawals: number;
    openTickets: number;
    opStats: Record<string, number>;
    realFinancials: {
      total_deposited_usd: number;
      pending_deposit_usd: number;
      total_withdrawn_usd: number;
      pending_withdrawal_usd: number;
      active_up_count: number;
      active_up_usd: number;
      active_down_count: number;
      active_down_usd: number;
      active_capital_usd?: number;
      active_live_value_usd?: number;
      active_floating_pnl_usd?: number;
    };
    appProfit?: AppProfitSummary;
    settings: PlatformSettings;
  } | null>(null);
  const [chartBusy, setChartBusy] = useState(false);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [globalLedger, setGlobalLedger] = useState<LedgerEntry[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [reports, setReports] = useState<{
    operationsByDirection: Array<{ direction: string; count: number; volume: number; net_pnl: number }>;
    operationsByStatus: Array<{ status: string; count: number; volume: number }>;
    depositsSummary: Array<{ status: string; count: number; volume_usd: number }>;
    withdrawalsSummary: Array<{ status: string; count: number; volume_usd: number }>;
  } | null>(null);

  const [reconciliationRecords, setReconciliationRecords] = useState<ReconciliationRecord[]>([]);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reconcileTxInputs, setReconcileTxInputs] = useState<Record<string, string>>({});
  const [reconcileNoteInputs, setReconcileNoteInputs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  // Wallet adjustment form
  const [adjUserId, setAdjUserId] = useState('');
  const [adjAmount, setAdjAmount] = useState('25');
  const [adjReason, setAdjReason] = useState('');

  // Notification broadcast form
  const [ntfUserId, setNtfUserId] = useState('');
  const [ntfTitle, setNtfTitle] = useState('');
  const [ntfMessage, setNtfMessage] = useState('');

  // Ticket reply state
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyStatusById, setReplyStatusById] = useState<Record<string, 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'>>({});

  // Admin Third-Party M-Pesa Payouts
  const [adminPayouts, setAdminPayouts] = useState<AdminPayout[]>([]);
  const [payoutRecipientName, setPayoutRecipientName] = useState('');
  const [payoutMsisdn, setPayoutMsisdn] = useState('');
  const [payoutAmountUsd, setPayoutAmountUsd] = useState('');
  const [payoutNotes, setPayoutNotes] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutReconcileId, setPayoutReconcileId] = useState<string | null>(null);
  const [payoutResolveId, setPayoutResolveId] = useState<string | null>(null);

  // Settings & Factory Reset state
  const [settingsForm, setSettingsForm] = useState<PlatformSettings | null>(null);
  const [resetConfirmInput, setResetConfirmInput] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadData = async () => {
    try {
      const ov = await apiRequest<typeof overview>('/api/admin/overview');
      setOverview(ov);
      if (ov?.settings) {
        setSettingsForm((prev) => prev ?? ov.settings);
      }

      if (tab === 'users' || tab === 'wallets' || tab === 'comms') {
        const uRes = await apiRequest<{ users: AdminUserRow[] }>('/api/admin/users');
        setUsers(uRes.users);
        if (!adjUserId && uRes.users.length > 0) setAdjUserId(uRes.users[0].id);
      }
      if (tab === 'transfers' || tab === 'overview') {
        const [dRes, wRes, recRes] = await Promise.all([
          apiRequest<{ deposits: DepositRequest[] }>('/api/admin/deposits'),
          apiRequest<{ withdrawals: WithdrawalRequest[] }>('/api/admin/withdrawals'),
          apiRequest<{ records: ReconciliationRecord[] }>('/api/admin/reconciliation'),
        ]);
        setDeposits(dRes.deposits);
        setWithdrawals(wRes.withdrawals);
        setReconciliationRecords(recRes.records ?? []);
      }
      if (
        tab === 'operations' ||
        tab === 'app-profit' ||
        tab === 'overview' ||
        tab === 'chart-control'
      ) {
        const oRes = await apiRequest<{ operations: Operation[] }>('/api/admin/operations');
        setOperations(oRes.operations);
      }
      if (tab === 'app-profit') {
        const pRes = await apiRequest<{ payouts: AdminPayout[]; summary?: AppProfitSummary }>(
          '/api/admin/app-payouts'
        );
        setAdminPayouts(pRes.payouts ?? []);
      }
      if (tab === 'audit') {
        const aRes = await apiRequest<{ logs: AuditLog[] }>('/api/admin/audit');
        setAuditLogs(aRes.logs);
      }
      if (tab === 'reports') {
        const [rRes, lRes] = await Promise.all([
          apiRequest<NonNullable<typeof reports>>('/api/admin/reports'),
          apiRequest<{ ledger: LedgerEntry[] }>('/api/admin/ledger'),
        ]);
        setReports(rRes);
        setGlobalLedger(lRes.ledger);
      }
      if (tab === 'comms') {
        const tRes = await apiRequest<{ tickets: SupportTicket[] }>('/api/admin/support');
        setTickets(tRes.tickets);
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao carregar dados administrativos.');
    }
  };

  useEffect(() => {
    loadData();
    if (
      tab === 'overview' ||
      tab === 'chart-control' ||
      tab === 'app-profit' ||
      tab === 'market' ||
      tab === 'operations' ||
      tab === 'transfers' ||
      tab === 'users' ||
      tab === 'wallets'
    ) {
      const timer = setInterval(() => {
        loadData();
      }, 2000);
      return () => clearInterval(timer);
    }
  }, [tab]);

  const handleReviewDeposit = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    notes?: string
  ) => {
    setActionBusyId(id);
    setMsg(null);
    try {
      await apiRequest(`/api/admin/deposits/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, notes: notes?.trim() || undefined }),
      });
      setMsg(`Pedido de depósito legado marcado como ${decision}.`);
      setReviewNotes('');
      onClearPendingReview?.();
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao rever depósito.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleReconcileDepositQuery = async (id: string) => {
    setActionBusyId(id);
    setMsg(null);
    try {
      const res = await apiRequest<{ deposit: DepositRequest; message?: string }>(
        `/api/deposits/${id}/reconcile`,
        { method: 'POST' }
      );
      setMsg(res.message || `Estado do depósito M-Pesa verificado: ${res.deposit?.status ?? 'atualizado'}.`);
      setReviewNotes('');
      onClearPendingReview?.();
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao consultar estado M-Pesa.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleReviewWithdrawal = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    notes?: string
  ) => {
    setActionBusyId(id);
    setMsg(null);
    try {
      const res = await apiRequest<{ withdrawal?: WithdrawalRequest; message?: string }>(
        `/api/admin/withdrawals/${id}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ decision, notes: notes?.trim() || undefined }),
        }
      );
      setMsg(
        res.message ||
          (decision === 'REJECTED'
            ? 'Levantamento rejeitado e reserva devolvida ao saldo disponível.'
            : `Levantamento processado: ${res.withdrawal?.status ?? 'atualizado'}.`)
      );
      setReviewNotes('');
      onClearPendingReview?.();
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao processar levantamento M-Pesa.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleReconcileWithdrawalQuery = async (id: string) => {
    setActionBusyId(id);
    setMsg(null);
    try {
      const res = await apiRequest<{ withdrawal?: WithdrawalRequest; message?: string }>(
        `/api/admin/withdrawals/${id}/reconcile`,
        { method: 'POST' }
      );
      setMsg(res.message || `Estado do saque verificado: ${res.withdrawal?.status ?? 'atualizado'}.`);
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao consultar saque na ZaasPay.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleResolveReconciliation = async (
    reconciliationId: string,
    outcome: 'RESOLVED_CONFIRMED' | 'RESOLVED_FAILED'
  ) => {
    setActionBusyId(reconciliationId);
    setMsg(null);
    try {
      const provider_tx_id = (reconcileTxInputs[reconciliationId] || '').trim() || undefined;
      const notes =
        (reconcileNoteInputs[reconciliationId] || '').trim() ||
        (outcome === 'RESOLVED_CONFIRMED'
          ? 'Confirmado após verificação operacional na operadora.'
          : 'Confirmado como falhado após verificação operacional.');

      await apiRequest(`/api/admin/reconciliation/${reconciliationId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ outcome, provider_tx_id, notes }),
      });
      setMsg(
        outcome === 'RESOLVED_CONFIRMED'
          ? 'Reconciliação resolvida como confirmada com atualização atómica.'
          : 'Reconciliação encerrada como falhada.'
      );
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao resolver reconciliação.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleToggleUserStatus = async (u: AdminUserRow) => {
    const nextStatus = u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    await apiRequest(`/api/admin/users/${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    setMsg(`Estado de ${u.email} alterado para ${nextStatus}.`);
    await loadData();
  };

  const handleAdjustWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest(`/api/admin/wallets/${adjUserId}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount_usd: Number(adjAmount), reason: adjReason }),
      });
      setAdjReason('');
      setMsg('Ajuste administrativo registado na carteira e na auditoria.');
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao ajustar carteira.');
    }
  };

  const handleCancelOperation = async (id: string) => {
    await apiRequest(`/api/admin/operations/${id}/cancel`, { method: 'POST' });
    setMsg('Operação cancelada com reembolso integral ao utilizador.');
    await Promise.all([loadData(), onRefreshGlobal()]);
  };

  const handleSendNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiRequest('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify({
        user_id: ntfUserId || null,
        title: ntfTitle,
        message: ntfMessage,
      }),
    });
    setNtfTitle('');
    setNtfMessage('');
    setMsg('Comunicado enviado com sucesso.');
    await onRefreshGlobal();
  };

  const handleReplyTicket = async (id: string) => {
    const cleanReply = replyText.trim();
    if (cleanReply.length < 2) {
      setMsg('Escreva uma resposta com pelo menos 2 caracteres.');
      return;
    }
    const nextStatus = replyStatusById[id] ?? 'RESOLVED';
    try {
      await apiRequest(`/api/admin/support/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ admin_reply: cleanReply, status: nextStatus }),
      });
      setReplyTargetId(null);
      setReplyText('');
      setMsg(`Resposta enviada e estado do pedido atualizado para ${nextStatus}.`);
      await loadData();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao enviar resposta ao pedido de suporte.');
    }
  };

  const handleCreateAdminPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const amountUsd = Number(payoutAmountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd < 1) {
      setMsg('Indique um valor válido a partir de $1.00 USD.');
      return;
    }
    setPayoutBusy(true);
    const idemKey = `apay_${currentUser.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await apiRequest<{ payout: AdminPayout; message?: string }>('/api/admin/app-payouts', {
        method: 'POST',
        body: JSON.stringify({
          recipient_name: payoutRecipientName.trim(),
          msisdn: payoutMsisdn.trim(),
          amount_usd: amountUsd,
          notes: payoutNotes.trim(),
          idempotency_key: idemKey,
        }),
      });
      setMsg(res.message || `Saque administrativo ${res.payout.reference} processado (${res.payout.status}).`);
      setPayoutAmountUsd('');
      setPayoutNotes('');
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao executar saque como terceiro via M-Pesa.');
    } finally {
      setPayoutBusy(false);
    }
  };

  const handleReconcileAdminPayout = async (payoutId: string) => {
    setPayoutReconcileId(payoutId);
    setMsg(null);
    try {
      const res = await apiRequest<{ payout: AdminPayout; message?: string }>(
        `/api/admin/app-payouts/${payoutId}/reconcile`,
        { method: 'POST' }
      );
      setMsg(res.message || `Estado do saque verificado: ${res.payout.status}.`);
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao consultar estado do saque na ZaasPay.');
    } finally {
      setPayoutReconcileId(null);
    }
  };

  const handleResolveAdminPayout = async (payoutId: string, decision: 'FAILED' | 'PAID') => {
    setPayoutResolveId(payoutId);
    setMsg(null);
    try {
      const res = await apiRequest<{ payout: AdminPayout; message?: string }>(
        `/api/admin/app-payouts/${payoutId}/resolve`,
        {
          method: 'POST',
          body: JSON.stringify({ decision }),
        }
      );
      setMsg(
        res.message ||
          (decision === 'FAILED'
            ? 'Saque marcado como falhado e saldo retido devolvido ao lucro disponível.'
            : 'Saque marcado como pago.')
      );
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao atualizar estado do saque.');
    } finally {
      setPayoutResolveId(null);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsForm) return;
    try {
      const res = await apiRequest<{ settings: PlatformSettings }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify(settingsForm),
      });
      if (res.settings) setSettingsForm(res.settings);
      setMsg('Configurações da plataforma atualizadas e auditadas.');
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao guardar configurações.');
    }
  };

  const toggleMarketPause = async () => {
    if (!settingsForm) return;
    try {
      const res = await apiRequest<{ settings: PlatformSettings }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ market_paused: !settingsForm.market_paused }),
      });
      if (res.settings) setSettingsForm(res.settings);
      setMsg(!settingsForm.market_paused ? 'Motor de mercado pausado.' : 'Motor de mercado retomado.');
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Apenas Super Admin pode pausar o motor.');
    }
  };

  const handleFactoryReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (resetConfirmInput.trim().toUpperCase() !== 'APAGAR TUDO') {
      setMsg('Escreva exatamente "APAGAR TUDO" para confirmar a limpeza completa.');
      return;
    }
    setResetBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ ok: boolean; message?: string }>('/api/admin/system/reset', {
        method: 'POST',
        body: JSON.stringify({ confirmation: resetConfirmInput.trim() }),
      });
      setResetConfirmInput('');
      setSettingsForm(null);
      setMsg(
        res.message ||
          'Todos os dados operacionais e financeiros foram apagados do zero. Sessão SUPER_ADMIN preservada.'
      );
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao executar reinicialização da plataforma.');
    } finally {
      setResetBusy(false);
    }
  };

  const handleSetMarketControl = async (mode: MarketControlMode) => {
    setChartBusy(true);
    try {
      await apiRequest('/api/admin/market/control', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const labels: Record<MarketControlMode, string> = {
        AUTO: 'Mercado definido para modo Autónomo.',
        FORCE_UP: 'Mercado colocado em Subida forçada.',
        FORCE_DOWN: 'Mercado colocado em Queda forçada.',
        HOUSE_WIN: 'Modo Casa ativado: o gráfico move-se contra as posições abertas para recolher lucro.',
      };
      setMsg(labels[mode]);
      await Promise.all([loadData(), onRefreshGlobal()]);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Erro ao alterar controlo do gráfico.');
    } finally {
      setChartBusy(false);
    }
  };

  const activeControlMode: MarketControlMode =
    overview?.settings.market_control_mode ?? snapshot?.market_control_mode ?? 'AUTO';

  const controlModeLabel: Record<MarketControlMode, string> = {
    AUTO: 'Autónomo',
    FORCE_UP: 'Subida Forçada',
    FORCE_DOWN: 'Queda Forçada',
    HOUSE_WIN: 'Modo Casa (Recolher Lucro)',
  };

  const rate = overview?.settings.usd_to_mt_rate ?? snapshot?.usd_to_mt_rate ?? 70;
  const currentMarketPrice = snapshot?.current_price ?? 0;
  const liveMultiplier =
    overview?.settings?.proportional_multiplier ?? snapshot?.proportional_multiplier ?? 25;

  const computeAdminOpLive = (o: Operation) => {
    if (currentMarketPrice > 0 && o.entry_price > 0) {
      const pct = (currentMarketPrice - o.entry_price) / o.entry_price;
      const signed = o.direction === 'SUBIDA' ? pct : -pct;
      const bounded = Math.max(-1.0, signed * liveMultiplier);
      const pnl = Number((o.amount_usd * bounded).toFixed(2));
      const val = Math.max(0, Number((o.amount_usd + pnl).toFixed(2)));
      return { pnl, pct: Number((bounded * 100).toFixed(2)), val };
    }
    const pnl = o.floating_pnl_usd ?? 0;
    const val = o.floating_value_usd ?? Math.max(0, Number((o.amount_usd + pnl).toFixed(2)));
    return { pnl, pct: o.floating_return_pct ?? 0, val };
  };

  const activeOpsList = operations.filter((o) => o.status === 'ACTIVE');
  const liveActiveCapitalUsd =
    activeOpsList.length > 0
      ? Number(activeOpsList.reduce((acc, o) => acc + o.amount_usd, 0).toFixed(2))
      : overview?.realFinancials?.active_capital_usd ?? overview?.walletStats.total_locked ?? 0;
  const liveUserFloatingPnlUsd =
    activeOpsList.length > 0 && currentMarketPrice > 0
      ? Number(activeOpsList.reduce((acc, o) => acc + computeAdminOpLive(o).pnl, 0).toFixed(2))
      : overview?.realFinancials?.active_floating_pnl_usd ?? 0;
  const liveHouseFloatingPnlUsd = Number((-liveUserFloatingPnlUsd).toFixed(2));

  const formatTerminationLabel = (o: Operation) => {
    if (o.status === 'ACTIVE') return 'Em curso';
    if (o.status === 'CANCELLED' || o.termination_reason === 'ADMIN_CANCELLED') {
      return 'Cancelada e reembolsada';
    }
    if (o.termination_reason === 'ZEROED_OUT') {
      return `Zerou em $0.00 (Antes do prazo)`;
    }
    if (o.termination_reason === 'ZEROED_AT_EXPIRY' || (o.payout_amount_usd ?? 0) <= 0) {
      return `Terminou em $0.00 (No prazo)`;
    }
    return `Vencimento · Pago ${formatUSD(o.payout_amount_usd ?? 0)}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
        <div>
          <div className="text-xs text-slate-400 mb-1">
            PAINEL ADMINISTRATIVO · {currentUser.role} · Atualização automática 2s
          </div>
          <h1 className="font-display text-2xl font-bold text-white">Controlo da Plataforma</h1>
        </div>
        <div className="text-xs font-mono text-slate-400">
          Taxa atual: 1 USD = {rate} MT · MIL-IDX ${snapshot?.current_price.toFixed(4) ?? '—'}
        </div>
      </div>

      {/* Admin Module Switcher */}
      <div className="flex flex-wrap gap-1.5 p-1.5 rounded-xl bg-[#101724] border border-slate-800">
        {ADMIN_SUB_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setMsg(null);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="p-3 rounded-lg border border-blue-500/40 bg-blue-500/10 text-xs text-blue-200">
          {msg}
        </div>
      )}

      {/* 1. OVERVIEW (STRICTLY REAL DATA) */}
      {tab === 'overview' && overview && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Utilizadores Reais</div>
              <div className="font-mono text-2xl font-bold text-white mt-1 tabular-nums">
                {overview.userStats.total_users}
              </div>
              <div className="text-xs text-slate-400 mt-1 tabular-nums">
                {overview.userStats.active_users} ativos · {overview.userStats.suspended_users} suspensos
              </div>
            </div>
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Dinheiro Real Depositado</div>
              <div className="font-mono text-2xl font-bold text-emerald-400 mt-1 tabular-nums">
                {formatUSD(overview.realFinancials?.total_deposited_usd ?? 0)}
              </div>
              <div className="text-xs text-slate-400 mt-1 tabular-nums">
                Pendente aprovação: {formatUSD(overview.realFinancials?.pending_deposit_usd ?? 0)}
              </div>
            </div>
            <div className="p-5 rounded-xl border border-blue-500/30 bg-[#101724]">
              <div className="text-xs text-slate-400">Capital em Operação (Tempo Real)</div>
              <div className="font-mono text-2xl font-bold text-blue-400 mt-1 tabular-nums">
                {formatUSD(liveActiveCapitalUsd)}
              </div>
              <div
                className={`text-xs font-mono mt-1 tabular-nums ${
                  liveUserFloatingPnlUsd > 0
                    ? 'text-emerald-400'
                    : liveUserFloatingPnlUsd < 0
                      ? 'text-red-400'
                      : 'text-slate-400'
                }`}
              >
                Utilizadores agora: {liveUserFloatingPnlUsd >= 0 ? '+' : ''}
                {formatUSD(liveUserFloatingPnlUsd)} · Casa:{' '}
                {liveHouseFloatingPnlUsd >= 0 ? '+' : ''}
                {formatUSD(liveHouseFloatingPnlUsd)}
              </div>
            </div>
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Suporte & Pedidos Pendentes</div>
              <div className="font-mono text-2xl font-bold text-amber-400 mt-1 tabular-nums">
                {overview.openTickets + overview.pendingDeposits + overview.pendingWithdrawals}
              </div>
              <div className="text-xs text-slate-400 mt-1 tabular-nums">
                {overview.openTickets} suporte · {overview.pendingDeposits} dep. · {overview.pendingWithdrawals} lev.
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Exposição Real em Subida</div>
              <div className="font-mono text-lg font-bold text-emerald-400 mt-1 tabular-nums">
                {overview.realFinancials?.active_up_count ?? 0} op(s) ·{' '}
                {formatUSD(overview.realFinancials?.active_up_usd ?? 0)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
                Disponível carteiras: {formatUSD(overview.walletStats.total_available)}
              </div>
            </div>
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Exposição Real em Descida</div>
              <div className="font-mono text-lg font-bold text-red-400 mt-1 tabular-nums">
                {overview.realFinancials?.active_down_count ?? 0} op(s) ·{' '}
                {formatUSD(overview.realFinancials?.active_down_usd ?? 0)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
                Reservado lev.: {formatUSD(overview.walletStats.total_reserved ?? 0)}
              </div>
            </div>
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Lucro Líquido da App (Após Taxas ZaasTec)</div>
              <div
                className={`font-mono text-lg font-bold mt-1 tabular-nums ${
                  (overview.appProfit?.net_app_profit_usd ?? 0) >= 0
                    ? 'text-emerald-400'
                    : 'text-red-400'
                }`}
              >
                {formatUSD(overview.appProfit?.net_app_profit_usd ?? 0)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
                Disponível p/ saque: {formatUSD(overview.appProfit?.available_admin_payout_usd ?? 0)} · Taxas ZaasTec:{' '}
                {formatUSD(overview.appProfit?.total_fees_deducted_usd ?? 0)}
              </div>
            </div>
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-white">Ações Rápidas de Gestão</div>
              <div className="text-xs text-slate-400 mt-0.5">
                Modo do gráfico: <span className="text-slate-200 font-mono">{controlModeLabel[activeControlMode]}</span> ·{' '}
                {overview.opStats.active_ops} operação(ões) ativa(s) no momento
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setTab('chart-control')}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Controle de Gráfico
              </button>
              <button
                onClick={() => setTab('app-profit')}
                className="px-4 py-2 text-xs font-semibold text-emerald-300 border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Lucro & Taxas ZaasTec
              </button>
              <button
                onClick={() => setTab('transfers')}
                className="px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Rever Pedidos ({overview.pendingDeposits + overview.pendingWithdrawals})
              </button>
              <button
                onClick={() => setTab('operations')}
                className="px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Ver Operações Ativas
              </button>
              {currentUser.role === 'SUPER_ADMIN' && (
                <button
                  onClick={() => setTab('settings')}
                  className="px-4 py-2 text-xs font-medium text-red-300 border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  Reiniciar Dados (Zero)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 1B. CONTROLE DE GRÁFICO */}
      {tab === 'chart-control' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Live Chart & Direct Controls */}
            <div className="lg:col-span-8 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
                <div>
                  <div className="text-xs text-slate-400">Índice MIL-IDX · Controlo Direto</div>
                  <div className="flex items-baseline gap-3 mt-1">
                    <span className="font-mono text-2xl font-bold text-white tabular-nums">
                      ${snapshot ? snapshot.current_price.toFixed(4) : '—'}
                    </span>
                    <span
                      className={`font-mono text-xs font-semibold ${
                        activeControlMode === 'FORCE_UP'
                          ? 'text-emerald-400'
                          : activeControlMode === 'FORCE_DOWN'
                            ? 'text-red-400'
                            : activeControlMode === 'HOUSE_WIN'
                              ? 'text-amber-400'
                              : 'text-blue-400'
                      }`}
                    >
                      Modo Ativo: {controlModeLabel[activeControlMode]}
                    </span>
                  </div>
                </div>
                <button
                  onClick={toggleMarketPause}
                  className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  {snapshot?.market_paused ? 'Retomar Motor' : 'Pausar Motor'}
                </button>
              </div>

              <MarketChart ticks={snapshot?.recent_ticks ?? []} height={300} />

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                <button
                  type="button"
                  disabled={chartBusy}
                  onClick={() => handleSetMarketControl('FORCE_UP')}
                  className={`py-3 px-4 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                    activeControlMode === 'FORCE_UP'
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-emerald-600/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-600/30'
                  }`}
                >
                  Colocar em Subida
                </button>

                <button
                  type="button"
                  disabled={chartBusy}
                  onClick={() => handleSetMarketControl('FORCE_DOWN')}
                  className={`py-3 px-4 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                    activeControlMode === 'FORCE_DOWN'
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-red-600/15 text-red-300 border-red-500/40 hover:bg-red-600/30'
                  }`}
                >
                  Colocar em Queda
                </button>

                <button
                  type="button"
                  disabled={chartBusy}
                  onClick={() => handleSetMarketControl('HOUSE_WIN')}
                  className={`py-3 px-4 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                    activeControlMode === 'HOUSE_WIN'
                      ? 'bg-amber-600 text-white border-amber-500'
                      : 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                  }`}
                >
                  Modo Casa (Recolher)
                </button>

                <button
                  type="button"
                  disabled={chartBusy}
                  onClick={() => handleSetMarketControl('AUTO')}
                  className={`py-3 px-4 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                    activeControlMode === 'AUTO'
                      ? 'bg-blue-600 text-white border-blue-500'
                      : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                  }`}
                >
                  Mercado Autónomo
                </button>
              </div>
            </div>

            {/* Real Exposure & DB Figures ONLY */}
            <div className="lg:col-span-4 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4 h-fit">
              <div>
                <h2 className="text-sm font-semibold text-white">Dados Reais em Tempo Real</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Apenas valores reais registados nas carteiras e operações ativas.
                </p>
              </div>

              {overview ? (
                <dl className="space-y-3 text-xs pt-2 border-t border-slate-800">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Dinheiro Real Depositado</dt>
                    <dd className="font-mono font-semibold text-emerald-400 tabular-nums">
                      {formatUSD(overview.realFinancials?.total_deposited_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Capital em Operação</dt>
                    <dd className="font-mono font-semibold text-blue-400 tabular-nums">
                      {formatUSD(liveActiveCapitalUsd)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Ganho / Perda Flutuante (Utilizadores)</dt>
                    <dd
                      className={`font-mono font-semibold tabular-nums ${
                        liveUserFloatingPnlUsd > 0
                          ? 'text-emerald-400'
                          : liveUserFloatingPnlUsd < 0
                            ? 'text-red-400'
                            : 'text-slate-300'
                      }`}
                    >
                      {liveUserFloatingPnlUsd >= 0 ? '+' : ''}
                      {formatUSD(liveUserFloatingPnlUsd)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Resultado Flutuante da Casa</dt>
                    <dd
                      className={`font-mono font-semibold tabular-nums ${
                        liveHouseFloatingPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {liveHouseFloatingPnlUsd >= 0 ? '+' : ''}
                      {formatUSD(liveHouseFloatingPnlUsd)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Saldo Disponível em Carteiras</dt>
                    <dd className="font-mono text-white tabular-nums">
                      {formatUSD(overview.walletStats.total_available)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Utilizadores Ativos</dt>
                    <dd className="font-mono text-white tabular-nums">
                      {overview.userStats.active_users} / {overview.userStats.total_users}
                    </dd>
                  </div>

                  <div className="pt-3 border-t border-slate-800 space-y-2">
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Operações SUBIDA Ativas</dt>
                      <dd className="font-mono text-emerald-400 tabular-nums">
                        {overview.realFinancials?.active_up_count ?? 0} ·{' '}
                        {formatUSD(overview.realFinancials?.active_up_usd ?? 0)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-400">Operações DESCIDA Ativas</dt>
                      <dd className="font-mono text-red-400 tabular-nums">
                        {overview.realFinancials?.active_down_count ?? 0} ·{' '}
                        {formatUSD(overview.realFinancials?.active_down_usd ?? 0)}
                      </dd>
                    </div>
                  </div>
                </dl>
              ) : (
                <div className="text-xs text-slate-400">A carregar dados reais...</div>
              )}

              <div className="p-3 rounded-lg bg-[#090D16] border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
                Regra ativa: operações que chegam a <span className="font-mono text-slate-200">$0.00</span> encerram de imediato. Operações em lucro só liquidam quando o tempo configurado termina. No <span className="text-amber-300 font-medium">Modo Casa</span>, o mercado sobe contra posições DESCIDA e cai contra posições SUBIDA.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 1C. CONTROLO DE LUCRO DA APP (DESCONTANDO 6% DEP. / 2% LEV. + SAQUE TERCEIRO) */}
      {tab === 'app-profit' && overview && (() => {
        const prof = overview.appProfit;
        const payoutNum = Number(payoutAmountUsd) || 0;
        const estFeeUsd = Number((payoutNum * 0.02).toFixed(2));
        const estTotalDeducted = Number((payoutNum + estFeeUsd).toFixed(2));
        const estMt = payoutNum * rate;

        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-5 rounded-xl border border-cyan-500/30 bg-[#101724]">
                <div className="text-xs text-slate-400">Lucro Disponível para Saque</div>
                <div className="font-mono text-2xl font-bold text-cyan-300 mt-1 tabular-nums">
                  {formatUSD(prof?.available_admin_payout_usd ?? 0)}
                </div>
                <div className="text-xs text-slate-400 mt-1 tabular-nums">
                  {formatMT(prof?.available_admin_payout_usd ?? 0, rate)} · Máx. líquido: {formatUSD(prof?.max_withdrawable_before_fee_usd ?? 0)}
                </div>
              </div>
              <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
                <div className="text-xs text-slate-400">Lucro Líquido (Após Taxas ZaasTec)</div>
                <div
                  className={`font-mono text-2xl font-bold mt-1 tabular-nums ${
                    (prof?.net_app_profit_usd ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {formatUSD(prof?.net_app_profit_usd ?? 0)}
                </div>
                <div className="text-xs text-slate-400 mt-1 tabular-nums">
                  Resultado ops: {formatUSD(prof?.net_ops_profit_usd ?? 0)} − ZaasTec: {formatUSD(prof?.total_fees_deducted_usd ?? 0)}
                </div>
              </div>
              <div className="p-5 rounded-xl border border-amber-500/30 bg-[#101724]">
                <div className="text-xs text-amber-300">Taxas da Provedora ZaasTec (API)</div>
                <div className="font-mono text-2xl font-bold text-amber-400 mt-1 tabular-nums">
                  {formatUSD(prof?.total_fees_deducted_usd ?? 0)}
                </div>
                <div className="text-xs text-slate-400 mt-1 tabular-nums">
                  Dep. 6%: {formatUSD(prof?.deposit_fees_usd ?? 0)} · Lev. 2%: {formatUSD((prof?.user_withdrawal_fees_usd ?? 0) + (prof?.admin_payout_fees_usd ?? 0))} (não é lucro da app)
                </div>
              </div>
              <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
                <div className="text-xs text-slate-400">Saques da App Realizados</div>
                <div className="font-mono text-2xl font-bold text-white mt-1 tabular-nums">
                  {formatUSD(prof?.admin_withdrawn_usd ?? 0)}
                </div>
                <div className="text-xs text-slate-400 mt-1 tabular-nums">
                  Em processamento: {formatUSD(prof?.pending_admin_payouts_usd ?? 0)}
                </div>
              </div>
            </div>

            {/* Accounting breakdown + Third-Party M-Pesa Payout form */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Detalhe Contabilístico · App vs. ZaasTec</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    As taxas de 6% sobre depósitos e 2% sobre levantamentos/saques pertencem à provedora ZaasTec (API de pagamentos), sendo descontadas antes do saldo líquido disponível.
                  </p>
                </div>
                <dl className="space-y-2.5 text-xs pt-2 border-t border-slate-800">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Perdas recolhidas (ops)</dt>
                    <dd className="font-mono text-emerald-400 tabular-nums">
                      +{formatUSD(prof?.gross_user_losses_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Ganhos pagos a utilizadores</dt>
                    <dd className="font-mono text-red-400 tabular-nums">
                      -{formatUSD(prof?.gross_user_wins_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt className="text-slate-300">Lucro operacional bruto ({prof?.completed_ops_count ?? 0} ops)</dt>
                    <dd className="font-mono text-white tabular-nums">
                      {formatUSD(prof?.net_ops_profit_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-800/80">
                    <dt className="text-slate-400">
                      Taxa ZaasTec depósitos 6% (API · sobre {formatUSD(prof?.total_deposited_usd ?? 0)})
                    </dt>
                    <dd className="font-mono text-amber-300 tabular-nums">
                      -{formatUSD(prof?.deposit_fees_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">
                      Taxa ZaasTec saques utilizadores 2% (API · sobre {formatUSD(prof?.total_user_withdrawn_usd ?? 0)})
                    </dt>
                    <dd className="font-mono text-amber-300 tabular-nums">
                      -{formatUSD(prof?.user_withdrawal_fees_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Taxa ZaasTec saques terceiros admin (2%)</dt>
                    <dd className="font-mono text-amber-300 tabular-nums">
                      -{formatUSD(prof?.admin_payout_fees_usd ?? 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-800 font-semibold">
                    <dt className="text-white">Lucro Líquido Disponível p/ Saque</dt>
                    <dd className="font-mono text-cyan-300 tabular-nums">
                      {formatUSD(prof?.available_admin_payout_usd ?? 0)}
                    </dd>
                  </div>
                </dl>

                <button
                  type="button"
                  onClick={() => setTab('chart-control')}
                  className="w-full py-2.5 px-4 text-xs font-semibold text-slate-200 bg-[#090D16] hover:bg-slate-800 border border-slate-700 rounded-lg cursor-pointer"
                >
                  Ir para Controle de Gráfico ({prof?.zeroed_ops_count ?? 0} zeradas · {prof?.winning_ops_count ?? 0} vencedoras)
                </button>
              </div>

              <form
                onSubmit={handleCreateAdminPayout}
                className="lg:col-span-7 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Saque como Terceiro via M-Pesa</h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Desembolso direto B2C via ZaasPay a partir do lucro líquido disponível (taxa adicional de 2% no saque).
                    </p>
                  </div>
                  <span className="text-[11px] font-mono text-cyan-300 border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 rounded">
                    1 USD = {rate} MT
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Nome do Beneficiário (opcional)
                    </label>
                    <input
                      type="text"
                      value={payoutRecipientName}
                      onChange={(e) => setPayoutRecipientName(e.target.value)}
                      placeholder="Ex.: Conta Operacional / Sócio"
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Número M-Pesa Vodacom (84 / 85)
                    </label>
                    <input
                      type="tel"
                      required
                      value={payoutMsisdn}
                      onChange={(e) => setPayoutMsisdn(e.target.value)}
                      placeholder="+258 84 123 4567"
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-300">Valor a Enviar (USD)</label>
                      <button
                        type="button"
                        onClick={() =>
                          setPayoutAmountUsd(String((prof?.max_withdrawable_before_fee_usd ?? 0).toFixed(2)))
                        }
                        className="text-[11px] font-mono text-cyan-400 hover:text-cyan-300 cursor-pointer"
                      >
                        Usar máximo
                      </button>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      required
                      value={payoutAmountUsd}
                      onChange={(e) => setPayoutAmountUsd(e.target.value)}
                      placeholder="Ex.: 25.00"
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Notas (opcional)</label>
                    <input
                      type="text"
                      value={payoutNotes}
                      onChange={(e) => setPayoutNotes(e.target.value)}
                      placeholder="Referência interna"
                      className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
                    />
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-[#090D16] border border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-slate-400 text-[11px]">Valor em Meticais</div>
                    <div className="font-mono font-semibold text-white tabular-nums">
                      {estMt.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} MT
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-[11px]">Taxa M-Pesa (2%)</div>
                    <div className="font-mono font-semibold text-amber-300 tabular-nums">
                      {formatUSD(estFeeUsd)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 text-[11px]">Total deduzido do lucro</div>
                    <div className="font-mono font-semibold text-cyan-300 tabular-nums">
                      {formatUSD(estTotalDeducted)}
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={payoutBusy || payoutNum < 1}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg cursor-pointer transition-colors"
                >
                  {payoutBusy
                    ? 'A enviar desembolso M-Pesa via ZaasPay...'
                    : 'Executar Saque como Terceiro via M-Pesa'}
                </button>
              </form>
            </div>

            {/* Admin Third-Party Payouts History */}
            <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 text-sm font-semibold text-white">
                Histórico de Saques do Lucro (Terceiros M-Pesa)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Referência / Data</th>
                      <th className="py-2.5 px-4 font-medium">Destinatário / M-Pesa</th>
                      <th className="py-2.5 px-4 font-medium text-right">Valor</th>
                      <th className="py-2.5 px-4 font-medium text-right">Taxa 2% / Deduzido</th>
                      <th className="py-2.5 px-4 font-medium">Estado / ID Operadora</th>
                      <th className="py-2.5 px-4 font-medium text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {adminPayouts.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-400">
                          Nenhum saque administrativo registado até ao momento.
                        </td>
                      </tr>
                    ) : (
                      adminPayouts.map((p) => (
                        <tr key={p.id}>
                          <td className="py-3 px-4 font-mono">
                            <div className="text-slate-200">{p.reference}</div>
                            <div className="text-[10px] text-slate-500">{formatDateTime(p.created_at)}</div>
                          </td>
                          <td className="py-3 px-4">
                            <div className="text-white">{p.recipient_name || p.admin_email}</div>
                            <div className="font-mono text-[11px] text-slate-400">{p.msisdn_masked}</div>
                          </td>
                          <td className="py-3 px-4 font-mono text-right tabular-nums">
                            <div className="text-white">{formatUSD(p.amount_usd)}</div>
                            <div className="text-[11px] text-slate-400">{formatMT(p.amount_usd, p.exchange_rate_used)}</div>
                          </td>
                          <td className="py-3 px-4 font-mono text-right tabular-nums">
                            <div className="text-amber-300">{formatUSD(p.fee_usd)}</div>
                            <div className="text-[11px] text-slate-400">Total: {formatUSD(p.total_deducted_usd)}</div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div
                              className={
                                p.status === 'PAID'
                                  ? 'text-emerald-400'
                                  : p.status === 'FAILED'
                                    ? 'text-red-400'
                                    : 'text-amber-400'
                              }
                            >
                              {p.status}
                            </div>
                            {p.provider_transaction_id && (
                              <div className="text-[10px] text-slate-400">TX: {p.provider_transaction_id}</div>
                            )}
                            {(p.response_code || p.response_desc) && (
                              <div className="text-[10px] text-slate-400 max-w-xs truncate" title={p.response_desc || ''}>
                                {p.response_code ? `[${p.response_code}] ` : ''}
                                {p.response_desc}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            {(p.status === 'PROCESSING' || p.status === 'RECONCILIATION_REQUIRED') && (
                              <div className="inline-flex flex-wrap justify-end gap-1.5">
                                {p.provider_payout_id && (
                                  <button
                                    type="button"
                                    disabled={payoutReconcileId === p.id || payoutResolveId === p.id}
                                    onClick={() => handleReconcileAdminPayout(p.id)}
                                    className="px-2.5 py-1 text-xs rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 cursor-pointer disabled:opacity-50"
                                  >
                                    {payoutReconcileId === p.id ? 'A consultar...' : 'Consultar Estado'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={payoutReconcileId === p.id || payoutResolveId === p.id}
                                  onClick={() => handleResolveAdminPayout(p.id, 'FAILED')}
                                  className="px-2.5 py-1 text-xs rounded border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 cursor-pointer disabled:opacity-50"
                                >
                                  {payoutResolveId === p.id ? 'A atualizar...' : 'Marcar Falhado (Libertar Saldo)'}
                                </button>
                                <button
                                  type="button"
                                  disabled={payoutReconcileId === p.id || payoutResolveId === p.id}
                                  onClick={() => handleResolveAdminPayout(p.id, 'PAID')}
                                  className="px-2.5 py-1 text-xs rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 cursor-pointer disabled:opacity-50"
                                >
                                  Confirmar Pago
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 text-sm font-semibold text-white">
                Controlo de Lucro por Operação Concluída
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Referência</th>
                      <th className="py-2.5 px-4 font-medium">Utilizador</th>
                      <th className="py-2.5 px-4 font-medium">Direção</th>
                      <th className="py-2.5 px-4 font-medium text-right">Apostado</th>
                      <th className="py-2.5 px-4 font-medium text-right">Pago ao Utilizador</th>
                      <th className="py-2.5 px-4 font-medium">Onde Terminou</th>
                      <th className="py-2.5 px-4 font-medium text-right">Lucro da App</th>
                      <th className="py-2.5 px-4 font-medium">Encerrada em</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {operations.filter((o) => o.status === 'COMPLETED').length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-400">
                          Nenhuma operação concluída registada até ao momento.
                        </td>
                      </tr>
                    ) : (
                      operations
                        .filter((o) => o.status === 'COMPLETED')
                        .map((o) => {
                          const appNet = Number((o.amount_usd - (o.payout_amount_usd ?? 0)).toFixed(2));
                          return (
                            <tr key={o.id}>
                              <td className="py-3 px-4 font-mono text-slate-300">{o.reference}</td>
                              <td className="py-3 px-4 font-mono text-slate-200">{o.public_code}</td>
                              <td className="py-3 px-4 font-mono font-semibold">
                                <span className={o.direction === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'}>
                                  {o.direction}
                                </span>
                              </td>
                              <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                                {formatUSD(o.amount_usd)}
                              </td>
                              <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                                {formatUSD(o.payout_amount_usd ?? 0)}
                              </td>
                              <td className="py-3 px-4 text-slate-300">
                                <div>{formatTerminationLabel(o)}</div>
                                {o.exit_price !== null && (
                                  <div className="font-mono text-[10px] text-slate-500">
                                    Entrada ${o.entry_price.toFixed(2)} → Saída ${o.exit_price.toFixed(2)}
                                  </div>
                                )}
                              </td>
                              <td
                                className={`py-3 px-4 font-mono text-right font-semibold tabular-nums ${
                                  appNet >= 0 ? 'text-emerald-400' : 'text-red-400'
                                }`}
                              >
                                {appNet >= 0 ? '+' : ''}
                                {formatUSD(appNet)}
                              </td>
                              <td className="py-3 px-4 font-mono text-slate-400 whitespace-nowrap">
                                {o.settled_at ? formatDateTime(o.settled_at) : '—'}
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 2. USERS */}
      {tab === 'users' && (
        <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Código</th>
                  <th className="py-3 px-4 font-medium">Utilizador</th>
                  <th className="py-3 px-4 font-medium">Telefone</th>
                  <th className="py-3 px-4 font-medium">Papel</th>
                  <th className="py-3 px-4 font-medium">Estado</th>
                  <th className="py-3 px-4 font-medium text-right">Saldo Disponível</th>
                  <th className="py-3 px-4 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-3 px-4 font-mono text-slate-300">{u.public_code}</td>
                    <td className="py-3 px-4">
                      <div className="text-white font-medium">{u.full_name}</div>
                      <div className="text-slate-400">{u.email}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300">{u.phone}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">{u.role}</td>
                    <td className="py-3 px-4 font-mono">
                      <span className={u.status === 'ACTIVE' ? 'text-emerald-400' : 'text-red-400'}>
                        {u.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                      {formatUSD(u.available_balance ?? 0)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {u.id !== currentUser.id && (
                        <button
                          onClick={() => handleToggleUserStatus(u)}
                          className="px-2.5 py-1 text-xs rounded border border-slate-700 hover:bg-slate-800 text-slate-200 cursor-pointer"
                        >
                          {u.status === 'ACTIVE' ? 'Suspender' : 'Ativar'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. WALLETS */}
      {tab === 'wallets' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Conta</th>
                    <th className="py-3 px-4 font-medium text-right">Disponível</th>
                    <th className="py-3 px-4 font-medium text-right">Em Operação</th>
                    <th className="py-3 px-4 font-medium text-right">Reservado</th>
                    <th className="py-3 px-4 font-medium text-right">Total (MT)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {users.map((u) => {
                    const reserved = (u.reserved_balance ?? 0) + (u.pending_balance ?? 0);
                    const tot = (u.available_balance ?? 0) + (u.locked_balance ?? 0) + reserved;
                    return (
                      <tr key={u.id}>
                        <td className="py-3 px-4">
                          <div className="font-mono text-slate-300">{u.public_code}</div>
                          <div className="text-slate-400">{u.email}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-emerald-400 tabular-nums">
                          {formatUSD(u.available_balance ?? 0)}
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-blue-400 tabular-nums">
                          {formatUSD(u.locked_balance ?? 0)}
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-amber-400 tabular-nums">
                          {formatUSD(reserved)}
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                          {formatMT(tot, rate)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <form
            onSubmit={handleAdjustWallet}
            className="lg:col-span-4 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4 h-fit"
          >
            <h2 className="text-sm font-semibold text-white">Ajuste Manual Auditado</h2>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Utilizador</label>
              <select
                value={adjUserId}
                onChange={(e) => setAdjUserId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.public_code} — {u.email}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Valor USD (+ crédito / - débito)
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={adjAmount}
                onChange={(e) => setAdjAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Motivo (obrigatório)</label>
              <input
                type="text"
                required
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                placeholder="Ex.: Crédito de teste solicitado"
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
            >
              Executar Ajuste Atómico
            </button>
          </form>
        </div>
      )}

      {/* 4. DEPOSITS, WITHDRAWALS & RECONCILIATION */}
      {tab === 'transfers' && (
        <div className="space-y-6">
          {pendingReviewAction && (() => {
            const targetDeposit =
              pendingReviewAction.kind === 'deposit'
                ? deposits.find((d) => d.id === pendingReviewAction.id)
                : undefined;
            const targetWithdrawal =
              pendingReviewAction.kind === 'withdrawal'
                ? withdrawals.find((w) => w.id === pendingReviewAction.id)
                : undefined;
            const targetItem = targetDeposit || targetWithdrawal;
            const isMpesaDep =
              targetDeposit &&
              (targetDeposit.method === 'M-Pesa' ||
                (targetDeposit.provider || '').includes('MPESA'));
            const withdrawalCanReview =
              targetWithdrawal &&
              (targetWithdrawal.status === 'AWAITING_APPROVAL' ||
                targetWithdrawal.status === 'PENDING');

            return (
              <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-mono uppercase tracking-wider text-amber-300">
                      Confirmação Administrativa Obrigatória (POST)
                    </div>
                    <h3 className="text-base font-bold text-white mt-0.5">
                      {pendingReviewAction.kind === 'withdrawal'
                        ? 'Revisão de Levantamento'
                        : 'Revisão de Depósito'}{' '}
                      ·{' '}
                      {pendingReviewAction.decision === 'APPROVED' ? 'Aprovação' : 'Rejeição'}
                    </h3>
                    <p className="text-xs text-slate-300 mt-1">
                      Nenhuma operação é executada ao abrir uma ligação do e-mail. Confirme explicitamente abaixo após rever os dados.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onClearPendingReview?.()}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
                  >
                    Cancelar
                  </button>
                </div>

                {!targetItem ? (
                  <div className="text-xs text-amber-200">
                    Pedido <span className="font-mono">{pendingReviewAction.id}</span> não encontrado nos registos recentes ou já removido.
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs bg-[#090D16] border border-slate-800 rounded-lg p-3.5">
                      <div>
                        <div className="text-slate-400">Referência</div>
                        <div className="font-mono text-cyan-300 font-semibold">{targetItem.reference}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">Utilizador</div>
                        <div className="text-white font-medium">
                          {targetItem.full_name || targetItem.public_code} ({targetItem.public_code})
                        </div>
                        <div className="text-[11px] text-slate-400">{targetItem.email}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">Valor & Equivalente</div>
                        <div className="font-mono text-white font-semibold">
                          {formatUSD(targetItem.amount_usd)} · {formatMT(targetItem.amount_usd, targetItem.exchange_rate_used)}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">Estado Atual</div>
                        <div className="font-mono text-amber-300 font-semibold">{targetItem.status}</div>
                      </div>
                    </div>

                    {targetWithdrawal && !withdrawalCanReview && (
                      <div className="text-xs text-slate-300">
                        Este levantamento já se encontra no estado <strong className="text-white">{targetWithdrawal.status}</strong> e não aceita nova aprovação/rejeição.
                      </div>
                    )}

                    {targetDeposit && isMpesaDep && (
                      <div className="text-xs text-amber-200 bg-[#090D16] border border-amber-500/30 rounded-lg p-3">
                        Bloqueio de segurança ativo (<strong>MPESA_ADMIN_BLOCK</strong>): depósitos M-Pesa não podem ser creditados manualmente. Utilize a consulta oficial à operadora M-Pesa.
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="text"
                        value={reviewNotes}
                        onChange={(e) => setReviewNotes(e.target.value)}
                        placeholder="Nota de auditoria opcional..."
                        className="flex-1 min-w-[220px] px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                      />
                      {targetWithdrawal && withdrawalCanReview && (
                        <button
                          type="button"
                          disabled={actionBusyId === targetWithdrawal.id}
                          onClick={() =>
                            handleReviewWithdrawal(
                              targetWithdrawal.id,
                              pendingReviewAction.decision,
                              reviewNotes
                            )
                          }
                          className={`px-4 py-2 text-xs font-semibold rounded-lg text-white cursor-pointer disabled:opacity-50 ${
                            pendingReviewAction.decision === 'APPROVED'
                              ? 'bg-emerald-600 hover:bg-emerald-500'
                              : 'bg-red-600 hover:bg-red-500'
                          }`}
                        >
                          {actionBusyId === targetWithdrawal.id
                            ? 'A processar...'
                            : pendingReviewAction.decision === 'APPROVED'
                              ? 'Confirmar Aprovação & Pagar M-Pesa (POST)'
                              : 'Confirmar Rejeição & Devolver Saldo (POST)'}
                        </button>
                      )}
                      {targetDeposit && isMpesaDep && (
                        <button
                          type="button"
                          disabled={actionBusyId === targetDeposit.id}
                          onClick={() => handleReconcileDepositQuery(targetDeposit.id)}
                          className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white cursor-pointer disabled:opacity-50"
                        >
                          {actionBusyId === targetDeposit.id
                            ? 'A consultar...'
                            : 'Consultar Operadora M-Pesa (POST)'}
                        </button>
                      )}
                      {targetDeposit && !isMpesaDep && targetDeposit.status === 'PENDING' && (
                        <button
                          type="button"
                          disabled={actionBusyId === targetDeposit.id}
                          onClick={() =>
                            handleReviewDeposit(
                              targetDeposit.id,
                              pendingReviewAction.decision,
                              reviewNotes
                            )
                          }
                          className={`px-4 py-2 text-xs font-semibold rounded-lg text-white cursor-pointer disabled:opacity-50 ${
                            pendingReviewAction.decision === 'APPROVED'
                              ? 'bg-emerald-600 hover:bg-emerald-500'
                              : 'bg-red-600 hover:bg-red-500'
                          }`}
                        >
                          {pendingReviewAction.decision === 'APPROVED'
                            ? 'Confirmar Aprovação Legado (POST)'
                            : 'Confirmar Rejeição (POST)'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white">Depósitos M-Pesa (Automático)</div>
                <div className="text-[11px] text-slate-400">
                  Aprovação manual administrativa bloqueada (MPESA_ADMIN_BLOCK). O crédito ocorre apenas após confirmação oficial da operadora.
                </div>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                1 USD = {rate} MT
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Referência</th>
                    <th className="py-2.5 px-4 font-medium">Utilizador</th>
                    <th className="py-2.5 px-4 font-medium">M-Pesa</th>
                    <th className="py-2.5 px-4 font-medium text-right">Valor</th>
                    <th className="py-2.5 px-4 font-medium">Estado</th>
                    <th className="py-2.5 px-4 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {deposits.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 px-4 text-center text-slate-500">
                        Sem depósitos registados.
                      </td>
                    </tr>
                  ) : (
                    deposits.map((d) => {
                      const isMpesa = d.method === 'M-Pesa' || (d.provider || '').includes('MPESA');
                      const canQueryMpesa =
                        isMpesa &&
                        ['CREATED', 'PAYMENT_PENDING', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(
                          d.status
                        );
                      const statusColor =
                        d.status === 'CREDITED' || d.status === 'APPROVED' || d.status === 'PAID'
                          ? 'text-emerald-400'
                          : d.status === 'FAILED' ||
                              d.status === 'EXPIRED' ||
                              d.status === 'REJECTED' ||
                              d.status === 'CANCELLED'
                            ? 'text-red-400'
                            : d.status === 'RECONCILIATION_REQUIRED' || d.status === 'UNKNOWN'
                              ? 'text-orange-400'
                              : 'text-amber-400';

                      return (
                        <tr key={d.id}>
                          <td className="py-3 px-4 font-mono text-slate-300">
                            <div>{d.reference}</div>
                            {d.mpesa_transaction_id && (
                              <div className="text-[10px] text-slate-500">
                                TX: {d.mpesa_transaction_id}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500">
                              {formatDateTime(d.created_at)}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-mono text-slate-200">{d.public_code}</span> ·{' '}
                            <span className="text-slate-400">{d.email}</span>
                          </td>
                          <td className="py-3 px-4 text-slate-200">
                            <div>{d.method}</div>
                            {(d.msisdn_masked || d.msisdn) && (
                              <div className="font-mono text-[11px] text-slate-400">
                                {d.msisdn_masked || d.msisdn}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                            <div>{formatUSD(d.amount_usd)}</div>
                            <div className="text-[11px] text-slate-400">
                              {formatMT(d.amount_usd, d.exchange_rate_used)} (1:{d.exchange_rate_used})
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span className={statusColor}>{d.status}</span>
                          </td>
                          <td className="py-3 px-4 text-right space-x-2">
                            {isMpesa ? (
                              <div className="inline-flex items-center gap-2">
                                {canQueryMpesa && (
                                  <button
                                    type="button"
                                    disabled={actionBusyId === d.id}
                                    onClick={() => handleReconcileDepositQuery(d.id)}
                                    className="px-2.5 py-1 text-xs font-medium rounded border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 cursor-pointer disabled:opacity-50"
                                  >
                                    Consultar M-Pesa
                                  </button>
                                )}
                                <span className="text-[11px] font-mono text-slate-500">
                                  Automático
                                </span>
                              </div>
                            ) : d.status === 'PENDING' ? (
                              <>
                                <button
                                  type="button"
                                  disabled={actionBusyId === d.id}
                                  onClick={() => handleReviewDeposit(d.id, 'APPROVED')}
                                  className="px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50"
                                >
                                  Aprovar Legado
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusyId === d.id}
                                  onClick={() => handleReviewDeposit(d.id, 'REJECTED')}
                                  className="px-2.5 py-1 text-xs font-medium rounded bg-red-600/80 hover:bg-red-500 text-white cursor-pointer disabled:opacity-50"
                                >
                                  Rejeitar
                                </button>
                              </>
                            ) : (
                              <span className="text-slate-500 font-mono">
                                {d.reviewed_by || '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white">
                  Gestão de Levantamentos M-Pesa (Aprovação + Desembolso B2C)
                </div>
                <div className="text-[11px] text-slate-400">
                  O saldo reservado só é consumido após confirmação B2C oficial ou devolvido em caso de rejeição/falha definitiva.
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Referência</th>
                    <th className="py-2.5 px-4 font-medium">Utilizador</th>
                    <th className="py-2.5 px-4 font-medium">Destino & Risco</th>
                    <th className="py-2.5 px-4 font-medium text-right">Valor</th>
                    <th className="py-2.5 px-4 font-medium">Estado</th>
                    <th className="py-2.5 px-4 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {withdrawals.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 px-4 text-center text-slate-500">
                        Sem levantamentos registados.
                      </td>
                    </tr>
                  ) : (
                    withdrawals.map((w) => {
                      const canReview =
                        w.status === 'AWAITING_APPROVAL' || w.status === 'PENDING';
                      const statusColor =
                        w.status === 'PAID' || w.status === 'APPROVED'
                          ? 'text-emerald-400'
                          : w.status === 'REJECTED' || w.status === 'FAILED'
                            ? 'text-red-400'
                            : w.status === 'RECONCILIATION_REQUIRED' || w.status === 'UNKNOWN'
                              ? 'text-orange-400'
                              : 'text-amber-400';

                      return (
                        <tr key={w.id}>
                          <td className="py-3 px-4 font-mono text-slate-300">
                            <div>{w.reference}</div>
                            {w.mpesa_transaction_id && (
                              <div className="text-[10px] text-slate-500">
                                TX: {w.mpesa_transaction_id}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500">
                              {formatDateTime(w.created_at)}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-mono text-slate-200">{w.public_code}</span> ·{' '}
                            <span className="text-slate-400">{w.email}</span>
                          </td>
                          <td className="py-3 px-4 text-slate-200 font-mono">
                            <div>
                              {w.destination_type} · {w.msisdn_masked || w.destination_account}
                            </div>
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              Risco: {w.risk_score ?? 0}/100
                              {w.risk_flags && w.risk_flags.length > 0
                                ? ` · ${w.risk_flags.join(', ')}`
                                : ' · Normal'}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                            <div>{formatUSD(w.amount_usd)}</div>
                            <div className="text-[11px] text-slate-400">
                              {formatMT(w.amount_usd, w.exchange_rate_used)} (1:{w.exchange_rate_used})
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <div className={statusColor}>{w.status}</div>
                            {w.disbursement_status && (
                              <div className="text-[10px] text-slate-500">
                                B2C: {w.disbursement_status}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right space-x-2">
                            {canReview ? (
                              <>
                                <button
                                  type="button"
                                  disabled={actionBusyId === w.id}
                                  onClick={() => handleReviewWithdrawal(w.id, 'APPROVED')}
                                  className="px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50"
                                >
                                  Aprovar & Pagar M-Pesa
                                </button>
                                <button
                                  type="button"
                                  disabled={actionBusyId === w.id}
                                  onClick={() => handleReviewWithdrawal(w.id, 'REJECTED')}
                                  className="px-2.5 py-1 text-xs font-medium rounded bg-red-600/80 hover:bg-red-500 text-white cursor-pointer disabled:opacity-50"
                                >
                                  Rejeitar & Devolver
                                </button>
                              </>
                            ) : (w.status === 'DISBURSEMENT_PENDING' || w.status === 'RECONCILIATION_REQUIRED') &&
                              w.mpesa_conversation_id ? (
                              <div className="inline-flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={actionBusyId === w.id}
                                  onClick={() => handleReconcileWithdrawalQuery(w.id)}
                                  className="px-2.5 py-1 text-xs font-medium rounded border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 cursor-pointer disabled:opacity-50"
                                >
                                  Consultar Saque
                                </button>
                                <span className="text-slate-500 font-mono">
                                  {w.approved_by || w.reviewed_by || '—'}
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-500 font-mono">
                                {w.approved_by || w.reviewed_by || '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white">
                  Reconciliação Operacional M-Pesa
                </div>
                <div className="text-[11px] text-slate-400">
                  Operações com timeout, divergência ou resposta incerta ficam retidas aqui até verificação oficial.
                </div>
              </div>
              <span className="text-xs font-mono text-amber-400">
                {reconciliationRecords.filter((r) => r.status === 'OPEN').length} aberta(s)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Tipo / Ref.</th>
                    <th className="py-2.5 px-4 font-medium">Motivo</th>
                    <th className="py-2.5 px-4 font-medium">Estado</th>
                    <th className="py-2.5 px-4 font-medium">Evidência / Notas</th>
                    <th className="py-2.5 px-4 font-medium text-right">Resolução</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {reconciliationRecords.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 px-4 text-center text-slate-500">
                        Sem ocorrências de reconciliação pendentes.
                      </td>
                    </tr>
                  ) : (
                    reconciliationRecords.map((rec) => (
                      <tr key={rec.id}>
                        <td className="py-3 px-4 font-mono text-slate-300">
                          <div>
                            {rec.entity_type} · {rec.reference}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {formatDateTime(rec.created_at)}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-300 max-w-xs">{rec.reason}</td>
                        <td className="py-3 px-4 font-mono">
                          <span
                            className={
                              rec.status === 'OPEN'
                                ? 'text-orange-400'
                                : rec.status === 'RESOLVED_CONFIRMED'
                                  ? 'text-emerald-400'
                                  : 'text-red-400'
                            }
                          >
                            {rec.status}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {rec.status === 'OPEN' ? (
                            <div className="flex flex-col gap-1.5 min-w-[200px]">
                              <input
                                type="text"
                                value={reconcileTxInputs[rec.id] ?? ''}
                                onChange={(e) =>
                                  setReconcileTxInputs((prev) => ({
                                    ...prev,
                                    [rec.id]: e.target.value,
                                  }))
                                }
                                placeholder="ID Transação M-Pesa (opcional)"
                                className="px-2.5 py-1 text-[11px] font-mono rounded bg-[#090D16] border border-slate-700 text-white"
                              />
                              <input
                                type="text"
                                value={reconcileNoteInputs[rec.id] ?? ''}
                                onChange={(e) =>
                                  setReconcileNoteInputs((prev) => ({
                                    ...prev,
                                    [rec.id]: e.target.value,
                                  }))
                                }
                                placeholder="Notas de auditoria..."
                                className="px-2.5 py-1 text-[11px] rounded bg-[#090D16] border border-slate-700 text-white"
                              />
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400">
                              {rec.resolution_notes || '—'}
                              {rec.resolved_by && (
                                <div className="font-mono text-[10px] text-slate-500">
                                  Por {rec.resolved_by}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                          {rec.status === 'OPEN' ? (
                            <>
                              <button
                                type="button"
                                disabled={actionBusyId === rec.id}
                                onClick={() =>
                                  handleResolveReconciliation(rec.id, 'RESOLVED_CONFIRMED')
                                }
                                className="px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50"
                              >
                                Confirmar Pago
                              </button>
                              <button
                                type="button"
                                disabled={actionBusyId === rec.id}
                                onClick={() =>
                                  handleResolveReconciliation(rec.id, 'RESOLVED_FAILED')
                                }
                                className="px-2.5 py-1 text-xs font-medium rounded bg-red-600/80 hover:bg-red-500 text-white cursor-pointer disabled:opacity-50"
                              >
                                Marcar Falhado
                              </button>
                            </>
                          ) : (
                            <span className="font-mono text-slate-500">Resolvido</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. OPERATIONS */}
      {tab === 'operations' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Capital Total em Operações Ativas</div>
              <div className="font-mono text-xl font-bold text-blue-400 mt-1 tabular-nums">
                {formatUSD(liveActiveCapitalUsd)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {activeOpsList.length} operação(ões) em curso
              </div>
            </div>
            <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Ganho / Perda Flutuante (Utilizadores)</div>
              <div
                className={`font-mono text-xl font-bold mt-1 tabular-nums ${
                  liveUserFloatingPnlUsd > 0
                    ? 'text-emerald-400'
                    : liveUserFloatingPnlUsd < 0
                      ? 'text-red-400'
                      : 'text-slate-300'
                }`}
              >
                {liveUserFloatingPnlUsd >= 0 ? '+' : ''}
                {formatUSD(liveUserFloatingPnlUsd)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {liveUserFloatingPnlUsd >= 0
                  ? 'Utilizadores em lucro flutuante neste instante'
                  : 'Utilizadores em perda flutuante neste instante'}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="text-xs text-slate-400">Resultado Flutuante da Casa</div>
              <div
                className={`font-mono text-xl font-bold mt-1 tabular-nums ${
                  liveHouseFloatingPnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {liveHouseFloatingPnlUsd >= 0 ? '+' : ''}
                {formatUSD(liveHouseFloatingPnlUsd)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                MIL-IDX atual: ${snapshot?.current_price.toFixed(4) ?? '—'}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Referência</th>
                    <th className="py-3 px-4 font-medium">Utilizador</th>
                    <th className="py-3 px-4 font-medium">Direção</th>
                    <th className="py-3 px-4 font-medium text-right">Valor</th>
                    <th className="py-3 px-4 font-medium text-right">Entrada → Atual/Saída</th>
                    <th className="py-3 px-4 font-medium">Duração / Restante</th>
                    <th className="py-3 px-4 font-medium text-right">Resultado / Flutuante</th>
                    <th className="py-3 px-4 font-medium">Onde Terminou</th>
                    <th className="py-3 px-4 font-medium">Estado</th>
                    <th className="py-3 px-4 font-medium text-right">Controlo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {operations.map((o) => {
                    const live = o.status === 'ACTIVE' ? computeAdminOpLive(o) : null;
                    return (
                      <tr key={o.id}>
                        <td className="py-3 px-4 font-mono text-slate-300">{o.reference}</td>
                        <td className="py-3 px-4">
                          <span className="font-mono text-slate-200">{o.public_code}</span>
                        </td>
                        <td className="py-3 px-4 font-mono font-semibold">
                          <span className={o.direction === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'}>
                            {o.direction}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                          {formatUSD(o.amount_usd)}
                        </td>
                        <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                          ${o.entry_price.toFixed(2)} →{' '}
                          {o.status === 'ACTIVE'
                            ? currentMarketPrice > 0
                              ? `$${currentMarketPrice.toFixed(2)}`
                              : '—'
                            : o.exit_price !== null
                              ? `$${o.exit_price.toFixed(2)}`
                              : '—'}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-300">
                          <div>{formatDurationLabel(o.duration_seconds)}</div>
                          {o.status === 'ACTIVE' && (
                            <div className="text-[11px] text-cyan-300 tabular-nums">
                              Restam: {formatCountdown(o.expires_at, nowMs)}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-right tabular-nums">
                          {o.status === 'ACTIVE' && live ? (
                            <div>
                              <span className={live.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                {live.pnl >= 0 ? '+' : ''}
                                {formatUSD(live.pnl)} ({live.pct >= 0 ? '+' : ''}
                                {live.pct.toFixed(2)}%)
                              </span>
                              <div className="text-[10px] text-slate-400">
                                Val. atual: {formatUSD(live.val)}
                              </div>
                            </div>
                          ) : o.result_amount_usd !== null ? (
                            <span className={o.result_amount_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                              {o.result_amount_usd >= 0 ? '+' : ''}
                              {formatUSD(o.result_amount_usd)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-300">
                          <div className="font-medium">{formatTerminationLabel(o)}</div>
                          {o.settled_at && (
                            <div className="font-mono text-[10px] text-slate-500">
                              {formatDateTime(o.settled_at)}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-300">{o.status}</td>
                        <td className="py-3 px-4 text-right">
                          {o.status === 'ACTIVE' && (
                            <button
                              onClick={() => handleCancelOperation(o.id)}
                              className="px-2.5 py-1 text-xs rounded border border-slate-700 hover:bg-slate-800 text-slate-200 cursor-pointer"
                            >
                              Cancelar & Reembolsar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 6. MARKET CONTROL & REAL PLATFORM DATA */}
      {tab === 'market' && snapshot && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
            <h2 className="text-base font-semibold text-white">Controlo do Motor MIL-IDX</h2>
            <dl className="space-y-2.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-400">Preço Atual</dt>
                <dd className="font-mono text-white font-semibold tabular-nums">
                  ${snapshot.current_price.toFixed(4)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Modo do Gráfico</dt>
                <dd className="font-mono text-blue-300 font-semibold">
                  {controlModeLabel[activeControlMode]}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Sessão Ativa</dt>
                <dd className="font-mono text-slate-200">
                  #{snapshot.session.session_number} ({snapshot.session.regime})
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Estado do Motor</dt>
                <dd
                  className={`font-mono font-semibold ${
                    snapshot.market_paused ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {snapshot.market_paused ? 'PAUSADO' : 'EM EXECUÇÃO CONTÍNUA'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400 mb-1">Hash SHA-256 da Sessão</dt>
                <dd className="font-mono text-[11px] break-all bg-[#090D16] p-2.5 rounded border border-slate-800 text-slate-300">
                  {snapshot.session.seed_hash}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={toggleMarketPause}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg cursor-pointer whitespace-nowrap"
              >
                {snapshot.market_paused ? 'Retomar Motor de Mercado' : 'Pausar Motor Temporariamente'}
              </button>
              <button
                onClick={() => setTab('chart-control')}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Abrir Controle de Gráfico
              </button>
            </div>
          </div>

          <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
            <h2 className="text-base font-semibold text-white">Dados Reais da Plataforma</h2>
            {overview ? (
              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-400">Dinheiro Real Depositado (Aprovado)</dt>
                  <dd className="font-mono text-emerald-400 tabular-nums">
                    {formatUSD(overview.realFinancials?.total_deposited_usd ?? 0)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Levantamentos Reais Aprovados</dt>
                  <dd className="font-mono text-white tabular-nums">
                    {formatUSD(overview.realFinancials?.total_withdrawn_usd ?? 0)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Dinheiro Real em Operação</dt>
                  <dd className="font-mono text-blue-400 tabular-nums">
                    {formatUSD(overview.walletStats.total_locked)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Saldo Disponível Real em Carteiras</dt>
                  <dd className="font-mono text-white tabular-nums">
                    {formatUSD(overview.walletStats.total_available)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Utilizadores Ativos Reais</dt>
                  <dd className="font-mono text-white tabular-nums">
                    {overview.userStats.active_users} ativos / {overview.userStats.total_users} total
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Operações Ativas Reais</dt>
                  <dd className="font-mono text-slate-200 tabular-nums">
                    {overview.realFinancials?.active_up_count ?? 0} SUBIDA (
                    {formatUSD(overview.realFinancials?.active_up_usd ?? 0)}) ·{' '}
                    {overview.realFinancials?.active_down_count ?? 0} DESCIDA (
                    {formatUSD(overview.realFinancials?.active_down_usd ?? 0)})
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="text-xs text-slate-400">A carregar dados reais...</div>
            )}
          </div>
        </div>
      )}

      {/* 7. REPORTS & GLOBAL LEDGER */}
      {tab === 'reports' && reports && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <h2 className="text-sm font-semibold text-white mb-3">Operações por Direção</h2>
              <table className="w-full text-xs">
                <thead className="text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 text-left">Direção</th>
                    <th className="py-2 text-right">Qtd.</th>
                    <th className="py-2 text-right">Volume</th>
                    <th className="py-2 text-right">PnL Líquido</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {reports.operationsByDirection.map((r) => (
                    <tr key={r.direction}>
                      <td className="py-2.5 font-mono text-white">{r.direction}</td>
                      <td className="py-2.5 font-mono text-right text-slate-300">{r.count}</td>
                      <td className="py-2.5 font-mono text-right text-slate-300">
                        {formatUSD(r.volume)}
                      </td>
                      <td className="py-2.5 font-mono text-right text-slate-200">
                        {formatUSD(r.net_pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <h2 className="text-sm font-semibold text-white mb-3">Resumo de Depósitos</h2>
              <table className="w-full text-xs">
                <thead className="text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 text-left">Estado</th>
                    <th className="py-2 text-right">Pedidos</th>
                    <th className="py-2 text-right">Volume USD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {reports.depositsSummary.map((r) => (
                    <tr key={r.status}>
                      <td className="py-2.5 font-mono text-white">{r.status}</td>
                      <td className="py-2.5 font-mono text-right text-slate-300">{r.count}</td>
                      <td className="py-2.5 font-mono text-right text-slate-300">
                        {formatUSD(r.volume_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-800 text-sm font-semibold text-white">
              Histórico Global de Movimentações (Extrato Geral)
            </div>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Referência</th>
                    <th className="py-2.5 px-4">Conta</th>
                    <th className="py-2.5 px-4">Descrição</th>
                    <th className="py-2.5 px-4 text-right">Valor</th>
                    <th className="py-2.5 px-4">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {globalLedger.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2.5 px-4 font-mono text-slate-300">{l.reference}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-400">{l.public_code}</td>
                      <td className="py-2.5 px-4 text-slate-200">{l.description}</td>
                      <td className="py-2.5 px-4 font-mono text-right text-white">
                        {formatUSD(l.amount)}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-400">
                        {formatDateTime(l.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 8. NOTIFICATIONS & SUPPORT */}
      {tab === 'comms' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleSendNotification}
            className="lg:col-span-5 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4 h-fit"
          >
            <h2 className="text-sm font-semibold text-white">Enviar Comunicado</h2>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Destinatário</label>
              <select
                value={ntfUserId}
                onChange={(e) => setNtfUserId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
              >
                <option value="">Todos os utilizadores (Global)</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.public_code} — {u.email}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Título</label>
              <input
                type="text"
                required
                value={ntfTitle}
                onChange={(e) => setNtfTitle(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Mensagem</label>
              <textarea
                rows={3}
                required
                value={ntfMessage}
                onChange={(e) => setNtfMessage(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
            >
              Publicar Notificação
            </button>
          </form>

          <div className="lg:col-span-7 space-y-3">
            <h2 className="text-sm font-semibold text-white">Solicitações de Suporte</h2>
            {tickets.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400 rounded-xl border border-slate-800 bg-[#101724]">
                Sem tickets de suporte.
              </div>
            ) : (
              tickets.map((t) => {
                const thread =
                  t.messages && t.messages.length > 0
                    ? t.messages
                    : [
                        {
                          id: `${t.id}_msg`,
                          ticket_id: t.id,
                          sender_id: t.user_id,
                          sender_role: 'USER',
                          sender_email: t.email || 'utilizador',
                          body: t.message,
                          created_at: t.created_at,
                        },
                        ...(t.admin_reply
                          ? [
                              {
                                id: `${t.id}_rep`,
                                ticket_id: t.id,
                                sender_id: 'admin',
                                sender_role: 'ADMIN',
                                sender_email: t.replied_by || 'equipa@milion.space',
                                body: t.admin_reply,
                                created_at: t.updated_at || t.created_at,
                              },
                            ]
                          : []),
                      ];
                return (
                  <div key={t.id} className="p-4 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
                    <div className="flex flex-wrap justify-between gap-2 text-xs">
                      <span className="font-mono text-slate-400">
                        {t.reference} · {t.category} · {t.public_code} ({t.email})
                      </span>
                      <span
                        className={`font-mono ${
                          t.status === 'RESOLVED'
                            ? 'text-emerald-400'
                            : t.status === 'IN_PROGRESS'
                              ? 'text-cyan-300'
                              : t.status === 'CLOSED'
                                ? 'text-slate-400'
                                : 'text-amber-400'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-white">{t.subject}</div>
                    <div className="space-y-1.5">
                      {thread.map((m) => {
                        const isStaff = m.sender_role === 'ADMIN' || m.sender_role === 'SUPER_ADMIN';
                        return (
                          <div
                            key={m.id}
                            className={`p-2.5 rounded-lg border text-xs ${
                              isStaff
                                ? 'bg-cyan-950/20 border-cyan-500/30'
                                : 'bg-[#090D16] border-slate-800'
                            }`}
                          >
                            <div className="flex justify-between text-[11px] mb-0.5">
                              <span className={isStaff ? 'text-cyan-300 font-medium' : 'text-slate-300 font-medium'}>
                                {isStaff ? `Equipa (${m.sender_email})` : `Utilizador (${m.sender_email})`}
                              </span>
                              <span className="font-mono text-slate-500">{formatDateTime(m.created_at)}</span>
                            </div>
                            <p className="text-slate-200 whitespace-pre-wrap">{m.body}</p>
                          </div>
                        );
                      })}
                    </div>
                    {replyTargetId === t.id ? (
                      <div className="space-y-2 pt-2 border-t border-slate-800">
                        <div className="flex flex-wrap gap-2">
                          <input
                            type="text"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="Escrever resposta para o utilizador..."
                            className="flex-1 min-w-[200px] px-3 py-1.5 text-xs rounded bg-[#090D16] border border-slate-700 text-white"
                          />
                          <select
                            value={replyStatusById[t.id] ?? 'RESOLVED'}
                            onChange={(e) =>
                              setReplyStatusById((prev) => ({
                                ...prev,
                                [t.id]: e.target.value as 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED',
                              }))
                            }
                            className="px-2.5 py-1.5 text-xs rounded bg-[#090D16] border border-slate-700 text-white"
                          >
                            <option value="IN_PROGRESS">Em Análise</option>
                            <option value="RESOLVED">Resolvido</option>
                            <option value="CLOSED">Encerrado</option>
                            <option value="OPEN">Aberto</option>
                          </select>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTargetId(null);
                              setReplyText('');
                            }}
                            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded cursor-pointer"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReplyTicket(t.id)}
                            className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded cursor-pointer"
                          >
                            Enviar Resposta
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTargetId(t.id);
                          setReplyText('');
                          setReplyStatusById((prev) => ({
                            ...prev,
                            [t.id]: t.status === 'OPEN' ? 'IN_PROGRESS' : t.status,
                          }));
                        }}
                        className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
                      >
                        Responder / Atualizar Estado
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* 9. AUDIT LOGS */}
      {tab === 'audit' && (
        <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Data e Hora</th>
                  <th className="py-3 px-4 font-medium">Ator</th>
                  <th className="py-3 px-4 font-medium">Ação</th>
                  <th className="py-3 px-4 font-medium">Entidade</th>
                  <th className="py-3 px-4 font-medium">Detalhes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5 px-4 font-mono text-slate-400 whitespace-nowrap">
                      {formatDateTime(a.created_at)}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="text-slate-200">{a.actor_email}</div>
                      <div className="font-mono text-[10px] text-slate-500">{a.actor_role}</div>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-blue-300">{a.action}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-300">
                      {a.entity_type} ({a.entity_id.slice(0, 10)})
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-slate-400 max-w-md truncate">
                      {a.details_json}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 10. SETTINGS & FACTORY RESET */}
      {tab === 'settings' && settingsForm && (
        <div className="space-y-6 max-w-2xl">
          <form
            onSubmit={handleSaveSettings}
            className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-4"
          >
            <h2 className="text-base font-semibold text-white">Parâmetros da Plataforma</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Taxa de Referência (1 USD = X MT)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={settingsForm.usd_to_mt_rate}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, usd_to_mt_rate: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Multiplicador Proporcional (x)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={settingsForm.proportional_multiplier}
                  onChange={(e) =>
                    setSettingsForm({
                      ...settingsForm,
                      proportional_multiplier: Number(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Duração Máxima (Dias)</label>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={settingsForm.max_duration_days}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, max_duration_days: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Depósito Mínimo (USD)</label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={settingsForm.min_deposit_usd}
                  onChange={(e) =>
                    setSettingsForm({ ...settingsForm, min_deposit_usd: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Volatilidade Base MIL-IDX
                </label>
                <input
                  type="number"
                  step="0.0002"
                  min="0.0002"
                  max="0.01"
                  value={settingsForm.market_base_volatility}
                  onChange={(e) =>
                    setSettingsForm({
                      ...settingsForm,
                      market_base_volatility: Number(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={currentUser.role !== 'SUPER_ADMIN'}
              className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg cursor-pointer"
            >
              {currentUser.role === 'SUPER_ADMIN'
                ? 'Guardar Configurações Auditadas'
                : 'Apenas Super Admin pode editar'}
            </button>
          </form>

          {currentUser.role === 'SUPER_ADMIN' && (
            <form
              onSubmit={handleFactoryReset}
              className="p-6 rounded-xl border border-red-500/40 bg-red-950/15 space-y-4"
            >
              <div>
                <div className="text-[11px] font-mono uppercase tracking-wider text-red-400">
                  Zona de Reinicialização Completa (SUPER_ADMIN)
                </div>
                <h2 className="text-base font-semibold text-white mt-0.5">
                  Apagar Todos os Dados e Registos (Começar do Zero)
                </h2>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  Remove todos os utilizadores comuns, saldos, extratos, depósitos, levantamentos, operações, saques de terceiros, tickets de suporte, notificações, logs de auditoria e ticks anteriores. As contas <span className="font-mono text-amber-300">SUPER_ADMIN</span> e a sua sessão atual são preservadas com saldo zerado e um novo ciclo limpo de mercado.
                </p>
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1.5">
                  Para confirmar, escreva exatamente <span className="font-mono text-red-300 font-semibold">APAGAR TUDO</span>:
                </label>
                <input
                  type="text"
                  value={resetConfirmInput}
                  onChange={(e) => setResetConfirmInput(e.target.value)}
                  placeholder="APAGAR TUDO"
                  className="w-full px-3.5 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-red-500/40 text-white focus:outline-none focus:border-red-400"
                />
              </div>

              <button
                type="submit"
                disabled={resetBusy || resetConfirmInput.trim().toUpperCase() !== 'APAGAR TUDO'}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-lg cursor-pointer transition-colors"
              >
                {resetBusy ? 'A apagar dados...' : 'Apagar Todos os Dados e Registos'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
