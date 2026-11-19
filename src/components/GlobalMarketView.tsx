import React, { useEffect, useState } from 'react';
import { ArrowUpRight, ArrowDownRight, Clock, Lock, UserPlus } from 'lucide-react';
import type { GlobalMarketSnapshot } from '../types';
import { MarketChart } from './MarketChart';
import { formatMT, formatShortTime, formatUSD } from '../lib/api';

interface GlobalMarketViewProps {
  snapshot: GlobalMarketSnapshot | null;
  wsConnected: boolean;
  onStartOperation?: () => void;
  onLogin?: () => void;
  previewSecondsLimit?: number;
  previewExpired?: boolean;
  onPreviewExpired?: () => void;
}

export const GlobalMarketView: React.FC<GlobalMarketViewProps> = ({
  snapshot,
  wsConnected,
  onStartOperation,
  onLogin,
  previewSecondsLimit,
  previewExpired = false,
  onPreviewExpired,
}) => {
  const [tickWindow, setTickWindow] = useState<40 | 90 | 160>(160);
  const [timeZone, setTimeZone] = useState<string>('Africa/Maputo');
  const [clockNow, setClockNow] = useState(() => new Date().toISOString());
  const [secondsLeft, setSecondsLeft] = useState<number>(previewSecondsLimit ?? 0);
  const onPreviewExpiredRef = React.useRef(onPreviewExpired);
  onPreviewExpiredRef.current = onPreviewExpired;

  useEffect(() => {
    const id = setInterval(() => {
      setClockNow(new Date().toISOString());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!previewSecondsLimit || previewExpired) return;
    let remaining = previewSecondsLimit;
    setSecondsLeft(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        setSecondsLeft(0);
        onPreviewExpiredRef.current?.();
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [previewSecondsLimit, previewExpired]);

  if (previewSecondsLimit && (previewExpired || secondsLeft <= 0)) {
    return (
      <div className="max-w-xl mx-auto my-8 p-8 rounded-xl border border-slate-800 bg-[#101724] text-center space-y-5">
        <div className="w-12 h-12 mx-auto rounded-lg bg-[#090D16] border border-slate-800 flex items-center justify-center text-cyan-400">
          <Lock className="w-5 h-5" />
        </div>
        <div className="space-y-2">
          <div className="text-xs font-mono text-slate-400">ACESSO AO GLOBAL MARKET</div>
          <h2 className="font-display text-2xl font-bold text-white">
            Crie uma conta para continuar a acompanhar o mercado
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            A amostra pública de {previewSecondsLimit} segundos terminou. Para acompanhar o
            índice MIL-IDX em tempo real, o livro de profundidade e executar operações confirmadas,
            crie a sua conta ou inicie sessão.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          {onStartOperation && (
            <button
              type="button"
              onClick={onStartOperation}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              <span>Criar Conta</span>
            </button>
          )}
          {onLogin && (
            <button
              type="button"
              onClick={onLogin}
              className="w-full sm:w-auto px-6 py-3 text-sm font-medium text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg transition-colors cursor-pointer"
            >
              Entrar
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="p-6 text-sm text-slate-400">
        A inicializar terminal de mercado MIL-IDX...
      </div>
    );
  }

  const isUp = snapshot.movement !== 'DESCIDA';
  const displayedTicks = snapshot.recent_ticks.slice(-tickWindow);
  const orderBook = snapshot.order_book ?? { bids: [], asks: [] };
  const tape = snapshot.recent_tape ?? [];
  const maxBookTotal = Math.max(
    ...[...orderBook.bids, ...orderBook.asks].map((l) => l.total_usd),
    1
  );

  const formatCompactUSD = (val: number) => {
    if (val >= 1_000_000_000_000) {
      return `$${(val / 1_000_000_000_000).toFixed(4)} T`;
    }
    if (val >= 1_000_000_000) {
      return `$${(val / 1_000_000_000).toFixed(2)} B`;
    }
    if (val >= 1_000_000) {
      return `$${(val / 1_000_000).toFixed(2)} M`;
    }
    return formatUSD(val);
  };

  const isPublicPreview = Boolean(previewSecondsLimit);

  return (
    <div className="space-y-5">
      {/* Terminal Top Strip */}
      <div className="rounded-xl border border-slate-800 bg-[#101724] p-4 sm:p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mb-1">
              <span className="font-semibold text-slate-200">MIL-IDX / USD</span>
              {isPublicPreview && (
                <span className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 font-mono text-[11px] font-semibold whitespace-nowrap">
                  AMOSTRA · DEMONSTRAÇÃO
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span>
                Sessão #{snapshot.session.session_number} ({snapshot.session.regime})
              </span>
              {wsConnected && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1.5 text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Tempo Real
                  </span>
                </>
              )}
              {previewSecondsLimit !== undefined && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-amber-400 tabular-nums">
                    Fecha em {secondsLeft}s
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-2xl sm:text-3xl font-bold text-white tabular-nums">
                {snapshot.current_price.toFixed(2)}
              </span>
              <span
                className={`font-mono text-xs font-semibold tabular-nums ${
                  snapshot.change_24h_pct >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {snapshot.change_24h_pct >= 0 ? '+' : ''}
                {snapshot.change_24h_pct.toFixed(3)}%
              </span>
              {isPublicPreview && (
                <span className="text-[11px] text-amber-300/90">
                  Índice de demonstração (apenas amostra)
                </span>
              )}
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-6 pl-6 border-l border-slate-800 text-xs">
            <div>
              <div className="text-slate-400">Máxima (Sessão)</div>
              <div className="font-mono text-slate-200 font-medium tabular-nums">
                {snapshot.high_24h.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Mínima (Sessão)</div>
              <div className="font-mono text-slate-200 font-medium tabular-nums">
                {snapshot.low_24h.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">Volume 24h</div>
              <div className="font-mono text-slate-200 font-medium tabular-nums">
                {formatCompactUSD(snapshot.volume_24h_usd)}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Synchronized Market Clock + Timezone Selector */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#090D16] border border-slate-800 text-xs">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-mono text-slate-100 tabular-nums">
              {formatShortTime(clockNow, timeZone)}
            </span>
            <select
              aria-label="Fuso horário do mercado"
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="bg-transparent text-slate-400 text-[11px] focus:outline-none cursor-pointer"
            >
              <option value="Africa/Maputo" className="bg-[#090D16]">
                Maputo (CAT)
              </option>
              <option value="Africa/Luanda" className="bg-[#090D16]">
                Luanda (WAT)
              </option>
              <option value="Europe/Lisbon" className="bg-[#090D16]">
                Lisboa (WET)
              </option>
              <option value="LOCAL" className="bg-[#090D16]">
                Hora Local
              </option>
            </select>
          </div>

          {onStartOperation && (
            <button
              onClick={onStartOperation}
              className="px-5 py-2 text-xs sm:text-sm font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Criar Conta para Operar
            </button>
          )}
        </div>
      </div>

      {/* 5 Live Macro Indicators */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
          <div className="text-xs text-slate-400 mb-1">Global Market Value</div>
          <div className="font-mono text-lg font-bold text-white tabular-nums">
            {formatUSD(snapshot.global_market_value, 0)}
          </div>
          <div
            className={`font-mono text-[11px] mt-1 tabular-nums ${
              snapshot.global_market_delta_pct >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {snapshot.global_market_delta_pct >= 0 ? '+' : ''}
            {snapshot.global_market_delta_pct.toFixed(3)}% variação líquida
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
          <div className="text-xs text-slate-400 mb-1">Active Investors</div>
          <div className="font-mono text-lg font-bold text-white tabular-nums">
            {snapshot.active_investors.toLocaleString('pt-PT')}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Participantes ativos na rede</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
          <div className="text-xs text-slate-400 mb-1">Total Active Operations</div>
          <div className="font-mono text-lg font-bold text-white tabular-nums">
            {snapshot.total_active_operations.toLocaleString('pt-PT')}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Ordens abertas no livro</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
          <div className="text-xs text-slate-400 mb-1">Capital in Operations</div>
          <div className="font-mono text-lg font-bold text-white tabular-nums">
            {formatCompactUSD(snapshot.capital_in_operations_usd)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1 tabular-nums">
            {formatMT(snapshot.capital_in_operations_usd, snapshot.usd_to_mt_rate)}
          </div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
          <div className="text-xs text-slate-400 mb-1">Market Movement</div>
          <div
            className={`font-mono text-lg font-bold flex items-center gap-1.5 ${
              isUp ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {isUp ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
            <span>{snapshot.movement}</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Tendência imediata do fluxo</div>
        </div>
      </div>

      {/* Main Institutional Trading Desk Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* Chart Terminal (Line & Area Only) */}
        <div className="xl:col-span-8 p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-white">Gráfico de Linha & Área</span>
              <div className="flex items-center gap-1 p-1 bg-[#090D16] rounded-lg border border-slate-800">
                {[
                  { label: 'Curto', val: 40 as const },
                  { label: 'Médio', val: 90 as const },
                  { label: 'Completo', val: 160 as const },
                ].map((w) => (
                  <button
                    key={w.val}
                    type="button"
                    onClick={() => setTickWindow(w.val)}
                    className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer ${
                      tickWindow === w.val
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
              <span>EMA(12)</span>
              <span>·</span>
              <span>Volume</span>
            </div>
          </div>

          <MarketChart
            ticks={displayedTicks}
            height={380}
            timeZone={timeZone}
            chartLabel="MIL-IDX / USD · Tempo Real"
          />

          {/* Sentiment Bar */}
          <div className="pt-3 border-t border-slate-800/80">
            <div className="flex items-center justify-between text-xs font-mono mb-1.5">
              <span className="text-emerald-400 font-semibold">
                {snapshot.sentiment_up_pct}% SUBIDA (COMPRADORES)
              </span>
              <span className="text-red-400 font-semibold">
                {snapshot.sentiment_down_pct}% DESCIDA (VENDEDORES)
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-red-500/30 overflow-hidden flex">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${snapshot.sentiment_up_pct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Right Side: Order Book Depth & Recent Executions Tape */}
        <div className="xl:col-span-4 space-y-5">
          {/* Order Book */}
          <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-white">Livro de Profundidade (MIL-IDX)</h2>
              <span className="text-[11px] font-mono text-slate-400">USD</span>
            </div>

            <div className="grid grid-cols-3 text-[11px] text-slate-500 pb-1.5 border-b border-slate-800/80">
              <span>Preço</span>
              <span className="text-right">Volume</span>
              <span className="text-right">Acumulado</span>
            </div>

            {/* Asks (Sell) */}
            <div className="space-y-0.5 py-1.5">
              {orderBook.asks.map((lvl, idx) => (
                <div
                  key={`ask_${idx}`}
                  className="relative grid grid-cols-3 text-xs font-mono py-1 px-1 rounded overflow-hidden tabular-nums"
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-red-500/10"
                    style={{ width: `${(lvl.total_usd / maxBookTotal) * 100}%` }}
                  />
                  <span className="relative text-red-400">{lvl.price.toFixed(2)}</span>
                  <span className="relative text-right text-slate-300">
                    ${Math.round(lvl.size_usd).toLocaleString('pt-PT')}
                  </span>
                  <span className="relative text-right text-slate-400">
                    ${Math.round(lvl.total_usd).toLocaleString('pt-PT')}
                  </span>
                </div>
              ))}
            </div>

            {/* Spread Divider */}
            <div className="py-1.5 my-1 border-y border-slate-800 flex items-center justify-between text-xs font-mono">
              <span className="text-white font-semibold">{snapshot.current_price.toFixed(2)}</span>
              <span className="text-[11px] text-slate-400">Spread ~0.42</span>
            </div>

            {/* Bids (Buy) */}
            <div className="space-y-0.5 pt-1">
              {orderBook.bids.map((lvl, idx) => (
                <div
                  key={`bid_${idx}`}
                  className="relative grid grid-cols-3 text-xs font-mono py-1 px-1 rounded overflow-hidden tabular-nums"
                >
                  <div
                    className="absolute inset-y-0 right-0 bg-emerald-500/10"
                    style={{ width: `${(lvl.total_usd / maxBookTotal) * 100}%` }}
                  />
                  <span className="relative text-emerald-400">{lvl.price.toFixed(2)}</span>
                  <span className="relative text-right text-slate-300">
                    ${Math.round(lvl.size_usd).toLocaleString('pt-PT')}
                  </span>
                  <span className="relative text-right text-slate-400">
                    ${Math.round(lvl.total_usd).toLocaleString('pt-PT')}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Live Executions Tape */}
          <div className="p-4 rounded-xl border border-slate-800 bg-[#101724]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-white">Fluxo de Mercado em Direto</h2>
              <span className="text-[11px] text-slate-400">Últimas execuções</span>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {tape.slice(0, 9).map((t) => (
                <div
                  key={t.id}
                  className="grid grid-cols-3 text-xs font-mono py-1 border-b border-slate-800/40 last:border-0 tabular-nums"
                >
                  <span className={t.side === 'SUBIDA' ? 'text-emerald-400' : 'text-red-400'}>
                    {t.price.toFixed(2)}
                  </span>
                  <span className="text-right text-slate-200">
                    ${t.amount_usd.toLocaleString('pt-PT', { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-right text-slate-400">
                    {formatShortTime(t.timestamp, timeZone)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Transparent Index Methodology, Rules & Loss Risk Disclosure */}
      <div className="rounded-xl border border-slate-800 bg-[#101724] p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
          <div>
            <div className="text-xs font-mono text-cyan-400">ESPECIFICAÇÕES DO MERCADO</div>
            <h2 className="text-base font-semibold text-white mt-0.5">
              Metodologia, Regras e Risco de Perda ({snapshot.index_name || 'MIL-IDX'})
            </h2>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Multiplicador proporcional: {snapshot.proportional_multiplier}x
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs leading-relaxed">
          <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800/80 space-y-1">
            <div className="font-semibold text-white">Índice e Metodologia</div>
            <p className="text-slate-300">
              O <strong className="text-white">MIL-IDX</strong> é um índice algorítmico interno da
              MILION.SPACE organizado em sessões contínuas. Não representa bolsas externas nem
              ativos interbancários.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800/80 space-y-1">
            <div className="font-semibold text-white">Tipo, Valor e Duração</div>
            <p className="text-slate-300">
              Escolha entre <strong className="text-emerald-400">SUBIDA</strong> ou{' '}
              <strong className="text-red-400">DESCIDA</strong>. Ordens abaixo de $5 exigem mínimo
              de 5 minutos; ordens de $5 ou mais exigem mínimo de 20 minutos, até{' '}
              {snapshot.max_duration_days} dias.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#090D16] border border-slate-800/80 space-y-1">
            <div className="font-semibold text-white">Risco de Perda e Histórico</div>
            <p className="text-amber-200/90">
              Pode perder até <strong className="text-white">100% do montante alocado</strong> na
              operação (sem risco de saldo negativo). Todas as execuções e liquidações ficam
              registadas no Histórico da conta.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
