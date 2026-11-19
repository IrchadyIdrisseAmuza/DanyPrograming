import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import {
  Activity,
  ArrowLeftRight,
  Bell,
  BookOpen,
  Globe,
  HelpCircle,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Shield,
  User as UserIcon,
  Wallet as WalletIcon,
  X,
} from 'lucide-react';
import type {
  GlobalMarketSnapshot,
  LedgerEntry,
  MarketTick,
  NotificationItem,
  Operation,
  User,
  Wallet,
} from './types';
import { apiRequest, formatUSD, getStoredToken, setStoredToken } from './lib/api';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  signOutFirebase,
  syncUserAccountToFirestore,
} from './firebase';
import { PublicHome } from './components/PublicHome';
import {
  PublicInfoPages,
  type PublicInfoPageId,
  type PublicRoute,
} from './components/PublicInfoPages';
import { GlobalMarketView } from './components/GlobalMarketView';
import { AuthView } from './components/AuthView';
import { UserWorkspace, type UserTab } from './components/UserWorkspace';
import {
  AdminPanel,
  ADMIN_SUB_TABS,
  type AdminSubTab,
  type PendingAdminReviewAction,
} from './components/AdminPanel';

const GM_PREVIEW_KEY = 'milion_gm_preview_expired';
const PENDING_ADMIN_REVIEW_KEY = 'milion_pending_admin_review';

function readPendingAdminReviewFromUrlOrStorage(): PendingAdminReviewAction | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('admin_action');
    const kind = params.get('kind');
    const id = params.get('id');
    const decision = params.get('decision');
    if (
      action === 'review' &&
      (kind === 'deposit' || kind === 'withdrawal') &&
      id &&
      (decision === 'APPROVED' || decision === 'REJECTED')
    ) {
      const parsed: PendingAdminReviewAction = { kind, id, decision };
      sessionStorage.setItem(PENDING_ADMIN_REVIEW_KEY, JSON.stringify(parsed));
      window.history.replaceState({}, '', window.location.pathname || '/');
      return parsed;
    }
    const stored = sessionStorage.getItem(PENDING_ADMIN_REVIEW_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as PendingAdminReviewAction;
      if (
        (parsed.kind === 'deposit' || parsed.kind === 'withdrawal') &&
        parsed.id &&
        (parsed.decision === 'APPROVED' || parsed.decision === 'REJECTED')
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore storage/url errors
  }
  return null;
}

