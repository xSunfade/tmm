// Plan sanity warnings (Phase 3.8). Display-layer heuristics only — the engine
// never mutates or clamps based on these (see PositionSemantics.md, negative
// cash policy). Monthly normalization here is a UI approximation (FPM); the
// ledger itself is calendar-accurate.

import type { Alternative, PlanState } from './types';
import { FPM } from './frequency';
import { getEffectiveValue } from './overrideManager';

export type PlanSanityWarning = {
  id: string;
  severity: 'warning';
  message: string;
};

function monthlyTotal(rows: Array<{ freq?: string; [key: string]: unknown }>): number {
  return rows.reduce((sum, row) => {
    const amount = getEffectiveValue(row as Parameters<typeof getEffectiveValue>[0]);
    const factor = FPM[(row.freq as keyof typeof FPM) || 'monthly'] || 1;
    return sum + amount * factor;
  }, 0);
}

export function getPlanSanityWarnings(plan: PlanState): PlanSanityWarning[] {
  const alt: Alternative = plan.alternatives[plan.activeAlt] || {
    income: [],
    expense: [],
    asset: [],
    debt: []
  };
  const warnings: PlanSanityWarning[] = [];

  const incomeMonthly = monthlyTotal(alt.income);
  const expenseMonthly = monthlyTotal(alt.expense);
  const contributionsMonthly = alt.asset.reduce((sum, row) => {
    const amount = Number(row.recurAmt) || 0;
    const factor = FPM[row.recurFreq || 'monthly'] || 1;
    return sum + amount * factor;
  }, 0);
  const debtPaymentsMonthly = alt.debt.reduce((sum, row) => {
    const pmt = (Number(row.pmt) || 0) * (FPM[row.freq || 'monthly'] || 1);
    const extra = (Number(row.extraPmt) || 0) * (FPM[row.extraFreq || row.freq || 'monthly'] || 1);
    return sum + pmt + extra;
  }, 0);

  const outflowMonthly = expenseMonthly + contributionsMonthly + debtPaymentsMonthly;
  if (incomeMonthly > 0 && outflowMonthly > incomeMonthly) {
    warnings.push({
      id: 'outflow-exceeds-income',
      severity: 'warning',
      message: `Monthly outflow (~$${Math.round(outflowMonthly).toLocaleString()}) exceeds income (~$${Math.round(incomeMonthly).toLocaleString()}). The projection will show a growing cash shortfall.`
    });
  } else if (incomeMonthly === 0 && outflowMonthly > 0) {
    warnings.push({
      id: 'no-income',
      severity: 'warning',
      message: 'This plan has expenses or payments but no income — the projection will only decline.'
    });
  }

  for (const debt of alt.debt) {
    const balance = getEffectiveValue(debt);
    if (balance <= 0) continue;
    const monthlyPayment =
      (Number(debt.pmt) || 0) * (FPM[debt.freq || 'monthly'] || 1) +
      (Number(debt.extraPmt) || 0) * (FPM[debt.extraFreq || debt.freq || 'monthly'] || 1);
    const monthlyInterest = (balance * ((Number(debt.apr) || 0) / 100)) / 12;
    if (monthlyPayment > 0 && monthlyPayment <= monthlyInterest) {
      warnings.push({
        id: `debt-never-zero:${debt.uuid}`,
        severity: 'warning',
        message: `"${debt.name || 'Debt'}" payment (~$${Math.round(monthlyPayment).toLocaleString()}/mo) doesn't cover its interest (~$${Math.round(monthlyInterest).toLocaleString()}/mo) — this debt will never reach zero.`
      });
    }
  }

  return warnings;
}
