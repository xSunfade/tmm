import type { PlanState } from './types';
import { generateForecastSeed } from '../simulation/forecastSeed';

export const DEFAULT_START_DATE = new Date().toISOString().slice(0, 10);

export const DEFAULT_PLAN_STATE: PlanState = {
  schemaVersion: '2.0',
  alternatives: {
    Baseline: { income: [], expense: [], asset: [], debt: [] }
  },
  activeAlt: 'Baseline',
  altChartEnabled: { Baseline: true },
  altColors: {},
  assumptions: { inflation: 2.5, start: DEFAULT_START_DATE, finnhubKey: '' },
  forecastSeed: generateForecastSeed(),
  forecastFingerprint: '',
  lastRun: null,
  lastSaved: null,
  checkpoints: {},
  checkpointSettings: {
    autoCreateMonthly: true,
    lastCheckpointDate: null,
    driftThreshold: 0.15
  },
  ignoredDriftWarnings: {},
  augments: [],
  goals: {},
  pipeline: { byAlt: {} },
  plaidConfig: {
    clientId: '',
    environment: 'production',
    backendApiUrl: 'http://localhost:3000',
    enabled: false
  },
  isSampleData: false
};

