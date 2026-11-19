import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Search,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type {
  DepositRequest,
  GlobalMarketSnapshot,
  LedgerEntry,
  NotificationItem,
  Operation,
  SupportTicket,
  User,
  Wallet,
  WithdrawalRequest,
} from '../types';
import {
  apiRequest,
  formatCountdown,
  formatDateTime,
  formatDurationLabel,
  formatMT,
  formatUSD,
} from '../lib/api';
import { MarketChart } from './MarketChart';
import { GlobalMarketView } from './GlobalMarketView';
import { HowItWorksView } from './HowItWorksView';

export type UserTab =
  | 'dashboard'
  | 'wallet'
  | 'transfers'
  | 'operations'
  | 'history'
  | 'market'
  | 'how-it-works'
  | 'notifications'
  | 'support'
  | 'profile';

interface UserWorkspaceProps {
  activeTab: UserTab;
  onTabChange: (tab: UserTab) => void;
  user: User;
  onUserUpdated: (user: User) => void;
  snapshot: GlobalMarketSnapshot | null;
  wsConnected: boolean;
  wallet: Wallet | null;
  ledger: LedgerEntry[];
  operations: Operation[];
  notifications: NotificationItem[];
  onRefreshAll: () => Promise<void>;
}

const DURATION_OPTIONS = [
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '15 min', seconds: 900 },
  { label: '20 min', seconds: 1200 },
  { label: '30 min', seconds: 1800 },
  { label: '1 hora', seconds: 3600 },
  { label: '4 horas', seconds: 14400 },
  { label: '24 horas', seconds: 86400 },
  { label: '3 dias', seconds: 259200 },
  { label: '7 dias', seconds: 604800 },
  { label: '14 dias', seconds: 1209600 },
];

