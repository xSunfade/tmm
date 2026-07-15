export type Frequency = 'monthly' | 'biweekly' | 'weekly' | 'yearly';

export type IncomeRow = {
  uuid: string;
  name: string;
  amount: number;
  freq: Frequency;
  start: string;
  raise?: number;
  dataSource?: 'manual' | 'connected';
  connectedAccountId?: string;
  autoValue?: number | null;
  manualValue?: number | null;
  overrideActive?: boolean;
  lastSyncedAt?: string | null;
  lastOverriddenAt?: string | null;
};

export type ExpenseRow = {
  uuid: string;
  name: string;
  amount: number;
  freq: Frequency;
  start: string;
  infl?: number;
  source?: string;
  dataSource?: 'manual' | 'connected';
  connectedAccountId?: string;
  autoValue?: number | null;
  manualValue?: number | null;
  overrideActive?: boolean;
  lastSyncedAt?: string | null;
  lastOverriddenAt?: string | null;
};

/** One recorded share purchase (schema v3, D4). Admits future cost-basis features. */
export type PositionAcquisition = {
  date: string;
  quantity: number;
  pricePerShare: number;
};

export type AssetRow = {
  uuid: string;
  mode: 'Manual' | 'APY' | 'Ticker';
  name: string;
  group?: string;
  value?: number;
  /** APY-mode: annual yield. Ticker-mode: assumed annual return of the simulated price path (D4). */
  apy?: number;
  quantity?: number;
  liveprice?: number;
  /** Schema v3 (D4): recorded purchases for Ticker positions. */
  acquisitions?: PositionAcquisition[];
  /** True when the v2→v3 migration derived quantity from value ÷ price; user should confirm. */
  positionNeedsReview?: boolean;
  totalContrib?: number;
  recurAmt?: number;
  recurFreq?: Frequency;
  ticker?: string;
  source?: string;
  dataSource?: 'manual' | 'connected';
  connectedAccountId?: string;
  autoValue?: number | null;
  manualValue?: number | null;
  overrideActive?: boolean;
  lastSyncedAt?: string | null;
  lastOverriddenAt?: string | null;
};

export type DebtRow = {
  uuid: string;
  name: string;
  bal: number;
  apr: number;
  pmt: number;
  freq: Frequency;
  start: string;
  source?: string;
  extraPmt?: number;
  extraFreq?: Frequency;
  dataSource?: 'manual' | 'connected';
  connectedAccountId?: string;
  autoValue?: number | null;
  manualValue?: number | null;
  overrideActive?: boolean;
  lastSyncedAt?: string | null;
  lastOverriddenAt?: string | null;
};

export type Alternative = {
  income: IncomeRow[];
  expense: ExpenseRow[];
  asset: AssetRow[];
  debt: DebtRow[];
};

export type Checkpoint = {
  checkpointId: string;
  alt: string;
  date: string;
  type: 'monthly' | 'event' | 'correction' | 'verified' | 'migration' | 'weekly-checkin' | 'manual';
  netWorth: number;
  assets: AssetRow[];
  debts: DebtRow[];
  income: IncomeRow[];
  expenses: ExpenseRow[];
  provenance: string;
  source: string;
  confidence: string;
  createdAt: string;
  immutable: boolean;
  metadata?: Record<string, unknown>;
};

export type CheckpointSettings = {
  autoCreateMonthly: boolean;
  lastCheckpointDate: string | null;
  driftThreshold: number;
};

export type Augment = {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  activation: {
    type: 'fixed-date' | 'date-range' | 'recurring' | 'conditional';
    startDate: string;
    endDate?: string | null;
    probability: number;
    frequency?: string | null;
  };
  effects: Array<Record<string, unknown>>;
  duration: {
    type: 'instant' | 'temporary' | 'permanent';
    months?: number;
  };
};

export type Goal = {
  id: string;
  name: string;
  type: string;
  targetValue: number;
  targetDate: string;
  relatedAccounts?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export type PipelineEdge = {
  from: string;
  to: string;
  mode: 'fixed' | 'percent';
  amount: number;
  freq?: Frequency;
  recurFreq?: Frequency;
  fromPort?: string;
  toPort?: string;
  note?: string;
};

export type PipelineState = {
  byAlt: Record<
    string,
    {
      edges: PipelineEdge[];
      layout: Record<string, { x: number; y: number }>;
      hasImportedLayout?: boolean;
      zoom?: number;
    }
  >;
};

export type PlanAssumptions = {
  inflation: number;
  start: string;
  /**
   * Device-local user secret (SEC-10). Never leaves the device: stripped from
   * server saves (planSync) and from XLSX/Sheets exports (schema v3).
   */
  finnhubKey: string;
};

export type PlanState = {
  schemaVersion: string;
  alternatives: Record<string, Alternative>;
  activeAlt: string;
  altChartEnabled: Record<string, boolean>;
  altColors: Record<string, string>;
  assumptions: PlanAssumptions;
  forecastSeed: string;
  forecastFingerprint: string;
  lastRun: { series: unknown; historicalSeries?: unknown } | null;
  lastSaved?: string | null;
  checkpoints: Record<string, Checkpoint[]>;
  checkpointSettings: CheckpointSettings;
  ignoredDriftWarnings: Record<string, unknown>;
  augments: Augment[];
  goals: Record<string, Goal[]>;
  pipeline: PipelineState;
  plaidConfig: {
    clientId: string;
    environment: string;
    backendApiUrl: string;
    enabled: boolean;
  };
  isSampleData?: boolean;
};

