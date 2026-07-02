import type { PlanState } from '../plan/types';

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function hashString(input: string): string {
  // FNV-1a 32-bit for compact, stable fingerprinting.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function generateForecastSeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function computeForecastFingerprint(plan: PlanState): string {
  const simulationShape = {
    assumptions: plan.assumptions,
    alternatives: plan.alternatives,
    augments: plan.augments,
    checkpoints: plan.checkpoints,
    checkpointSettings: plan.checkpointSettings,
    // Pipeline edges are routed into the ledger, so they must influence the fingerprint
    // (and therefore the simulation cache key) when they change.
    pipeline: plan.pipeline
  };
  return hashString(stableSerialize(simulationShape));
}

export function ensureForecastSeed(plan: PlanState): PlanState {
  const fingerprint = computeForecastFingerprint(plan);
  const currentSeed = String(plan.forecastSeed || '').trim();
  const currentFingerprint = String(plan.forecastFingerprint || '').trim();
  if (currentSeed && currentFingerprint === fingerprint) {
    return plan;
  }
  return {
    ...plan,
    forecastSeed: generateForecastSeed(),
    forecastFingerprint: fingerprint
  };
}

export function withResampledForecastSeed(plan: PlanState): PlanState {
  return {
    ...plan,
    forecastSeed: generateForecastSeed(),
    forecastFingerprint: computeForecastFingerprint(plan)
  };
}
