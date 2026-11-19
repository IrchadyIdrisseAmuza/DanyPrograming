import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Globe,
  HelpCircle,
  Lock,
  Mail,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import type { GlobalMarketSnapshot } from '../types';

export type PublicRoute =
  | 'home'
  | 'how-it-works'
  | 'global-market'
  | 'security'
  | 'about'
  | 'terms'
  | 'privacy'
  | 'payments-policy'
  | 'risks'
  | 'faq'
  | 'support-contact'
  | 'exchange-rates'
  | 'auth-login'
  | 'auth-register';

export type PublicInfoPageId = Exclude<
  PublicRoute,
  'home' | 'global-market' | 'auth-login' | 'auth-register'
>;

interface PublicInfoPagesProps {
  page: PublicInfoPageId;
  snapshot: GlobalMarketSnapshot | null;
  onNavigate: (route: PublicRoute) => void;
}

interface InternationalRate {
  code: string;
  country: string;
  name: string;
  symbol: string;
  ratePerUsd: number;
  note: string;
}

export const PublicInfoPages: React.FC<PublicInfoPagesProps> = ({
  page,
  snapshot,
  onNavigate,
}) => {
  const mtRate = snapshot?.usd_to_mt_rate ?? 70;
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [usdSample, setUsdSample] = useState<string>('10');

  const internationalRates: InternationalRate[] = [
    {
      code: 'MZN',
      country: 'Moçambique',
      name: 'Metical Moçambicano',
      symbol: 'MT',
      ratePerUsd: mtRate,
      note: 'Taxa interna fixa da plataforma para depósitos e levantamentos via M-Pesa.',
    },
    {
      code: 'AOA',
      country: 'Angola',
      name: 'Kwanza Angolano',
      symbol: 'Kz',
      ratePerUsd: 920,
      note: 'Referência indicativa de mercado.',
    },
    {
      code: 'BRL',
      country: 'Brasil',
      name: 'Real Brasileiro',
      symbol: 'R$',
      ratePerUsd: 5.8,
      note: 'Referência indicativa de mercado.',
    },
    {
      code: 'EUR',
      country: 'Zona Euro',
      name: 'Euro',
      symbol: '€',
      ratePerUsd: 0.92,
      note: 'Referência indicativa de mercado.',
    },
    {
      code: 'ZAR',
      country: 'África do Sul',
      name: 'Rand Sul-Africano',
      symbol: 'R',
      ratePerUsd: 18.2,
      note: 'Referência indicativa de mercado.',
    },
    {
      code: 'GBP',
      country: 'Reino Unido',
      name: 'Libra Esterlina',
      symbol: '£',
      ratePerUsd: 0.79,
      note: 'Referência indicativa de mercado.',
    },
  ];

  const faqItems = [
    {
      q: 'Como funciona a moeda interna da conta?',
      a: `O saldo interno da carteira digital é mantido exclusivamente em dólares americanos (USD). Para operações em Meticais via M-Pesa, utiliza-se a taxa interna fixa de 1 USD = ${mtRate} MT.`,
    },
    {
      q: 'Quais os métodos de depósito e levantamento disponíveis?',
      a: 'Atualmente, a MILION.SPACE aceita exclusivamente pagamentos e levantamentos via M-Pesa (Vodacom Moçambique · números com prefixo 84 ou 85). Outros métodos estão desativados.',
    },
    {
      q: 'Como é confirmado um depósito via M-Pesa?',
      a: 'Ao submeter o depósito, o servidor envia uma solicitação de cobrança real à API do operador. Receberá um pedido no telemóvel para introduzir o seu PIN oficial M-Pesa. A MILION.SPACE nunca solicita nem guarda o seu PIN. Após confirmação oficial, o saldo em USD é creditado automaticamente.',
    },
    {
      q: 'Existe garantia de lucro nas operações do Global Market?',
      a: 'Não. As operações de mercado sobre o índice MIL-IDX envolvem risco financeiro real. Pode perder até 100% do capital alocado numa operação individual, embora o seu risco máximo seja limitado ao montante aplicado nessa operação (sem saldos negativos).',
    },
    {
      q: 'O que é o índice MIL-IDX?',
      a: 'O MIL-IDX é um índice algorítmico interno da plataforma MILION.SPACE, concebido para apresentar variações de mercado organizadas em sessões. Não representa um ativo negociado em bolsas externas como NASDAQ, NYSE ou Forex interbancário.',
    },
    {
      q: 'Que provedores de e-mail são aceites no registo?',
      a: 'Pode criar conta com qualquer endereço de e-mail válido de qualquer provedor (Gmail, Outlook, Yahoo, iCloud, domínio empresarial, entre outros).',
    },
  ];

  const parsedUsd = Math.max(0, Number(usdSample) || 0);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      {/* Breadcrumb back bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-cyan-400 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Voltar à Página Inicial</span>
        </button>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <button
            type="button"
            onClick={() => onNavigate('faq')}
            className={`hover:text-white transition-colors cursor-pointer ${
              page === 'faq' ? 'text-cyan-400 font-semibold' : ''
            }`}
          >
            Perguntas Frequentes
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onNavigate('payments-policy')}
            className={`hover:text-white transition-colors cursor-pointer ${
              page === 'payments-policy' ? 'text-cyan-400 font-semibold' : ''
            }`}
          >
            Pagamentos M-Pesa
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onNavigate('risks')}
            className={`hover:text-white transition-colors cursor-pointer ${
              page === 'risks' ? 'text-cyan-400 font-semibold' : ''
            }`}
          >
            Riscos
          </button>
        </div>
      </div>

      {/* 1. COMO FUNCIONA */}
      {page === 'how-it-works' && (
        <div className="space-y-8">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Funcionamento da Plataforma
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Como funciona a MILION.SPACE
            </h1>
            <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-3xl">
              A MILION.SPACE reúne uma carteira digital em USD, movimentos exclusivos via M-Pesa
              e operações de mercado sobre o índice interno MIL-IDX num fluxo simples e auditável.
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {[
              {
                num: '01',
                title: 'Criar Conta',
                desc: 'Registe-se com nome completo, número M-Pesa (84 ou 85), qualquer e-mail válido e palavra-passe. Cada conta recebe um identificador público único (ex.: MIL-123456).',
              },
              {
                num: '02',
                title: 'Carregar Carteira via M-Pesa',
                desc: `Os depósitos são feitos exclusivamente via M-Pesa. A conversão é transparente à taxa interna de 1 USD = ${mtRate} MT. A autorização por PIN ocorre apenas no seu telemóvel.`,
              },
              {
                num: '03',
                title: 'Configurar Operação com Confirmação',
                desc: 'Escolha a direção (SUBIDA ou DESCIDA), o montante em USD e a duração (5 min para valores abaixo de $5; 20 min a 14 dias para valores iguais ou superiores a $5). A operação só inicia após a sua confirmação explícita.',
              },
              {
                num: '04',
                title: 'Liquidação e Levantamentos',
                desc: 'Ao terminar a duração da operação, o resultado é liquidado para o seu Saldo Disponível. Pode solicitar levantamentos M-Pesa sujeitos a revisão e aprovação administrativa.',
              },
            ].map((item) => (
              <div
                key={item.num}
                className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5"
              >
                <div className="font-mono text-xs text-cyan-400">Passo {item.num}</div>
                <h2 className="text-lg font-semibold text-white">{item.title}</h2>
                <p className="text-sm text-slate-300 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#0B101B] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="text-sm text-slate-300">
              Pronto para consultar o painel ou criar a sua conta?
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('global-market')}
                className="px-4 py-2.5 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg cursor-pointer"
              >
                Ver Global Market
              </button>
              <button
                type="button"
                onClick={() => onNavigate('auth-register')}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer"
              >
                <span>Criar Conta</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. SEGURANÇA */}
      {page === 'security' && (
        <div className="space-y-8">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Controlos Técnicos & Transparência
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Segurança na MILION.SPACE
            </h1>
            <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-3xl">
              Aplicamos medidas técnicas de controlo e rastreabilidade nas sessões, na carteira
              digital e nos fluxos de pagamento M-Pesa, mantendo total clareza sobre como os seus
              dados e fundos são tratados.
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
              <Lock className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Autenticação e Palavras-passe</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                As palavras-passe são guardadas com derivação criptográfica (scrypt com salt
                aleatório por utilizador) e nunca em texto simples. As sessões usam assinatura HMAC
                com suporte a encerramento e revogação no servidor.
              </p>
            </div>
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
              <Smartphone className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Autorização M-Pesa no Canal Oficial</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                A MILION.SPACE nunca solicita, processa nem armazena o seu PIN do M-Pesa. A
                confirmação do pagamento ocorre exclusivamente no seu telemóvel através da rede
                Vodacom/ZaasPay, e nenhum crédito é adicionado antes da confirmação oficial.
              </p>
            </div>
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Integridade de Carteira e Ledger</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                Cada movimentação financeira (depósito creditado, reserva de operação, liquidação ou
                levantamento) é executada em transação atómica na base de dados com registo
                imutável no extrato (ledger) e trilha de auditoria.
              </p>
            </div>
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-2.5">
              <CheckCircle2 className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Limitação de Risco por Operação</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                O risco de uma operação está limitado ao montante alocado nessa ordem específica. O
                sistema impede saldos negativos na carteira, sem exigir garantias adicionais além do
                capital reservado.
              </p>
            </div>
          </div>

          <div className="p-5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-slate-300 leading-relaxed">
            <strong className="text-amber-300">Nota de responsabilidade:</strong> Nenhum sistema
            online é isento de riscos operacionais ou financeiros. Proteja o acesso ao seu e-mail e
            ao seu telemóvel M-Pesa e nunca partilhe códigos PIN com terceiros.
          </div>
        </div>
      )}

      {/* 3. SOBRE A PLATAFORMA */}
      {page === 'about' && (
        <div className="space-y-6">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Identidade & Propósito
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Sobre a MILION.SPACE
            </h1>
            <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-3xl">
              A MILION.SPACE é uma plataforma digital orientada para utilizadores em Moçambique,
              combinando gestão de saldo em USD, integração direta com M-Pesa e acompanhamento do
              índice interno MIL-IDX numa interface estruturada e transparente.
            </p>
          </header>

          <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-4 text-sm text-slate-300 leading-relaxed">
            <h2 className="text-base font-semibold text-white">Princípios de Funcionamento</h2>
            <ul className="space-y-2.5 list-disc pl-5">
              <li>
                <strong className="text-white">Clareza contabilística:</strong> o saldo interno é
                expresso em USD e separado em Saldo Disponível, Saldo em Operação e Saldo Reservado
                para levantamento.
              </li>
              <li>
                <strong className="text-white">Taxas e conversão transparentes:</strong> a taxa de
                referência interna é de <span className="font-mono text-white">1 USD = {mtRate} MT</span>,
                calculada diretamente pelo servidor.
              </li>
              <li>
                <strong className="text-white">Transparência sobre o mercado:</strong> o índice
                MIL-IDX é um índice proprietário da plataforma, não devendo ser confundido com
                mercados acionistas ou bolsas internacionais externas.
              </li>
              <li>
                <strong className="text-white">Atendimento estruturado:</strong> pedidos de suporte
                são acompanhados com referência única, estado e histórico completo de mensagens.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* 4. TERMOS E CONDIÇÕES */}
      {page === 'terms' && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Enquadramento de Utilização
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Termos e Condições
            </h1>
          </header>

          <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-5 text-sm text-slate-300 leading-relaxed">
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">1. Elegibilidade e Conta</h2>
              <p>
                Ao criar uma conta na MILION.SPACE, o utilizador declara fornecer informações reais
                (nome completo, número M-Pesa válido e endereço de e-mail ativo). Cada conta é
                pessoal e identificada por código público único.
              </p>
            </section>
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">2. Carteira Digital e Pagamentos</h2>
              <p>
                A unidade de conta interna é o dólar americano (USD). Depósitos e levantamentos são
                processados exclusivamente em Meticais (MT) via M-Pesa à taxa interna de{' '}
                <span className="font-mono text-white">1 USD = {mtRate} MT</span>, mediante validação
                da operadora ou aprovação administrativa conforme o fluxo aplicável.
              </p>
            </section>
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">3. Operações MIL-IDX</h2>
              <p>
                As operações são executadas voluntariamente após confirmação explícita do utilizador.
                O utilizador aceita as regras de duração, cálculo proporcional e possibilidade de
                perda total do montante aplicado em cada operação.
              </p>
            </section>
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">4. Conduta e Suspensão</h2>
              <p>
                Tentativas de fraude, abuso de API, criação de múltiplas contas para exploração
                indevida ou manipulação podem resultar na suspensão preventiva da conta e revisão dos
                movimentos registados.
              </p>
            </section>
          </div>
        </div>
      )}

      {/* 5. POLÍTICA DE PRIVACIDADE */}
      {page === 'privacy' && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Proteção de Dados
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Política de Privacidade
            </h1>
          </header>

          <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-5 text-sm text-slate-300 leading-relaxed">
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">1. Dados Recolhidos</h2>
              <p>
                Recolhemos apenas os dados estritamente necessários ao funcionamento da conta e dos
                pagamentos: nome completo, endereço de e-mail, número M-Pesa, histórico de
                transações e registos de suporte.
              </p>
            </section>
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">2. Finalidade de Tratamento</h2>
              <p>
                Os dados são usados exclusivamente para autenticação, execução e reconciliação de
                depósitos e levantamentos M-Pesa, liquidação de operações, auditoria interna e
                atendimento de suporte.
              </p>
            </section>
            <section className="space-y-1.5">
              <h2 className="text-base font-semibold text-white">3. Sigilo de Credenciais e PIN</h2>
              <p>
                A plataforma não armazena palavras-passe em texto limpo e nunca recolhe ou guarda o
                PIN do serviço M-Pesa. Números M-Pesa são exibidos em formato mascarado nos registos
                públicos e históricos.
              </p>
            </section>
          </div>
        </div>
      )}

      {/* 6. POLÍTICA DE DEPÓSITOS E LEVANTAMENTOS */}
      {page === 'payments-policy' && (
        <div className="space-y-6">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Regras Financeiras M-Pesa
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Política de Depósitos e Levantamentos
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed max-w-3xl">
              Todos os fluxos de entrada e saída de fundos operam exclusivamente através da rede
              M-Pesa Vodacom Moçambique via gateway autorizado ZaasPay.
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-3">
              <h2 className="text-base font-semibold text-white">Depósitos M-Pesa (C2B)</h2>
              <ul className="text-sm text-slate-300 space-y-2 list-disc pl-5">
                <li>
                  Taxa interna aplicada no servidor:{' '}
                  <span className="font-mono text-white">1 USD = {mtRate} MT</span>.
                </li>
                <li>Montantes em Meticais devem ser inteiros (ex.: 70 MT, 350 MT, 700 MT).</li>
                <li>Após submissão, recebe uma solicitação de PIN no telemóvel M-Pesa.</li>
                <li>
                  O saldo em USD só é creditado após confirmação oficial verificável pela
                  operadora/gateway. Pedidos falhados ou cancelados nunca creditam saldo.
                </li>
              </ul>
            </div>

            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-3">
              <h2 className="text-base font-semibold text-white">Levantamentos M-Pesa (B2C)</h2>
              <ul className="text-sm text-slate-300 space-y-2 list-disc pl-5">
                <li>Disponível para carteiras M-Pesa com prefixos 84 ou 85.</li>
                <li>
                  Ao solicitar levantamento, o valor em USD é imediatamente transferido do Saldo
                  Disponível para Saldo Reservado, impedindo gastos duplicados.
                </li>
                <li>
                  Os levantamentos passam por verificação de segurança e aprovação administrativa
                  antes do envio à operadora.
                </li>
                <li>
                  Em caso de rejeição ou falha confirmada no envio, a reserva retorna integralmente
                  ao Saldo Disponível.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 7. RISCOS DAS OPERAÇÕES */}
      {page === 'risks' && (
        <div className="space-y-6">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-amber-400">
              Aviso Obrigatório de Risco
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Riscos das Operações de Mercado
            </h1>
          </header>

          <div className="p-6 rounded-xl border border-amber-500/35 bg-[#101724] space-y-4 text-sm text-slate-300 leading-relaxed">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold text-white mb-1">
                  Possibilidade de Perda Total do Capital Alocado
                </h2>
                <p>
                  Cada operação aberta no módulo MILION Operations envolve risco financeiro real. Se
                  a variação do índice MIL-IDX for contrária à direção escolhida (SUBIDA ou DESCIDA),
                  poderá perder parcial ou integralmente (até 100%) o valor aplicado nessa operação.
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Índice Interno MIL-IDX</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  O MIL-IDX é gerado pelo motor interno da plataforma em sessões configuradas pelo
                  sistema. Não existem garantias de retorno, nem previsão certa do movimento futuro.
                </p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Risco Limitado à Ordem</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Embora possa perder 100% do valor alocado a uma operação, a plataforma não gera
                  saldos negativos nem exige reembolsos adicionais além do capital reservado.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 8. PERGUNTAS FREQUENTES */}
      {page === 'faq' && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Esclarecimentos Rápidos
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Perguntas Frequentes
            </h1>
          </header>

          <div className="space-y-3">
            {faqItems.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div
                  key={item.q}
                  className="rounded-xl border border-slate-800 bg-[#101724] overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                    className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left cursor-pointer hover:bg-slate-800/30 transition-colors"
                  >
                    <span className="text-sm font-semibold text-white">{item.q}</span>
                    {isOpen ? (
                      <ChevronUp className="w-4 h-4 text-cyan-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 text-sm text-slate-300 leading-relaxed border-t border-slate-800/70 pt-3">
                      {item.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 9. CONTACTOS E SUPORTE */}
      {page === 'support-contact' && (
        <div className="space-y-6">
          <header className="space-y-2">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Atendimento ao Cliente
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Contactos e Suporte
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed max-w-2xl">
              Utilize os canais oficiais abaixo para esclarecer dúvidas sobre depósitos M-Pesa,
              levantamentos, operações ou acesso à conta.
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-3">
              <Mail className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Correio Eletrónico Oficial</h2>
              <p className="text-sm text-slate-300">
                Para solicitações formais ou apoio no acesso à conta:
              </p>
              <a
                href="mailto:milionspace367@gmail.com"
                className="inline-block font-mono text-sm text-cyan-400 hover:text-cyan-300"
              >
                milionspace367@gmail.com
              </a>
            </div>

            <div className="p-6 rounded-xl border border-slate-800 bg-[#101724] space-y-3">
              <HelpCircle className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-white">Central de Pedidos na Conta</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                Utilizadores com sessão iniciada podem abrir tickets organizados por categoria na aba{' '}
                <strong className="text-white">Suporte</strong>, acompanhar o estado e trocar
                mensagens diretamente com a equipa.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('auth-login')}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#06101D] bg-cyan-400 hover:bg-cyan-300 rounded-lg cursor-pointer"
              >
                <span>Entrar na Conta</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 10. CÂMBIO DE REFERÊNCIA INTERNACIONAL */}
      {page === 'exchange-rates' && (
        <div className="space-y-6">
          <header className="space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-cyan-400">
              Informação Cambial
            </div>
            <h1 className="font-display text-3xl font-bold text-white tracking-tight">
              Câmbio de Referência Internacional
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed max-w-3xl">
              Consulte as cotações de referência face ao dólar americano (USD). Apenas o Metical
              (MZN) via M-Pesa está disponível como método de pagamento na plataforma.
            </p>
          </header>

          <div className="p-5 rounded-xl border border-amber-500/35 bg-amber-500/5 flex items-start gap-3 text-xs text-slate-200 leading-relaxed">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong>Aviso importante:</strong> As taxas internacionais abaixo (AOA, BRL, EUR,
              ZAR, GBP) são meramente informativas e não constituem métodos de depósito ou
              levantamento ativos. Todos os pagamentos reais da MILION.SPACE são processados
              exclusivamente em <strong className="text-white">MZN via M-Pesa</strong> à taxa fixa
              interna <span className="font-mono text-cyan-300">1 USD = {mtRate} MT</span>.
            </div>
          </div>

          <div className="p-5 rounded-xl border border-slate-800 bg-[#101724] space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <label
                  htmlFor="usd-ref-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Simular montante de referência em USD
                </label>
                <input
                  id="usd-ref-input"
                  type="number"
                  min="1"
                  step="1"
                  value={usdSample}
                  onChange={(e) => setUsdSample(e.target.value)}
                  className="w-44 px-3.5 py-2 text-sm font-mono rounded-lg bg-[#090D16] border border-slate-700 text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div className="text-xs text-slate-400">
                <Globe className="w-3.5 h-3.5 inline mr-1.5 text-cyan-400" />
                Referência interna ativa: <span className="font-mono text-white">1 USD = {mtRate} MT</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2.5 pr-4 font-medium">País / Zona</th>
                    <th className="py-2.5 pr-4 font-medium">Moeda</th>
                    <th className="py-2.5 pr-4 font-medium text-right">1 USD</th>
                    <th className="py-2.5 pr-4 font-medium text-right">
                      Equivalente (${parsedUsd.toFixed(0)} USD)
                    </th>
                    <th className="py-2.5 font-medium">Estatuto na Plataforma</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {internationalRates.map((r) => {
                    const converted = parsedUsd * r.ratePerUsd;
                    const formatted = new Intl.NumberFormat('pt-PT', {
                      minimumFractionDigits: converted % 1 !== 0 ? 2 : 0,
                      maximumFractionDigits: 2,
                    }).format(converted);
                    const isMzn = r.code === 'MZN';
                    return (
                      <tr key={r.code}>
                        <td className="py-3 pr-4 text-slate-200 font-medium">{r.country}</td>
                        <td className="py-3 pr-4 text-slate-300">
                          {r.name} (<span className="font-mono">{r.code}</span>)
                        </td>
                        <td className="py-3 pr-4 text-right font-mono text-white tabular-nums">
                          {r.ratePerUsd} {r.symbol}
                        </td>
                        <td className="py-3 pr-4 text-right font-mono text-cyan-300 tabular-nums">
                          {formatted} {r.symbol}
                        </td>
                        <td className="py-3">
                          {isMzn ? (
                            <span className="text-emerald-400 font-medium">
                              Ativo (M-Pesa exclusivo)
                            </span>
                          ) : (
                            <span className="text-slate-400">Apenas informativo</span>
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

      {/* Footer shortcuts across secondary pages */}
      <footer className="pt-6 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={() => onNavigate('about')} className="hover:text-white cursor-pointer">
            Sobre
          </button>
          <button type="button" onClick={() => onNavigate('terms')} className="hover:text-white cursor-pointer">
            Termos
          </button>
          <button type="button" onClick={() => onNavigate('privacy')} className="hover:text-white cursor-pointer">
            Privacidade
          </button>
          <button type="button" onClick={() => onNavigate('payments-policy')} className="hover:text-white cursor-pointer">
            Depósitos e Levantamentos
          </button>
          <button type="button" onClick={() => onNavigate('risks')} className="hover:text-white cursor-pointer">
            Riscos
          </button>
          <button type="button" onClick={() => onNavigate('exchange-rates')} className="hover:text-white cursor-pointer">
            Câmbio Internacional
          </button>
          <button type="button" onClick={() => onNavigate('support-contact')} className="hover:text-white cursor-pointer">
            Contactos
          </button>
        </div>
        <div className="inline-flex items-center gap-1.5 text-slate-500">
          <BookOpen className="w-3.5 h-3.5" />
          <span>MILION.SPACE</span>
        </div>
      </footer>
    </div>
  );
};
