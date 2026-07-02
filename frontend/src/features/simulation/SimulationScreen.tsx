import React from 'react';
import { useAppState } from '../../state/appState';
import { usePlanStore } from '../../lib/plan/planStore';
import type { Augment, PlanState } from '../../lib/plan/types';
import { exportPlanXlsx, importPlanXlsx, downloadTemplateXlsx } from '../../lib/plan/xlsx';
import { loadLastRun } from '../../lib/simulation/runHistory';

type EffectDraft = {
  type?: string;
  target?: string;
  amount?: number;
  scale?: number;
};

const EFFECT_TYPES = [
  { value: 'pause-income', label: 'Pause Income' },
  { value: 'add-income', label: 'Add Income' },
  { value: 'scale-income', label: 'Scale Income' },
  { value: 'pause-expense', label: 'Pause Expense' },
  { value: 'add-expense', label: 'Add Expense' },
  { value: 'scale-expense', label: 'Scale Expense' },
  { value: 'lump-sum', label: 'Lump Sum (cash)' },
  { value: 'scale-asset', label: 'Scale Asset Growth' },
  { value: 'pause-debt', label: 'Pause Debt Payment' }
];

function createAugment(): Augment {
  return {
    id: `augment_${Date.now().toString(36)}`,
    name: 'New augment',
    category: 'global',
    description: '',
    enabled: true,
    activation: {
      type: 'fixed-date',
      startDate: new Date().toISOString().slice(0, 10),
      probability: 1
    },
    effects: [{}],
    duration: {
      type: 'instant',
      months: 0
    }
  };
}

function getAugmentStatus(augment: Augment) {
  const now = new Date();
  const start = new Date(augment.activation.startDate);
  let end = augment.activation.endDate ? new Date(augment.activation.endDate) : null;
  if (!end && augment.duration.type === 'temporary') {
    const tempEnd = new Date(start);
    tempEnd.setMonth(tempEnd.getMonth() + (augment.duration.months || 0));
    end = tempEnd;
  }
  if (now < start) return 'scheduled';
  if (end && now > end) return 'expired';
  return 'active';
}

function planHasData(plan: PlanState): boolean {
  return Object.values(plan.alternatives || {}).some(
    (alt) =>
      (alt.income?.length ?? 0) > 0 ||
      (alt.expense?.length ?? 0) > 0 ||
      (alt.asset?.length ?? 0) > 0 ||
      (alt.debt?.length ?? 0) > 0
  );
}

function getCategoryMeta(category: string) {
  const iconMap: Record<string, string> = {
    income: '💼',
    expense: '🧾',
    asset: '📈',
    debt: '💳',
    global: '🌐'
  };
  const colorMap: Record<string, string> = {
    income: 'text-emerald-300',
    expense: 'text-rose-300',
    asset: 'text-cyan-300',
    debt: 'text-amber-300',
    global: 'text-indigo-300'
  };
  return {
    icon: iconMap[category] || '📌',
    colorClass: colorMap[category] || 'text-slate-200'
  };
}

