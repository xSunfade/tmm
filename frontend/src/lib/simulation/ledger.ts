import type { Alternative, Augment, Checkpoint, PipelineState, PlanState } from '../plan/types';
import { getEffectiveValue } from '../plan/overrideManager';
import { applyFlowsToAlternative } from '../pipeline/engine';
import { detectDrift, getCheckpoints, getLastCheckpoint } from './checkpoints';
import { isAugmentActive } from './augments';
import { deriveSeed } from './prng';

export type LedgerFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export type LedgerEvent = {
  id: string;
  dayIndex: number;
  date: string;
  type: 'income' | 'expense' | 'transfer_out' | 'transfer_in' | 'interest' | 'fee' | 'adjustment';
  accountId: string;
  deltaCents: bigint;
  groupId?: string;
};

export type LedgerAccountInput = {
  id: string;
  kind: 'cash' | 'asset' | 'debt';
  name?: string;
  balanceCents: bigint;
  annualRatePpm?: bigint;
  dailyFeeCents?: bigint;
  allowNegative?: boolean;
};

export type RecurringFlow = {
  id: string;
  name?: string;
  /**
   * - income: adds to cash
   * - expense: subtracts from cash
   * - transfer: moves cash into an asset account (cash down, asset up; net-worth neutral)
   * - debt_payment: pays down a debt account (cash down, debt balance down; net-worth neutral),
   *   applied after interest accrual and capped at the outstanding balance
   */
  type: 'income' | 'expense' | 'transfer' | 'debt_payment';
  amountCents: bigint;
  frequency: LedgerFrequency;
  /** Day offset from scenario start when this flow first becomes active. */
  startDayIndex?: number;
  fromAccountId?: string;
  toAccountId?: string;
  /**
   * Annual growth rate in parts-per-million applied with whole-year compounding
   * relative to the flow's start date (e.g. income raise or expense inflation).
   * 30000 ppm = 3% per year.
   */
  annualGrowthPpm?: bigint;
};

/**
 * One-time balance correction applied on day 0, before any flows. Used to seed
 * checkpoint state (D3): the id must be deterministic (`checkpoint_adjust:<alt>:<date>`)
 * so re-applying the same checkpoint never creates additional adjustment events
 * (spec: CheckpointSemantics.md, ghost-adjustment prevention).
 */
export type LedgerInitialAdjustment = {
  id: string;
  accountId: string;
  deltaCents: bigint;
};

export type LedgerScenario = {
  startDate: string;
  days: number;
  accounts: LedgerAccountInput[];
  recurringFlows: RecurringFlow[];
  initialAdjustments?: LedgerInitialAdjustment[];
  augments?: Augment[];
  seed?: string;
};

export type LedgerRunResult = {
  events: LedgerEvent[];
  dailyBalances: Array<Record<string, bigint>>;
  netWorthByDay: Array<{ dayIndex: number; date: string; valueCents: bigint }>;
  monthlyAggregates: Array<{ month: string; netWorthEndCents: bigint; flowNetCents: bigint }>;
  cumulativeRoundingLossCents: bigint;
};

const RATE_DENOM = 1_000_000n * 365n;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

