import React, { useEffect, useMemo, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { MarketTick, Operation } from '../types';
import { formatShortTime } from '../lib/api';

interface MarketChartProps {
  ticks: MarketTick[];
  activeOperations?: Operation[];
  height?: number;
  timeZone?: string;
  showExpandButton?: boolean;
  chartLabel?: string;
}

export const MarketChart: React.FC<MarketChartProps> = ({
  ticks,
  activeOperations = [],
  height = 360,
  timeZone,
  showExpandButton = true,
  chartLabel = 'Gráfico em Tempo Real',
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedWindow, setExpandedWindow] = useState<30 | 80 | 160>(160);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const activeTicks = useMemo(
    () => (expanded ? ticks.slice(-expandedWindow) : ticks),
    [expanded, expandedWindow, ticks]
  );

  const renderSvgChart = (chartHeight: number, viewWidth: number, isFullscreen: boolean) => {
    const padLeft = 14;
    const padRight = isFullscreen ? 88 : 82;
    const padTop = 22;
    const padBottom = 34;
    const plotW = viewWidth - padLeft - padRight;
    const plotH = chartHeight - padTop - padBottom;
    const priceAreaH = plotH * 0.82;
    const volAreaTop = padTop + priceAreaH + 8;
    const volAreaH = plotH * 0.16;

    if (activeTicks.length === 0) {
      return (
        <div
          className="flex items-center justify-center border border-slate-800/80 rounded-lg bg-[#0B111E] text-sm text-slate-400"
          style={{ height: chartHeight }}
        >
          A aguardar dados de mercado...
        </div>
      );
    }

    const prices = activeTicks.map((t) => t.price);
    const entryPrices = activeOperations.map((o) => o.entry_price);
    const allValues = [...prices, ...entryPrices];
    const rawMin = Math.min(...allValues);
    const rawMax = Math.max(...allValues);
    const spread = Math.max(rawMax - rawMin, Math.max(1, rawMax) * 0.0025);
    const minVal = Math.max(0, rawMin - spread * 0.14);
    const maxVal = rawMax + spread * 0.14;
    const range = maxVal - minVal || 1;
    const maxVol = Math.max(...activeTicks.map((t) => Math.abs(t.delta) + 0.1), 1);

    const toX = (i: number) =>
      padLeft + (activeTicks.length === 1 ? plotW / 2 : (i / (activeTicks.length - 1)) * plotW);
    const toY = (val: number) => padTop + (1 - (val - minVal) / range) * priceAreaH;

    const points = activeTicks.map((t, i) => ({
      x: toX(i),
      y: toY(t.price),
      tick: t,
      vol: Math.abs(t.delta) + 0.1,
    }));

    const linePath = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(
      padTop + priceAreaH
    ).toFixed(2)} L ${points[0].x.toFixed(2)} ${(padTop + priceAreaH).toFixed(2)} Z`;

    const emaPoints: string[] = [];
    let ema = activeTicks[0].price;
    const k = 2 / (12 + 1);
    points.forEach((p, idx) => {
      ema = p.tick.price * k + ema * (1 - k);
      emaPoints.push(`${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${toY(ema).toFixed(2)}`);
    });

    const firstPrice = activeTicks[0].price;
    const lastPrice = activeTicks[activeTicks.length - 1].price;
    const isUp = lastPrice >= firstPrice;
    const strokeColor = isUp ? '#16A34A' : '#DC2626';
    const fillId = isUp
      ? isFullscreen
        ? 'milionUpGradFs'
        : 'milionUpGrad'
      : isFullscreen
        ? 'milionDownGradFs'
        : 'milionDownGrad';

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      y: padTop + ratio * priceAreaH,
      val: maxVal - ratio * range,
    }));

    const lastPoint = points[points.length - 1];
    const hoveredPoint = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : null;

    const updateHoverFromClientX = (clientX: number, target: SVGSVGElement) => {
      const rect = target.getBoundingClientRect();
      const relX = ((clientX - rect.left) / rect.width) * viewWidth;
      const clamped = Math.max(padLeft, Math.min(padLeft + plotW, relX));
      const ratio = (clamped - padLeft) / plotW;
      const len = points.length;
      const idx = Math.round(ratio * (len - 1));
      setHoverIdx(Math.max(0, Math.min(len - 1, idx)));
    };

    return (
      <div className="relative w-full select-none">
        <svg
          viewBox={`0 0 ${viewWidth} ${chartHeight}`}
          className={`w-full block ${isFullscreen ? 'h-[calc(100vh-170px)] min-h-[340px]' : 'h-auto'}`}
          preserveAspectRatio={isFullscreen ? 'none' : 'xMidYMid meet'}
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => updateHoverFromClientX(e.clientX, e.currentTarget)}
          onTouchStart={(e) => {
            if (e.touches[0]) updateHoverFromClientX(e.touches[0].clientX, e.currentTarget);
          }}
          onTouchMove={(e) => {
            if (e.touches[0]) updateHoverFromClientX(e.touches[0].clientX, e.currentTarget);
          }}
          onTouchEnd={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={strokeColor} stopOpacity="0.22" />
              <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {gridLines.map((g, i) => (
            <g key={i}>
              <line
                x1={padLeft}
                y1={g.y}
                x2={padLeft + plotW}
                y2={g.y}
                stroke="rgba(148, 163, 184, 0.08)"
                strokeDasharray="3 4"
              />
              <text
                x={padLeft + plotW + 8}
                y={g.y + 4}
                fill="#64748B"
                fontSize={isFullscreen ? '12' : '11'}
                fontFamily="JetBrains Mono, monospace"
              >
                {g.val.toFixed(2)}
              </text>
            </g>
          ))}

          {activeOperations.map((op) => {
            const y = toY(op.entry_price);
            const color = op.direction === 'SUBIDA' ? '#22C55E' : '#EF4444';
            return (
              <g key={op.id}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke={color}
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  opacity="0.75"
                />
                <rect
                  x={padLeft + 6}
                  y={y - 10}
                  width="142"
                  height="18"
                  rx="3"
                  fill="#090D16"
                  stroke={color}
                  strokeOpacity="0.55"
                />
                <text
                  x={padLeft + 12}
                  y={y + 2}
                  fill={color}
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {op.direction} ${op.entry_price.toFixed(2)}
                </text>
              </g>
            );
          })}

          <path d={areaPath} fill={`url(#${fillId})`} />
          <path
            d={emaPoints.join(' ')}
            fill="none"
            stroke="rgba(59, 130, 246, 0.55)"
            strokeWidth="1.25"
            strokeDasharray="3 3"
          />
          <path
            d={linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth={isFullscreen ? '2.4' : '2'}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {points.map((p, idx) => {
            const barH = Math.max(2, (p.vol / maxVol) * volAreaH);
            const barColor =
              p.tick.delta >= 0 ? 'rgba(22, 163, 74, 0.35)' : 'rgba(220, 38, 38, 0.35)';
            return (
              <rect
                key={idx}
                x={p.x - 1.5}
                y={volAreaTop + (volAreaH - barH)}
                width="3"
                height={barH}
                fill={barColor}
              />
            );
          })}

          <circle cx={lastPoint.x} cy={lastPoint.y} r="3.5" fill={strokeColor} />

          {hoveredPoint && (
            <g>
              <line
                x1={hoveredPoint.x}
                y1={padTop}
                x2={hoveredPoint.x}
                y2={padTop + plotH}
                stroke="rgba(148,163,184,0.35)"
                strokeDasharray="3 3"
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r="4.5"
                fill="#F8FAFC"
                stroke={strokeColor}
                strokeWidth="2"
              />
            </g>
          )}

          <line
            x1={padLeft}
            y1={toY(lastPrice)}
            x2={padLeft + plotW}
            y2={toY(lastPrice)}
            stroke={strokeColor}
            strokeOpacity="0.45"
            strokeDasharray="2 3"
          />
          <rect
            x={padLeft + plotW + 4}
            y={toY(lastPrice) - 10}
            width={isFullscreen ? '80' : '74'}
            height="20"
            rx="3"
            fill={strokeColor}
          />
          <text
            x={padLeft + plotW + 10}
            y={toY(lastPrice) + 4}
            fill="#FFFFFF"
            fontSize={isFullscreen ? '11.5' : '11'}
            fontWeight="600"
            fontFamily="JetBrains Mono, monospace"
          >
            {lastPrice.toFixed(2)}
          </text>

          {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
            const idx = Math.min(activeTicks.length - 1, Math.round(r * (activeTicks.length - 1)));
            const t = activeTicks[idx];
            if (!t) return null;
            const x = padLeft + r * plotW;
            return (
              <text
                key={i}
                x={x}
                y={chartHeight - 8}
                textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
                fill="#64748B"
                fontSize={isFullscreen ? '12' : '11'}
                fontFamily="JetBrains Mono, monospace"
              >
                {formatShortTime(t.timestamp, timeZone)}
              </text>
            );
          })}
        </svg>

        {hoveredPoint && (
          <div className="absolute top-3 left-3 pointer-events-none bg-[#090D16]/95 border border-slate-700/80 rounded-md px-3 py-1.5 text-xs flex items-center gap-2.5">
            <span className="font-mono font-semibold text-slate-100 tabular-nums">
              {hoveredPoint.tick.price.toFixed(4)}
            </span>
            <span className="text-slate-500">·</span>
            <span
              className={`font-mono tabular-nums ${
                hoveredPoint.tick.delta >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {hoveredPoint.tick.delta >= 0 ? '+' : ''}
              {hoveredPoint.tick.delta_pct.toFixed(3)}%
            </span>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-slate-400 tabular-nums">
              {formatShortTime(hoveredPoint.tick.timestamp, timeZone)}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {showExpandButton && ticks.length > 0 && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#090D16] hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors whitespace-nowrap cursor-pointer min-h-[36px] sm:min-h-[32px]"
          >
            <Maximize2 className="w-3.5 h-3.5 text-blue-400" />
            <span>Ampliar Gráfico</span>
          </button>
        </div>
      )}

      {renderSvgChart(height, 920, false)}

      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-[#090D16] flex flex-col p-4 sm:p-6 overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label={chartLabel}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-800">
            <div>
              <div className="text-xs text-slate-400">{chartLabel}</div>
              <div className="font-mono text-lg sm:text-xl font-bold text-white tabular-nums">
                {activeTicks.length > 0 ? activeTicks[activeTicks.length - 1].price.toFixed(4) : '—'}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-[#101724] rounded-lg border border-slate-800">
                {(
                  [
                    { label: '30', val: 30 },
                    { label: '80', val: 80 },
                    { label: '160', val: 160 },
                  ] as const
                ).map((w) => (
                  <button
                    key={w.val}
                    type="button"
                    onClick={() => setExpandedWindow(w.val)}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer min-h-[36px] ${
                      expandedWindow === w.val
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg cursor-pointer min-h-[40px]"
              >
                <X className="w-4 h-4" />
                <span>Fechar</span>
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-[#101724] border border-slate-800 rounded-xl p-3 sm:p-5 flex flex-col justify-center">
            {renderSvgChart(540, 1080, true)}
            <div className="text-[11px] text-slate-400 text-center mt-2">
              Deslize o dedo ou o cursor sobre o gráfico para consultar os valores exatos.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