export const UserWorkspace: React.FC<UserWorkspaceProps> = ({
  activeTab,
  onTabChange,
  user,
  onUserUpdated,
  snapshot,
  wsConnected,
  wallet,
  ledger,
  operations,
  notifications,
  onRefreshAll,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [walletRefCurrency, setWalletRefCurrency] = useState('MZN');

  // Transfers state (M-Pesa Exclusive + Stylized Regional Tabs)
  const [paymentRegion, setPaymentRegion] = useState<'MZ' | 'AO' | 'BR' | 'EU' | 'ZA'>('MZ');
  const [transferMode, setTransferMode] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'DEPOSIT' | 'WITHDRAWAL'>('ALL');
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [depMsisdn, setDepMsisdn] = useState(() =>
    /^(?:\+?258)?\s?(?:84|85)\d{7}$/.test(user.phone.replace(/\s+/g, '')) ? user.phone : ''
  );
  const [depCurrency, setDepCurrency] = useState<'USD' | 'MZN'>('USD');
  const [depAmountInput, setDepAmountInput] = useState('10');
  const [wdrMsisdn, setWdrMsisdn] = useState(() =>
    /^(?:\+?258)?\s?(?:84|85)\d{7}$/.test(user.phone.replace(/\s+/g, '')) ? user.phone : ''
  );
  const [wdrCurrency, setWdrCurrency] = useState<'USD' | 'MZN'>('MZN');
  const [wdrAmountInput, setWdrAmountInput] = useState('350');
  const [transferMsg, setTransferMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [mpesaGatewayStatus, setMpesaGatewayStatus] = useState<{
    provider?: string;
    configured: boolean;
    environment: string;
    missing_vars?: string[];
  } | null>(null);
  const [pollingDepositId, setPollingDepositId] = useState<string | null>(null);
  const [reconcilingDepositId, setReconcilingDepositId] = useState<string | null>(null);

  // Operations state
  const [opDirection, setOpDirection] = useState<'SUBIDA' | 'DESCIDA'>('SUBIDA');
  const [opAmount, setOpAmount] = useState('4');
  const [opDuration, setOpDuration] = useState(300);
  const [opBusy, setOpBusy] = useState(false);
  const [opMsg, setOpMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pendingOpConfirm, setPendingOpConfirm] = useState<{
    direction: 'SUBIDA' | 'DESCIDA';
    amount_usd: number;
    duration_seconds: number;
  } | null>(null);

  // History filters
  const [histFilter, setHistFilter] = useState<string>('ALL');
  const [histQuery, setHistQuery] = useState('');

  // Support state
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [supSubject, setSupSubject] = useState('');
  const [supCategory, setSupCategory] = useState('Operações');
  const [supMessage, setSupMessage] = useState('');
  const [supMsg, setSupMsg] = useState<string | null>(null);
  const [supStatusFilter, setSupStatusFilter] = useState<'ALL' | 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'>('ALL');
  const [supReplyTextById, setSupReplyTextById] = useState<Record<string, string>>({});
  const [supReplyBusyId, setSupReplyBusyId] = useState<string | null>(null);

  // Profile state
  const [profName, setProfName] = useState(user.full_name);
  const [profMsg, setProfMsg] = useState<string | null>(null);

  // Operation completion animation state
  const [settledToast, setSettledToast] = useState<Operation | null>(null);
  const prevActiveOpIdsRef = useRef<Set<string>>(new Set());
  const opsInitializedRef = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setProfName(user.full_name);
  }, [user]);

  useEffect(() => {
    const currentActiveIds = new Set(
      operations.filter((o) => o.status === 'ACTIVE').map((o) => o.id)
    );
    if (opsInitializedRef.current) {
      const newlyCompleted = operations.find(
        (o) => prevActiveOpIdsRef.current.has(o.id) && o.status === 'COMPLETED'
      );
      if (newlyCompleted) {
        setSettledToast(newlyCompleted);
      }
    } else if (operations.length > 0 || wallet !== null) {
      opsInitializedRef.current = true;
    }
    prevActiveOpIdsRef.current = currentActiveIds;
  }, [operations, wallet]);

  useEffect(() => {
    if (!settledToast) return;
    const timer = setTimeout(() => setSettledToast(null), 10000);
    return () => clearTimeout(timer);
  }, [settledToast?.id]);

  const loadTransfers = async () => {
    try {
      const [dRes, wRes, statusRes] = await Promise.all([
        apiRequest<{ deposits: DepositRequest[] }>('/api/deposits'),
        apiRequest<{ withdrawals: WithdrawalRequest[] }>('/api/withdrawals'),
        apiRequest<{ provider?: string; configured: boolean; environment: string; missing_vars?: string[] }>(
          '/api/payments/mpesa/status'
        ).catch(() => null),
      ]);
      setDeposits(dRes.deposits);
      setWithdrawals(wRes.withdrawals);
      if (statusRes) {
        setMpesaGatewayStatus(statusRes);
      }
    } catch {
      // ignore
    }
  };

  const loadSupport = async () => {
    try {
      const res = await apiRequest<{ tickets: SupportTicket[] }>('/api/support');
      setTickets(res.tickets);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (activeTab === 'transfers') {
      loadTransfers();
      const timer = setInterval(() => {
        loadTransfers();
      }, 2000);
      return () => clearInterval(timer);
    } else if (activeTab === 'support') {
      loadSupport();
    }
  }, [activeTab]);

  // Auto-mark notifications as read as soon as the user opens the Notifications tab
  const lastAutoReadSigRef = React.useRef<string>('');
  useEffect(() => {
    if (activeTab !== 'notifications') {
      lastAutoReadSigRef.current = '';
      return;
    }
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const sig = unreadIds.join(',');
    if (lastAutoReadSigRef.current === sig) return;
    lastAutoReadSigRef.current = sig;
    apiRequest('/api/notifications/read-all', { method: 'POST' })
      .then(() => onRefreshAll())
      .catch(() => {
        // ignore
      });
  }, [activeTab, notifications]);

  // Keep transfer table synced whenever wallet updates via WebSocket
  useEffect(() => {
    if (activeTab === 'transfers') {
      loadTransfers();
    }
  }, [wallet?.available_balance, wallet?.reserved_balance]);

  // Poll operator transaction status automatically while waiting for customer M-Pesa PIN
  useEffect(() => {
    if (!pollingDepositId) return;
    let cancelled = false;
    let attempts = 0;

    const timer = setInterval(async () => {
      if (cancelled) return;
      attempts++;
      try {
        const res = await apiRequest<{
          deposit: DepositRequest;
          still_pending?: boolean;
          message?: string;
        }>(`/api/deposits/${pollingDepositId}/reconcile`, { method: 'POST' });

        if (cancelled) return;
        const st = res.deposit.status;
        if (st === 'CREDITED' || st === 'APPROVED') {
          setPollingDepositId(null);
          setTransferMsg({
            type: 'ok',
            text:
              res.message ||
              `Depósito ${res.deposit.reference} de ${formatMT(res.deposit.amount_usd, res.deposit.exchange_rate_used)} (${formatUSD(res.deposit.amount_usd)}) confirmado e creditado.`,
          });
          await Promise.all([loadTransfers(), onRefreshAll()]);
        } else if (st === 'FAILED' || st === 'EXPIRED' || st === 'REJECTED' || st === 'CANCELLED') {
          setPollingDepositId(null);
          setTransferMsg({
            type: 'err',
            text: res.message || `O pagamento M-Pesa ${res.deposit.reference} não foi concluído (${st}).`,
          });
          await Promise.all([loadTransfers(), onRefreshAll()]);
        } else if (attempts >= 32) {
          setPollingDepositId(null);
          await loadTransfers();
        }
      } catch {
        if (attempts >= 32) {
          setPollingDepositId(null);
        }
      }
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollingDepositId]);

  // Enforce dynamic minimum duration when opAmount crosses $5
  const parsedOpAmount = Number(opAmount) || 0;
  const minRequiredSeconds = parsedOpAmount >= 5 ? 1200 : 300;
  useEffect(() => {
    if (opDuration < minRequiredSeconds) {
      setOpDuration(minRequiredSeconds);
    }
  }, [minRequiredSeconds, opDuration]);

  const rate = wallet?.exchange_rate ?? snapshot?.usd_to_mt_rate ?? 70;
  const currentPrice = snapshot?.current_price ?? 2500;
  const multiplier = snapshot?.proportional_multiplier ?? 25;

  const activeOperations = useMemo(
    () => operations.filter((o) => o.status === 'ACTIVE'),
    [operations]
  );

  // Auto-dismiss operation open/status message after a short delay
  useEffect(() => {
    if (!opMsg) return;
    const timer = setTimeout(() => {
      setOpMsg(null);
    }, opMsg.type === 'ok' ? 3500 : 5000);
    return () => clearTimeout(timer);
  }, [opMsg]);

  const filteredHistory = useMemo(() => {
    return operations.filter((o) => {
      if (histFilter !== 'ALL' && o.status !== histFilter) return false;
      if (histQuery.trim()) {
        const q = histQuery.trim().toLowerCase();
        return (
          o.reference.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q) ||
          o.direction.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [operations, histFilter, histQuery]);

  const estimateFloatingResult = (op: Operation) => {
    const pct = op.entry_price > 0 ? (currentPrice - op.entry_price) / op.entry_price : 0;
    const signed = op.direction === 'SUBIDA' ? pct : -pct;
    const bounded = Math.max(-1.0, signed * multiplier);
    const net = op.amount_usd * bounded;
    return { net, pct: bounded * 100 };
  };

  const hasBalance = (wallet?.total_balance ?? 0) > 0;
  const totalFloatingNet = activeOperations.reduce(
    (acc, op) => acc + estimateFloatingResult(op).net,
    0
  );
  const accountDepositedIndex = hasBalance
    ? Math.max(0, Number(((wallet?.total_balance ?? 0) + totalFloatingNet).toFixed(2)))
    : 0;

  const zeroTicks = useMemo(() => {
    const now = Date.now();
    return Array.from({ length: 24 }, (_, idx) => ({
      id: idx + 1,
      session_id: 'zero',
      price: 0,
      delta: 0,
      delta_pct: 0,
      timestamp: new Date(now - (23 - idx) * 2000).toISOString(),
    }));
  }, []);

  const displayedChartTicks = useMemo(() => {
    if (!hasBalance) return zeroTicks;
    const raw = snapshot?.recent_ticks ?? [];
    if (raw.length === 0 || currentPrice <= 0) {
      return zeroTicks.map((t) => ({ ...t, price: accountDepositedIndex }));
    }
    const scale = accountDepositedIndex / currentPrice;
    return raw.map((t) => ({
      ...t,
      price: Number((t.price * scale).toFixed(4)),
      delta: Number((t.delta * scale).toFixed(4)),
    }));
  }, [hasBalance, zeroTicks, snapshot?.recent_ticks, currentPrice, accountDepositedIndex]);

  const displayedOperationalPrice = accountDepositedIndex;

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTransferMsg(null);
    const rawNum = Number(depAmountInput) || 0;
    const amountUsd = depCurrency === 'MZN' ? Number((rawNum / rate).toFixed(2)) : Number(rawNum.toFixed(2));
    const idempotencyKey = `dep_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setTransferBusy(true);
    try {
      const res = await apiRequest<{
        deposit: DepositRequest;
        gateway_configured?: boolean;
        message?: string;
      }>('/api/deposits', {
        method: 'POST',
        body: JSON.stringify({
          method: 'M-Pesa',
          msisdn: depMsisdn.trim(),
          amount_usd: amountUsd,
          idempotency_key: idempotencyKey,
        }),
      });

      const dep = res.deposit;
      if (dep.status === 'CREDITED' || dep.status === 'APPROVED') {
        setPollingDepositId(null);
        setTransferMsg({
          type: 'ok',
          text:
            res.message ||
            `Depósito ${dep.reference} de ${formatMT(dep.amount_usd, dep.exchange_rate_used)} (${formatUSD(dep.amount_usd)}) confirmado e creditado na sua carteira.`,
        });
      } else {
        setPollingDepositId(dep.id);
        setTransferMsg({
          type: 'ok',
          text:
            res.message ||
            `Solicitação M-Pesa enviada (${dep.reference}). Introduza o PIN M-Pesa no telemóvel; o saldo será creditado automaticamente após confirmação.`,
        });
      }
      await Promise.all([loadTransfers(), onRefreshAll()]);
    } catch (err) {
      setPollingDepositId(null);
      setTransferMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Erro ao iniciar cobrança M-Pesa.',
      });
    } finally {
      setTransferBusy(false);
    }
  };

  const handleManualDepositCheck = async (depositId: string) => {
    setReconcilingDepositId(depositId);
    setTransferMsg(null);
    try {
      const res = await apiRequest<{
        deposit: DepositRequest;
        still_pending?: boolean;
        message?: string;
      }>(`/api/deposits/${depositId}/reconcile`, { method: 'POST' });

      const st = res.deposit.status;
      setTransferMsg({
        type: st === 'FAILED' || st === 'EXPIRED' ? 'err' : 'ok',
        text: res.message || `Estado M-Pesa verificado: ${st}.`,
      });
      if (st === 'CREDITED' || st === 'FAILED' || st === 'EXPIRED') {
        setPollingDepositId((curr) => (curr === depositId ? null : curr));
      }
      await Promise.all([loadTransfers(), onRefreshAll()]);
    } catch (err) {
      setTransferMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Não foi possível consultar a operadora M-Pesa.',
      });
    } finally {
      setReconcilingDepositId(null);
    }
  };

  const handleWithdrawalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTransferMsg(null);
    const rawNum = Number(wdrAmountInput) || 0;
    const amountUsd = wdrCurrency === 'MZN' ? Number((rawNum / rate).toFixed(2)) : Number(rawNum.toFixed(2));
    const idempotencyKey = `wdr_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setTransferBusy(true);
    try {
      const res = await apiRequest<{ withdrawal: WithdrawalRequest; message?: string }>(
        '/api/withdrawals',
        {
          method: 'POST',
          body: JSON.stringify({
            destination_type: 'M-Pesa',
            destination_account: wdrMsisdn.trim(),
            amount_usd: amountUsd,
            idempotency_key: idempotencyKey,
          }),
        }
      );
      setTransferMsg({
        type: 'ok',
        text:
          res.message ||
          `Levantamento M-Pesa ${res.withdrawal.reference} reservado para aprovação administrativa.`,
      });
      await Promise.all([loadTransfers(), onRefreshAll()]);
    } catch (err) {
      setTransferMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Erro ao solicitar levantamento via M-Pesa.',
      });
    } finally {
      setTransferBusy(false);
    }
  };

  const handleOpenOperation = (e: React.FormEvent) => {
    e.preventDefault();
    setOpMsg(null);
    if (snapshot?.market_paused) {
      setOpMsg({ type: 'err', text: 'O mercado encontra-se temporariamente pausado pelo administrador.' });
      return;
    }
    const cleanAmount = Number(parsedOpAmount.toFixed(2));
    if (!Number.isFinite(cleanAmount) || cleanAmount < 0.5) {
      setOpMsg({ type: 'err', text: 'O valor mínimo por operação é $0.50 USD.' });
      return;
    }
    if ((wallet?.available_balance ?? 0) < cleanAmount) {
      setOpMsg({ type: 'err', text: 'Saldo disponível insuficiente para abrir esta operação.' });
      return;
    }
    setPendingOpConfirm({
      direction: opDirection,
      amount_usd: cleanAmount,
      duration_seconds: opDuration,
    });
  };

  const executeConfirmedOperation = async () => {
    if (!pendingOpConfirm) return;
    setOpMsg(null);
    setOpBusy(true);
    const idempotencyKey = `op_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await apiRequest<{ operation: Operation }>('/api/operations', {
        method: 'POST',
        body: JSON.stringify({
          direction: pendingOpConfirm.direction,
          amount_usd: pendingOpConfirm.amount_usd,
          duration_seconds: pendingOpConfirm.duration_seconds,
          idempotency_key: idempotencyKey,
        }),
      });
      setPendingOpConfirm(null);
      setOpMsg({
        type: 'ok',
        text: `Operação ${res.operation.reference} (${res.operation.direction}) aberta com ${formatUSD(res.operation.amount_usd)}.`,
      });
      await onRefreshAll();
    } catch (err) {
      setPendingOpConfirm(null);
      setOpMsg({
        type: 'err',
        text: err instanceof Error ? err.message : 'Não foi possível abrir a operação.',
      });
    } finally {
      setOpBusy(false);
    }
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setSupMsg(null);
    try {
      await apiRequest('/api/support', {
        method: 'POST',
        body: JSON.stringify({
          subject: supSubject,
          category: supCategory,
          message: supMessage,
        }),
      });
      setSupSubject('');
      setSupMessage('');
      setSupMsg('Solicitação de suporte registada com sucesso.');
      await loadSupport();
    } catch (err) {
      setSupMsg(err instanceof Error ? err.message : 'Erro ao enviar pedido.');
    }
  };

  const handleReplySupportTicket = async (ticketId: string) => {
    const body = (supReplyTextById[ticketId] || '').trim();
    if (body.length < 2) return;
    setSupReplyBusyId(ticketId);
    setSupMsg(null);
    try {
      await apiRequest(`/api/support/${ticketId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setSupReplyTextById((prev) => ({ ...prev, [ticketId]: '' }));
      setSupMsg('Mensagem enviada para a equipa de atendimento.');
      await loadSupport();
    } catch (err) {
      setSupMsg(err instanceof Error ? err.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSupReplyBusyId(null);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfMsg(null);
    try {
      const res = await apiRequest<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ full_name: profName }),
      });
      onUserUpdated(res.user);
      setProfMsg('Dados do perfil atualizados.');
    } catch (err) {
      setProfMsg(err instanceof Error ? err.message : 'Erro ao atualizar perfil.');
    }
  };

  const getRemainingProgressPct = (op: Operation) => {
    const totalMs = Math.max(1000, op.duration_seconds * 1000);
    const remMs = Math.max(0, new Date(op.expires_at).getTime() - nowMs);
    return Math.min(100, Math.max(0, Number(((remMs / totalMs) * 100).toFixed(1))));
  };

  const renderSettledAnimationBanner = () => {
    if (!settledToast) return null;
    const isZeroed =
      settledToast.termination_reason === 'ZEROED_OUT' ||
      settledToast.termination_reason === 'ZEROED_AT_EXPIRY' ||
      (settledToast.payout_amount_usd ?? 0) <= 0;
    const isGain = (settledToast.result_amount_usd ?? 0) > 0;
    const reasonLabel =
      settledToast.termination_reason === 'ZEROED_OUT'
        ? 'Encerrada de imediato em $0.00'
        : isZeroed
          ? 'Encerrada em $0.00 no prazo'
          : isGain
            ? 'Operação Concluída com Lucro'
            : 'Operação Concluída';

    return (
      <div
        role="status"
        aria-live="polite"
        className={`fixed bottom-5 right-5 z-50 w-full max-w-sm rounded-2xl border p-4 shadow-2xl backdrop-blur-md transition-all duration-500 ${
          isGain
            ? 'border-emerald-400/60 bg-[#0B1F1B]/95 shadow-emerald-950/50'
            : isZeroed
              ? 'border-red-500/60 bg-[#220E14]/95 shadow-red-950/50'
              : 'border-amber-500/50 bg-[#1B160B]/95 shadow-amber-950/50'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                isGain
                  ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-300 animate-pulse'
                  : isZeroed
                    ? 'border-red-400/40 bg-red-500/20 text-red-300 animate-pulse'
                    : 'border-amber-400/40 bg-amber-500/20 text-amber-300'
              }`}
            >
              {isGain ? (
                <Sparkles className="w-5 h-5" />
              ) : isZeroed ? (
                <Zap className="w-5 h-5" />
              ) : (
                <CheckCircle2 className="w-5 h-5" />
              )}
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-300">
                {reasonLabel}
              </div>
              <div className="font-mono text-sm font-bold text-white">
                {settledToast.reference} · {settledToast.direction}
              </div>
              <div
                className={`font-mono text-lg font-bold tabular-nums ${
                  isGain ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {(settledToast.result_amount_usd ?? 0) >= 0 ? '+' : ''}
                {formatUSD(settledToast.result_amount_usd ?? 0)} ({settledToast.return_pct?.toFixed(2) ?? '0.00'}%)
              </div>
              <div className="text-[11px] font-mono text-slate-300 tabular-nums">
                Creditado: {formatUSD(settledToast.payout_amount_usd ?? 0)} · Entrada $
                {settledToast.entry_price.toFixed(2)} → Saída $
                {(settledToast.exit_price ?? settledToast.entry_price).toFixed(2)}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSettledToast(null)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
            aria-label="Fechar notificação de liquidação"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  // ==================== DASHBOARD ====================
  if (activeTab === 'dashboard') {
    return (
      <div className="space-y-6">
        {renderSettledAnimationBanner()}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="text-xs text-slate-400 mb-1">
              Painel do Utilizador · Conta Ativa
            </div>
            <h1 className="font-display text-2xl font-bold text-white">
              Olá, {user.full_name}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onTabChange('operations')}
              className="px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Nova Operação
            </button>
          </div>
        </div>

        {/* Wallet Balances Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400 mb-1">Saldo Total</div>
            <div className="font-mono text-2xl font-bold text-white tabular-nums">
              {formatUSD(wallet?.total_balance ?? 0)}
            </div>
            <div className="font-mono text-xs text-slate-400 mt-1 tabular-nums">
              {formatMT(wallet?.total_balance ?? 0, rate)}
            </div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400 mb-1">Saldo Disponível</div>
            <div className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
              {formatUSD(wallet?.available_balance ?? 0)}
            </div>
            <div className="text-xs text-slate-400 mt-1">Saldo livre para operar</div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400 mb-1">Saldo em Operação</div>
            <div className="font-mono text-2xl font-bold text-blue-400 tabular-nums">
              {formatUSD(wallet?.locked_balance ?? 0)}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {activeOperations.length} operação(ões) ativa(s)
            </div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400 mb-1">Saldo Reservado</div>
            <div className="font-mono text-2xl font-bold text-amber-400 tabular-nums">
              {formatUSD((wallet?.reserved_balance ?? 0) + (wallet?.pending_balance ?? 0))}
            </div>
            <div className="text-xs text-slate-400 mt-1">Retido em levantamentos</div>
          </div>
        </div>

        {/* Live Index & Active Operations Split */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-xs text-slate-400">
                  {hasBalance ? 'O Teu Índice Depositado' : 'Índice da Conta (Sem Saldo)'}
                </div>
                <div className="font-mono text-xl font-bold text-white tabular-nums">
                  {formatUSD(displayedOperationalPrice)}
                </div>
              </div>
              <button
                onClick={() => onTabChange(hasBalance ? 'operations' : 'transfers')}
                className="text-xs font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                {hasBalance ? 'Abrir Terminal de Operações →' : 'Efetuar Primeiro Depósito →'}
              </button>
            </div>
            <MarketChart
              ticks={displayedChartTicks}
              activeOperations={[]}
              height={240}
              chartLabel={hasBalance ? 'O Teu Índice Depositado (USD)' : 'Índice da Conta ($0.00)'}
            />
          </div>

          <div className="lg:col-span-5 p-5 rounded-xl border border-slate-800 bg-[#101724] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Operações Ativas</h2>
              <button
                onClick={() => onTabChange('history')}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Ver histórico
              </button>
            </div>
            {activeOperations.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                <p className="text-sm text-slate-400 mb-3">
                  Não tem operações abertas neste momento.
                </p>
                <button
                  onClick={() => onTabChange('operations')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
                >
                  Abrir Operação
                </button>
              </div>
            ) : (
              <div className="space-y-3 overflow-y-auto max-h-[280px]">
                {activeOperations.map((op) => {
                  const est = estimateFloatingResult(op);
                  const currentVal = Math.max(0, op.amount_usd + est.net);
                  const remPct = getRemainingProgressPct(op);
                  return (
                    <div
                      key={op.id}
                      className="p-3.5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 text-xs">
                            <span
                              className={`font-mono font-semibold ${
                                op.direction === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'
                              }`}
                            >
                              {op.direction}
                            </span>
                            <span className="text-slate-500">·</span>
                            <span className="font-mono text-slate-300">{op.reference}</span>
                          </div>
                          <div className="text-xs text-slate-400 font-mono mt-1 tabular-nums">
                            Reservado: {formatUSD(op.amount_usd)} → Atual: {formatUSD(currentVal)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`font-mono text-xs font-semibold tabular-nums ${
                              est.net >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {est.net >= 0 ? '+' : ''}
                            {formatUSD(est.net)}
                          </div>
                          <div className="font-mono text-xs text-cyan-300 mt-1 flex items-center justify-end gap-1 tabular-nums">
                            <Clock className="w-3 h-3" />
                            <span>{formatCountdown(op.expires_at, nowMs)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-700 ${
                            est.net >= 0 ? 'bg-emerald-400' : 'bg-amber-400'
                          }`}
                          style={{ width: `${remPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Recent Ledger */}
        <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Movimentações Recentes</h2>
            <button
              onClick={() => onTabChange('wallet')}
              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              Extrato completo →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Referência</th>
                  <th className="py-3 px-4 font-medium">Descrição</th>
                  <th className="py-3 px-4 font-medium text-right">Valor</th>
                  <th className="py-3 px-4 font-medium text-right">Saldo Após</th>
                  <th className="py-3 px-4 font-medium">Data</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {ledger.slice(0, 6).map((item) => (
                  <tr key={item.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono text-slate-300">{item.reference}</td>
                    <td className="py-3 px-4 text-slate-200">{item.description}</td>
                    <td
                      className={`py-3 px-4 font-mono text-right tabular-nums ${
                        item.amount >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {item.amount >= 0 ? '+' : ''}
                      {formatUSD(item.amount)}
                    </td>
                    <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                      {formatUSD(item.balance_after)}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-400">
                      {formatDateTime(item.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ==================== WALLET ====================
  if (activeTab === 'wallet') {
    return (
      <div className="space-y-6">
        {renderSettledAnimationBanner()}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="text-xs text-slate-400 mb-1">
              Carteira em USD · Taxa de Referência 1 USD = {rate} MT
            </div>
            <h1 className="font-display text-2xl font-bold text-white">Carteira Digital</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onTabChange('transfers')}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
            >
              Depósitos e Levantamentos
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400">Saldo Total</div>
            <div className="font-mono text-2xl font-bold text-white mt-1 tabular-nums">
              {formatUSD(wallet?.total_balance ?? 0)}
            </div>
            <div className="font-mono text-xs text-slate-400 mt-1 tabular-nums">
              {formatMT(wallet?.total_balance ?? 0, rate)}
            </div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400">Saldo Disponível</div>
            <div className="font-mono text-2xl font-bold text-emerald-400 mt-1 tabular-nums">
              {formatUSD(wallet?.available_balance ?? 0)}
            </div>
            <div className="text-xs text-slate-400 mt-1">Fundos livres</div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400">Saldo em Operação</div>
            <div className="font-mono text-2xl font-bold text-blue-400 mt-1 tabular-nums">
              {formatUSD(wallet?.locked_balance ?? 0)}
            </div>
            <div className="text-xs text-slate-400 mt-1">Fundos reservados</div>
          </div>
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="text-xs text-slate-400">Saldo Reservado</div>
            <div className="font-mono text-2xl font-bold text-amber-400 mt-1 tabular-nums">
              {formatUSD((wallet?.reserved_balance ?? 0) + (wallet?.pending_balance ?? 0))}
            </div>
            <div className="text-xs text-slate-400 mt-1">Levantamentos a aguardar aprovação ou desembolso</div>
          </div>
        </div>

        {/* Reference Exchange Table (Multi-Currency) */}
        <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">
              Câmbio de Referência Internacional (Base 1 USD)
            </h2>
            <span className="text-xs text-slate-400">
              Pagamentos exclusivos via M-Pesa (Vodacom 84/85) · Câmbio de referência
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 p-1 bg-[#090D16] rounded-lg border border-slate-800">
            {[
              { code: 'MZN', label: `Moçambique (${rate} MT)`, sym: 'MT', r: rate },
              { code: 'AOA', label: 'Angola (920 Kz)', sym: 'Kz', r: 920 },
              { code: 'BRL', label: 'Brasil (5.80 R$)', sym: 'R$', r: 5.8 },
              { code: 'EUR', label: 'Europa (0.92 €)', sym: '€', r: 0.92 },
              { code: 'ZAR', label: 'África do Sul (18.20 R)', sym: 'R', r: 18.2 },
            ].map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => setWalletRefCurrency(c.code)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  walletRefCurrency === c.code
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[1, 5, 10, 20, 50, 100].map((u) => {
              const curMap: Record<string, { sym: string; r: number }> = {
                MZN: { sym: 'MT', r: rate },
                AOA: { sym: 'Kz', r: 920 },
                BRL: { sym: 'R$', r: 5.8 },
                EUR: { sym: '€', r: 0.92 },
                ZAR: { sym: 'R', r: 18.2 },
              };
              const cur = curMap[walletRefCurrency] ?? curMap.MZN;
              const converted = new Intl.NumberFormat('pt-PT', {
                maximumFractionDigits: 2,
              }).format(u * cur.r);
              return (
                <div
                  key={u}
                  className="p-3 rounded-lg border border-slate-800 bg-[#090D16] flex items-center justify-between font-mono text-xs"
                >
                  <span className="text-slate-300 font-semibold">${u}</span>
                  <span className="text-slate-300">
                    {converted} {cur.sym}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Full Ledger */}
        <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800">
            <h2 className="text-sm font-semibold text-white">Extrato Completo da Carteira</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Referência</th>
                  <th className="py-3 px-4 font-medium">Tipo</th>
                  <th className="py-3 px-4 font-medium">Descrição</th>
                  <th className="py-3 px-4 font-medium text-right">Movimento</th>
                  <th className="py-3 px-4 font-medium text-right">Antes</th>
                  <th className="py-3 px-4 font-medium text-right">Depois</th>
                  <th className="py-3 px-4 font-medium">Data e Hora</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {ledger.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono text-slate-300">{l.reference}</td>
                    <td className="py-3 px-4 font-mono text-slate-400">{l.type}</td>
                    <td className="py-3 px-4 text-slate-200">{l.description}</td>
                    <td
                      className={`py-3 px-4 font-mono text-right tabular-nums ${
                        l.amount >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {l.amount >= 0 ? '+' : ''}
                      {formatUSD(l.amount)}
                    </td>
                    <td className="py-3 px-4 font-mono text-right text-slate-400 tabular-nums">
                      {formatUSD(l.balance_before)}
                    </td>
                    <td className="py-3 px-4 font-mono text-right text-slate-200 tabular-nums">
                      {formatUSD(l.balance_after)}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-400">
                      {formatDateTime(l.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ==================== DEPOSITS & WITHDRAWALS (SIMPLIFIED + REGIONAL SHOWCASE TABS) ====================
  if (activeTab === 'transfers') {
    const depRaw = Number(depAmountInput) || 0;
    const depUsd = depCurrency === 'MZN' ? Number((depRaw / rate).toFixed(2)) : Number(depRaw.toFixed(2));
    const depMt = depCurrency === 'MZN' ? Number(depRaw.toFixed(2)) : Number((depRaw * rate).toFixed(2));

    const wdrRaw = Number(wdrAmountInput) || 0;
    const wdrUsd = wdrCurrency === 'MZN' ? Number((wdrRaw / rate).toFixed(2)) : Number(wdrRaw.toFixed(2));
    const wdrMt = wdrCurrency === 'MZN' ? Number(wdrRaw.toFixed(2)) : Number((wdrRaw * rate).toFixed(2));

    const reservedTotal = Number(((wallet?.reserved_balance ?? 0) + (wallet?.pending_balance ?? 0)).toFixed(2));

    const formatTxStatus = (st: string) => {
      switch (st) {
        case 'CREDITED':
        case 'APPROVED':
          return { label: 'Creditado', cls: 'text-emerald-400' };
        case 'PAID':
          return { label: 'Pago', cls: 'text-emerald-400' };
        case 'PAYMENT_PENDING':
        case 'CREATED':
        case 'PENDING':
          return { label: 'Aguardando Pagamento', cls: 'text-amber-400' };
        case 'AWAITING_APPROVAL':
          return { label: 'Aguardando Aprovação', cls: 'text-amber-400' };
        case 'DISBURSEMENT_PENDING':
          return { label: 'Em Desembolso', cls: 'text-blue-400' };
        case 'RECONCILIATION_REQUIRED':
        case 'UNKNOWN':
          return { label: 'Em Reconciliação', cls: 'text-amber-300' };
        case 'REJECTED':
          return { label: 'Rejeitado', cls: 'text-red-400' };
        case 'FAILED':
        case 'EXPIRED':
          return { label: 'Falhado', cls: 'text-red-400' };
        case 'CANCELLED':
          return { label: 'Cancelado', cls: 'text-slate-400' };
        default:
          return { label: st, cls: 'text-slate-300' };
      }
    };

    const REGION_TABS: Array<{
      id: 'MZ' | 'AO' | 'BR' | 'EU' | 'ZA';
      country: string;
      method: string;
      currency: string;
      active: boolean;
      note: string;
    }> = [
      {
        id: 'MZ',
        country: 'Moçambique',
        method: 'M-Pesa',
        currency: 'MZN',
        active: true,
        note: 'Canal oficial ativo para depósitos e levantamentos via Vodacom M-Pesa (84 / 85).',
      },
      {
        id: 'AO',
        country: 'Angola',
        method: 'Multicaixa Express',
        currency: 'AOA (Kz)',
        active: false,
        note: 'Integração regional para Angola (Multicaixa Express / IBAN) em preparação.',
      },
      {
        id: 'BR',
        country: 'Brasil',
        method: 'PIX Instantâneo',
        currency: 'BRL (R$)',
        active: false,
        note: 'Canal PIX para liquidação em Reais em fase de ativação.',
      },
      {
        id: 'EU',
        country: 'Europa',
        method: 'SEPA Instant',
        currency: 'EUR (€)',
        active: false,
        note: 'Transferências bancárias europeias SEPA em fase de homologação.',
      },
      {
        id: 'ZA',
        country: 'África do Sul',
        method: 'Instant EFT',
        currency: 'ZAR (R)',
        active: false,
        note: 'Canal bancário África do Sul (Instant EFT) em fase de homologação.',
      },
    ];

    const selectedRegion = REGION_TABS.find((r) => r.id === paymentRegion) ?? REGION_TABS[0];

    const unifiedHistory = [
      ...deposits.map((d) => ({
        id: d.id,
        kind: 'DEPOSIT' as const,
        kindLabel: 'Depósito',
        reference: d.reference,
        account: d.msisdn_masked || 'M-Pesa',
        txId: d.mpesa_transaction_id,
        amount_usd: d.amount_usd,
        amount_mt: d.amount_mt,
        rateUsed: d.exchange_rate_used,
        status: d.status,
        created_at: d.created_at,
      })),
      ...withdrawals.map((w) => ({
        id: w.id,
        kind: 'WITHDRAWAL' as const,
        kindLabel: 'Levantamento',
        reference: w.reference,
        account: w.msisdn_masked || w.destination_account,
        txId: w.mpesa_transaction_id,
        amount_usd: w.amount_usd,
        amount_mt: w.amount_mt,
        rateUsed: w.exchange_rate_used,
        status: w.status,
        created_at: w.created_at,
      })),
    ]
      .filter((item) => historyFilter === 'ALL' || item.kind === historyFilter)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return (
      <div className="space-y-6">
        {renderSettledAnimationBanner()}
        {/* Clean Header + Compact Balance Strip */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
              <span>Carteira Digital</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">1 USD = {rate} MT</span>
            </div>
            <h1 className="font-display text-2xl font-bold text-white">
              Depósitos e Levantamentos
            </h1>
          </div>

          <div className="flex items-center gap-6 px-4 py-2.5 rounded-xl border border-slate-800 bg-[#101724] shrink-0">
            <div>
              <div className="text-[11px] text-slate-400">Disponível</div>
              <div className="font-mono text-base font-bold text-emerald-400 tabular-nums">
                {formatUSD(wallet?.available_balance ?? 0)}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-800" />
            <div>
              <div className="text-[11px] text-slate-400">Reservado</div>
              <div className="font-mono text-base font-bold text-amber-400 tabular-nums">
                {formatUSD(reservedTotal)}
              </div>
            </div>
          </div>
        </div>

        {/* Stylish Regional Payment Method Tabs */}
        <div className="flex items-center gap-1.5 p-1.5 rounded-xl bg-[#101724] border border-slate-800 overflow-x-auto">
          {REGION_TABS.map((tabItem) => {
            const isSelected = paymentRegion === tabItem.id;
            return (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => {
                  setPaymentRegion(tabItem.id);
                  setTransferMsg(null);
                }}
                className={`px-3.5 py-2 rounded-lg text-left transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-2 ${
                  isSelected
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <span className="text-xs font-semibold">{tabItem.country}</span>
                <span aria-hidden="true" className={isSelected ? 'text-blue-200' : 'text-slate-600'}>
                  ·
                </span>
                <span className={`text-xs ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                  {tabItem.method}
                </span>
              </button>
            );
          })}
        </div>

        {transferMsg && (
          <div
            className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
              transferMsg.type === 'ok'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/40 bg-red-500/10 text-red-300'
            }`}
          >
            {transferMsg.text}
          </div>
        )}

        {/* Regional Showcase Panel for Inactive Showcase Tabs */}
        {!selectedRegion.active ? (
          <div className="p-8 rounded-xl border border-slate-800 bg-[#101724] max-w-2xl space-y-4">
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div>
                <div className="text-xs text-slate-400">{selectedRegion.country} · {selectedRegion.currency}</div>
                <h2 className="text-lg font-semibold text-white mt-0.5">{selectedRegion.method}</h2>
              </div>
              <span className="text-xs font-mono text-amber-400">Em breve</span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              {selectedRegion.note}
            </p>
            <p className="text-xs text-slate-400">
              Para carregar ou levantar fundos neste momento, utilize o canal ativo de Moçambique via Vodacom M-Pesa.
            </p>
            <button
              type="button"
              onClick={() => setPaymentRegion('MZ')}
              className="px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors cursor-pointer"
            >
              Usar Moçambique · M-Pesa
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Single Clean Focused Action Card */}
            <div className="lg:col-span-5 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-5">
              {/* Segmented Deposit / Withdrawal Switch */}
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#090D16] border border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setTransferMode('DEPOSIT');
                    setTransferMsg(null);
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    transferMode === 'DEPOSIT'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Depositar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTransferMode('WITHDRAWAL');
                    setTransferMsg(null);
                  }}
                  className={`py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    transferMode === 'WITHDRAWAL'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Levantar
                </button>
              </div>

              {mpesaGatewayStatus && !mpesaGatewayStatus.configured && transferMode === 'DEPOSIT' && (
                <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-200 leading-relaxed">
                  Gateway {mpesaGatewayStatus.provider || 'M-Pesa'} não configurado no servidor: defina{' '}
                  <span className="font-mono">
                    {(mpesaGatewayStatus.missing_vars ?? ['ZAASPAY_KEY']).join(', ')}
                  </span>{' '}
                  no ambiente do servidor para enviar cobranças M-Pesa reais ao telemóvel.
                </div>
              )}

              {transferMode === 'DEPOSIT' ? (
                <form onSubmit={handleDepositSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Número M-Pesa (84 / 85)
                    </label>
                    <input
                      type="tel"
                      required
                      value={depMsisdn}
                      onChange={(e) => setDepMsisdn(e.target.value)}
                      placeholder="+258 84 123 4567"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-blue-500 min-h-[44px]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <label className="text-xs font-medium text-slate-300">Montante</label>
                      <div className="flex items-center gap-1 p-0.5 bg-[#090D16] rounded-md border border-slate-800">
                        {(['MZN', 'USD'] as const).map((cur) => (
                          <button
                            key={cur}
                            type="button"
                            onClick={() => {
                              if (cur === depCurrency) return;
                              const currVal = Number(depAmountInput) || 0;
                              const converted =
                                cur === 'MZN'
                                  ? Math.round(currVal * rate)
                                  : Number((currVal / rate).toFixed(2));
                              setDepCurrency(cur);
                              setDepAmountInput(String(converted));
                            }}
                            className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                              depCurrency === cur
                                ? 'bg-blue-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            {cur === 'MZN' ? 'MT' : 'USD'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="relative">
                      <input
                        type="number"
                        step={depCurrency === 'MZN' ? '1' : '0.01'}
                        min={depCurrency === 'MZN' ? rate : 1}
                        required
                        value={depAmountInput}
                        onChange={(e) => setDepAmountInput(e.target.value)}
                        className="w-full px-3.5 py-2.5 pr-16 text-base font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-blue-500 min-h-[44px]"
                      />
                      <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                        {depCurrency === 'MZN' ? 'MT' : 'USD'}
                      </span>
                    </div>

                    <div className="grid grid-cols-4 gap-1.5 mt-2">
                      {[5, 10, 20, 50].map((usdPreset) => {
                        const label =
                          depCurrency === 'MZN' ? `${Math.round(usdPreset * rate)} MT` : `$${usdPreset}`;
                        const valueToSet =
                          depCurrency === 'MZN' ? String(Math.round(usdPreset * rate)) : String(usdPreset);
                        return (
                          <button
                            key={usdPreset}
                            type="button"
                            onClick={() => setDepAmountInput(valueToSet)}
                            className="py-1.5 text-[11px] font-mono rounded border border-slate-700/80 bg-[#090D16] hover:bg-slate-800 text-slate-200 cursor-pointer"
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-800">
                    <span className="text-slate-400">Crédito na carteira</span>
                    <span className="font-mono font-semibold text-emerald-400 tabular-nums">
                      {formatUSD(depUsd)} · {formatMT(depUsd, rate)}
                    </span>
                  </div>
                  {depUsd >= 1 && Math.round(depUsd * rate * 100) % 100 !== 0 && (
                    <div className="text-[11px] text-amber-300 leading-relaxed">
                      A ZaasPay processa apenas valores inteiros em MT. Use múltiplos de $0.10 USD (7 MT), por exemplo $1.00 = 70 MT ou $1.50 = 105 MT.
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={transferBusy || depUsd < 1}
                    className="w-full py-3 px-4 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded-lg transition-colors cursor-pointer min-h-[44px]"
                  >
                    {transferBusy
                      ? 'A aguardar autorização PIN M-Pesa no telemóvel...'
                      : `Depositar ${depMt.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} MT`}
                  </button>
                  {transferBusy && (
                    <p className="text-[11px] text-slate-400 text-center">
                      Solicitação enviada para o seu telemóvel. Introduza o seu PIN M-Pesa oficial (até 120s); o crédito é automático após confirmação.
                    </p>
                  )}
                </form>
              ) : (
                <form onSubmit={handleWithdrawalSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Número M-Pesa de Destino (84 / 85)
                    </label>
                    <input
                      type="tel"
                      required
                      value={wdrMsisdn}
                      onChange={(e) => setWdrMsisdn(e.target.value)}
                      placeholder="+258 84 123 4567"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-blue-500 min-h-[44px]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <label className="text-xs font-medium text-slate-300">Valor a Levantar</label>
                      <div className="flex items-center gap-1 p-0.5 bg-[#090D16] rounded-md border border-slate-800">
                        {(['MZN', 'USD'] as const).map((cur) => (
                          <button
                            key={cur}
                            type="button"
                            onClick={() => {
                              if (cur === wdrCurrency) return;
                              const currVal = Number(wdrAmountInput) || 0;
                              const converted =
                                cur === 'MZN'
                                  ? Math.round(currVal * rate)
                                  : Number((currVal / rate).toFixed(2));
                              setWdrCurrency(cur);
                              setWdrAmountInput(String(converted));
                            }}
                            className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                              wdrCurrency === cur
                                ? 'bg-blue-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            {cur === 'MZN' ? 'MT' : 'USD'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="relative">
                      <input
                        type="number"
                        step={wdrCurrency === 'MZN' ? '1' : '0.01'}
                        min={wdrCurrency === 'MZN' ? rate * 2 : 2}
                        required
                        value={wdrAmountInput}
                        onChange={(e) => setWdrAmountInput(e.target.value)}
                        className="w-full px-3.5 py-2.5 pr-16 text-base font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-blue-500 min-h-[44px]"
                      />
                      <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-xs text-slate-400">
                        {wdrCurrency === 'MZN' ? 'MT' : 'USD'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2">
                      <span>Mínimo: $2.00 ({formatMT(2, rate)})</span>
                      <button
                        type="button"
                        onClick={() => {
                          const avail = wallet?.available_balance ?? 0;
                          setWdrAmountInput(
                            wdrCurrency === 'MZN'
                              ? String(Math.floor(avail * rate))
                              : String(avail.toFixed(2))
                          );
                        }}
                        className="font-mono text-blue-400 hover:text-blue-300 cursor-pointer"
                      >
                        Usar disponível
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-800">
                    <span className="text-slate-400">Recebe no M-Pesa</span>
                    <span className="font-mono font-semibold text-emerald-400 tabular-nums">
                      {formatMT(wdrUsd, rate)} ({formatUSD(wdrUsd)})
                    </span>
                  </div>

                  <button
                    type="submit"
                    disabled={transferBusy || wdrUsd < 2}
                    className="w-full py-3 px-4 text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 disabled:opacity-60 rounded-lg transition-colors cursor-pointer min-h-[44px]"
                  >
                    {transferBusy
                      ? 'A reservar saldo...'
                      : `Solicitar Levantamento · ${wdrMt.toLocaleString('pt-PT', { maximumFractionDigits: 2 })} MT`}
                  </button>
                </form>
              )}
            </div>

            {/* Right: Clean Unified History Table */}
            <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm font-semibold text-white">Movimentações M-Pesa</span>
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#090D16] border border-slate-800">
                  {(
                    [
                      { id: 'ALL', label: 'Todos' },
                      { id: 'DEPOSIT', label: 'Depósitos' },
                      { id: 'WITHDRAWAL', label: 'Levantamentos' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setHistoryFilter(f.id)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                        historyFilter === f.id
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Tipo / Ref.</th>
                      <th className="py-2.5 px-4 font-medium">M-Pesa</th>
                      <th className="py-2.5 px-4 font-medium text-right">Valor</th>
                      <th className="py-2.5 px-4 font-medium">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {unifiedHistory.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-10 text-center text-slate-400">
                          Sem movimentações M-Pesa registadas nesta conta.
                        </td>
                      </tr>
                    ) : (
                      unifiedHistory.map((item) => {
                        const st = formatTxStatus(item.status);
                        const canCheckPendingDeposit =
                          item.kind === 'DEPOSIT' &&
                          (item.status === 'PAYMENT_PENDING' ||
                            item.status === 'CREATED' ||
                            item.status === 'RECONCILIATION_REQUIRED' ||
                            item.status === 'UNKNOWN');
                        return (
                          <tr key={item.id} className="hover:bg-slate-800/30">
                            <td className="py-3 px-4">
                              <div className="font-medium text-slate-200">{item.kindLabel}</div>
                              <div className="font-mono text-[11px] text-slate-400">{item.reference}</div>
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-300">
                              <div>{item.account}</div>
                              <div className="text-[10px] text-slate-500">
                                {formatDateTime(item.created_at)}
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono text-right tabular-nums">
                              <div className="text-white">{formatUSD(item.amount_usd)}</div>
                              <div className="text-[11px] text-slate-400">
                                {formatMT(item.amount_usd, item.rateUsed)}
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono">
                              <div className={st.cls}>{st.label}</div>
                              {canCheckPendingDeposit && (
                                <button
                                  type="button"
                                  disabled={reconcilingDepositId === item.id}
                                  onClick={() => handleManualDepositCheck(item.id)}
                                  className="mt-1 text-[10px] text-blue-400 hover:text-blue-300 underline cursor-pointer disabled:opacity-50"
                                >
                                  {reconcilingDepositId === item.id
                                    ? 'A consultar...'
                                    : pollingDepositId === item.id
                                      ? 'A verificar...'
                                      : 'Verificar estado'}
                                </button>
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
          </div>
        )}
      </div>
    );
  }

  // ==================== MILION OPERATIONS ====================
  if (activeTab === 'operations') {
    return (
      <div className="space-y-6">
        {renderSettledAnimationBanner()}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
              <span>MILION OPERATIONS</span>
              <span aria-hidden="true">·</span>
              <span>ÍNDICE DEPOSITADO DA CONTA</span>
              {wsConnected && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-400">Tempo Real</span>
                </>
              )}
            </div>
            <h1 className="font-display text-2xl font-bold text-white">
              Operações de Subida e Descida
            </h1>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">Saldo Disponível</div>
            <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">
              {formatUSD(wallet?.available_balance ?? 0)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Live Chart & Active Operations */}
          <div className="lg:col-span-8 space-y-6">
            <div className="p-5 rounded-xl border border-slate-800 bg-[#101724]">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <div>
                  <div className="text-xs text-slate-400">
                    {hasBalance
                      ? 'O Teu Índice Depositado (Tempo Real)'
                      : 'Índice da Conta (Aguardando Depósito)'}
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-2xl font-bold text-white tabular-nums">
                      {formatUSD(displayedOperationalPrice)}
                    </span>
                    {hasBalance && (
                      <span
                        className={`font-mono text-xs font-semibold ${
                          snapshot?.movement === 'DESCIDA' ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      >
                        {snapshot?.movement ?? 'SUBIDA'}
                      </span>
                    )}
                  </div>
                </div>
                {!hasBalance && (
                  <button
                    type="button"
                    onClick={() => onTabChange('transfers')}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
                  >
                    Fazer Depósito
                  </button>
                )}
              </div>
              <MarketChart
                ticks={displayedChartTicks}
                activeOperations={[]}
                height={330}
                chartLabel={hasBalance ? 'O Teu Índice Depositado (USD)' : 'Índice da Conta ($0.00)'}
              />
            </div>

            {/* Active Operations Table */}
            <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  Operações Ativas ({activeOperations.length})
                </h2>
                <span className="text-xs text-slate-400">
                  Liquidação no vencimento ou imediata em $0.00
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Referência</th>
                      <th className="py-2.5 px-4 font-medium">Direção</th>
                      <th className="py-2.5 px-4 font-medium text-right">Valor Inicial</th>
                      <th className="py-2.5 px-4 font-medium text-right">Valor Atual</th>
                      <th className="py-2.5 px-4 font-medium text-right">Tempo Restante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {activeOperations.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-slate-400">
                          Nenhuma operação ativa. Utilize o painel ao lado para abrir uma operação.
                        </td>
                      </tr>
                    ) : (
                      activeOperations.map((op) => {
                        const est = estimateFloatingResult(op);
                        const currentVal = Math.max(0, op.amount_usd + est.net);
                        const remPct = getRemainingProgressPct(op);
                        return (
                          <tr key={op.id}>
                            <td className="py-3 px-4 font-mono text-slate-300">{op.reference}</td>
                            <td className="py-3 px-4 font-mono font-semibold">
                              <span
                                className={
                                  op.direction === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'
                                }
                              >
                                {op.direction}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                              {formatUSD(op.amount_usd)}
                            </td>
                            <td
                              className={`py-3 px-4 font-mono text-right tabular-nums ${
                                est.net >= 0 ? 'text-emerald-400' : 'text-red-400'
                              }`}
                            >
                              {formatUSD(currentVal)} ({est.net >= 0 ? '+' : ''}
                              {est.pct.toFixed(2)}%)
                            </td>
                            <td className="py-3 px-4 font-mono text-right text-slate-200 tabular-nums">
                              <div className="inline-flex items-center justify-end gap-1.5 text-cyan-300">
                                <Clock className="w-3 h-3" />
                                <span>{formatCountdown(op.expires_at, nowMs)}</span>
                              </div>
                              <div className="w-24 ml-auto mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-700 ${
                                    est.net >= 0 ? 'bg-emerald-400' : 'bg-amber-400'
                                  }`}
                                  style={{ width: `${remPct}%` }}
                                />
                              </div>
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

          {/* Right: Order Ticket */}
          <form
            onSubmit={handleOpenOperation}
            className="lg:col-span-4 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-5 h-fit"
          >
            <div>
              <h2 className="text-base font-semibold text-white">Configurar Operação</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Escolha a direção, o montante virtual e a duração antes de confirmar.
              </p>
            </div>

            {opMsg && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  opMsg.type === 'ok'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-red-500/40 bg-red-500/10 text-red-300'
                }`}
              >
                {opMsg.text}
              </div>
            )}

            {/* Direction Selector */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-2">Direção</label>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setOpDirection('SUBIDA')}
                  className={`py-3 px-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                    opDirection === 'SUBIDA'
                      ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                      : 'bg-[#090D16] border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <ArrowUpRight className="w-4 h-4" />
                  <span>SUBIDA (UP)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setOpDirection('DESCIDA')}
                  className={`py-3 px-3 rounded-lg border text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                    opDirection === 'DESCIDA'
                      ? 'bg-red-600/20 border-red-500 text-red-300'
                      : 'bg-[#090D16] border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <ArrowDownRight className="w-4 h-4" />
                  <span>DESCIDA (DOWN)</span>
                </button>
              </div>
            </div>

            {/* Amount USD */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <label className="font-medium text-slate-300">Valor (USD)</label>
                <span className="font-mono text-slate-400">
                  {formatMT(parsedOpAmount, rate)}
                </span>
              </div>
              <input
                type="number"
                step="0.5"
                min="0.5"
                required
                value={opAmount}
                onChange={(e) => setOpAmount(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-blue-500"
              />
              <div className="grid grid-cols-5 gap-1.5 mt-2">
                {[1, 4, 5, 10, 25].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setOpAmount(String(preset))}
                    className="py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#090D16] hover:bg-slate-800 text-slate-300 cursor-pointer"
                  >
                    ${preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Duration Selector with Rule Enforcement */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <label className="font-medium text-slate-300">Duração</label>
                <span className="text-slate-400">
                  Mínimo atual: {parsedOpAmount >= 5 ? '20 min' : '5 min'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {DURATION_OPTIONS.map((opt) => {
                  const disabled = opt.seconds < minRequiredSeconds;
                  const active = opDuration === opt.seconds;
                  return (
                    <button
                      key={opt.seconds}
                      type="button"
                      disabled={disabled}
                      onClick={() => setOpDuration(opt.seconds)}
                      className={`py-2 px-2 text-xs font-mono rounded-md border transition-colors ${
                        disabled
                          ? 'bg-[#090D16]/40 border-slate-800/60 text-slate-600 cursor-not-allowed'
                          : active
                            ? 'bg-blue-600 border-blue-500 text-white cursor-pointer'
                            : 'bg-[#090D16] border-slate-700 text-slate-300 hover:border-slate-500 cursor-pointer'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Regra: abaixo de $5 mínimo de 5 minutos; $5 ou mais mínimo de 20 minutos (até 14
                dias).
              </p>
            </div>

            {/* Pre-Confirmation Rules & Risk Disclosure */}
            <div className="p-3.5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>Condições Antes da Confirmação</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Duração selecionada</span>
                <span className="font-mono text-slate-200">{formatDurationLabel(opDuration)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Cálculo do resultado</span>
                <span className="font-mono text-slate-200">Variação% × {multiplier}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Proteção de saldo</span>
                <span className="font-mono text-slate-200">Perda máx. -100% · Sem teto de ganho</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed pt-1 border-t border-slate-800/80">
                O resultado acompanha a variação real aplicada ao montante da sua operação. Se o valor atingir $0.00 encerra de imediato; se permanecer positivo liquida no vencimento.
              </p>
            </div>

            <button
              type="submit"
              disabled={opBusy || snapshot?.market_paused}
              className={`w-full py-3 px-4 text-sm font-semibold text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                opDirection === 'SUBIDA'
                  ? 'bg-emerald-600 hover:bg-emerald-500'
                  : 'bg-red-600 hover:bg-red-500'
              }`}
            >
              {snapshot?.market_paused
                ? 'Mercado Temporariamente Pausado'
                : opBusy
                  ? 'A registar operação...'
                  : `Rever e Confirmar ${opDirection} · ${formatUSD(parsedOpAmount)}`}
            </button>
          </form>
        </div>

        {/* Mandatory Pre-Execution Confirmation Modal */}
        {pendingOpConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
            role="dialog"
            aria-modal="true"
            aria-labelledby="op-confirm-title"
          >
            <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#101724] p-6 shadow-2xl space-y-5">
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-800">
                <div>
                  <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400">
                    Confirmação Obrigatória
                  </div>
                  <h2 id="op-confirm-title" className="font-display text-lg font-bold text-white mt-0.5">
                    Confirmar Início da Operação
                  </h2>
                </div>
                <span
                  className={`px-2.5 py-1 text-xs font-mono font-semibold rounded-md border ${
                    pendingOpConfirm.direction === 'SUBIDA'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/40 bg-red-500/10 text-red-300'
                  }`}
                >
                  {pendingOpConfirm.direction}
                </span>
              </div>

              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-400">Montante a Alocar</dt>
                  <dd className="font-mono font-semibold text-white tabular-nums">
                    {formatUSD(pendingOpConfirm.amount_usd)} ({formatMT(pendingOpConfirm.amount_usd, rate)})
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Duração da Operação</dt>
                  <dd className="font-mono text-slate-200">
                    {formatDurationLabel(pendingOpConfirm.duration_seconds)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Índice de Referência (MIL-IDX)</dt>
                  <dd className="font-mono text-slate-200 tabular-nums">${currentPrice.toFixed(4)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Modelo de Resultado</dt>
                  <dd className="font-mono text-slate-200">Variação% × {multiplier}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Risco Máximo da Posição</dt>
                  <dd className="font-mono text-amber-300 tabular-nums">
                    -{formatUSD(pendingOpConfirm.amount_usd)} (-100% do valor alocado)
                  </dd>
                </div>
              </dl>

              <div className="p-3 rounded-lg bg-[#090D16] border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
                O investimento só é iniciado e o saldo bloqueado após clicar em{' '}
                <strong className="text-slate-200">Confirmar e Iniciar Operação</strong>. Ao confirmar, aceita que a posição encerra imediatamente se atingir $0.00.
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  disabled={opBusy}
                  onClick={() => setPendingOpConfirm(null)}
                  className="py-2.5 px-4 text-xs font-semibold text-slate-200 bg-[#090D16] hover:bg-slate-800 border border-slate-700 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={opBusy}
                  onClick={executeConfirmedOperation}
                  className="py-2.5 px-4 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {opBusy ? 'A iniciar...' : 'Confirmar e Iniciar Operação'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== HISTORY ====================
  if (activeTab === 'history') {
    return (
      <div className="space-y-6">
        {renderSettledAnimationBanner()}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="text-xs text-slate-400 mb-1">Registo Auditável Imutável</div>
            <h1 className="font-display text-2xl font-bold text-white">Histórico de Operações</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={histQuery}
                onChange={(e) => setHistQuery(e.target.value)}
                placeholder="Pesquisar referência..."
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg bg-[#101724] border border-slate-700 text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-1 p-1 bg-[#101724] border border-slate-800 rounded-lg">
              {['ALL', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((st) => (
                <button
                  key={st}
                  onClick={() => setHistFilter(st)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                    histFilter === st ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {st === 'ALL' ? 'Todas' : st}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#090D16] text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4 font-medium">Referência</th>
                  <th className="py-3 px-4 font-medium">Data e Hora</th>
                  <th className="py-3 px-4 font-medium">Direção</th>
                  <th className="py-3 px-4 font-medium text-right">Valor Inicial</th>
                  <th className="py-3 px-4 font-medium text-right">Valor Pago</th>
                  <th className="py-3 px-4 font-medium">Duração</th>
                  <th className="py-3 px-4 font-medium text-right">Resultado</th>
                  <th className="py-3 px-4 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredHistory.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-400">
                      Sem operações correspondentes ao filtro.
                    </td>
                  </tr>
                ) : (
                  filteredHistory.map((op) => (
                    <tr key={op.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 font-mono text-slate-300">
                        <div>{op.reference}</div>
                        <div className="text-[10px] text-slate-500">{op.id.slice(0, 12)}</div>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-400">
                        {formatDateTime(op.opened_at)}
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold">
                        <span
                          className={
                            op.direction === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'
                          }
                        >
                          {op.direction}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-right text-white tabular-nums">
                        {formatUSD(op.amount_usd)}
                      </td>
                      <td className="py-3 px-4 font-mono text-right text-slate-300 tabular-nums">
                        {op.payout_amount_usd !== null ? formatUSD(op.payout_amount_usd) : '—'}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300">
                        {formatDurationLabel(op.duration_seconds)}
                      </td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums">
                        {op.result_amount_usd !== null ? (
                          <span
                            className={
                              op.result_amount_usd > 0
                                ? 'text-emerald-400'
                                : op.result_amount_usd < 0
                                  ? 'text-red-400'
                                  : 'text-slate-300'
                            }
                          >
                            {op.result_amount_usd >= 0 ? '+' : ''}
                            {formatUSD(op.result_amount_usd)} ({op.return_pct?.toFixed(2)}%)
                          </span>
                        ) : (
                          <span className="text-slate-400">Em curso</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono">
                        <span
                          className={
                            op.status === 'COMPLETED'
                              ? 'text-emerald-400'
                              : op.status === 'ACTIVE'
                                ? 'text-blue-400'
                                : 'text-slate-400'
                          }
                        >
                          {op.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ==================== GLOBAL MARKET ====================
  if (activeTab === 'market') {
    return (
      <GlobalMarketView
        snapshot={snapshot}
        wsConnected={wsConnected}
      />
    );
  }

  // ==================== HOW IT WORKS ====================
  if (activeTab === 'how-it-works') {
    return (
      <HowItWorksView
        usdToMtRate={snapshot?.usd_to_mt_rate ?? 70}
        onGoToTransfers={() => onTabChange('transfers')}
        onGoToOperations={() => onTabChange('operations')}
        onOpenMarket={() => onTabChange('market')}
      />
    );
  }

  // ==================== NOTIFICATIONS ====================
  if (activeTab === 'notifications') {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-5 border-b border-slate-800/80">
          <div>
            <div className="text-xs text-slate-400 mb-1">Alertas e Comunicados</div>
            <h1 className="font-display text-2xl font-bold text-white">Notificações</h1>
          </div>
          <span className="text-xs text-slate-400">
            Todas as mensagens são marcadas como lidas automaticamente ao abrir esta secção.
          </span>
        </div>

        <div className="space-y-3">
          {notifications.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400 rounded-xl border border-slate-800 bg-[#101724]">
              Não tem notificações no momento.
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`p-4 rounded-xl border bg-[#101724] ${
                  n.is_read ? 'border-slate-800/80' : 'border-cyan-500/40'
                }`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                  <span className="font-mono">{n.type}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{formatDateTime(n.created_at)}</span>
                </div>
                <div className="text-sm font-semibold text-white">{n.title}</div>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">{n.message}</p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // ==================== SUPPORT ====================
  if (activeTab === 'support') {
    const statusLabel: Record<SupportTicket['status'], { text: string; cls: string }> = {
      OPEN: { text: 'Aberto', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
      IN_PROGRESS: { text: 'Em Análise', cls: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10' },
      RESOLVED: { text: 'Resolvido', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
      CLOSED: { text: 'Encerrado', cls: 'text-slate-400 border-slate-700 bg-slate-800/50' },
    };

    const visibleTickets = tickets.filter((t) =>
      supStatusFilter === 'ALL' ? true : t.status === supStatusFilter
    );

    return (
      <div className="space-y-6 max-w-6xl">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div>
            <div className="text-xs text-slate-400 mb-1">Atendimento Organizado · Acompanhamento por Pedido</div>
            <h1 className="font-display text-2xl font-bold text-white">Suporte</h1>
          </div>
          <div className="text-xs text-slate-300">
            E-mail oficial de suporte:{' '}
            <a
              href="mailto:milionspace367@gmail.com"
              className="font-mono text-cyan-400 hover:text-cyan-300"
            >
              milionspace367@gmail.com
            </a>
          </div>
        </div>

        {supMsg && (
          <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-300">
            {supMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleCreateTicket}
            className="lg:col-span-4 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4 h-fit"
          >
            <div>
              <h2 className="text-sm font-semibold text-white">Nova Solicitação</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Selecione a categoria e descreva o seu pedido para acompanhamento direto com a equipa.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Categoria</label>
              <select
                value={supCategory}
                onChange={(e) => setSupCategory(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white"
              >
                <option value="Operações">Operações</option>
                <option value="Carteira e Pedidos">Carteira e Pedidos</option>
                <option value="M-Pesa / Moçambique">M-Pesa / Moçambique</option>
                <option value="Conta e Acesso">Conta e Acesso</option>
                <option value="Geral">Geral</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Assunto</label>
              <input
                type="text"
                required
                value={supSubject}
                onChange={(e) => setSupSubject(e.target.value)}
                placeholder="Resumo da sua questão"
                className="w-full px-3 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Mensagem</label>
              <textarea
                rows={4}
                required
                value={supMessage}
                onChange={(e) => setSupMessage(e.target.value)}
                placeholder="Descreva com detalhe (ex.: referência do depósito/operação)..."
                className="w-full px-3 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 px-4 text-sm font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer transition-colors"
            >
              Enviar Solicitação
            </button>
          </form>

          <div className="lg:col-span-8 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">
                Os Meus Pedidos ({visibleTickets.length})
              </h2>
              <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#101724] border border-slate-800">
                {(
                  [
                    { id: 'ALL', label: 'Todos' },
                    { id: 'OPEN', label: 'Abertos' },
                    { id: 'IN_PROGRESS', label: 'Em Análise' },
                    { id: 'RESOLVED', label: 'Resolvidos' },
                    { id: 'CLOSED', label: 'Encerrados' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSupStatusFilter(f.id)}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                      supStatusFilter === f.id
                        ? 'bg-cyan-400 text-slate-950 font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {visibleTickets.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400 rounded-xl border border-slate-800 bg-[#101724]">
                Sem solicitações de suporte neste filtro.
              </div>
            ) : (
              visibleTickets.map((t) => {
                const st = statusLabel[t.status] ?? statusLabel.OPEN;
                const thread =
                  t.messages && t.messages.length > 0
                    ? t.messages
                    : [
                        {
                          id: `${t.id}_msg`,
                          ticket_id: t.id,
                          sender_id: t.user_id,
                          sender_role: 'USER',
                          sender_email: user.email,
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
                                sender_email: t.replied_by || 'Equipa MILION.SPACE',
                                body: t.admin_reply,
                                created_at: t.updated_at || t.created_at,
                              },
                            ]
                          : []),
                      ];
                return (
                  <div key={t.id} className="p-4 sm:p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-800/80">
                      <div className="text-xs font-mono text-slate-400">
                        {t.reference} · {t.category} · {formatDateTime(t.created_at)}
                      </div>
                      <span className={`px-2 py-0.5 text-[11px] font-mono rounded border ${st.cls}`}>
                        {st.text}
                      </span>
                    </div>

                    <div className="text-sm font-semibold text-white">{t.subject}</div>

                    {/* Conversation Thread */}
                    <div className="space-y-2 pt-1">
                      {thread.map((m) => {
                        const isStaff = m.sender_role === 'ADMIN' || m.sender_role === 'SUPER_ADMIN';
                        return (
                          <div
                            key={m.id}
                            className={`p-3 rounded-lg border text-xs ${
                              isStaff
                                ? 'bg-cyan-950/20 border-cyan-500/30'
                                : 'bg-[#090D16] border-slate-800'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className={`font-medium ${isStaff ? 'text-cyan-300' : 'text-slate-300'}`}>
                                {isStaff ? `Equipa MILION.SPACE (${m.sender_email})` : 'Você'}
                              </span>
                              <span className="font-mono text-[10px] text-slate-500">
                                {formatDateTime(m.created_at)}
                              </span>
                            </div>
                            <p className="text-slate-200 leading-relaxed whitespace-pre-wrap">{m.body}</p>
                          </div>
                        );
                      })}
                    </div>

                    {/* User Follow-up Message */}
                    <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-slate-800/70">
                      <input
                        type="text"
                        value={supReplyTextById[t.id] || ''}
                        onChange={(e) =>
                          setSupReplyTextById((prev) => ({ ...prev, [t.id]: e.target.value }))
                        }
                        placeholder="Adicionar resposta ou detalhe para a equipa..."
                        className="flex-1 px-3 py-2 text-xs rounded-lg bg-[#090D16] border border-slate-700 text-white"
                      />
                      <button
                        type="button"
                        disabled={supReplyBusyId === t.id || (supReplyTextById[t.id] || '').trim().length < 2}
                        onClick={() => handleReplySupportTicket(t.id)}
                        className="px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        {supReplyBusyId === t.id ? 'A enviar...' : 'Enviar Mensagem'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // ==================== PROFILE ====================
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="pb-5 border-b border-slate-800/80">
        <div className="text-xs text-slate-400 mb-1">Identificação da Conta</div>
        <h1 className="font-display text-2xl font-bold text-white">Perfil</h1>
      </div>

      {profMsg && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-300">
          {profMsg}
        </div>
      )}

      <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-5 border-b border-slate-800 text-xs">
          <div>
            <div className="text-slate-400 mb-1">ID Exclusivo</div>
            <div className="font-mono text-slate-200 break-all">{user.id}</div>
          </div>
          <div>
            <div className="text-slate-400 mb-1">Código Público</div>
            <div className="font-mono text-white font-semibold">{user.public_code}</div>
          </div>
          <div>
            <div className="text-slate-400 mb-1">E-mail</div>
            <div className="text-slate-200">{user.email}</div>
          </div>
          <div>
            <div className="text-slate-400 mb-1">Telefone</div>
            <div className="font-mono text-slate-200">{user.phone}</div>
          </div>
          <div>
            <div className="text-slate-400 mb-1">Estado / Papel</div>
            <div className="font-mono text-emerald-400">
              {user.status} · {user.role}
            </div>
          </div>
        </div>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Nome completo
            </label>
            <input
              type="text"
              required
              value={profName}
              onChange={(e) => setProfName(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Telefone (não editável)
            </label>
            <input
              type="tel"
              readOnly
              disabled
              value={user.phone}
              className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg bg-[#090D16]/60 border border-slate-800 text-slate-400 cursor-not-allowed"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Por segurança, o número de telefone registado não pode ser alterado no perfil.
            </p>
          </div>
          <button
            type="submit"
            className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer"
          >
            Guardar Alterações
          </button>
        </form>
      </div>
    </div>
  );
};
