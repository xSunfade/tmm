import React from 'react';
import { usePlanStore } from '../../lib/plan/planStore';
import { getEffectiveValue } from '../../lib/plan/overrideManager';
import { type SimulationResult, type SimulationSeries } from '../../lib/simulation/ledger';
import { fetchMergedHistoricalSeries } from '../../lib/simulation/historyApi';
import { NetWorthChart } from '../../components/charts/NetWorthChart';
import { AssetPieChart } from '../../components/charts/AssetPieChart';
import { CashflowChart } from '../../components/charts/CashflowChart';
import { shouldShowCheckIn, setLastCheckInDate } from '../checkin/checkinLogic';
import { WeeklyCheckInModal } from '../checkin/WeeklyCheckInModal';
import { createCheckpoint } from '../../lib/simulation/checkpoints';
import { loadSimulationSettings, saveSimulationSettings } from '../../lib/simulation/simulationSettings';
import { useAppState } from '../../state/appState';
import { authFetch } from '../../lib/api/authFetch';
import { withResampledForecastSeed } from '../../lib/simulation/forecastSeed';
import { runSimulationInWorker } from '../../lib/simulation/simulationWorkerHost';
import {
  buildSimulationCacheKey,
  getCachedSimulation,
  setCachedSimulation
} from '../../lib/simulation/simulationCache';

const DEFAULT_RUNS = 20;
const IDLE_RUNS = 80;
const REFINE_DEBOUNCE_MS = 2500;
const EMPTY_SIMULATION: SimulationResult = {
  series: [],
  percentileSeries: undefined,
  historicalSeries: [],
  audit: [],
  logs: [],
  drift: null
};

