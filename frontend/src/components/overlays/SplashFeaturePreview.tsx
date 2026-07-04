import { useState, type ReactElement } from 'react';

type FeatureTab = 'build-flows' | 'simulate-outcomes' | 'optimize-growth' | 'connect-accounts';

const FEATURE_TABS: { id: FeatureTab; label: string }[] = [
  { id: 'build-flows', label: 'Build flows' },
  { id: 'simulate-outcomes', label: 'Simulate outcomes' },
  { id: 'optimize-growth', label: 'Optimize growth' },
  { id: 'connect-accounts', label: 'Connect accounts' }
];

const FLOW_NODE_H = 34;

function FlowNodeBox({
  x,
  y,
  width,
  title,
  subtitle,
  fill,
  stroke
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  subtitle: string;
  fill: string;
  stroke: string;
}) {
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y}
        width={width}
        height={FLOW_NODE_H}
        rx={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={1}
      />
      <text x={x} y={y + 14} textAnchor="middle" fill="#f8fafc" fontSize={10} fontWeight={600}>
        {title}
      </text>
      <text x={x} y={y + 26} textAnchor="middle" fill="#cbd5e1" fontSize={8}>
        {subtitle}
      </text>
    </g>
  );
}

function FlowConnector({ d }: { d: string }) {
  return (
    <path
      d={d}
      fill="none"
      stroke="rgba(148, 163, 184, 0.5)"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      markerEnd="url(#splash-flow-arrow)"
    />
  );
}

function FlowEdgeLabel({ x, y, label, width = 36 }: { x: number; y: number; label: string; width?: number }) {
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y - 7}
        width={width}
        height={13}
        rx={6.5}
        fill="rgba(15, 23, 42, 0.94)"
        stroke="rgba(148, 163, 184, 0.3)"
      />
      <text x={x} y={y + 2} textAnchor="middle" fill="#e2e8f0" fontSize={7.5} fontWeight={600}>
        {label}
      </text>
    </g>
  );
}

function BuildFlowsPreview() {
  const salary = { x: 190, y: 10, w: 88 };
  const checking = { x: 72, y: 78, w: 92 };
  const retirement = { x: 190, y: 78, w: 92 };
  const debt = { x: 308, y: 78, w: 92 };
  const subscriptions = { x: 72, y: 140, w: 104 };

  const salaryBottom = salary.y + FLOW_NODE_H;
  const busY = salaryBottom + 12;
  const labelY = busY + 11;

  return (
    <>
      <div className="mb-2.5 text-[11px] font-semibold text-slate-300/90">Example Flow</div>
      <div className="relative h-52 overflow-hidden rounded-xl border border-slate-200/10 bg-gradient-to-b from-slate-900/95 to-slate-950/95 sm:h-60">
        <svg className="h-full w-full" viewBox="0 0 380 188" aria-label="Example money flow diagram" role="img">
          <defs>
            <marker
              id="splash-flow-arrow"
              viewBox="0 0 8 8"
              refX={7}
              refY={4}
              markerWidth={7}
              markerHeight={7}
              orient="auto"
            >
              <path d="M0.5 0.5 L7 4 L0.5 7.5 Z" fill="rgba(148, 163, 184, 0.85)" />
            </marker>
          </defs>

          <g aria-hidden>
            <path
              d={`M${salary.x} ${salaryBottom} V${busY}`}
              fill="none"
              stroke="rgba(148, 163, 184, 0.5)"
              strokeWidth={1.25}
              strokeLinecap="round"
            />
            <path
              d={`M${checking.x} ${busY} H${debt.x}`}
              fill="none"
              stroke="rgba(148, 163, 184, 0.5)"
              strokeWidth={1.25}
              strokeLinecap="round"
            />
            <FlowConnector d={`M${checking.x} ${busY} V${checking.y}`} />
            <FlowConnector d={`M${retirement.x} ${busY} V${retirement.y}`} />
            <FlowConnector d={`M${debt.x} ${busY} V${debt.y}`} />
            <FlowConnector
              d={`M${checking.x} ${checking.y + FLOW_NODE_H} V${subscriptions.y}`}
            />
          </g>

          <FlowEdgeLabel x={checking.x} y={labelY} label="35%" />
          <FlowEdgeLabel x={retirement.x} y={labelY} label="35%" />
          <FlowEdgeLabel x={debt.x} y={labelY} label="30%" />
          <FlowEdgeLabel
            x={checking.x}
            y={checking.y + FLOW_NODE_H + 15}
            label="$350/mo"
            width={48}
          />

          <FlowNodeBox
            x={salary.x}
            y={salary.y}
            width={salary.w}
            title="Salary"
            subtitle="Income"
            fill="rgba(34, 211, 238, 0.12)"
            stroke="rgba(34, 211, 238, 0.45)"
          />
          <FlowNodeBox
            x={checking.x}
            y={checking.y}
            width={checking.w}
            title="Checking"
            subtitle="Cash"
            fill="rgba(74, 222, 128, 0.12)"
            stroke="rgba(74, 222, 128, 0.45)"
          />
          <FlowNodeBox
            x={retirement.x}
            y={retirement.y}
            width={retirement.w}
            title="401(k)"
            subtitle="Retirement"
            fill="rgba(251, 191, 36, 0.12)"
            stroke="rgba(251, 191, 36, 0.45)"
          />
          <FlowNodeBox
            x={debt.x}
            y={debt.y}
            width={debt.w}
            title="Debt Payoff"
            subtitle="Liability"
            fill="rgba(251, 113, 133, 0.12)"
            stroke="rgba(251, 113, 133, 0.45)"
          />
          <FlowNodeBox
            x={subscriptions.x}
            y={subscriptions.y}
            width={subscriptions.w}
            title="Subscriptions"
            subtitle="Expense"
            fill="rgba(167, 139, 250, 0.12)"
            stroke="rgba(167, 139, 250, 0.45)"
          />

          <text x={190} y={182} textAnchor="middle" fill="rgba(203, 213, 225, 0.82)" fontSize={9}>
            Split income by percent or route fixed amounts to any node
          </text>
        </svg>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300 sm:grid-cols-4">
        <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-2 py-1.5">% splits</div>
        <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5">Fixed $ flows</div>
        <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1.5">Multi-branch</div>
        <div className="rounded-lg border border-violet-300/20 bg-violet-300/10 px-2 py-1.5">Any node type</div>
      </div>
    </>
  );
}