function parseIso(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function bankersRoundRational(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const absNumer = numerator < 0n ? -numerator : numerator;
  const q = absNumer / denominator;
  const r = absNumer % denominator;
  const doubled = r * 2n;
  let rounded = q;
  if (doubled > denominator) {
    rounded = q + 1n;
  } else if (doubled === denominator && (q % 2n !== 0n)) {
    rounded = q + 1n;
  }
  return rounded * sign;
}

function daysInUTCMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

/**
 * True when `currentDate` lands on the target day-of-month, rolling short months
 * forward (e.g. a target of the 31st fires on Feb 28/29, Apr 30, etc.).
 */
function firesOnDayOfMonth(currentDate: Date, targetDayOfMonth: number): boolean {
  const dim = daysInUTCMonth(currentDate.getUTCFullYear(), currentDate.getUTCMonth());
  const effectiveTarget = Math.min(targetDayOfMonth, dim);
  return currentDate.getUTCDate() === effectiveTarget;
}

/**
 * Calendar-accurate scheduling. Weekly/biweekly fire on a fixed weekday cadence from
 * the start date; monthly fires on the start day-of-month each calendar month; yearly
 * fires on the start month + day-of-month each year. Requires daily stepping.
 */
function shouldFire(
  dayIndex: number,
  startDayIndex: number,
  frequency: LedgerFrequency,
  currentDate: Date,
  startDate: Date
): boolean {
  if (dayIndex < startDayIndex) return false;
  if (frequency === 'daily') return true;
  const delta = dayIndex - startDayIndex;
  if (frequency === 'weekly') return delta % 7 === 0;
  if (frequency === 'biweekly') return delta % 14 === 0;
  if (frequency === 'monthly') {
    return firesOnDayOfMonth(currentDate, startDate.getUTCDate());
  }
  if (frequency === 'yearly') {
    return (
      currentDate.getUTCMonth() === startDate.getUTCMonth() &&
      firesOnDayOfMonth(currentDate, startDate.getUTCDate())
    );
  }
  return false;
}

/** Whole years elapsed from `start` to `current`, counted on anniversaries. */
function fullYearsBetween(start: Date, current: Date): number {
  let years = current.getUTCFullYear() - start.getUTCFullYear();
  const beforeAnniversary =
    current.getUTCMonth() < start.getUTCMonth() ||
    (current.getUTCMonth() === start.getUTCMonth() && current.getUTCDate() < start.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return Math.max(0, years);
}

/**
 * Applies whole-year compounding growth (raise/inflation) to a base amount.
 * Growth steps on each anniversary of the flow's start date.
 */
function grownAmountCents(
  baseCents: bigint,
  annualGrowthPpm: bigint | undefined,
  currentDate: Date,
  startDate: Date
): bigint {
  if (!annualGrowthPpm || annualGrowthPpm === 0n) return baseCents;
  const yearsElapsed = fullYearsBetween(startDate, currentDate);
  if (yearsElapsed <= 0) return baseCents;
  const rate = Number(annualGrowthPpm) / 1_000_000;
  const factor = Math.pow(1 + rate, yearsElapsed);
  if (!Number.isFinite(factor)) return baseCents;
  return BigInt(Math.round(Number(baseCents) * factor));
}

type DayAugmentModifiers = {
  extraCashCents: bigint;
  extraIncomeCents: bigint;
  extraExpenseCents: bigint;
  pausedIncomeTargets: Set<string>;
  pausedExpenseTargets: Set<string>;
  pausedDebtTargets: Set<string>;
  incomeScaleByTarget: Map<string, number>;
  expenseScaleByTarget: Map<string, number>;
  assetRateScaleByTarget: Map<string, number>;
};

type IndexedAugment = {
  augment: Augment;
  startDay: number;
  endDay: number;
};

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function buildIndexedAugments(scenario: LedgerScenario): IndexedAugment[] {
  const out: IndexedAugment[] = [];
  const maxDay = Math.max(0, Math.floor(scenario.days));
  for (const augment of scenario.augments || []) {
    if (!augment?.enabled) continue;
    const activationType = String(augment.activation?.type || '').trim();
    if (activationType !== 'fixed-date' && activationType !== 'date-range') continue;
    const startIso = String(augment.activation?.startDate || '').slice(0, 10);
    if (!startIso) continue;
    const startDayRaw = dateDiffDays(scenario.startDate, startIso);
    const startDay = Math.max(0, startDayRaw);
    if (startDay > maxDay) continue;

    let endDay = maxDay;
    const endDateRaw = String(augment.activation?.endDate || '').slice(0, 10);
    if (activationType === 'date-range' && endDateRaw) {
      endDay = Math.min(endDay, Math.max(0, dateDiffDays(scenario.startDate, endDateRaw)));
    }

    const startDate = parseIso(startIso);
    if (augment.duration?.type === 'instant') {
      endDay = Math.min(endDay, startDay);
    } else if (augment.duration?.type === 'temporary') {
      const durationMonths = Math.max(0, Number(augment.duration?.months || 0));
      const durationEnd = addMonths(startDate, durationMonths);
      const durationEndDay = Math.max(0, dateDiffDays(scenario.startDate, toDateString(durationEnd)));
      endDay = Math.min(endDay, durationEndDay);
    }

    if (endDay < startDay) continue;
    out.push({ augment, startDay, endDay });
  }
  return out;
}

function isSameDay(dateA: Date, dateB: Date): boolean {
  return dateA.toISOString().slice(0, 10) === dateB.toISOString().slice(0, 10);
}

function getEffectType(effect: Record<string, unknown>): string {
  return String(effect.type || '').trim();
}

function getEffectTarget(effect: Record<string, unknown>): string | null {
  const target = effect.target;
  if (typeof target !== 'string') return null;
  const next = target.trim();
  return next || null;
}

function getEffectNumber(effect: Record<string, unknown>, key: string, fallback: number): number {
  const raw = effect[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function toDailyCents(monthlyAmountDollars: number): bigint {
  return BigInt(Math.round((monthlyAmountDollars * 100) / 30.4375));
}

function multiplyCents(amount: bigint, scale: number): bigint {
  if (!Number.isFinite(scale)) return amount;
  return BigInt(Math.round(Number(amount) * scale));
}

function buildAugmentModifiers(
  scenario: LedgerScenario,
  currentDate: Date,
  dayIndex: number,
  indexedAugments: IndexedAugment[]
): DayAugmentModifiers {
  const modifiers: DayAugmentModifiers = {
    extraCashCents: 0n,
    extraIncomeCents: 0n,
    extraExpenseCents: 0n,
    pausedIncomeTargets: new Set<string>(),
    pausedExpenseTargets: new Set<string>(),
    pausedDebtTargets: new Set<string>(),
    incomeScaleByTarget: new Map<string, number>(),
    expenseScaleByTarget: new Map<string, number>(),
    assetRateScaleByTarget: new Map<string, number>()
  };
  if (!indexedAugments.length) return modifiers;

  for (const indexed of indexedAugments) {
    if (dayIndex < indexed.startDay || dayIndex > indexed.endDay) continue;
    const augment = indexed.augment;
    if (!isAugmentActive(augment, currentDate, { seed: scenario.seed })) continue;
    const startDate = new Date(augment.activation.startDate);
    for (const rawEffect of augment.effects || []) {
      const effect = rawEffect as Record<string, unknown>;
      const effectType = getEffectType(effect);
      const target = getEffectTarget(effect);
      if (effectType === 'pause-income') {
        modifiers.pausedIncomeTargets.add(target || '*');
      } else if (effectType === 'add-income') {
        modifiers.extraIncomeCents += toDailyCents(getEffectNumber(effect, 'amount', 0));
      } else if (effectType === 'scale-income') {
        modifiers.incomeScaleByTarget.set(target || '*', getEffectNumber(effect, 'scale', 1));
      } else if (effectType === 'pause-expense') {
        modifiers.pausedExpenseTargets.add(target || '*');
      } else if (effectType === 'add-expense') {
        modifiers.extraExpenseCents += toDailyCents(getEffectNumber(effect, 'amount', 0));
      } else if (effectType === 'scale-expense') {
        modifiers.expenseScaleByTarget.set(target || '*', getEffectNumber(effect, 'scale', 1));
      } else if (effectType === 'lump-sum') {
        if (isSameDay(currentDate, startDate)) {
          modifiers.extraCashCents += BigInt(Math.round(getEffectNumber(effect, 'amount', 0) * 100));
        }
      } else if (effectType === 'scale-asset') {
        modifiers.assetRateScaleByTarget.set(target || '*', getEffectNumber(effect, 'scale', 1));
      } else if (effectType === 'pause-debt') {
        modifiers.pausedDebtTargets.add(target || '*');
      }
    }
  }
  return modifiers;
}

function cloneBalances(map: Map<string, bigint>): Record<string, bigint> {
  return Object.fromEntries(Array.from(map.entries()));
}

type LedgerRunOptions = {
  stepDays?: number;
  captureDailyBalances?: boolean;
};

export function runLedgerScenario(scenario: LedgerScenario, options: LedgerRunOptions = {}): LedgerRunResult {
  const balances = new Map<string, bigint>();
  const accountById = new Map<string, LedgerAccountInput>();
  const residualInterestNumerator = new Map<string, bigint>();
  const events: LedgerEvent[] = [];
  const captureDailyBalances = options.captureDailyBalances !== false;
  const stepDays = Math.max(1, Math.floor(options.stepDays || 1));
  const dailyBalances: Array<Record<string, bigint>> = [];
  const netWorthByDay: Array<{ dayIndex: number; date: string; valueCents: bigint }> = [];
  let cumulativeRoundingLossCents = 0n;
  const indexedAugments = buildIndexedAugments(scenario);

  const scenarioStart = parseIso(scenario.startDate);
  const flowStartDates = new Map<string, Date>();
  for (const flow of scenario.recurringFlows) {
    const startDay = flow.startDayIndex ?? 0;
    flowStartDates.set(
      flow.id,
      startDay > 0 ? parseIso(addDaysIso(scenario.startDate, startDay)) : scenarioStart
    );
  }

  for (const account of scenario.accounts) {
    balances.set(account.id, account.balanceCents);
    accountById.set(account.id, account);
    residualInterestNumerator.set(account.id, 0n);
  }

  // Day-0 state seeding (checkpoint adjustments). Applied exactly once per run with
  // caller-provided deterministic ids, before any flows or accrual.
  for (const adjustment of scenario.initialAdjustments || []) {
    if (adjustment.deltaCents === 0n) continue;
    const current = balances.get(adjustment.accountId) ?? 0n;
    balances.set(adjustment.accountId, current + adjustment.deltaCents);
    events.push({
      id: adjustment.id,
      dayIndex: 0,
      date: scenario.startDate,
      type: 'adjustment',
      accountId: adjustment.accountId,
      deltaCents: adjustment.deltaCents
    });
  }

  for (let day = 0; day <= scenario.days; day += stepDays) {
    const date = addDaysIso(scenario.startDate, day);
    const dateObject = parseIso(date);
    const modifiers = buildAugmentModifiers(scenario, dateObject, day, indexedAugments);

    if (modifiers.extraCashCents !== 0n) {
      const current = balances.get('cash') ?? 0n;
      balances.set('cash', current + modifiers.extraCashCents);
      events.push({
        id: `augment:${day}:lump_sum`,
        dayIndex: day,
        date,
        type: 'adjustment',
        accountId: 'cash',
        deltaCents: modifiers.extraCashCents
      });
    }

    // 1) Income, expense, and asset contributions (cash-funded transfers).
    //    Debt payments are deferred until after interest accrual (step 4).
    for (const flow of scenario.recurringFlows) {
      if (flow.type === 'debt_payment') continue;
      const startDay = flow.startDayIndex ?? 0;
      const flowStart = flowStartDates.get(flow.id) ?? scenarioStart;
      if (!shouldFire(day, startDay, flow.frequency, dateObject, flowStart)) continue;
      const grown = grownAmountCents(flow.amountCents, flow.annualGrowthPpm, dateObject, flowStart);
      if (flow.type === 'income') {
        const target = flow.name || flow.id;
        if (modifiers.pausedIncomeTargets.has('*') || modifiers.pausedIncomeTargets.has(target)) {
          continue;
        }
        const scale =
          modifiers.incomeScaleByTarget.get(target) ??
          modifiers.incomeScaleByTarget.get('*') ??
          1;
        const delta = multiplyCents(grown, scale);
        const current = balances.get('cash') ?? 0n;
        balances.set('cash', current + delta);
        events.push({
          id: `${flow.id}:${day}:income`,
          dayIndex: day,
          date,
          type: 'income',
          accountId: 'cash',
          deltaCents: delta
        });
      } else if (flow.type === 'expense') {
        const target = flow.name || flow.id;
        if (modifiers.pausedExpenseTargets.has('*') || modifiers.pausedExpenseTargets.has(target)) {
          continue;
        }
        const scale =
          modifiers.expenseScaleByTarget.get(target) ??
          modifiers.expenseScaleByTarget.get('*') ??
          1;
        const delta = -multiplyCents(grown, scale);
        const current = balances.get('cash') ?? 0n;
        balances.set('cash', current + delta);
        events.push({
          id: `${flow.id}:${day}:expense`,
          dayIndex: day,
          date,
          type: 'expense',
          accountId: 'cash',
          deltaCents: delta
        });
      } else {
        // transfer: cash -> asset contribution (net-worth neutral, asset then earns interest)
        const from = flow.fromAccountId ?? 'cash';
        const to = flow.toAccountId ?? 'cash';
        const fromBal = balances.get(from) ?? 0n;
        const toBal = balances.get(to) ?? 0n;
        balances.set(from, fromBal - grown);
        balances.set(to, toBal + grown);
        const groupId = `${flow.id}:${day}:transfer`;
        events.push({
          id: `${groupId}:out`,
          dayIndex: day,
          date,
          type: 'transfer_out',
          accountId: from,
          deltaCents: -grown,
          groupId
        });
        events.push({
          id: `${groupId}:in`,
          dayIndex: day,
          date,
          type: 'transfer_in',
          accountId: to,
          deltaCents: grown,
          groupId
        });
      }
    }

    // 2) Augment-driven extra income / expense.
    if (modifiers.extraIncomeCents !== 0n) {
      const current = balances.get('cash') ?? 0n;
      balances.set('cash', current + modifiers.extraIncomeCents);
      events.push({
        id: `augment:${day}:add_income`,
        dayIndex: day,
        date,
        type: 'income',
        accountId: 'cash',
        deltaCents: modifiers.extraIncomeCents
      });
    }
    if (modifiers.extraExpenseCents !== 0n) {
      const current = balances.get('cash') ?? 0n;
      const delta = -modifiers.extraExpenseCents;
      balances.set('cash', current + delta);
      events.push({
        id: `augment:${day}:add_expense`,
        dayIndex: day,
        date,
        type: 'expense',
        accountId: 'cash',
        deltaCents: delta
      });
    }

    // 3) Daily fees + interest accrual on assets and debts (before debt payments).
    for (const account of scenario.accounts) {
      if (account.dailyFeeCents && account.dailyFeeCents !== 0n) {
        const current = balances.get(account.id) ?? 0n;
        balances.set(account.id, current - account.dailyFeeCents);
        events.push({
          id: `fee:${account.id}:${day}`,
          dayIndex: day,
          date,
          type: 'fee',
          accountId: account.id,
          deltaCents: -account.dailyFeeCents
        });
      }

      const rateScale = account.kind === 'asset'
        ? (
            modifiers.assetRateScaleByTarget.get(account.name || account.id) ??
            modifiers.assetRateScaleByTarget.get('*') ??
            1
          )
        : 1;
      const rate = multiplyCents(account.annualRatePpm ?? 0n, rateScale);
      if (rate !== 0n) {
        const bal = balances.get(account.id) ?? 0n;
        const carry = residualInterestNumerator.get(account.id) ?? 0n;
        const numer = bal * rate + carry;
        const interestCents = bankersRoundRational(numer, RATE_DENOM);
        const residual = numer - interestCents * RATE_DENOM;
        residualInterestNumerator.set(account.id, residual);
        const current = balances.get(account.id) ?? 0n;
        balances.set(account.id, current + interestCents);
        events.push({
          id: `interest:${account.id}:${day}`,
          dayIndex: day,
          date,
          type: 'interest',
          accountId: account.id,
          deltaCents: interestCents
        });
      }
    }

    // 4) Debt payments, applied after interest and capped at the outstanding balance.
    for (const flow of scenario.recurringFlows) {
      if (flow.type !== 'debt_payment') continue;
      const startDay = flow.startDayIndex ?? 0;
      const flowStart = flowStartDates.get(flow.id) ?? scenarioStart;
      if (!shouldFire(day, startDay, flow.frequency, dateObject, flowStart)) continue;
      const to = flow.toAccountId;
      if (!to) continue;
      const debtTarget = flow.name || flow.id;
      if (modifiers.pausedDebtTargets.has('*') || modifiers.pausedDebtTargets.has(debtTarget)) {
        continue;
      }
      const debtBal = balances.get(to) ?? 0n;
      if (debtBal <= 0n) continue;
      const desired = grownAmountCents(flow.amountCents, flow.annualGrowthPpm, dateObject, flowStart);
      if (desired <= 0n) continue;
      const pay = desired > debtBal ? debtBal : desired;
      const cashBal = balances.get('cash') ?? 0n;
      balances.set('cash', cashBal - pay);
      balances.set(to, debtBal - pay);
      events.push({
        id: `${flow.id}:${day}:debtpay_cash`,
        dayIndex: day,
        date,
        type: 'transfer_out',
        accountId: 'cash',
        deltaCents: -pay
      });
      events.push({
        id: `${flow.id}:${day}:debtpay_principal`,
        dayIndex: day,
        date,
        type: 'transfer_in',
        accountId: to,
        deltaCents: -pay
      });
    }

    // 5) Floor liability accounts that may not go negative.
    for (const account of scenario.accounts) {
      if (account.allowNegative === false) {
        const current = balances.get(account.id) ?? 0n;
        if (current < 0n) {
          const correction = -current;
          balances.set(account.id, 0n);
          events.push({
            id: `adjust:${account.id}:${day}`,
            dayIndex: day,
            date,
            type: 'adjustment',
            accountId: account.id,
            deltaCents: correction
          });
        }
      }
    }

    let netWorth = 0n;
    for (const [id, bal] of balances.entries()) {
      const kind = accountById.get(id)?.kind ?? 'cash';
      if (kind === 'debt') netWorth -= bal;
      else netWorth += bal;
    }
    if (captureDailyBalances) {
      dailyBalances.push(cloneBalances(balances));
    }
    netWorthByDay.push({ dayIndex: day, date, valueCents: netWorth });
  }

  // Remainders are carried, not dropped. Report dropped rounding loss as zero.
  cumulativeRoundingLossCents = 0n;

  const monthlyMap = new Map<string, { month: string; netWorthEndCents: bigint; flowNetCents: bigint }>();
  for (const point of netWorthByDay) {
    const month = point.date.slice(0, 7);
    const existing = monthlyMap.get(month) || { month, netWorthEndCents: point.valueCents, flowNetCents: 0n };
    existing.netWorthEndCents = point.valueCents;
    monthlyMap.set(month, existing);
  }
  for (const e of events) {
    const month = e.date.slice(0, 7);
    const existing = monthlyMap.get(month) || { month, netWorthEndCents: 0n, flowNetCents: 0n };
    existing.flowNetCents += e.deltaCents;
    monthlyMap.set(month, existing);
  }

  return {
    events,
    dailyBalances,
    netWorthByDay,
    monthlyAggregates: Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
    cumulativeRoundingLossCents
  };
}

export function aggregateDailyNetWorthByMonth(points: Array<{ date: string; valueCents: bigint }>) {
  const out = new Map<string, bigint>();
  for (const p of points) {
    out.set(p.date.slice(0, 7), p.valueCents);
  }
  return out;
}

export function aggregateDailyNetWorthByWeek(points: Array<{ date: string; valueCents: bigint }>) {
  const out = new Map<string, bigint>();
  for (const p of points) {
    const d = new Date(`${p.date}T00:00:00.000Z`);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    out.set(toDateString(weekStart), p.valueCents);
  }
  return out;
}

export function centsFromNumber(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

export function buildLedgerScenarioFromPlan(plan: PlanState, days: number): LedgerScenario {
  const alt = plan.alternatives[plan.activeAlt] || { income: [], expense: [], asset: [], debt: [] };
  return buildPlanLedgerScenario({
    alt,
    altName: plan.activeAlt,
    checkpoint: getLastCheckpoint(plan, plan.activeAlt),
    pipeline: plan.pipeline?.byAlt?.[plan.activeAlt],
    augments: plan.augments || [],
    startDate: plan.assumptions.start,
    days,
    defaultInflationPct: Number(plan.assumptions.inflation) || 0
  });
}

export function dateDiffDays(startIso: string, endIso: string): number {
  const start = parseIso(startIso).getTime();
  const end = parseIso(endIso).getTime();
  return Math.round((end - start) / 86_400_000);
}

export type SimulationGranularity = 'monthly' | 'daily';

export type SimulationPoint = {
  date: Date;
  value: number;
  source?: string;
  confidence?: string;
  reconciled?: boolean;
  needsReview?: boolean;
};

export type SimulationSeries = {
  alt: string;
  points: SimulationPoint[];
  isHistorical?: boolean;
};

export type SimulationResult = {
  series: SimulationSeries[];
  percentileSeries?: Array<{
    alt: string;
    points: Array<{ date: Date; p10: number; p50: number; p90: number }>;
  }>;
  historicalSeries: SimulationSeries[];
  audit: string[];
  logs: string[];
  monteCarloRuns?: number;
  seedUsed?: string;
  drift?: { alt: string; variance: number; daysSince: number; checkpointDate: string } | null;
};

export type ForecastOptions = {
  seed?: string;
  monteCarloRuns?: number;
  returnPercentiles?: boolean;
  /**
   * ISO date (YYYY-MM-DD) treated as "today" for drift detection only. Injectable so
   * tests can pin the clock; the simulated series itself never depends on it.
   */
  today?: string;
};

/**
 * Net worth the simulation projects for `todayIso`, read from the engine's daily
 * series (exact daily resolution, independent of display granularity). Clamps to the
 * scenario boundaries. This is the value drift must compare against (BUG-4/D3):
 * today's projection from the checkpoint baseline, never the horizon end.
 */
function projectedNetWorthAtDate(
  netWorthByDay: LedgerRunResult['netWorthByDay'],
  todayIso: string
): number | null {
  if (!netWorthByDay.length) return null;
  const first = netWorthByDay[0];
  const last = netWorthByDay[netWorthByDay.length - 1];
  if (todayIso <= first.date) return Number(first.valueCents) / 100;
  if (todayIso >= last.date) return Number(last.valueCents) / 100;
  const dayIndex = dateDiffDays(first.date, todayIso);
  const point = netWorthByDay[dayIndex];
  if (point && point.date === todayIso) return Number(point.valueCents) / 100;
  const fallback = netWorthByDay.find((p) => p.date >= todayIso);
  return fallback ? Number(fallback.valueCents) / 100 : Number(last.valueCents) / 100;
}

function percentileFromSorted(sorted: number[], percentile: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

function planFrequency(value: string | undefined): LedgerFrequency {
  if (value === 'weekly' || value === 'biweekly' || value === 'monthly' || value === 'yearly') {
    return value;
  }
  return 'monthly';
}

/** Converts an annual percentage (e.g. 5 for 5%) to parts-per-million (50000). */
function pctToPpm(pct: number | undefined): bigint {
  if (!pct || !Number.isFinite(pct)) return 0n;
  return BigInt(Math.round(pct * 10_000));
}

/** Day offset of a row's start date relative to the plan start (clamped at 0). */
function startDayFromDate(planStartIso: string, rowStartIso: string | undefined): number {
  if (!rowStartIso) return 0;
  const diff = dateDiffDays(planStartIso, rowStartIso);
  return diff > 0 ? diff : 0;
}

/**
 * Finds the checkpoint snapshot row matching a current plan entity (uuid first,
 * falling back to name for pre-uuid rows).
 */
function findCheckpointRow<T extends { uuid?: string; name?: string }>(
  rows: T[] | undefined,
  entity: { uuid?: string; name?: string }
): T | undefined {
  if (!rows || rows.length === 0) return undefined;
  if (entity.uuid) {
    const byUuid = rows.find((row) => row.uuid && row.uuid === entity.uuid);
    if (byUuid) return byUuid;
  }
  return rows.find((row) => !row.uuid && !!entity.name && row.name === entity.name);
}

/**
 * Builds a fully-wired ledger scenario from a plan alternative. This is the single
 * source of truth that maps plan rows (income raises, expense inflation, per-row start
 * dates, asset APY + recurring contributions, debt APR + payments) and pipeline edges
 * (routed contributions / extra debt payments) into the deterministic ledger engine.
 *
 * Checkpoint semantics (D3, CheckpointSemantics.md): when the latest checkpoint is
 * provided, it is the observed baseline — the scenario starts at the checkpoint date,
 * asset/debt balances seed from the checkpoint snapshot (Plaid-connected entities use
 * their current live value, which takes precedence over the checkpoint), and any
 * residual between the checkpoint's recorded net worth and the seeded balances enters
 * as one deterministic day-0 cash adjustment: `checkpoint_adjust:<alt>:<date>`.
 * Flow and rate configuration always comes from the current plan rows.
 */
export function buildPlanLedgerScenario(params: {
  alt: Alternative;
  altName?: string;
  checkpoint?: Checkpoint | null;
  pipeline?: PipelineState['byAlt'][string] | null;
  augments?: Augment[];
  startDate: string;
  days: number;
  seed?: string;
  defaultInflationPct?: number;
}): LedgerScenario {
  const { days, seed } = params;
  const defaultInflationPct = params.defaultInflationPct ?? 0;
  const checkpoint = params.checkpoint || null;
  const startDate = checkpoint ? String(checkpoint.date).slice(0, 10) : params.startDate;

  // Clone so pipeline-driven mutations never touch the caller's plan state.
  const alt: Alternative = JSON.parse(JSON.stringify(params.alt));
  if (params.pipeline && Array.isArray(params.pipeline.edges) && params.pipeline.edges.length > 0) {
    applyFlowsToAlternative(alt, params.pipeline);
  }

  const accounts: LedgerAccountInput[] = [
    { id: 'cash', name: 'cash', kind: 'cash', balanceCents: 0n }
  ];
  const recurringFlows: RecurringFlow[] = [];
  const initialAdjustments: LedgerInitialAdjustment[] = [];

  /**
   * Seed balance for an asset/debt entity. Precedence per CheckpointSemantics.md:
   * live/connected value > checkpoint snapshot value > current plan value.
   */
  const seededBalance = (
    entity: Parameters<typeof getEffectiveValue>[0],
    checkpointRows: Array<Parameters<typeof getEffectiveValue>[0]> | undefined
  ): number => {
    const currentValue = getEffectiveValue(entity);
    if (!checkpoint) return currentValue;
    if (entity.dataSource === 'connected') return currentValue;
    const snapshot = findCheckpointRow(checkpointRows, entity);
    if (!snapshot) return currentValue;
    return getEffectiveValue(snapshot);
  };

  for (const r of alt.income) {
    recurringFlows.push({
      id: `income:${r.uuid}`,
      name: r.name,
      type: 'income',
      amountCents: centsFromNumber(getEffectiveValue(r)),
      frequency: planFrequency(r.freq),
      startDayIndex: startDayFromDate(startDate, r.start),
      annualGrowthPpm: pctToPpm(Number(r.raise) || 0)
    });
  }

  for (const r of alt.expense) {
    // Matches the legacy engine: a 0/missing per-row inflation falls back to the
    // plan's global inflation assumption.
    const inflPct = Number(r.infl) || defaultInflationPct;
    recurringFlows.push({
      id: `expense:${r.uuid}`,
      name: r.name,
      type: 'expense',
      amountCents: centsFromNumber(getEffectiveValue(r)),
      frequency: planFrequency(r.freq),
      startDayIndex: startDayFromDate(startDate, r.start),
      annualGrowthPpm: pctToPpm(inflPct)
    });
  }

  let seededAssetsCents = 0n;
  let seededDebtsCents = 0n;

  for (const a of alt.asset) {
    const balanceCents = centsFromNumber(seededBalance(a, checkpoint?.assets));
    seededAssetsCents += balanceCents;
    accounts.push({
      id: `asset:${a.uuid}`,
      name: a.name,
      kind: 'asset',
      balanceCents,
      annualRatePpm: pctToPpm(Number(a.apy) || 0)
    });
    const recurAmt = Number(a.recurAmt) || 0;
    if (recurAmt > 0) {
      recurringFlows.push({
        id: `assetcontrib:${a.uuid}`,
        name: a.name,
        type: 'transfer',
        amountCents: centsFromNumber(recurAmt),
        frequency: planFrequency(a.recurFreq),
        fromAccountId: 'cash',
        toAccountId: `asset:${a.uuid}`
      });
    }
  }

  for (const d of alt.debt) {
    const balanceCents = centsFromNumber(seededBalance(d, checkpoint?.debts));
    seededDebtsCents += balanceCents;
    accounts.push({
      id: `debt:${d.uuid}`,
      name: d.name,
      kind: 'debt',
      balanceCents,
      annualRatePpm: pctToPpm(Number(d.apr) || 0),
      allowNegative: false
    });
    const pmt = Number(d.pmt) || 0;
    if (pmt > 0) {
      recurringFlows.push({
        id: `debtpmt:${d.uuid}`,
        name: d.name,
        type: 'debt_payment',
        amountCents: centsFromNumber(pmt),
        frequency: planFrequency(d.freq),
        startDayIndex: startDayFromDate(startDate, d.start),
        toAccountId: `debt:${d.uuid}`
      });
    }
    const extraPmt = Number(d.extraPmt) || 0;
    if (extraPmt > 0) {
      recurringFlows.push({
        id: `debtextra:${d.uuid}`,
        name: d.name,
        type: 'debt_payment',
        amountCents: centsFromNumber(extraPmt),
        frequency: planFrequency(d.extraFreq || d.freq),
        startDayIndex: startDayFromDate(startDate, d.start),
        toAccountId: `debt:${d.uuid}`
      });
    }
  }

  if (checkpoint) {
    // Cash (and any value the checkpoint observed beyond the seeded asset/debt rows)
    // enters as a single deterministic adjustment so re-applying the same checkpoint
    // can never create additional adjustment events.
    const targetNetWorthCents = centsFromNumber(Number(checkpoint.netWorth) || 0);
    const residualCents = targetNetWorthCents - seededAssetsCents + seededDebtsCents;
    if (residualCents !== 0n) {
      initialAdjustments.push({
        id: `checkpoint_adjust:${params.altName || checkpoint.alt || 'default'}:${startDate}`,
        accountId: 'cash',
        deltaCents: residualCents
      });
    }
  }

  return {
    startDate,
    days,
    seed,
    augments: params.augments || [],
    accounts,
    recurringFlows,
    initialAdjustments
  };
}

export function runSimulationFromLedger(
  plan: PlanState,
  years: number,
  granularity: SimulationGranularity,
  options: ForecastOptions = {}
): SimulationResult {
  const enabled = Object.keys(plan.alternatives).filter((alt) => plan.altChartEnabled[alt]);
  if (!enabled.length) enabled.push(plan.activeAlt);

  const baseSeed = String(options.seed || plan.forecastSeed || 'tmm-default-seed');
  const monteCarloRuns = Math.max(1, Math.floor(options.monteCarloRuns || 1));
  const returnPercentiles = Boolean(options.returnPercentiles);

  const series: SimulationSeries[] = [];
  const percentileSeries: SimulationResult['percentileSeries'] = [];
  const historicalSeries: SimulationSeries[] = [];
  const logs: string[] = [];
  const audit: string[] = [];
  let drift: SimulationResult['drift'] = null;

  const todayIso = String(options.today || '').slice(0, 10) || new Date().toISOString().slice(0, 10);

  for (const altName of enabled) {
    const alt = plan.alternatives[altName] || { income: [], expense: [], asset: [], debt: [] };
    // D3: the latest checkpoint is the observed baseline the projection seeds from.
    const lastCheckpoint = getLastCheckpoint(plan, altName);
    const days = Math.round(years * 365);
    const runPointSets: Array<{ date: Date; value: number }[]> = [];
    let firstRun: LedgerRunResult | null = null;
    for (let runIndex = 0; runIndex < monteCarloRuns; runIndex += 1) {
      const runSeed = deriveSeed(baseSeed, runIndex, altName);
      const scenario = buildPlanLedgerScenario({
        alt,
        altName,
        checkpoint: lastCheckpoint,
        pipeline: plan.pipeline?.byAlt?.[altName],
        augments: plan.augments || [],
        startDate: plan.assumptions.start,
        days,
        seed: runSeed,
        defaultInflationPct: Number(plan.assumptions.inflation) || 0
      });
      const run = runLedgerScenario(scenario, {
        stepDays: 1,
        captureDailyBalances: granularity === 'daily'
      });
      if (!firstRun) firstRun = run;
      const points =
        granularity === 'daily'
          ? run.netWorthByDay.map((p) => ({
              date: new Date(`${p.date}T00:00:00.000Z`),
              value: Number(p.valueCents) / 100
            }))
          : run.monthlyAggregates.map((m) => ({
              date: new Date(`${m.month}-01T00:00:00.000Z`),
              value: Number(m.netWorthEndCents) / 100
            }));
      runPointSets.push(points);
    }

    const firstPoints = runPointSets[0] || [];
    const percentilePoints = firstPoints.map((point, pointIndex) => {
      const values = runPointSets
        .map((points) => points[pointIndex]?.value)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b);
      return {
        date: point.date,
        p10: percentileFromSorted(values, 0.1),
        p50: percentileFromSorted(values, 0.5),
        p90: percentileFromSorted(values, 0.9)
      };
    });

    const medianSeriesPoints = percentilePoints.map((p) => ({ date: p.date, value: p.p50 }));
    series.push({ alt: altName, points: medianSeriesPoints });
    if (returnPercentiles || monteCarloRuns > 1) {
      percentileSeries.push({ alt: altName, points: percentilePoints });
    }
    audit.push(`[ledger] ${altName} points=${medianSeriesPoints.length} runs=${monteCarloRuns}`);
    if (firstRun?.events.some((e) => e.type === 'adjustment')) {
      logs.push(`${altName} adjustment event emitted`);
    }

    const checkpoints = getCheckpoints(plan, altName);
    if (checkpoints.length > 0) {
      historicalSeries.push({
        alt: altName,
        isHistorical: true,
        points: checkpoints.map((cp) => ({
          date: new Date(cp.date),
          value: cp.netWorth,
          source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
          confidence: cp.confidence || 'high',
          reconciled: false
        }))
      });
    }
    if (!drift && firstRun && firstRun.netWorthByDay.length > 0) {
      const currentNetWorth =
        (alt.asset || []).reduce((sum, a) => sum + getEffectiveValue(a), 0) -
        (alt.debt || []).reduce((sum, d) => sum + getEffectiveValue(d), 0);
      // BUG-4 fix: compare today's actuals to TODAY's projection from the checkpoint
      // baseline — never the horizon-end value.
      const projected = projectedNetWorthAtDate(firstRun.netWorthByDay, todayIso);
      const driftInfo =
        projected === null
          ? null
          : detectDrift(plan, altName, currentNetWorth, projected, parseIso(todayIso));
      if (driftInfo?.detected) {
        drift = {
          alt: altName,
          variance: driftInfo.variance || 0,
          daysSince: driftInfo.daysSince || 0,
          checkpointDate: driftInfo.checkpointDate || ''
        };
      }
    }
  }

  return {
    series,
    percentileSeries: (returnPercentiles || monteCarloRuns > 1) ? percentileSeries : undefined,
    historicalSeries,
    audit,
    logs,
    monteCarloRuns,
    seedUsed: baseSeed,
    drift
  };
}
