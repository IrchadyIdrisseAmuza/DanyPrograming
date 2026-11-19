import React from 'react';
import {
  UserCheck,
  Wallet,
  ArrowLeftRight,
  TrendingUp,
  CheckCircle2,
  ArrowRight,
  Mail,
} from 'lucide-react';

interface HowItWorksViewProps {
  usdToMtRate: number;
  onGoToTransfers: () => void;
  onGoToOperations: () => void;
  onOpenMarket: () => void;
}

export const HowItWorksView: React.FC<HowItWorksViewProps> = ({
  usdToMtRate,
  onGoToTransfers,
  onGoToOperations,
  onOpenMarket,
}) => {
  const steps = [
    {
      step: '01',
      title: 'Conta e Código Público',
      icon: UserCheck,
      detail:
        'A sua conta é registada com qualquer endereço de e-mail válido e identificada por um código público único (ex.: MIL-123456).',
    },
    {
      step: '02',
      title: 'Carteira Digital em USD',
      icon: Wallet,
      detail: `O saldo é gerido em USD com conversão interna de 1 USD = ${usdToMtRate} MT e divisão clara entre Disponível, Em Operação e Reservado.`,
    },
    {
      step: '03',
      title: 'Depósitos via M-Pesa',
      icon: ArrowLeftRight,
      detail:
        'Carregue a carteira exclusivamente via M-Pesa (84 ou 85). Introduza o seu PIN apenas no telemóvel; o crédito em USD ocorre após confirmação oficial.',
    },
    {
      step: '04',
      title: 'Operações com Confirmação',
      icon: TrendingUp,
      detail:
        'Escolha SUBIDA ou DESCIDA, montante e duração (5 min abaixo de $5; 20 min a 14 dias a partir de $5). A ordem só inicia após confirmar o resumo e aceitar o risco de perda até 100% do valor aplicado.',
    },
    {
      step: '05',
      title: 'Liquidação e Levantamentos',
      icon: CheckCircle2,
      detail:
        'Ao concluir o prazo, o resultado regressa ao Saldo Disponível e fica registado no Histórico. Pode solicitar levantamentos M-Pesa sujeitos a revisão administrativa.',
    },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="pb-4 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="text-xs font-mono text-cyan-400 mb-1">GUIA SIMPLIFICADO</div>
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Como funciona a sua conta
          </h1>
          <p className="text-sm text-slate-300 mt-1">
            Resumo direto do funcionamento da carteira, pagamentos M-Pesa e operações MIL-IDX.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoToTransfers}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>Depositar via M-Pesa</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {steps.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.step}
              className="p-5 rounded-xl border border-slate-800 bg-[#101724] flex items-start gap-4"
            >
              <div className="w-10 h-10 rounded-lg bg-[#090D16] border border-slate-800 flex items-center justify-center shrink-0 text-cyan-400">
                <Icon className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <div className="font-mono text-[11px] text-cyan-400">Passo {item.step}</div>
                <h2 className="text-sm font-semibold text-white">{item.title}</h2>
                <p className="text-xs text-slate-300 leading-relaxed">{item.detail}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="text-xs text-slate-400 flex items-center gap-2">
          <Mail className="w-3.5 h-3.5 text-cyan-400" />
          <span>Suporte: </span>
          <a
            href="mailto:milionspace367@gmail.com"
            className="text-cyan-400 hover:text-cyan-300 font-mono"
          >
            milionspace367@gmail.com
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onOpenMarket}
            className="px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg cursor-pointer"
          >
            Global Market
          </button>
          <button
            type="button"
            onClick={onGoToOperations}
            className="px-4 py-2 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer"
          >
            Abrir Operações
          </button>
        </div>
      </div>
    </div>
  );
};