function SimulateOutcomesPreview() {
  return (
    <>
      <div className="mb-2.5 flex items-center justify-between text-[11px] text-slate-300/90">
        <span className="font-semibold">Example Projection</span>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-cyan-300" />
            Baseline
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-300" />
            Growth
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-300" />
            Conservative
          </span>
        </div>
      </div>
      <div className="relative h-52 overflow-hidden rounded-xl border border-slate-200/10 bg-gradient-to-b from-slate-900/95 to-slate-950/95 sm:h-60">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 820 300" aria-hidden>
          <defs>
            <linearGradient id="splash-gridline" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9ca3af" stopOpacity="0.26" />
              <stop offset="1" stopColor="#9ca3af" stopOpacity="0.07" />
            </linearGradient>
          </defs>
          <path d="M40 260H780M40 214H780M40 168H780M40 122H780M40 76H780M40 30H780" stroke="url(#splash-gridline)" strokeWidth="1" />
          <path d="M40 246L164 232L287 210L411 178L534 142L658 98L780 55" stroke="#7dd3fc" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M40 250L164 238L287 222L411 196L534 158L658 120L780 76" stroke="#4ade80" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M40 255L164 248L287 236L411 217L534 188L658 154L780 118" stroke="#fbbf24" strokeWidth="3" fill="none" strokeLinecap="round" />
          <circle cx="658" cy="98" r="4.5" fill="#7dd3fc" />
          <circle cx="658" cy="120" r="4.5" fill="#4ade80" />
          <circle cx="658" cy="154" r="4.5" fill="#fbbf24" />
        </svg>
        <div className="absolute bottom-2 left-2 right-2 flex justify-between text-[10px] text-slate-300/75">
          <span>8/2026</span>
          <span>8/2036</span>
          <span>8/2046</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300 sm:grid-cols-4">
        <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5">Assets</div>
        <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-2 py-1.5">Income</div>
        <div className="rounded-lg border border-rose-300/20 bg-rose-300/10 px-2 py-1.5">Debt</div>
        <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1.5">Investments</div>
      </div>
    </>
  );
}

