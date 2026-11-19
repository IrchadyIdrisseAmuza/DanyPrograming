import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Globe,
  HelpCircle,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
  Wallet,
} from 'lucide-react';
import type { GlobalMarketSnapshot } from '../types';
import type { PublicRoute } from './PublicInfoPages';

interface PublicHomeProps {
  snapshot: GlobalMarketSnapshot | null;
  onNavigate: (view: PublicRoute) => void;
}

export const PublicHome: React.FC<PublicHomeProps> = ({ snapshot, onNavigate }) => {
  const mtRate = snapshot?.usd_to_mt_rate ?? 70;
  const isUp = (snapshot?.movement ?? 'SUBIDA') !== 'DESCIDA';
  const currentIdx = snapshot?.current_price ?? 2514.8;
  const [previewTab, setPreviewTab] = useState<'wallet' | 'market'>('wallet');

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100">
      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
          {/* Left Copy Column */}
          <div className="lg:col-span-6 space-y-6">
            <div className="inline-flex items-center gap-2 text-xs text-slate-400">
              <span className="font-mono font-semibold text-cyan-400">MILION.SPACE</span>
              <span aria-hidden="true">·</span>
              <span>Carteira USD · M-Pesa Moçambique</span>
            </div>

            <h1
              className="font-display font-bold tracking-tight text-white leading-[1.08]"
              style={{ fontSize: 'clamp(2.15rem, 3.8vw, 3.25rem)', textWrap: 'balance' }}
            >
              Uma plataforma. Mais controlo sobre as suas operações.
            </h1>

            <p className="text-base text-slate-300 leading-relaxed max-w-xl">
              Consulte a sua carteira digital em USD, acompanhe movimentações e conheça as
              condições das operações de mercado numa interface simples e organizada.
            </p>

            <div className="flex flex-wrap items-center gap-3.5 pt-1">
              <button
                type="button"
                onClick={() => onNavigate('auth-register')}
                className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Criar Conta</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('how-it-works')}
                className="inline-flex items-center gap-2 px-5 py-3 text-sm font-medium text-slate-200 border border-slate-700 hover:border-cyan-400/60 hover:text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <BookOpen className="w-4 h-4 text-cyan-400" />
                <span>Como Funciona</span>
              </button>
            </div>

            {/* Discreet 1 USD = 70 MT note + quick trust facts */}
            <div className="pt-5 border-t border-slate-800/80 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
              <span>
                Referência interna:{' '}
                <strong className="font-mono text-slate-200">1 USD = {mtRate} MT</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>Depósitos e levantamentos exclusivos via M-Pesa</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onNavigate('risks')}
                className="text-slate-300 hover:text-cyan-400 underline underline-offset-4 cursor-pointer"
              >
                Aviso de risco
              </button>
            </div>
          </div>

          {/* Right Column: Visual App Preview (Clearly marked as Demonstração ilustrativa) */}
          <div className="lg:col-span-6">
            <div className="rounded-xl border border-slate-800 bg-[#0D1422] overflow-hidden">
              {/* Preview Top Bar */}
              <div className="px-4 py-3 border-b border-slate-800 bg-[#0B101B] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-display text-xs font-bold text-white tracking-tight">
                    MILION.SPACE
                  </span>
                  <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[11px] font-mono text-amber-300">
                    Demonstração ilustrativa
                  </span>
                </div>

                <div className="flex items-center gap-1 p-0.5 rounded-md bg-[#090D16] border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setPreviewTab('wallet')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer transition-colors ${
                      previewTab === 'wallet'
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Carteira & M-Pesa
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewTab('market')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded cursor-pointer transition-colors ${
                      previewTab === 'market'
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Terminal MIL-IDX
                  </button>
                </div>
              </div>

              {previewTab === 'wallet' ? (
                <div className="p-5 space-y-4">
                  {/* Balance Trio */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3.5 rounded-lg border border-slate-800 bg-[#101724]">
                      <div className="text-[11px] text-slate-400">Saldo Disponível</div>
                      <div className="font-mono text-base sm:text-lg font-bold text-white mt-1 tabular-nums">
                        $120.00
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 mt-0.5 tabular-nums">
                        {(120 * mtRate).toLocaleString('pt-PT')} MT
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-800 bg-[#101724]">
                      <div className="text-[11px] text-slate-400">Em Operação</div>
                      <div className="font-mono text-base sm:text-lg font-bold text-cyan-300 mt-1 tabular-nums">
                        $25.00
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">1 ordem ativa</div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-800 bg-[#101724]">
                      <div className="text-[11px] text-slate-400">Reservado</div>
                      <div className="font-mono text-base sm:text-lg font-bold text-slate-200 mt-1 tabular-nums">
                        $0.00
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">Sem saques pendentes</div>
                    </div>
                  </div>

                  {/* Exclusive M-Pesa Flow Preview */}
                  <div className="p-4 rounded-lg border border-slate-800 bg-[#101724] space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-white flex items-center gap-2">
                        <Smartphone className="w-4 h-4 text-cyan-400" />
                        Canal Exclusivo M-Pesa (84 / 85)
                      </span>
                      <span className="font-mono text-[11px] text-cyan-300">
                        1 USD = {mtRate} MT
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="p-3 rounded-lg bg-[#090D16] border border-slate-800/80">
                        <div className="text-slate-400">Exemplo de Depósito</div>
                        <div className="font-mono text-white font-semibold mt-0.5">
                          $10.00 → {(10 * mtRate).toLocaleString('pt-PT')} MT
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1">
                          PIN autorizado no telemóvel
                        </div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#090D16] border border-slate-800/80">
                        <div className="text-slate-400">Registo no Ledger</div>
                        <div className="font-mono text-emerald-400 font-semibold mt-0.5">
                          + $10.00 USD
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1">
                          Após confirmação oficial
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Footer Disclaimer inside Mockup */}
                  <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                    <span>Valores exemplificativos · Não representam saldo real</span>
                    <button
                      type="button"
                      onClick={() => onNavigate('payments-policy')}
                      className="text-cyan-400 hover:text-cyan-300 cursor-pointer"
                    >
                      Regras M-Pesa
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-slate-400">Índice Interno MIL-IDX / USD</div>
                      <div className="font-mono text-2xl font-bold text-white tabular-nums mt-0.5">
                        {currentIdx.toFixed(2)}
                      </div>
                    </div>
                    <div
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#090D16] border border-slate-800 text-xs font-mono font-semibold ${
                        isUp ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {isUp ? (
                        <ArrowUpRight className="w-4 h-4" />
                      ) : (
                        <ArrowDownRight className="w-4 h-4" />
                      )}
                      <span>{isUp ? 'SUBIDA' : 'DESCIDA'}</span>
                    </div>
                  </div>

                  {/* Clean illustrative SVG chart */}
                  <div className="rounded-lg border border-slate-800 bg-[#090D16] p-3">
                    <svg
                      viewBox="0 0 360 110"
                      className="w-full h-28"
                      role="img"
                      aria-label="Ilustração do comportamento do índice MIL-IDX"
                    >
                      <defs>
                        <linearGradient id="previewArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#06B6D4" stopOpacity="0.28" />
                          <stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path
                        d="M 4 86 L 38 78 L 72 82 L 106 64 L 140 69 L 174 52 L 208 58 L 242 40 L 276 44 L 310 26 L 356 22 L 356 106 L 4 106 Z"
                        fill="url(#previewArea)"
                      />
                      <path
                        d="M 4 86 L 38 78 L 72 82 L 106 64 L 140 69 L 174 52 L 208 58 L 242 40 L 276 44 L 310 26 L 356 22"
                        fill="none"
                        stroke="#22D3EE"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-[#101724] border border-slate-800">
                      <div className="text-slate-400">Durações</div>
                      <div className="text-white font-medium mt-0.5">5 min a 14 dias</div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#101724] border border-slate-800">
                      <div className="text-slate-400">Risco da Ordem</div>
                      <div className="text-amber-300 font-medium mt-0.5">
                        Até 100% do valor alocado
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                    <span>Demonstração ilustrativa do painel de mercado</span>
                    <button
                      type="button"
                      onClick={() => onNavigate('global-market')}
                      className="text-cyan-400 hover:text-cyan-300 cursor-pointer"
                    >
                      Abrir Global Market
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Essential 4-Card Summary */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-14 border-t border-slate-800/80">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400 mb-1.5">
              Estrutura Clara
            </div>
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
              O essencial para operar com informação.
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('exchange-rates')}
            className="text-xs font-medium text-cyan-400 hover:text-cyan-300 text-left cursor-pointer whitespace-nowrap"
          >
            Consultar câmbio de referência internacional →
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
            <Wallet className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-semibold text-white">Carteira Digital em USD</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Saldos separados entre disponível, em operação e reservado, com extrato completo de
              cada movimento.
            </p>
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
            <Smartphone className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-semibold text-white">Pagamentos via M-Pesa</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Método exclusivo via Vodacom M-Pesa (84/85) à taxa interna de{' '}
              <span className="font-mono text-white">1 USD = {mtRate} MT</span>, sem armazenamento
              de PIN.
            </p>
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
            <Globe className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-semibold text-white">Índice MIL-IDX</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Operações de SUBIDA ou DESCIDA confirmadas explicitamente pelo utilizador antes da
              abertura.
            </p>
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
            <ShieldCheck className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-semibold text-white">Segurança e Risco</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Risco limitado ao montante alocado por operação, com divulgação clara de que pode haver
              perda até 100% da ordem.
            </p>
          </div>
        </div>
      </section>

      {/* Transparency & Quick Access Strip */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-14">
        <div className="p-6 rounded-xl border border-slate-800 bg-[#0D1422] flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-3.5 max-w-2xl">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-white">
                Transparência sobre operações e câmbio
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                O índice MIL-IDX é interno da plataforma e não garante rentabilidade. Consulte as
                nossas páginas de informação antes de abrir operações.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('security')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5 text-cyan-400" />
              <span>Segurança</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('faq')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
              <span>FAQ</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('auth-register')}
              className="px-4 py-2 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer"
            >
              Criar Conta
            </button>
          </div>
        </div>
      </section>

      {/* Organized Multi-Link Trust Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070B13]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 text-xs">
            <div className="space-y-2.5">
              <div className="font-display text-sm font-bold text-white">MILION.SPACE</div>
              <p className="text-slate-400 leading-relaxed">
                Carteira digital em USD com liquidação via M-Pesa (1 USD = {mtRate} MT) e operações
                sobre o índice MIL-IDX.
              </p>
              <a
                href="mailto:milionspace367@gmail.com"
                className="inline-flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>milionspace367@gmail.com</span>
              </a>
            </div>

            <div className="space-y-2">
              <div className="font-semibold text-slate-200">Plataforma</div>
              <ul className="space-y-1.5 text-slate-400">
                <li>
                  <button type="button" onClick={() => onNavigate('about')} className="hover:text-white cursor-pointer">
                    Sobre a Plataforma
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('how-it-works')} className="hover:text-white cursor-pointer">
                    Como Funciona
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('global-market')} className="hover:text-white cursor-pointer">
                    Global Market
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('exchange-rates')} className="hover:text-white cursor-pointer">
                    Câmbio Internacional
                  </button>
                </li>
              </ul>
            </div>

            <div className="space-y-2">
              <div className="font-semibold text-slate-200">Transparência & Normas</div>
              <ul className="space-y-1.5 text-slate-400">
                <li>
                  <button type="button" onClick={() => onNavigate('security')} className="hover:text-white cursor-pointer">
                    Segurança
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('payments-policy')} className="hover:text-white cursor-pointer">
                    Depósitos e Levantamentos
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('risks')} className="hover:text-white cursor-pointer">
                    Riscos das Operações
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('terms')} className="hover:text-white cursor-pointer">
                    Termos e Condições
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('privacy')} className="hover:text-white cursor-pointer">
                    Política de Privacidade
                  </button>
                </li>
              </ul>
            </div>

            <div className="space-y-2">
              <div className="font-semibold text-slate-200">Acesso & Apoio</div>
              <ul className="space-y-1.5 text-slate-400">
                <li>
                  <button type="button" onClick={() => onNavigate('faq')} className="hover:text-white cursor-pointer">
                    Perguntas Frequentes
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('support-contact')} className="hover:text-white cursor-pointer">
                    Contactos e Suporte
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('auth-login')} className="hover:text-white cursor-pointer">
                    Entrar na Conta
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => onNavigate('auth-register')} className="hover:text-cyan-300 text-cyan-400 cursor-pointer">
                    Criar Conta
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};
