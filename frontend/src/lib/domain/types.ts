// TMM domain model (ADR-2, D4): the financial facts, independent of any simulation
// method. The simulation engine consumes this model; nothing here may import from
// the simulation package. v1 scope deliberately excludes dividends, splits, tax
// lots, capital gains, rebalancing, and withdrawal strategies — but the shapes
// below must admit them without redesign (hence Position.acquisitions).

export type DomainFrequency = 'weekly' | 'biweekly' | 'monthly' | 'yearly';

/** A balance-bearing account (cash, savings, APY/manual assets). */
export type DomainAccount = {
  id: string;
  name: string;
  kind: 'cash' | 'asset';
  /** Current balance in dollars (plan documents store dollars; the engine converts to bigint cents). */
  balance: number;
  /** Annual growth rate in percent (APY). 0 for non-interest-bearing accounts. */
  annualRatePct: number;
};

/** One share purchase. Admits future cost-basis/tax-lot features without redesign. */
export type AcquisitionEvent = {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  quantity: number;
  pricePerShare: number;
};

/**
 * A market holding: quantity × price(t), where price(t) is a deterministic path
 * derived from `assumedAnnualReturnPct` (spec: PositionSemantics.md). Explicitly
 * not a market prediction.
 */
export type Position = {
  id: string;
  name: string;
  instrument: {
    symbol: string;
    name?: string;
  };
  quantity: number;
  /** Last observed price per share in dollars (the price path's starting point). */
  lastObservedPrice: number;
  /** Assumed annual return in percent; drives the simulated price path. */
  assumedAnnualReturnPct: number;
  /** Recorded purchases (v1: informational; opening quantity is authoritative). */
  acquisitions: AcquisitionEvent[];
  /** True when the migration derived quantity from value ÷ price and the user should confirm. */
  needsReview?: boolean;
};

/** Recurring or one-time cash movement (income and expenses). */
export type CashFlow = {
  id: string;
  name: string;
  direction: 'in' | 'out';
  amount: number;
  frequency: DomainFrequency;
  /** ISO start date; flows before this date do not fire. */
  start: string;
  /** Annual growth in percent (raise for income, inflation for expenses). */
  annualGrowthPct: number;
  /** Target account/position id for contributions; undefined = the cash account. */
  targetId?: string;
};

export type DebtAccount = {
  id: string;
  name: string;
  balance: number;
  aprPct: number;
  payment: number;
  paymentFrequency: DomainFrequency;
  start: string;
  extraPayment?: number;
  extraPaymentFrequency?: DomainFrequency;
};

/** Observed ground truth (D3): the baseline projections seed from. */
export type DomainCheckpoint = {
  id: string;
  date: string;
  netWorth: number;
};

export type DomainAssumptions = {
  inflationPct: number;
  /** ISO plan start date (superseded by the latest checkpoint date when present). */
  startDate: string;
};

/**
 * The engine's input contract (ADR-2): (domain model, assumptions, seed, horizon)
 * → percentile series + events.
 */
export type DomainModel = {
  accounts: DomainAccount[];
  positions: Position[];
  cashFlows: CashFlow[];
  debts: DebtAccount[];
  assumptions: DomainAssumptions;
};