export function SimulationScreen() {
  const appState = useAppState();
  const { state: planState, dispatch: planDispatch } = usePlanStore();
  const [sampleStatus, setSampleStatus] = React.useState<string | null>(null);
  const buildSampleAugments = (startDate: string): Augment[] => {
    const toDate = (offsetMonths: number) => {
      const date = new Date(startDate);
      date.setMonth(date.getMonth() + offsetMonths);
      return date.toISOString().slice(0, 10);
    };
    const baseId = Date.now().toString(36);
    return [
      {
        id: `augment_${baseId}_jobloss`,
        name: 'Job Loss',
        category: 'income',
        description: 'Laid off from job. Severance received, 8 months to find new position',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(3), probability: 1.0 },
        effects: [
          { type: 'pause-income', target: null, duration: 'temporary' },
          { type: 'lump-sum', amount: 15000, duration: 'instant' }
        ],
        duration: { type: 'temporary', months: 8 }
      },
      {
        id: `augment_${baseId}_unemployment`,
        name: 'Unemployment Benefits',
        category: 'income',
        description: 'Unemployment benefits received during job search period',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(3), probability: 1.0 },
        effects: [{ type: 'add-income', amount: 2000, duration: 'temporary' }],
        duration: { type: 'temporary', months: 6 }
      },
      {
        id: `augment_${baseId}_medical`,
        name: 'Major Medical Expense',
        category: 'expense',
        description: 'Unexpected medical emergency requiring significant out-of-pocket expense',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(9), probability: 1.0 },
        effects: [{ type: 'add-expense', amount: 25000, duration: 'instant' }],
        duration: { type: 'instant', months: 0 }
      },
      {
        id: `augment_${baseId}_career`,
        name: 'Career Breakthrough',
        category: 'income',
        description: 'Major promotion with significant salary increase and expanded responsibilities',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(18), probability: 1.0 },
        effects: [{ type: 'scale-income', target: null, scale: 1.35, duration: 'permanent' }],
        duration: { type: 'permanent' }
      },
      {
        id: `augment_${baseId}_crash`,
        name: 'Market Crash',
        category: 'asset',
        description: 'Major market correction causes portfolio value drop and reduced growth for recovery period',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(30), probability: 1.0 },
        effects: [
          { type: 'scale-asset', target: null, scale: 0.3, duration: 'temporary' },
          { type: 'lump-sum', amount: -20000, duration: 'instant' }
        ],
        duration: { type: 'temporary', months: 12 }
      },
      {
        id: `augment_${baseId}_inheritance`,
        name: 'Inheritance',
        category: 'asset',
        description: 'Inheritance from relative provides significant financial boost',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(42), probability: 1.0 },
        effects: [{ type: 'lump-sum', amount: 75000, duration: 'instant' }],
        duration: { type: 'instant', months: 0 }
      },
      {
        id: `augment_${baseId}_purchase`,
        name: 'Major Purchase',
        category: 'expense',
        description: 'Major purchase (home down payment, vehicle, or other significant expense)',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(54), probability: 1.0 },
        effects: [{ type: 'add-expense', amount: 40000, duration: 'instant' }],
        duration: { type: 'instant', months: 0 }
      },
      {
        id: `augment_${baseId}_incomeBoost`,
        name: 'Investment Income Boost',
        category: 'income',
        description: 'Side business takes off, providing additional permanent income stream',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(66), probability: 1.0 },
        effects: [{ type: 'scale-income', target: null, scale: 1.15, duration: 'permanent' }],
        duration: { type: 'permanent' }
      },
      {
        id: `augment_${baseId}_growthBoost`,
        name: 'Investment Growth Boost',
        category: 'asset',
        description: 'Additional investment capital accelerates portfolio growth',
        enabled: true,
        activation: { type: 'fixed-date', startDate: toDate(66), probability: 1.0 },
        effects: [{ type: 'scale-asset', target: null, scale: 1.2, duration: 'temporary' }],
        duration: { type: 'temporary', months: 18 }
      }
    ];
  };
  const augments = planState.augments;
  const [activeAugment, setActiveAugment] = React.useState<Augment | null>(null);
  const [draft, setDraft] = React.useState<Augment | null>(null);
  const [audit, setAudit] = React.useState(() => loadLastRun());
  const [importFile, setImportFile] = React.useState<File | null>(null);

  const openAugmentEditor = (augment?: Augment) => {
    const next = augment ? JSON.parse(JSON.stringify(augment)) : createAugment();
    setActiveAugment(augment || null);
    setDraft(next);
  };

  const updateAugment = (id: string, next: Partial<Augment>) => {
    const updated = augments.map((augment) => (augment.id === id ? { ...augment, ...next } : augment));
    planDispatch({ type: 'setAugments', augments: updated });
  };

  const removeAugment = (id: string) => {
    const next = augments.filter((augment) => augment.id !== id);
    planDispatch({ type: 'setAugments', augments: next });
  };
  React.useEffect(() => {
    const refresh = () => setAudit(loadLastRun());
    window.addEventListener('tmm:run-simulation', refresh);
    return () => window.removeEventListener('tmm:run-simulation', refresh);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100">Simulation</h1>
        </div>

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Simulation Augments</h2>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={() => openAugmentEditor()}
            >
              + Add Augment
            </button>
          </div>
          <div className="text-xs text-slate-400">
            Life events, shocks, and opportunities that affect your financial machine.
          </div>
          {augments.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-400">
              <div>No augments yet</div>
              <div className="text-xs text-slate-500">
                Click &quot;+ Add Augment&quot; to create your first life event, shock, or opportunity.
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              {augments.map((augment) => {
                const status = getAugmentStatus(augment);
                const { icon, colorClass } = getCategoryMeta(augment.category);
                const statusLabel = status === 'scheduled' ? 'Scheduled' : status === 'active' ? 'Active' : 'Expired';
                return (
                  <div
                    key={augment.id}
                    className={`rounded-lg border border-slate-800 bg-slate-950/70 p-4 ${augment.enabled ? '' : 'opacity-50'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 ${colorClass}`}>
                          {icon}
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-slate-100">{augment.name}</div>
                          <div className="text-xs text-slate-400">{augment.description || 'No description'}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                          type="button"
                          title={augment.enabled ? 'Disable' : 'Enable'}
                          onClick={() => updateAugment(augment.id, { enabled: !augment.enabled })}
                        >
                          {augment.enabled ? '✓' : '○'}
                        </button>
                        <button
                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                          type="button"
                          onClick={() => openAugmentEditor(augment)}
                        >
                          ✎
                        </button>
                        <button
                          className="rounded-md border border-rose-500/60 px-2 py-1 text-[11px] text-rose-200"
                          type="button"
                          onClick={() => removeAugment(augment.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200">
                        {statusLabel}
                      </span>
                      <span>{new Date(augment.activation.startDate).toLocaleDateString()}</span>
                      {augment.duration.type === 'temporary' ? (
                        <span>• {augment.duration.months || 0} months</span>
                      ) : augment.duration.type === 'permanent' ? (
                        <span>• Permanent</span>
                      ) : (
                        <span>• One-time</span>
                      )}
                      {augment.activation.probability < 1 ? (
                        <span>• {Math.round(augment.activation.probability * 100)}% chance</span>
                      ) : null}
                    </div>
                    <div className="mt-3 h-2 w-full rounded-full bg-slate-900">
                      <div className="h-full w-1/3 rounded-full bg-slate-700" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Backup & Export</h2>
          <div className="text-xs text-slate-400">
            Download backups or import from files. Useful for offline mode or sharing plans.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="rounded-md border border-slate-700 bg-slate-950 text-xs text-slate-200"
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => setImportFile(event.target.files?.[0] || null)}
            />
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              data-tour="import-backup"
              type="button"
              onClick={async () => {
                if (!importFile) return;
                const nextPlan = await importPlanXlsx(importFile);
                planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
                setImportFile(null);
              }}
            >
              Import Backup
            </button>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={() => downloadTemplateXlsx()}
            >
              Download Template
            </button>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={() => exportPlanXlsx(planState)}
            >
              Export Backup
            </button>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              data-tour="load-sample-data"
              type="button"
              onClick={async () => {
                if (appState.sheets.connected) {
                  if (!window.confirm('You have a connected Google Sheet. Loading sample data will replace that data. Continue?')) return;
                } else if (planHasData(planState)) {
                  if (!window.confirm('This will replace your current data. Continue?')) return;
                }
                try {
                  setSampleStatus('Loading sample data...');
                  const response = await fetch('/TMM_Sample_Data.xlsx');
                  if (!response.ok) throw new Error('Legacy sample file not found');
                  const blob = await response.blob();
                  const file = new File([blob], 'TMM_Sample_Data.xlsx', {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  });
                  const nextPlan = await importPlanXlsx(file);
                  const nextAugments = buildSampleAugments(nextPlan.assumptions.start);
                  const altChartEnabled = Object.keys(nextPlan.alternatives || {}).reduce<Record<string, boolean>>(
                    (acc, name) => {
                      acc[name] = true;
                      return acc;
                    },
                    {}
                  );
                  planDispatch({
                    type: 'hydrate',
                    plan: { ...nextPlan, augments: nextAugments, altChartEnabled, isSampleData: true }
                  });
                  setSampleStatus('Sample data loaded from TMM_Sample_Data.xlsx.');
                } catch (error) {
                  console.warn('[sample-data] Failed to load legacy sample data', error);
                  alert(
                    'Failed to load legacy sample data. Please place "TMM_Sample_Data.xlsx" in frontend/public and try again.'
                  );
                  setSampleStatus('Failed to load sample data.');
                }
              }}
            >
              Load Sample Data
            </button>
            {sampleStatus ? <div className="text-xs text-slate-400">{sampleStatus}</div> : null}
          </div>
          <p className="text-xs text-slate-400">
            Sheets support Baseline and Alternatives. Format: <span className="rounded bg-slate-800 px-2 py-1">Income - AltName</span>,{' '}
            <span className="rounded bg-slate-800 px-2 py-1">Expenses - AltName</span>,{' '}
            <span className="rounded bg-slate-800 px-2 py-1">Assets - AltName</span>,{' '}
            <span className="rounded bg-slate-800 px-2 py-1">Debts - AltName</span>. Backwards compatible with single sheets named without &quot; - Alt&quot;. Dates in YYYY-MM-DD.
          </p>
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Audit Trail (last run)</h2>
          <div className="max-h-64 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-300">
            {audit?.audit?.length ? (
              audit.audit.map((line, idx) => <div key={`${line}-${idx}`}>{line}</div>)
            ) : (
              <div className="text-slate-500">No audit data yet. Run a simulation to capture the trail.</div>
            )}
          </div>
        </section>
      </div>

      {draft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur">
          <div className="w-full max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-200 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-100">
              {activeAugment ? 'Edit' : 'Create'} Simulation Augment
            </h2>
            <div className="mt-4 space-y-4">
              <label className="block text-xs text-slate-400">
                Name
                <input
                  className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="block text-xs text-slate-400">
                Category
                <select
                  className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                >
                  <option value="income">Income</option>
                  <option value="expense">Expense</option>
                  <option value="asset">Asset</option>
                  <option value="debt">Debt</option>
                  <option value="global">Global</option>
                </select>
              </label>
              <label className="block text-xs text-slate-400">
                Description
                <textarea
                  className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  rows={2}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <div className="space-y-2">
                <div className="text-xs text-slate-400">Activation</div>
                <select
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={draft.activation.type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      activation: { ...draft.activation, type: event.target.value as Augment['activation']['type'] }
                    })
                  }
                >
                  <option value="fixed-date">Fixed Date</option>
                  <option value="date-range">Date Range</option>
                </select>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-xs text-slate-400">
                    Start Date
                    <input
                      className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      type="date"
                      value={draft.activation.startDate}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          activation: { ...draft.activation, startDate: event.target.value }
                        })
                      }
                    />
                  </label>
                  {draft.activation.type === 'date-range' ? (
                    <label className="text-xs text-slate-400">
                      End Date
                      <input
                        className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                        type="date"
                        value={draft.activation.endDate || ''}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            activation: { ...draft.activation, endDate: event.target.value }
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
                <label className="flex items-center gap-3 text-xs text-slate-400">
                  Probability
                  <input
                    className="flex-1"
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(draft.activation.probability * 100)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        activation: { ...draft.activation, probability: Number(event.target.value) / 100 }
                      })
                    }
                  />
                  <span className="text-slate-200">{Math.round(draft.activation.probability * 100)}%</span>
                </label>
              </div>
              <div className="space-y-2">
                <div className="text-xs text-slate-400">Duration</div>
                <select
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={draft.duration.type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      duration: { ...draft.duration, type: event.target.value as Augment['duration']['type'] }
                    })
                  }
                >
                  <option value="instant">Instant (one-time)</option>
                  <option value="temporary">Temporary</option>
                  <option value="permanent">Permanent</option>
                </select>
                {draft.duration.type === 'temporary' ? (
                  <label className="text-xs text-slate-400">
                    Duration (months)
                    <input
                      className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      type="number"
                      min={1}
                      value={draft.duration.months || 0}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          duration: { ...draft.duration, months: Number(event.target.value) || 0 }
                        })
                      }
                    />
                  </label>
                ) : null}
              </div>
              <div className="space-y-2">
                <div className="text-xs text-slate-400">Effects</div>
                <div className="space-y-2">
                  {(draft.effects as EffectDraft[]).map((effect, index) => {
                    const type = effect.type || '';
                    const showTarget = ['pause-income', 'scale-income', 'pause-expense', 'scale-expense', 'scale-asset', 'pause-debt'].includes(type);
                    const showAmount = ['add-income', 'add-expense', 'lump-sum'].includes(type);
                    const showScale = ['scale-income', 'scale-expense', 'scale-asset'].includes(type);
                    return (
                      <div key={index} className="rounded-md border border-slate-800 bg-slate-950 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            className="min-w-[160px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                            value={type}
                            onChange={(event) => {
                              const next = [...draft.effects] as EffectDraft[];
                              next[index] = { ...next[index], type: event.target.value };
                              setDraft({ ...draft, effects: next });
                            }}
                          >
                            <option value="">Select effect...</option>
                            {EFFECT_TYPES.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          {showTarget ? (
                            <input
                              className="min-w-[140px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                              placeholder="Target name (optional)"
                              value={effect.target || ''}
                              onChange={(event) => {
                                const next = [...draft.effects] as EffectDraft[];
                                next[index] = { ...next[index], target: event.target.value };
                                setDraft({ ...draft, effects: next });
                              }}
                            />
                          ) : null}
                          {showAmount ? (
                            <input
                              className="min-w-[120px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                              placeholder="Amount"
                              type="number"
                              value={effect.amount ?? ''}
                              onChange={(event) => {
                                const next = [...draft.effects] as EffectDraft[];
                                next[index] = { ...next[index], amount: Number(event.target.value) || 0 };
                                setDraft({ ...draft, effects: next });
                              }}
                            />
                          ) : null}
                          {showScale ? (
                            <input
                              className="min-w-[160px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                              placeholder="Scale (0.5 = 50%, 1.5 = 150%)"
                              type="number"
                              step="0.1"
                              value={effect.scale ?? ''}
                              onChange={(event) => {
                                const next = [...draft.effects] as EffectDraft[];
                                next[index] = { ...next[index], scale: Number(event.target.value) || 0 };
                                setDraft({ ...draft, effects: next });
                              }}
                            />
                          ) : null}
                          <button
                            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                            type="button"
                            onClick={() => {
                              const next = draft.effects.filter((_, idx) => idx !== index);
                              setDraft({ ...draft, effects: next.length ? next : [{}] });
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                  type="button"
                  onClick={() => setDraft({ ...draft, effects: [...draft.effects, {}] })}
                >
                  + Add Effect
                </button>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2 border-t border-slate-800 pt-4">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200"
                type="button"
                onClick={() => {
                  setDraft(null);
                  setActiveAugment(null);
                }}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950"
                type="button"
                onClick={() => {
                  if (!draft.name.trim()) return;
                  const exists = augments.some((augment) => augment.id === draft.id);
                  if (exists) {
                    updateAugment(draft.id, draft);
                  } else {
                  planDispatch({ type: 'setAugments', augments: [...augments, draft] });
                  }
                  setDraft(null);
                  setActiveAugment(null);
                }}
              >
                {activeAugment ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