function OptimizeGrowthPreview() {
  const opportunities = [
    { label: 'Max employer 401(k) match', impact: '+$840/mo', tone: 'emerald' },
    { label: 'Pay down high-APR card', impact: '-$128/mo interest', tone: 'rose' },
    { label: 'Increase HSA contributions', impact: '+$210/mo tax savings', tone: 'cyan' }
  ] as const;

  const toneClasses = {
    emerald: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100',
    rose: 'border-rose-300/25 bg-rose-300/10 text-rose-100',
    cyan: 'border-cyan-300/25 bg-cyan-300/10 text-cyan-100'
  };

  return (
    <>
      <div className="mb-2.5 text-[11px] font-semibold text-slate-300/90">Growth Opportunities</div>
      <div className="relative flex h-52 flex-col justify-center gap-2 overflow-hidden rounded-xl border border-slate-200/10 bg-gradient-to-b from-slate-900/95 to-slate-950/95 px-3 py-3 sm:h-60">
        {opportunities.map((item) => (
          <div
            key={item.label}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${toneClasses[item.tone]}`}
          >
            <span className="text-[10px] font-medium sm:text-[11px]">{item.label}</span>
            <span className="shrink-0 text-[10px] font-semibold">{item.impact}</span>
          </div>
        ))}
        <div className="mt-1 rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-center">
          <div className="text-[10px] text-slate-400">Projected net worth at 2046</div>
          <div className="mt-0.5 flex items-center justify-center gap-2 text-[11px]">
            <span className="text-slate-400 line-through">$1.42M</span>
            <span className="font-semibold text-amber-200">$1.68M optimized</span>
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300 sm:grid-cols-3">
        <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5">Match capture</div>
        <div className="rounded-lg border border-rose-300/20 bg-rose-300/10 px-2 py-1.5">Debt payoff</div>
        <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1.5 sm:col-span-1 col-span-2">Tax efficiency</div>
      </div>
    </>
  );
}

function ConnectAccountsPreview() {
  const institutions = [
    {
      name: 'Chase',
      accounts: [
        { label: 'Total Checking', mask: '4821', linked: 'Salary' },
        { label: 'Premier Savings', mask: '9012', linked: 'Emergency fund' }
      ]
    },
    {
      name: 'Fidelity',
      accounts: [{ label: 'Brokerage', mask: '7734', linked: 'Growth portfolio' }]
    }
  ];

  return (
    <>
      <div className="mb-2.5 text-[11px] font-semibold text-slate-300/90">Connected Accounts</div>
      <div className="relative flex h-52 flex-col gap-2.5 overflow-hidden overflow-y-auto rounded-xl border border-slate-200/10 bg-gradient-to-b from-slate-900/95 to-slate-950/95 px-3 py-3 sm:h-60">
        {institutions.map((institution) => (
          <div key={institution.name} className="rounded-lg border border-slate-100/12 bg-slate-950/50 p-2">
            <div className="mb-1.5 flex items-center justify-between text-[10px]">
              <span className="font-semibold text-slate-200">{institution.name}</span>
              <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-200">
                Synced
              </span>
            </div>
            <div className="space-y-1.5">
              {institution.accounts.map((account) => (
                <div
                  key={account.mask}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-100/10 bg-slate-900/60 px-2 py-1.5 text-[10px]"
                >
                  <div>
                    <div className="font-medium text-slate-200">{account.label}</div>
                    <div className="text-slate-400">••{account.mask}</div>
                  </div>
                  <span className="rounded border border-cyan-300/25 bg-cyan-300/10 px-1.5 py-0.5 text-[9px] text-cyan-100">
                    → {account.linked}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300 sm:grid-cols-3">
        <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5">Auto-sync</div>
        <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-2 py-1.5">Link to nodes</div>
        <div className="rounded-lg border border-violet-300/20 bg-violet-300/10 px-2 py-1.5 sm:col-span-1 col-span-2">Live balances</div>
      </div>
    </>
  );
}

const PREVIEW_BY_TAB: Record<FeatureTab, () => ReactElement> = {
  'build-flows': BuildFlowsPreview,
  'simulate-outcomes': SimulateOutcomesPreview,
  'optimize-growth': OptimizeGrowthPreview,
  'connect-accounts': ConnectAccountsPreview
};

export function SplashFeaturePreview() {
  const [activeTab, setActiveTab] = useState<FeatureTab>('simulate-outcomes');
  const ActivePreview = PREVIEW_BY_TAB[activeTab];

  return (
    <section
      className="tmm-splash-concept__preview relative mx-auto w-full max-w-[840px] rounded-2xl border border-slate-100/16 bg-slate-950/72 p-3 shadow-[0_34px_90px_rgba(2,6,23,0.72)] backdrop-blur-md sm:p-4"
      aria-label="Feature preview"
    >
      <div role="tablist" aria-label="Product features" className="mb-3 flex flex-wrap gap-1.5 sm:gap-2">
        {FEATURE_TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`splash-feature-panel-${tab.id}`}
              id={`splash-feature-tab-${tab.id}`}
              className={`rounded-full border px-2.5 py-1 text-[10px] transition sm:px-3 sm:text-[11px] ${
                selected
                  ? 'border-emerald-300/50 bg-emerald-400/15 font-semibold text-emerald-100 shadow-[0_0_16px_rgba(16,185,129,0.2)]'
                  : 'border-slate-100/15 bg-slate-950/40 text-slate-300/88 hover:border-slate-100/30 hover:bg-slate-900/50'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`splash-feature-panel-${activeTab}`}
        aria-labelledby={`splash-feature-tab-${activeTab}`}
      >
        <ActivePreview />
      </div>
    </section>
  );
}
