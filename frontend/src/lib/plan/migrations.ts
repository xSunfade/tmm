import { DEFAULT_PLAN_STATE } from './defaults';
import type { PlanState } from './types';
import { ensureEntityUuids } from './normalize';
import { ensureForecastSeed } from '../simulation/forecastSeed';

type PartialPlan = Partial<PlanState> & { schemaVersion?: string };

function ensureAltShape(plan: PartialPlan) {
  if (!plan.alternatives || typeof plan.alternatives !== 'object') {
    plan.alternatives = { Baseline: { income: [], expense: [], asset: [], debt: [] } };
  }
  Object.entries(plan.alternatives).forEach(([name, alt]) => {
    if (!alt) return;
    alt.income = Array.isArray(alt.income) ? alt.income : [];
    alt.expense = Array.isArray(alt.expense) ? alt.expense : [];
    alt.asset = Array.isArray(alt.asset) ? alt.asset : [];
    alt.debt = Array.isArray(alt.debt) ? alt.debt : [];
    if (typeof plan.altChartEnabled !== 'object' || !plan.altChartEnabled) {
      plan.altChartEnabled = {};
    }
    if (!(name in plan.altChartEnabled)) {
      plan.altChartEnabled[name] = name === 'Baseline';
    }
  });
}

export function migratePlan(raw: unknown): PlanState {
  const next: PartialPlan = typeof raw === 'object' && raw ? { ...(raw as PartialPlan) } : {};
  next.schemaVersion = next.schemaVersion || '1.0';

  if (!next.assumptions) {
    next.assumptions = { ...DEFAULT_PLAN_STATE.assumptions };
  } else {
    next.assumptions = {
      inflation:
        typeof next.assumptions.inflation === 'number'
          ? next.assumptions.inflation
          : DEFAULT_PLAN_STATE.assumptions.inflation,
      start: next.assumptions.start || DEFAULT_PLAN_STATE.assumptions.start,
      finnhubKey: next.assumptions.finnhubKey || ''
    };
  }

  if (!next.altChartEnabled || typeof next.altChartEnabled !== 'object') {
    next.altChartEnabled = { Baseline: true };
  }
  if (!next.altColors || typeof next.altColors !== 'object') {
    next.altColors = {};
  }
  if (!next.checkpoints || typeof next.checkpoints !== 'object') {
    next.checkpoints = {};
  }
  if (!next.checkpointSettings) {
    next.checkpointSettings = { ...DEFAULT_PLAN_STATE.checkpointSettings };
  }
  if (!next.ignoredDriftWarnings || typeof next.ignoredDriftWarnings !== 'object') {
    next.ignoredDriftWarnings = {};
  }
  if (!Array.isArray(next.augments)) {
    next.augments = [];
  }
  if (!next.goals || typeof next.goals !== 'object') {
    next.goals = {};
  }
  if (!next.pipeline) {
    next.pipeline = { byAlt: {} };
  } else if (!next.pipeline.byAlt) {
    next.pipeline.byAlt = {};
  }
  if (!next.plaidConfig) {
    next.plaidConfig = { ...DEFAULT_PLAN_STATE.plaidConfig };
  }
  if (next.lastSaved === undefined) {
    next.lastSaved = null;
  }
  if (next.isSampleData === undefined) {
    next.isSampleData = false;
  }
  if (typeof next.forecastSeed !== 'string') {
    next.forecastSeed = DEFAULT_PLAN_STATE.forecastSeed;
  }
  if (typeof next.forecastFingerprint !== 'string') {
    next.forecastFingerprint = '';
  }

  ensureAltShape(next);
  ensureEntityUuids(next as PlanState);
  Object.keys(next.alternatives || {}).forEach((altName) => {
    if (!next.pipeline?.byAlt[altName]) {
      next.pipeline!.byAlt[altName] = { edges: [], layout: {} };
    }
  });

  const alts = next.alternatives ?? {};
  if (!next.activeAlt || !alts[next.activeAlt]) {
    next.activeAlt = Object.keys(alts)[0] || 'Baseline';
  }

  return ensureForecastSeed({
    ...DEFAULT_PLAN_STATE,
    ...next,
    schemaVersion: '2.0'
  } as PlanState);
}