export default function App() {
  const [pendingAdminReview, setPendingAdminReview] = useState<PendingAdminReviewAction | null>(
    () => readPendingAdminReviewFromUrlOrStorage()
  );
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [publicPage, setPublicPage] = useState<PublicRoute>(
    pendingAdminReview ? 'auth-login' : 'home'
  );
  const [publicMobileOpen, setPublicMobileOpen] = useState(false);
  const [marketPreviewExpired, setMarketPreviewExpired] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(GM_PREVIEW_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [userTab, setUserTab] = useState<UserTab>('dashboard');
  const [adminTab, setAdminTab] = useState<AdminSubTab>('overview');
  const [inAdminPanel, setInAdminPanel] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [snapshot, setSnapshot] = useState<GlobalMarketSnapshot | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [firebaseAuthReady, setFirebaseAuthReady] = useState(false);

  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const refreshUserData = useCallback(async () => {
    if (!getStoredToken()) return;
    try {
      const [wRes, oRes, nRes] = await Promise.all([
        apiRequest<{ wallet: Wallet; ledger: LedgerEntry[] }>('/api/wallet'),
        apiRequest<{ operations: Operation[] }>('/api/operations'),
        apiRequest<{ notifications: NotificationItem[] }>('/api/notifications'),
      ]);
      setWallet(wRes.wallet);
      setLedger(wRes.ledger);
      setOperations(oRes.operations);
      setNotifications(nRes.notifications);
    } catch {
      // Ignore transient errors
    }
  }, []);

  const refreshMarketState = useCallback(async () => {
    try {
      const data = await apiRequest<GlobalMarketSnapshot>('/api/market/state');
      setSnapshot(data);
    } catch {
      // ignore
    }
  }, []);

  // Restore session on boot
  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthChecked(true);
      return;
    }
    apiRequest<{ user: User }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        if (res.user.status === 'PENDING_VERIFICATION') {
          return;
        }
        if (
          pendingAdminReview &&
          (res.user.role === 'ADMIN' || res.user.role === 'SUPER_ADMIN')
        ) {
          setInAdminPanel(true);
          setAdminTab('transfers');
        }
        return refreshUserData();
      })
      .catch(() => {
        setStoredToken(null);
        setUser(null);
      })
      .finally(() => setAuthChecked(true));
  }, [refreshUserData, pendingAdminReview]);

  // Track Firebase Auth readiness state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      setFirebaseUser(fbUser);
      setFirebaseAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Sync & observe authenticated Firebase user document in Firestore
  useEffect(() => {
    if (!firebaseAuthReady || !firebaseUser || !user) return;
    let active = true;
    const path = `users/${firebaseUser.uid}`;

    syncUserAccountToFirestore(firebaseUser, user, wallet).catch(() => {
      // Handled inside syncUserAccountToFirestore via handleFirestoreError
    });

    const unsub = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      () => {
        // Real-time document sync verified
      },
      (error) => {
        if (active) {
          handleFirestoreError(error, OperationType.GET, path);
        }
      }
    );

    return () => {
      active = false;
      unsub();
    };
  }, [firebaseAuthReady, firebaseUser, user, wallet]);

  // Initial market fetch + WebSocket real-time streaming
  useEffect(() => {
    refreshMarketState();

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByEffect = false;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as {
            event: string;
            payload: unknown;
          };
          if (msg.event === 'market:init' || msg.event === 'market:update') {
            setSnapshot(msg.payload as GlobalMarketSnapshot);
          } else if (msg.event === 'market:tick') {
            const data = msg.payload as { tick: MarketTick; snapshot: GlobalMarketSnapshot };
            setSnapshot((prev) => {
              if (!prev) return data.snapshot;
              const nextTicks = [...prev.recent_ticks.slice(-159), data.tick];
              return {
                ...data.snapshot,
                recent_ticks: nextTicks,
              };
            });
          } else if (msg.event === 'operation:settled' || msg.event === 'wallet:update') {
            const payload = msg.payload as { userId: string };
            if (userRef.current && payload.userId === userRef.current.id) {
              refreshUserData();
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!closedByEffect) {
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [refreshMarketState, refreshUserData]);

  // 2-second real-time sync for user wallet, active operations & notifications
  useEffect(() => {
    if (!user || user.status === 'PENDING_VERIFICATION') return;
    const interval = setInterval(() => {
      void refreshUserData();
    }, 2000);
    return () => clearInterval(interval);
  }, [user?.id, user?.status, refreshUserData]);

  const handleAuthSuccess = async (loggedUser: User) => {
    if (!loggedUser || !loggedUser.role) {
      return;
    }
    try {
      sessionStorage.removeItem(GM_PREVIEW_KEY);
    } catch {
      // ignore storage failure
    }
    setMarketPreviewExpired(false);
    setUser(loggedUser);
    if (loggedUser.status === 'PENDING_VERIFICATION') {
      return;
    }
    const adminUser = loggedUser.role === 'ADMIN' || loggedUser.role === 'SUPER_ADMIN';
    setInAdminPanel(adminUser);
    if (adminUser && pendingAdminReview) {
      setAdminTab('transfers');
    }
    setUserTab('dashboard');
    await refreshUserData();
  };

  const handleLogout = async () => {
    try {
      if (getStoredToken()) {
        await apiRequest('/api/auth/logout', { method: 'POST' });
      }
    } catch {
      // Proceed cleanly even if token already expired
    }
    setStoredToken(null);
    void signOutFirebase();
    setUser(null);
    setWallet(null);
    setLedger([]);
    setOperations([]);
    setNotifications([]);
    setInAdminPanel(false);
    setPublicPage('home');
  };

  const navigatePublic = (route: PublicRoute) => {
    setPublicPage(route);
    setPublicMobileOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#090D16] flex items-center justify-center text-sm text-slate-400">
        A inicializar MILION.SPACE...
      </div>
    );
  }

  // ==================== PUBLIC AREA (UNAUTHENTICATED) ====================
  if (!user) {
    const isInfoPage =
      publicPage !== 'home' &&
      publicPage !== 'global-market' &&
      publicPage !== 'auth-login' &&
      publicPage !== 'auth-register';

    return (
      <div className="min-h-screen bg-[#090D16] text-slate-100">
        {/* Public Header */}
        <header className="sticky top-0 z-30 bg-[#090D16]/95 backdrop-blur border-b border-slate-800/80">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => navigatePublic('home')}
              className="font-display text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-2"
            >
              <span>MILION.SPACE</span>
            </button>

            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
              <button
                type="button"
                onClick={() => navigatePublic('home')}
                className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  publicPage === 'home' ? 'text-cyan-400 font-semibold' : ''
                }`}
              >
                Início
              </button>
              <button
                type="button"
                onClick={() => navigatePublic('how-it-works')}
                className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  publicPage === 'how-it-works' ? 'text-cyan-400 font-semibold' : ''
                }`}
              >
                Como Funciona
              </button>
              <button
                type="button"
                onClick={() => navigatePublic('global-market')}
                className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  publicPage === 'global-market' ? 'text-cyan-400 font-semibold' : ''
                }`}
              >
                Global Market
              </button>
              <button
                type="button"
                onClick={() => navigatePublic('security')}
                className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  publicPage === 'security' ? 'text-cyan-400 font-semibold' : ''
                }`}
              >
                Segurança
              </button>
            </nav>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => navigatePublic('auth-login')}
                className={`hidden sm:inline-flex px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  publicPage === 'auth-login'
                    ? 'border-cyan-400/60 text-cyan-300 bg-cyan-500/10'
                    : 'border-slate-700 text-slate-200 hover:border-slate-500 hover:text-white'
                }`}
              >
                Entrar
              </button>
              <button
                type="button"
                onClick={() => navigatePublic('auth-register')}
                className="px-4 py-2 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Criar Conta
              </button>
              <button
                type="button"
                onClick={() => setPublicMobileOpen(!publicMobileOpen)}
                className="md:hidden p-2 rounded-lg border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
                aria-label="Abrir navegação"
              >
                {publicMobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {publicMobileOpen && (
            <div className="md:hidden border-t border-slate-800 bg-[#0B101B] px-4 py-3 space-y-1 text-xs">
              {[
                { id: 'home' as const, label: 'Início' },
                { id: 'how-it-works' as const, label: 'Como Funciona' },
                { id: 'global-market' as const, label: 'Global Market' },
                { id: 'security' as const, label: 'Segurança' },
                { id: 'faq' as const, label: 'Perguntas Frequentes' },
                { id: 'auth-login' as const, label: 'Entrar' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigatePublic(item.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg cursor-pointer ${
                    publicPage === item.id
                      ? 'bg-cyan-500/10 text-cyan-300 font-semibold'
                      : 'text-slate-200 hover:bg-slate-800/70'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {publicPage === 'home' && (
          <PublicHome snapshot={snapshot} onNavigate={navigatePublic} />
        )}

        {isInfoPage && (
          <PublicInfoPages
            page={publicPage as PublicInfoPageId}
            snapshot={snapshot}
            onNavigate={navigatePublic}
          />
        )}

        {publicPage === 'global-market' && (
          <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
            <GlobalMarketView
              snapshot={snapshot}
              wsConnected={wsConnected}
              previewSecondsLimit={6}
              previewExpired={marketPreviewExpired}
              onPreviewExpired={() => {
                try {
                  sessionStorage.setItem(GM_PREVIEW_KEY, '1');
                } catch {
                  // ignore
                }
                setMarketPreviewExpired(true);
              }}
              onStartOperation={() => navigatePublic('auth-register')}
              onLogin={() => navigatePublic('auth-login')}
            />
          </main>
        )}

        {(publicPage === 'auth-login' || publicPage === 'auth-register') && (
          <AuthView
            key={publicPage}
            initialMode={publicPage === 'auth-register' ? 'register' : 'login'}
            adminPromptNotice={
              pendingAdminReview
                ? 'Autenticação administrativa necessária para rever e confirmar a transferência.'
                : null
            }
            onSuccess={handleAuthSuccess}
            onCancel={() => navigatePublic('home')}
          />
        )}
      </div>
    );
  }

  // ==================== MANDATORY EMAIL VERIFICATION GATE ====================
  if (user.status === 'PENDING_VERIFICATION') {
    return (
      <div className="min-h-screen bg-[#090D16] text-slate-100">
        <header className="sticky top-0 z-30 bg-[#090D16]/95 backdrop-blur border-b border-slate-800/80">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
            <div className="font-display text-base sm:text-lg font-bold tracking-tight text-white">
              MILION.SPACE
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:text-white cursor-pointer"
            >
              Terminar Sessão
            </button>
          </div>
        </header>
        <AuthView
          forcedPendingUser={user}
          onSuccess={handleAuthSuccess}
          onCancel={handleLogout}
          onSignOutPending={handleLogout}
        />
      </div>
    );
  }

  // ==================== AUTHENTICATED WORKSPACE (USER OR ADMIN-ONLY) ====================
  const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';

  const currentMarketPrice = snapshot?.current_price ?? 2500;
  const multiplier = snapshot?.proportional_multiplier ?? 25;
  const activeOpsFloatingNet = operations
    .filter((o) => o.status === 'ACTIVE')
    .reduce((acc, op) => {
      const pct = op.entry_price > 0 ? (currentMarketPrice - op.entry_price) / op.entry_price : 0;
      const signed = op.direction === 'SUBIDA' ? pct : -pct;
      const bounded = Math.max(-1.0, signed * multiplier);
      return acc + op.amount_usd * bounded;
    }, 0);
  const userDepositedIndex =
    (wallet?.total_balance ?? 0) > 0
      ? Math.max(0, Number(((wallet?.total_balance ?? 0) + activeOpsFloatingNet).toFixed(2)))
      : 0;

  const navItems: Array<{ id: UserTab; label: string; icon: typeof LayoutDashboard; badge?: number }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'wallet', label: 'Carteira Digital', icon: WalletIcon },
    { id: 'transfers', label: 'Depósitos e Levantamentos', icon: ArrowLeftRight },
    { id: 'operations', label: 'MILION Operations', icon: Activity },
    { id: 'market', label: 'Global Market', icon: Globe },
    { id: 'how-it-works', label: 'Como Funciona', icon: BookOpen },
    { id: 'history', label: 'Histórico', icon: History },
    { id: 'notifications', label: 'Notificações', icon: Bell, badge: unreadCount },
    { id: 'support', label: 'Suporte', icon: HelpCircle },
    { id: 'profile', label: 'Perfil', icon: UserIcon },
  ];

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-slate-800/80 bg-[#0B101B]">
        <div className="px-5 py-5 border-b border-slate-800/80 flex items-center justify-between">
          <button
            onClick={() => {
              setInAdminPanel(false);
              setUserTab('dashboard');
            }}
            className="font-display text-lg font-bold tracking-tight text-white cursor-pointer"
          >
            MILION
          </button>
          <span className="font-mono text-[11px] text-slate-400">{user.public_code}</span>
        </div>

        <div className="p-3 flex-1 overflow-y-auto space-y-1">
            {isAdmin ? (
            <>
              <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-amber-300/80">
                Administração
              </div>
              {ADMIN_SUB_TABS.map((item) => {
                const active = adminTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setInAdminPanel(true);
                      setAdminTab(item.id);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                      active
                        ? 'bg-cyan-500/12 text-cyan-300 border border-cyan-500/30'
                        : 'text-slate-300 hover:bg-slate-800/50 hover:text-white border border-transparent'
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5 shrink-0 opacity-75" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </>
          ) : (
            navItems.map((item) => {
              const Icon = item.icon;
              const active = userTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setUserTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                    active
                      ? 'bg-cyan-500/12 text-cyan-300 border border-cyan-500/30'
                      : 'text-slate-300 hover:bg-slate-800/50 hover:text-white border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2.5 truncate">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="font-mono text-[11px] text-cyan-300">{item.badge}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="p-4 border-t border-slate-800/80 space-y-3">
          {isAdmin ? (
            <div className="text-xs">
              <div className="text-slate-400">Conta Administrativa</div>
              <div className="font-mono text-xs font-semibold text-amber-300 truncate">
                {user.email}
              </div>
            </div>
          ) : (
            <div className="text-xs">
              <div className="text-slate-400">Saldo Disponível</div>
              <div className="font-mono text-sm font-semibold text-emerald-400 tabular-nums">
                {formatUSD(wallet?.available_balance ?? 0)}
              </div>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Terminar Sessão</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Contextual Header */}
        <header className="sticky top-0 z-20 bg-[#090D16]/95 backdrop-blur border-b border-slate-800/80 px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
              aria-label="Abrir menu"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <div className="text-xs text-slate-400 truncate">
              <span>MILION.SPACE</span>
              <span className="mx-2">/</span>
              <span className="text-slate-200 font-medium">
                {isAdmin
                  ? `Administração · ${ADMIN_SUB_TABS.find((t) => t.id === adminTab)?.label ?? 'Resumo'}`
                  : navItems.find((n) => n.id === userTab)?.label ?? 'Dashboard'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {isAdmin ? (
              <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-amber-300">
                <Shield className="w-3.5 h-3.5" />
                <span>{user.role}</span>
              </div>
            ) : (
              <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-slate-300">
                <span className="text-slate-400">Índice Depositado</span>
                <span className="text-white font-semibold tabular-nums">
                  {formatUSD(userDepositedIndex)}
                </span>
              </div>
            )}
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-b border-slate-800 bg-[#0B101B] p-3 space-y-1">
            {isAdmin
              ? ADMIN_SUB_TABS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setInAdminPanel(true);
                      setAdminTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium rounded-lg cursor-pointer ${
                      adminTab === item.id
                        ? 'bg-blue-600/15 text-blue-300'
                        : 'text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <Shield className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                ))
              : navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setInAdminPanel(false);
                        setUserTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-lg text-slate-200 hover:bg-slate-800 cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon className="w-4 h-4" />
                        <span>{item.label}</span>
                      </span>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="font-mono text-blue-400">{item.badge}</span>
                      )}
                    </button>
                  );
                })}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium rounded-lg text-red-300 hover:bg-slate-800 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Terminar Sessão</span>
            </button>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          {isAdmin ? (
            <AdminPanel
              currentUser={user}
              snapshot={snapshot}
              activeTab={adminTab}
              onTabChange={setAdminTab}
              pendingReviewAction={pendingAdminReview}
              onClearPendingReview={() => {
                setPendingAdminReview(null);
                try {
                  sessionStorage.removeItem(PENDING_ADMIN_REVIEW_KEY);
                } catch {
                  // ignore
                }
              }}
              onRefreshGlobal={async () => {
                await Promise.all([refreshMarketState(), refreshUserData()]);
              }}
            />
          ) : (
            <UserWorkspace
              activeTab={userTab}
              onTabChange={setUserTab}
              user={user}
              onUserUpdated={setUser}
              snapshot={snapshot}
              wsConnected={wsConnected}
              wallet={wallet}
              ledger={ledger}
              operations={operations}
              notifications={notifications}
              onRefreshAll={refreshUserData}
            />
          )}
        </main>
      </div>
    </div>
  );
}
