import React, { useEffect, useState } from 'react';
import { apiRequest, setStoredToken } from '../lib/api';
import { formatFirebaseAuthError, signInWithGooglePopup } from '../firebase';
import type { User } from '../types';

interface AuthViewProps {
  initialMode?: 'login' | 'register';
  forcedPendingUser?: User | null;
  adminPromptNotice?: string | null;
  onSuccess: (user: User) => void;
  onCancel: () => void;
  onSignOutPending?: () => void;
}

export const AuthView: React.FC<AuthViewProps> = ({
  initialMode = 'login',
  forcedPendingUser = null,
  adminPromptNotice = null,
  onSuccess,
  onCancel,
  onSignOutPending,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'recover' | 'verify'>(
    forcedPendingUser ? 'verify' : initialMode
  );
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(forcedPendingUser?.email || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryStep, setRecoveryStep] = useState<'request' | 'reset'>('request');
  const [verificationCode, setVerificationCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pendingUser, setPendingUser] = useState<User | null>(forcedPendingUser);
  const [editingPendingEmail, setEditingPendingEmail] = useState(false);
  const [correctedEmail, setCorrectedEmail] = useState(forcedPendingUser?.email || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (forcedPendingUser) {
      setMode('verify');
      setPendingUser(forcedPendingUser);
      setEmail(forcedPendingUser.email);
      setCorrectedEmail(forcedPendingUser.email);
      setVerificationCode('');
      setNewPassword('');
    }
  }, [forcedPendingUser]);

  const clearRecoveryFields = () => {
    setVerificationCode('');
    setNewPassword('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        token: string;
        user: User;
        requires_email_verification?: boolean;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (!res?.token || !res?.user?.role) {
        throw new Error('Resposta de autenticação inválida. Tente novamente.');
      }
      setStoredToken(res.token);
      if (res.requires_email_verification || res.user.status === 'PENDING_VERIFICATION') {
        setPendingUser(res.user);
        setEmail(res.user.email);
        setCorrectedEmail(res.user.email);
        setVerificationCode('');
        setMode('verify');
        setInfoMessage('Confirme o seu endereço de e-mail para desbloquear a sua conta MILION.SPACE.');
      }
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao iniciar sessão.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    if (!emailRegex.test(cleanEmail) || cleanEmail.includes('..')) {
      setError('Indique um endereço de e-mail válido (ex.: nome@dominio.com).');
      return;
    }
    if (password !== confirmPassword) {
      setError('As palavras-passe não coincidem.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{
        token: string;
        user: User;
        requires_email_verification?: boolean;
        confirmation_email_sent?: boolean;
        confirmation_email_error?: string | null;
      }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName,
          phone,
          email: cleanEmail,
          password,
          confirm_password: confirmPassword,
        }),
      });
      if (!res?.token || !res?.user?.role) {
        throw new Error('Resposta de registo inválida. Tente novamente.');
      }
      setStoredToken(res.token);
      setPendingUser(res.user);
      setEmail(res.user.email);
      setCorrectedEmail(res.user.email);
      setVerificationCode('');
      setNewPassword('');
      setEditingPendingEmail(false);
      setMode('verify');
      if (res.confirmation_email_sent) {
        setInfoMessage(
          `Enviámos um código de confirmação de 6 dígitos para ${res.user.email}.`
        );
      } else {
        setError(
          res.confirmation_email_error ||
            'Conta registada em verificação obrigatória, mas o envio do código pelo Resend falhou. Corrija o e-mail ou clique em "Reenviar código".'
        );
      }
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar conta.');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    clearRecoveryFields();
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string; email_sent?: boolean }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      clearRecoveryFields();
      setInfoMessage(res.message || 'Código de recuperação enviado para o seu e-mail.');
      setRecoveryStep('reset');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao solicitar recuperação.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendRecovery = async () => {
    setError(null);
    setInfoMessage(null);
    clearRecoveryFields();
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      clearRecoveryFields();
      setInfoMessage(res.message || 'Novo código de recuperação enviado. Códigos anteriores invalidados.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reenviar código de recuperação.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          recovery_code: verificationCode.trim(),
          new_password: newPassword,
        }),
      });
      setPassword('');
      clearRecoveryFields();
      setRecoveryStep('request');
      setMode('login');
      setInfoMessage(res.message || 'Palavra-passe atualizada com sucesso. Já pode entrar.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao redefinir palavra-passe.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ user: User; message: string }>('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          code: verificationCode.trim(),
        }),
      });
      setVerificationCode('');
      setPendingUser(res.user);
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Código de verificação inválido.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setError(null);
    setInfoMessage(null);
    setVerificationCode('');
    setLoading(true);
    try {
      const res = await apiRequest<{ message: string; already_verified?: boolean }>(
        '/api/auth/send-verification-code',
        {
          method: 'POST',
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        }
      );
      setInfoMessage(res.message || 'Novo código enviado para o seu e-mail.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reenviar código.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePendingEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    const nextEmail = correctedEmail.trim().toLowerCase();
    const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
    if (!emailRegex.test(nextEmail) || nextEmail.includes('..')) {
      setError('Indique um endereço de e-mail válido.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest<{
        ok?: boolean;
        email_updated?: boolean;
        message?: string;
        user: User;
      }>('/api/auth/update-pending-email', {
        method: 'POST',
        body: JSON.stringify({
          new_email: nextEmail,
          current_email: email.trim().toLowerCase(),
          password: password || undefined,
        }),
      });
      if (res.user) {
        setPendingUser(res.user);
        setEmail(res.user.email);
        setCorrectedEmail(res.user.email);
      }
      setVerificationCode('');
      setEditingPendingEmail(false);
      setInfoMessage(res.message || `E-mail atualizado para ${nextEmail} e novo código enviado.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao corrigir o endereço de e-mail.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError(null);
    setLoading(true);
    try {
      const { idToken } = await signInWithGooglePopup();
      const res = await apiRequest<{ token: string; user: User }>('/api/auth/firebase-google', {
        method: 'POST',
        body: JSON.stringify({
          id_token: idToken,
          phone: phone.trim() || undefined,
        }),
      });
      if (!res?.token || !res?.user?.role) {
        throw new Error('Não foi possível validar os dados da conta Google no servidor.');
      }
      setStoredToken(res.token);
      onSuccess(res.user);
    } catch (err) {
      setError(formatFirebaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const isForcedPending = Boolean(forcedPendingUser && forcedPendingUser.status === 'PENDING_VERIFICATION');

  return (
    <div className="min-h-[calc(100vh-72px)] flex items-center justify-center px-4 sm:px-6 py-10">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#101724] p-6 sm:p-7">
        <div className="mb-6">
          <div className="text-xs font-mono text-cyan-400 mb-1">MILION.SPACE</div>
          <h1 className="font-display text-2xl font-bold text-white">
            {mode === 'login'
              ? 'Iniciar Sessão'
              : mode === 'register'
                ? 'Criar Conta'
                : mode === 'recover'
                  ? 'Recuperar Palavra-Passe'
                  : 'Confirmar E-mail (Obrigatório)'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {mode === 'login'
              ? 'Aceda à sua carteira digital em USD e às operações de mercado.'
              : mode === 'register'
                ? 'Preencha os seus dados essenciais para criar uma conta pessoal.'
                : mode === 'recover'
                  ? 'Receba um código único no seu e-mail para redefinir a sua palavra-passe.'
                  : 'A confirmação do endereço de e-mail é obrigatória antes de aceder à plataforma.'}
          </p>
        </div>

        {adminPromptNotice && mode === 'login' && (
          <div className="mb-4 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-200">
            {adminPromptNotice}
          </div>
        )}

        {/* Mode Switcher (hidden during mandatory pending verification) */}
        {!isForcedPending && (
          <div className="grid grid-cols-2 gap-1 p-1 bg-[#090D16] rounded-lg border border-slate-800 mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setRecoveryStep('request');
                clearRecoveryFields();
                setError(null);
                setInfoMessage(null);
              }}
              className={`py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'login' || mode === 'recover'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setRecoveryStep('request');
                clearRecoveryFields();
                setError(null);
                setInfoMessage(null);
              }}
              className={`py-2 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'register' || mode === 'verify'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Criar Conta
            </button>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {infoMessage && (
          <div
            role="status"
            className="mb-4 p-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-xs text-cyan-200"
          >
            {infoMessage}
          </div>
        )}

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                E-mail
              </label>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@exemplo.com"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="login-password" className="block text-xs font-medium text-slate-300">
                  Palavra-passe
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMode('recover');
                    setRecoveryStep('request');
                    clearRecoveryFields();
                    setError(null);
                    setInfoMessage(null);
                  }}
                  className="text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
                >
                  Esqueci a palavra-passe
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              {loading ? 'A validar...' : 'Entrar'}
            </button>
          </form>
        ) : mode === 'recover' ? (
          recoveryStep === 'request' ? (
            <form onSubmit={handleRequestRecovery} className="space-y-4">
              <div>
                <label htmlFor="rec-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                  E-mail da conta
                </label>
                <input
                  id="rec-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nome@exemplo.com"
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'A enviar...' : 'Enviar código de recuperação'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setRecoveryStep('request');
                  clearRecoveryFields();
                  setError(null);
                  setInfoMessage(null);
                }}
                className="w-full text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                Voltar ao login
              </button>
            </form>
          ) : (
            <form onSubmit={handleResetPassword} className="space-y-3.5">
              <div className="p-3 rounded-lg border border-slate-800 bg-[#090D16] text-xs text-slate-300">
                Código enviado para <strong className="text-white">{email}</strong>.
              </div>
              <div>
                <label htmlFor="rec-code" className="block text-xs font-medium text-slate-300 mb-1">
                  Código recebido por e-mail
                </label>
                <input
                  id="rec-code"
                  type="text"
                  required
                  autoComplete="off"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  placeholder="REC-000000"
                  className="w-full px-3.5 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="rec-new-pass" className="block text-xs font-medium text-slate-300 mb-1">
                  Nova palavra-passe
                </label>
                <input
                  id="rec-new-pass"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Mín. 6 caracteres"
                  className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
              >
                {loading ? 'A atualizar...' : 'Redefinir palavra-passe'}
              </button>
              <div className="flex items-center justify-between pt-1 text-xs">
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleResendRecovery}
                  className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer disabled:opacity-50"
                >
                  Reenviar código
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setRecoveryStep('request');
                    clearRecoveryFields();
                    setError(null);
                    setInfoMessage(null);
                  }}
                  className="text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Nova recuperação
                </button>
              </div>
            </form>
          )
        ) : mode === 'verify' ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded-lg border border-slate-800 bg-[#090D16] text-xs text-slate-300 leading-relaxed space-y-1">
              <div>
                Introduza o código de 6 dígitos enviado para{' '}
                <strong className="text-white">{email}</strong>.
              </div>
              <div className="text-[11px] text-amber-300">
                A carteira, depósitos, levantamentos e operações ficam bloqueados até confirmar o seu e-mail.
              </div>
            </div>

            {editingPendingEmail ? (
              <form onSubmit={handleUpdatePendingEmail} className="space-y-3 p-3.5 rounded-lg border border-slate-700 bg-[#090D16]">
                <label htmlFor="fix-pending-email" className="block text-xs font-medium text-slate-300">
                  Novo endereço de e-mail
                </label>
                <input
                  id="fix-pending-email"
                  type="email"
                  required
                  value={correctedEmail}
                  onChange={(e) => setCorrectedEmail(e.target.value)}
                  placeholder="corrigido@exemplo.com"
                  className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#101724] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-2 px-3 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg cursor-pointer"
                  >
                    {loading ? 'A guardar...' : 'Atualizar e-mail e enviar código'}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setEditingPendingEmail(false);
                      setCorrectedEmail(email);
                    }}
                    className="py-2 px-3 text-xs text-slate-400 hover:text-white border border-slate-700 rounded-lg cursor-pointer"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleVerifyEmail} className="space-y-4">
                <div>
                  <label htmlFor="verify-code" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Código de verificação
                  </label>
                  <input
                    id="verify-code"
                    type="text"
                    required
                    autoComplete="off"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    placeholder="000000"
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
                >
                  {loading ? 'A confirmar...' : 'Confirmar e-mail'}
                </button>
                <div className="flex items-center justify-between text-xs pt-1">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleResendVerification}
                    className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer disabled:opacity-50"
                  >
                    Reenviar código
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setCorrectedEmail(email);
                      setEditingPendingEmail(true);
                      setError(null);
                      setInfoMessage(null);
                    }}
                    className="text-slate-300 hover:text-white cursor-pointer"
                  >
                    Corrigir e-mail
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <form onSubmit={handleRegister} className="space-y-3.5">
            <div className="p-3 rounded-lg border border-slate-800 bg-[#090D16] text-xs text-slate-300 leading-relaxed">
              Depósitos e levantamentos processados exclusivamente via M-Pesa (Vodacom Moçambique · 84/85).
            </div>
            <div>
              <label htmlFor="reg-fullname" className="block text-xs font-medium text-slate-300 mb-1">
                Nome completo
              </label>
              <input
                id="reg-fullname"
                type="text"
                required
                minLength={3}
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Seu nome completo"
                className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label htmlFor="reg-phone" className="block text-xs font-medium text-slate-300 mb-1">
                Número M-Pesa (Vodacom 84 / 85)
              </label>
              <input
                id="reg-phone"
                type="tel"
                required
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+258 84 000 0000"
                className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label htmlFor="reg-email" className="block text-xs font-medium text-slate-300 mb-1">
                E-mail válido
              </label>
              <input
                id="reg-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@exemplo.com"
                className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Enviaremos um código obrigatório para confirmar este endereço antes de aceder à conta.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="reg-pass" className="block text-xs font-medium text-slate-300 mb-1">
                  Palavra-passe
                </label>
                <input
                  id="reg-pass"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mín. 6 caracteres"
                  className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="reg-confirm" className="block text-xs font-medium text-slate-300 mb-1">
                  Confirmação da palavra-passe
                </label>
                <input
                  id="reg-confirm"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repetir palavra-passe"
                  className="w-full px-3.5 py-2 text-sm rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              {loading ? 'A criar conta...' : 'Criar Conta'}
            </button>
          </form>
        )}

        {!isForcedPending && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-slate-500">
              <div className="h-px flex-1 bg-slate-800" />
              <span>ou</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            <button
              type="button"
              onClick={handleGoogleAuth}
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-medium text-slate-100 bg-[#090D16] hover:bg-slate-800/80 border border-slate-700 disabled:opacity-60 rounded-lg transition-colors flex items-center justify-center gap-2.5 cursor-pointer"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.37 24 12 24Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.37 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                />
              </svg>
              <span>Continuar com Google</span>
            </button>
          </>
        )}

        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          {isForcedPending ? (
            <button
              type="button"
              onClick={onSignOutPending || onCancel}
              className="hover:text-slate-200 cursor-pointer"
            >
              Terminar sessão / Sair
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              className="hover:text-slate-200 cursor-pointer"
            >
              Voltar à página inicial
            </button>
          )}
          <a href="mailto:milionspace367@gmail.com" className="hover:text-slate-200">
            Suporte
          </a>
        </div>
      </div>
    </div>
  );
};
