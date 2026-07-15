// Maps plan-document rows (schema v3) onto the domain model (ADR-2). This is the
// single place that decides which AssetRows are positions vs balance accounts
// (spec: PositionSemantics.md). Imports nothing from the simulation package.

import type { Alternative, AssetRow, PlanAssumptions } from '../plan/types';
import { getEffectiveValue } from '../plan/overrideManager';
import type {
  CashFlow,
  DebtAccount,
  DomainAccount,
  DomainAssumptions,
  DomainFrequency,
  DomainModel,
  Position
} from './types';

function toFrequency(value: string | undefined): DomainFrequency {
  if (value === 'weekly' || value === 'biweekly' || value === 'monthly' || value === 'yearly') {
    return value;
  }
  return 'monthly';
}

/**
 * A Ticker row models a position only when both quantity and a starting price are
 * resolvable; otherwise it degrades to balance-based modeling (same as APY mode).
 */
export function isPositionRow(row: AssetRow): boolean {
  if (row.mode !== 'Ticker') return false;
  const price = Number(row.liveprice) || 0;
  const quantity = Number(row.quantity) || 0;
  return price > 0 && quantity > 0;
}

export function positionFromAssetRow(row: AssetRow): Position {
  return {
    id: row.uuid,
    name: row.name,
    instrument: { symbol: row.ticker || '', name: row.name },
    quantity: Number(row.quantity) || 0,
    lastObservedPrice: Number(row.liveprice) || 0,
    assumedAnnualReturnPct: Number(row.apy) || 0,
    acquisitions: Array.isArray(row.acquisitions) ? row.acquisitions : [],
    needsReview: row.positionNeedsReview === true
  };
}

export function buildDomainModel(params: {
  alt: Alternative;
  assumptions: PlanAssumptions;
}): DomainModel {
  const { alt, assumptions } = params;

  const accounts: DomainAccount[] = [];
  const positions: Position[] = [];
  const cashFlows: CashFlow[] = [];
  const debts: DebtAccount[] = [];

  for (const row of alt.income) {
    cashFlows.push({
      id: row.uuid,
      name: row.name,
      direction: 'in',
      amount: getEffectiveValue(row),
      frequency: toFrequency(row.freq),
      start: row.start,
      annualGrowthPct: Number(row.raise) || 0
    });
  }

  for (const row of alt.expense) {
    cashFlows.push({
      id: row.uuid,
      name: row.name,
      direction: 'out',
      amount: getEffectiveValue(row),
      frequency: toFrequency(row.freq),
      start: row.start,
      annualGrowthPct: Number(row.infl) || Number(assumptions.inflation) || 0
    });
  }

  for (const row of alt.asset) {
    if (isPositionRow(row)) {
      positions.push(positionFromAssetRow(row));
    } else {
      accounts.push({
        id: row.uuid,
        name: row.name,
        kind: 'asset',
        balance: getEffectiveValue(row),
        annualRatePct: Number(row.apy) || 0
      });
    }
    const recurAmt = Number(row.recurAmt) || 0;
    if (recurAmt > 0) {
      cashFlows.push({
        id: `contrib:${row.uuid}`,
        name: row.name,
        direction: 'out',
        amount: recurAmt,
        frequency: toFrequency(row.recurFreq),
        start: '',
        annualGrowthPct: 0,
        targetId: row.uuid
      });
    }
  }

  for (const row of alt.debt) {
    debts.push({
      id: row.uuid,
      name: row.name,
      balance: getEffectiveValue(row),
      aprPct: Number(row.apr) || 0,
      payment: Number(row.pmt) || 0,
      paymentFrequency: toFrequency(row.freq),
      start: row.start,
      extraPayment: Number(row.extraPmt) || 0,
      extraPaymentFrequency: toFrequency(row.extraFreq || row.freq)
    });
  }

  const domainAssumptions: DomainAssumptions = {
    inflationPct: Number(assumptions.inflation) || 0,
    startDate: assumptions.start
  };

  return { accounts, positions, cashFlows, debts, assumptions: domainAssumptions };
}