export function DashboardScreen() {
  const { state: planState, dispatch } = usePlanStore();
  const appState = useAppState();
  const [summary, setSummary] = React.useState(() => loadSimulationSettings());
  const [monteCarloRuns, setMonteCarloRuns] = React.useState(DEFAULT_RUNS);
  const [checkInDue, setCheckInDue] = React.useState(() => shouldShowCheckIn());
  const [showCheckInModal, setShowCheckInModal] = React.useState(false);
  const [eventsExpanded, setEventsExpanded] = React.useState(false);
  const [showReconciliationModal, setShowReconciliationModal] = React.useState(false);
  const [simulation, setSimulation] = React.useState<SimulationResult>(EMPTY_SIMULATION);
  const [simulationLoading, setSimulationLoading] = React.useState(false);
  const [simulationError, setSimulationError] = React.useState<string | null>(null);
  const [simulationAttempt, setSimulationAttempt] = React.useState(0);
  const latestPlanRef = React.useRef(planState);
  const altChartEnabledKey = React.useMemo(
    () =>
      Object.entries(planState.altChartEnabled || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, enabled]) => `${name}:${enabled ? '1' : '0'}`)
        .join('|'),
    [planState.altChartEnabled]
  );

  React.useEffect(() => {
    latestPlanRef.current = planState;
  }, [planState]);
  const formatCurrency = React.useCallback(
    (value: number) =>
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value),
    []
  );

  const [remoteHistoricalSeries, setRemoteHistoricalSeries] = React.useState<SimulationSeries[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    const plan = latestPlanRef.current;
    const cacheKey = buildSimulationCacheKey([
      plan.forecastFingerprint,
      plan.forecastSeed,
      plan.activeAlt,
      altChartEnabledKey,
      summary.runYears,
      summary.granularity,
      summary.forecastView,
      monteCarloRuns
    ]);

    // Reuse a previously computed result for the exact same inputs. This makes
    // navigating away and back instant instead of recalculating from scratch.
    const cached = getCachedSimulation(cacheKey);
    if (cached) {
      setSimulation(cached);
      setSimulationError(null);
      setSimulationLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setSimulationLoading(true);
    setSimulationError(null);
    runSimulationInWorker(plan, summary.runYears, summary.granularity, {
      seed: plan.forecastSeed,
      monteCarloRuns,
      returnPercentiles: summary.forecastView === 'range'
    })
      .then((nextSimulation) => {
        if (cancelled) return;
        setCachedSimulation(cacheKey, nextSimulation);
        setSimulation(nextSimulation);
      })
      .catch((error) => {
        if (cancelled) return;
        setSimulationError(error instanceof Error ? error.message : 'Simulation failed');
      })
      .finally(() => {
        if (cancelled) return;
        setSimulationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    planState.forecastFingerprint,
    planState.forecastSeed,
    planState.activeAlt,
    altChartEnabledKey,
    summary.runYears,
    summary.granularity,
    summary.forecastView,
    monteCarloRuns,
    simulationAttempt
  ]);

  React.useEffect(() => {
    saveSimulationSettings(summary);
  }, [summary]);

  React.useEffect(() => {
    setMonteCarloRuns(DEFAULT_RUNS);
    let cancelled = false;
    let timeoutId: number | null = null;
    const refine = () => {
      timeoutId = globalThis.setTimeout(() => {
        if (!cancelled) setMonteCarloRuns(IDLE_RUNS);
      }, REFINE_DEBOUNCE_MS);
    };
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const idleHandle = (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(refine);
      return () => {
        cancelled = true;
        if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
          (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleHandle);
        }
      };
    }
    timeoutId = globalThis.setTimeout(refine, 900);
    return () => {
      cancelled = true;
      if (timeoutId != null) globalThis.clearTimeout(timeoutId);
    };
  }, [planState.forecastSeed, planState.forecastFingerprint, summary.granularity, summary.runYears, summary.forecastView]);

  React.useEffect(() => {
    const openCheckIn = () => setShowCheckInModal(true);
    window.addEventListener('tmm:weekly-checkin', openCheckIn);
    return () => window.removeEventListener('tmm:weekly-checkin', openCheckIn);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const isPlus = appState.auth.planTier === 'tmm_plus';
    if (!isPlus) {
      setRemoteHistoricalSeries([]);
      return () => {
        cancelled = true;
      };
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCFullYear(now.getUTCFullYear() - Math.max(1, summary.runYears));
    fetchMergedHistoricalSeries({
      plaidBaseUrl: planState.plaidConfig?.backendApiUrl || '',
      altNames: Object.keys(planState.alternatives || {}),
      checkpointsByAlt: planState.checkpoints || {},
      startDate,
      endDate: now
    })
      .then((result) => {
        if (cancelled) return;
        setRemoteHistoricalSeries(result.series || []);
      })
      .catch(() => {
        if (cancelled) return;
        setRemoteHistoricalSeries([]);
      });

    return () => {
      cancelled = true;
    };
  }, [
    appState.auth.planTier,
    appState.plaid.syncLastCompletedAt,
    planState.alternatives,
    planState.checkpoints,
    planState.plaidConfig?.backendApiUrl,
    summary.runYears
  ]);

  const activeAlt = planState.alternatives[planState.activeAlt] || {
    income: [],
    expense: [],
    asset: [],
    debt: []
  };
  const netWorth =
    (activeAlt?.asset || []).reduce((sum, a) => sum + getEffectiveValue(a), 0) -
    (activeAlt?.debt || []).reduce((sum, d) => sum + getEffectiveValue(d), 0);

  const cashFlow =
    simulation.series.length > 0 && simulation.series[0].points.length > 1
      ? simulation.series[0].points[simulation.series[0].points.length - 1].value -
        simulation.series[0].points[simulation.series[0].points.length - 2].value
      : 0;

  const altNames = Object.keys(planState.alternatives || {});
  const augmentToggles = planState.augments || [];
  const endRange = React.useMemo(() => {
    if (!simulation.series.length) return null;
    const endDate = simulation.series.reduce((latest, s) => {
      const last = s.points[s.points.length - 1]?.date;
      if (!last) return latest;
      if (!latest || last.getTime() > latest.getTime()) return last;
      return latest;
    }, null as Date | null);
    const values = simulation.series
      .filter((s) => planState.altChartEnabled[s.alt] !== false)
      .map((s) => ({
        alt: s.alt,
        value: s.points[s.points.length - 1]?.value ?? 0
      }));
    return { endDate, values };
  }, [planState.altChartEnabled, simulation.series]);

  const palette = ['#8b5cf6', '#22c55e', '#06b6d4', '#f59e0b', '#ef4444'];
  const effectiveHistoricalSeries = React.useMemo(
    () =>
      appState.auth.planTier === 'tmm_plus' && remoteHistoricalSeries.length > 0
        ? remoteHistoricalSeries
        : simulation.historicalSeries,
    [appState.auth.planTier, remoteHistoricalSeries, simulation.historicalSeries]
  );

  const projectedEndValue = React.useMemo(() => {
    if (!endRange) return null;
    const active = endRange.values.find((entry) => entry.alt === planState.activeAlt);
    return active?.value ?? endRange.values[0]?.value ?? null;
  }, [endRange, planState.activeAlt]);

  const projectedDelta =
    projectedEndValue != null ? projectedEndValue - netWorth : null;
  const projectedDeltaPct =
    projectedDelta != null && netWorth !== 0 ? (projectedDelta / Math.abs(netWorth)) * 100 : null;

  const forecastHorizonLabel = `${summary.runYears} yr · ${summary.granularity === 'monthly' ? 'Monthly' : 'Daily'}`;

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-4 text-slate-200 sm:px-6">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <section className="dashboard-hero relative overflow-hidden rounded-2xl">
          <div className="dashboard-hero__backdrop" aria-hidden />
          <div className="relative z-10 flex flex-col gap-3 p-3.5 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/85">
                  Live simulation
                </p>
                <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-white sm:text-xl">Dashboard</h1>
                <p className="mt-0.5 text-[11px] text-slate-300/80">
                  Your money, simulated ·{' '}
                  <span className="font-medium text-emerald-200">{planState.activeAlt}</span>
                </p>
              </div>
              <div className="dashboard-hero__controls flex flex-wrap items-center gap-1.5" data-tour="run-range-controls">
                <select
                  className="dashboard-hero__select"
                  value={summary.runYears}
                  aria-label="Forecast run years"
                  onChange={(event) =>
                    setSummary((prev) => ({
                      ...prev,
                      runYears: Number(event.target.value) || 0
                    }))
                  }
                >
                  <option value={5}>5 years</option>
                  <option value={10}>10 years</option>
                  <option value={20}>20 years</option>
                  <option value={30}>30 years</option>
                </select>
                <select
                  className="dashboard-hero__select"
                  value={summary.granularity}
                  aria-label="Forecast granularity"
                  onChange={(event) =>
                    setSummary((prev) => ({
                      ...prev,
                      granularity: event.target.value as 'monthly' | 'daily'
                    }))
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="daily">Daily</option>
                </select>
                <select
                  className="dashboard-hero__select dashboard-hero__select--wide"
                  value={summary.forecastView || 'likely'}
                  aria-label="Forecast view"
                  onChange={(event) =>
                    setSummary((prev) => ({
                      ...prev,
                      forecastView: event.target.value as 'likely' | 'range'
                    }))
                  }
                >
                  <option value="likely">Most Likely (P50)</option>
                  <option value="range">Range (P10 - P90)</option>
                </select>
                <button
                  type="button"
                  className="dashboard-hero__action"
                  onClick={() => dispatch({ type: 'hydrate', plan: withResampledForecastSeed(planState) })}
                >
                  Resample
                </button>
              </div>
            </div>

            <div className="dashboard-hero__metrics grid gap-2.5 sm:grid-cols-3">
              <div className="dashboard-hero__metric dashboard-hero__metric--primary" data-tour="net-worth-metric">
                <div className="dashboard-hero__metric-label">
                  <span>Net Worth</span>
                  <span className="dashboard-hero__chip">Baseline</span>
                </div>
                <div className="dashboard-hero__value dashboard-hero__value--hero" data-testid="dashboard-net-worth-value">
                  {formatCurrency(netWorth)}
                </div>
              </div>

              <div className="dashboard-hero__metric" data-tour="cash-flow-metric">
                <div className="dashboard-hero__metric-label">
                  <span>{summary.granularity === 'monthly' ? 'Monthly' : 'Daily'} Cash Flow</span>
                </div>
                <div
                  className={`dashboard-hero__value ${
                    cashFlow >= 0 ? 'dashboard-hero__value--positive' : 'dashboard-hero__value--negative'
                  }`}
                  data-testid="dashboard-cashflow-value"
                >
                  {formatCurrency(cashFlow)}
                </div>
              </div>

              <div className="dashboard-hero__metric dashboard-hero__metric--projection">
                <div className="dashboard-hero__metric-label">
                  <span>Projected End</span>
                  <span className="dashboard-hero__chip dashboard-hero__chip--live">
                    {simulationLoading ? 'Updating' : `${monteCarloRuns} runs`}
                  </span>
                </div>
                <div className="dashboard-hero__value dashboard-hero__value--projection">
                  {projectedEndValue != null ? formatCurrency(projectedEndValue) : '—'}
                </div>
                <div className="dashboard-hero__projection-meta">
                  {endRange?.endDate ? (
                    <span className="dashboard-hero__hint">{endRange.endDate.getFullYear()}</span>
                  ) : null}
                  {projectedDelta != null && projectedDeltaPct != null ? (
                    <span
                      className={`dashboard-hero__delta ${
                        projectedDelta >= 0 ? 'dashboard-hero__delta--up' : 'dashboard-hero__delta--down'
                      }`}
                    >
                      {projectedDelta >= 0 ? '+' : ''}
                      {formatCurrency(projectedDelta)} ({projectedDelta >= 0 ? '+' : ''}
                      {projectedDeltaPct.toFixed(1)}%)
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="dashboard-hero__layers" data-tour="alt-toggles">
              <div className="dashboard-hero__layer-row">
                <span className="dashboard-hero__layer-label">Alts</span>
                <div className="dashboard-hero__pills">
                  {altNames.map((name) => {
                    const enabled = Boolean(planState.altChartEnabled[name]);
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={enabled}
                        className={`dashboard-hero__pill ${enabled ? 'dashboard-hero__pill--on' : ''}`}
                        onClick={() =>
                          dispatch({ type: 'setAltChartEnabled', altName: name, enabled: !enabled })
                        }
                      >
                        <span
                          className="dashboard-hero__pill-dot"
                          style={{ background: planState.altColors[name] || '#22c55e' }}
                        />
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="dashboard-hero__layer-row">
                <span className="dashboard-hero__layer-label">Augments</span>
                <div className="dashboard-hero__pills">
                  {augmentToggles.length ? (
                    augmentToggles.map((augment) => (
                      <button
                        key={augment.id}
                        type="button"
                        aria-pressed={augment.enabled}
                        className={`dashboard-hero__pill ${augment.enabled ? 'dashboard-hero__pill--on' : ''}`}
                        onClick={() =>
                          dispatch({
                            type: 'setAugments',
                            augments: augmentToggles.map((a) =>
                              a.id === augment.id ? { ...a, enabled: !a.enabled } : a
                            )
                          })
                        }
                      >
                        {augment.name}
                      </button>
                    ))
                  ) : (
                    <span className="dashboard-hero__layer-empty">None</span>
                  )}
                </div>
              </div>
            </div>

            <div className="dashboard-hero__footer flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400/90">
              <span>{forecastHorizonLabel}</span>
              <span>{summary.forecastView === 'range' ? 'P10–P90 range' : 'P50 likely'}</span>
            </div>
          </div>
        </section>

        {checkInDue ? (
          <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            Weekly check-in is due. Update your latest balances to keep projections accurate.
            <button
              className="ml-3 rounded-lg border border-emerald-500/70 bg-emerald-600/20 px-3 py-1 text-xs font-semibold text-emerald-100"
              type="button"
              onClick={() => setShowCheckInModal(true)}
            >
              Start check-in
            </button>
          </section>
        ) : null}

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4" data-tour="net-worth-chart">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Net Worth Projection</h2>
              <div className="text-[11px] text-slate-500">
                {summary.forecastView === 'range'
                  ? `P10–P90 · ${simulation.monteCarloRuns || monteCarloRuns} outcomes`
                  : 'P50 most likely'}
                {simulationLoading ? <span className="ml-2 text-emerald-300">Updating…</span> : null}
              </div>
            </div>
            <div className="text-right text-[10px] uppercase tracking-wide text-slate-500">
              End of Run
              <div className="mt-0.5 text-[11px] font-normal normal-case text-slate-400">
                {endRange?.endDate ? endRange.endDate.toLocaleDateString() : '—'}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {simulation.series.map((series, idx) => {
              const color = planState.altColors[series.alt] || palette[idx % palette.length];
              const value = endRange?.values.find((entry) => entry.alt === series.alt)?.value ?? 0;
              return (
                <span
                  key={series.alt}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-950/60 px-3 py-1.5 shadow-[0_0_12px_rgba(15,23,42,0.35)]"
                >
                  <span className="inline-flex h-3 w-3 rounded-full" style={{ background: color }} />
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">{series.alt}</span>
                  <span className="text-base font-semibold text-slate-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.25)]">
                    {formatCurrency(value)}
                  </span>
                </span>
              );
            })}
          </div>
          {simulationError ? (
            <div
              className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200"
              role="alert"
              data-testid="simulation-error"
            >
              <div className="font-semibold">Projection could not be updated</div>
              <div className="mt-1 text-xs text-rose-200/80">
                The simulation failed to run ({simulationError}). The chart below may be stale or empty.
              </div>
              <button
                type="button"
                className="mt-3 rounded-lg border border-rose-300/50 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/20"
                onClick={() => setSimulationAttempt((attempt) => attempt + 1)}
              >
                Retry simulation
              </button>
            </div>
          ) : null}
          <div className="mt-3">
            <NetWorthChart
              series={simulation.series}
              percentileSeries={simulation.percentileSeries}
              historicalSeries={effectiveHistoricalSeries}
              height={300}
              augments={planState.augments}
              altChartEnabled={planState.altChartEnabled}
              altColors={planState.altColors}
              granularity={summary.granularity}
              isUpdating={simulationLoading}
            />
          </div>
          <div className="sr-only" data-testid="networth-tooltip">
            <span data-testid="networth-tooltip-date">
              {endRange?.endDate ? endRange.endDate.toISOString().slice(0, 10) : ''}
            </span>
            {(endRange?.values || []).map((row) => (
              <div key={row.alt} data-testid={`networth-tooltip-row-${row.alt}`}>
                <span>{row.alt}</span>
                <span>{row.value.toFixed(2)}</span>
                <span data-testid={`networth-tooltip-row-source-${row.alt}`}>ledger</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            Zoom by pinch or mouse wheel over the chart. Pan by dragging timeline slider window.
          </div>
        </section>

        {simulation.drift ? (
          <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200" data-testid="drift-badge">
            Drift detected for {simulation.drift.alt}. Variance {(simulation.drift.variance * 100).toFixed(1)}% since{' '}
            {simulation.drift.checkpointDate}.
            <button
              type="button"
              className="ml-3 rounded border border-amber-300/50 px-2 py-1 text-xs"
              onClick={() => setShowReconciliationModal(true)}
            >
              Review reconciliation
            </button>
          </section>
        ) : null}

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-6" data-tour="cashflow-chart">
          <div className="grid gap-6 md:grid-cols-[260px_1fr]">
            <div className="space-y-4">
              <div className="text-sm font-semibold text-slate-200">Asset Allocation</div>
              <AssetPieChart assets={activeAlt?.asset || []} />
            </div>
            <div className="space-y-4">
              <div className="text-sm font-semibold text-slate-200">Cashflow Breakdown</div>
              <CashflowChart alt={activeAlt} />
              <div className="text-center text-sm font-semibold text-slate-200">
                ${cashFlow.toLocaleString()}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-6">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-base font-semibold text-slate-200 transition-colors hover:bg-slate-800/60 hover:text-slate-100"
            onClick={() => setEventsExpanded((e) => !e)}
          >
            Events & Warnings
            <span className="flex items-center gap-2 text-sm font-normal text-slate-400">
              {eventsExpanded ? 'Collapse' : 'Expand'}
              <svg
                className={`h-4 w-4 text-slate-400 transition-transform ${eventsExpanded ? '' : '-rotate-90'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </button>
          <ul className="mt-3 list-disc space-y-2 pl-4 text-xs text-slate-300">
            {[...simulation.logs].reverse().slice(0, eventsExpanded ? undefined : 5).map((entry, idx) => (
              <li key={`${entry}-${idx}`}>{entry}</li>
            ))}
            {simulation.logs.length === 0 ? (
              <li className="text-slate-500">No events logged yet.</li>
            ) : null}
          </ul>
        </section>

        {showCheckInModal ? (
          <WeeklyCheckInModal
            altName={planState.activeAlt}
            alt={activeAlt}
            planTier={appState.auth.planTier}
            onApply={(nextAlt) => {
              const nextPlan = JSON.parse(JSON.stringify(planState));
              nextPlan.alternatives[planState.activeAlt] = nextAlt;
              createCheckpoint(nextPlan, planState.activeAlt, 'weekly-checkin', {
                provenance: 'manual-update',
                source: 'weekly-checkin'
              });
              dispatch({ type: 'hydrate', plan: nextPlan });
              setLastCheckInDate();
              setCheckInDue(false);
              setShowCheckInModal(false);
            }}
            onClose={() => setShowCheckInModal(false)}
          />
        ) : null}
        {simulation.drift && showReconciliationModal ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4" data-testid="reconciliation-modal">
              <div className="text-sm font-semibold text-slate-100" data-testid="reconciliation-classification">
                modified_tx
              </div>
              <div className="mt-2 text-xs text-slate-300" data-testid="reconciliation-delta">
                Delta: {(simulation.drift.variance * 100).toFixed(2)}%
              </div>
              <ul className="mt-2 text-xs text-slate-400" data-testid="reconciliation-evidence-list">
                <li>checkpointDate: {simulation.drift.checkpointDate}</li>
                <li>alt: {simulation.drift.alt}</li>
              </ul>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  data-testid="reconciliation-action-accept-plaid"
                  className="rounded border border-emerald-500/50 px-2 py-1 text-xs text-emerald-200"
                  onClick={async () => {
                    const base = (planState.plaidConfig?.backendApiUrl || '').replace(/\/$/, '');
                    if (base) {
                      await authFetch(`${base}/api/history/reconciliation`, {
                        method: 'POST',
                        body: JSON.stringify({
                          point_date: simulation.drift?.checkpointDate,
                          chosen_source: 'plaid',
                          checkpoint_value: 0,
                          plaid_value: 0,
                          reason: 'validation_reconcile'
                        })
                      });
                    }
                    setShowReconciliationModal(false);
                  }}
                >
                  Accept Plaid
                </button>
                <button
                  type="button"
                  data-testid="reconciliation-action-keep-ledger"
                  className="rounded border border-cyan-500/50 px-2 py-1 text-xs text-cyan-200"
                  onClick={async () => {
                    const base = (planState.plaidConfig?.backendApiUrl || '').replace(/\/$/, '');
                    if (base) {
                      await authFetch(`${base}/api/history/reconciliation`, {
                        method: 'POST',
                        body: JSON.stringify({
                          point_date: simulation.drift?.checkpointDate,
                          chosen_source: 'checkpoint',
                          checkpoint_value: 0,
                          plaid_value: 0,
                          reason: 'validation_keep_ledger'
                        })
                      });
                    }
                    setShowReconciliationModal(false);
                  }}
                >
                  Keep Ledger
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
