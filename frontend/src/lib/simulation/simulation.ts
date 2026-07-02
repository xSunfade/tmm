import type { PlanState } from '../plan/types';
import { FPM } from '../plan/frequency';
import { getEffectiveValue } from '../plan/overrideManager';
import { addMonths, addDays } from './dateUtils';
import { getActiveAugmentsAtDate, applyAugmentEffects } from './augments';
import { getCheckpoints, getLastCheckpoint, detectDrift } from './checkpoints';

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

export type SimulationRunOptions = {
  seed?: string;
  monteCarloRuns?: number;
  returnPercentiles?: boolean;
};

export function simulateAlternative(
  plan: PlanState,
  altName: string,
  years: number,
  gran: SimulationGranularity,
  options: SimulationRunOptions = {}
) {
  const alt = plan.alternatives[altName] || { income: [], expense: [], asset: [], debt: [] };
  const lastCheckpoint = getLastCheckpoint(plan, altName);
  const startDate = lastCheckpoint ? new Date(lastCheckpoint.date) : new Date(plan.assumptions.start);

  let initialAssets = alt.asset.map((a) => ({ ...a, value: getEffectiveValue(a) ?? 0 }));
  let initialDebts = alt.debt.map((d) => ({ ...d, bal: getEffectiveValue(d) }));
  let initialCash = 0;

  if (lastCheckpoint) {
    initialAssets = lastCheckpoint.assets.map((checkpointAsset) => {
      const currentEntity = alt.asset.find(
        (a) => (checkpointAsset.uuid && a.uuid === checkpointAsset.uuid) || (!checkpointAsset.uuid && a.name === checkpointAsset.name)
      );
      if (currentEntity && currentEntity.dataSource === 'connected') {
        return { ...checkpointAsset, value: getEffectiveValue(currentEntity) ?? 0 };
      }
      return { ...checkpointAsset, value: Number(checkpointAsset.value) || 0 };
    });
    initialDebts = lastCheckpoint.debts.map((checkpointDebt) => {
      const currentEntity = alt.debt.find(
        (d) => (checkpointDebt.uuid && d.uuid === checkpointDebt.uuid) || (!checkpointDebt.uuid && d.name === checkpointDebt.name)
      );
      if (currentEntity && currentEntity.dataSource === 'connected') {
        return { ...checkpointDebt, bal: getEffectiveValue(currentEntity) };
      }
      return { ...checkpointDebt };
    });
    const assetValue = initialAssets.reduce((s, a) => s + (Number(a.value) || 0), 0);
    const debtValue = initialDebts.reduce((s, d) => s + (Number(d.bal) || 0), 0);
    initialCash = lastCheckpoint.netWorth - assetValue + debtValue;
  }

  const points: Array<{ date: Date; value: number }> = [];
  const audit: string[] = [];
  const logs: string[] = [];
  const augments = plan.augments || [];

  const assets = initialAssets.map((a) => {
    if (a.mode === 'Ticker') {
      const qty = Number(a.quantity) || 0;
      const price = Number(a.liveprice) || 0;
      const val = Number(a.value) || qty * price;
      return {
        mode: 'Ticker' as const,
        name: a.name,
        ticker: a.ticker,
        qty,
        price,
        val,
        totalContrib: Number(a.totalContrib) || 0,
        recurAmt: Number(a.recurAmt) || 0,
        recurFreq: a.recurFreq || 'monthly',
        apy: (Number(a.apy) || 0) / 100
      };
    }
    if (a.mode === 'APY') {
      return {
        mode: 'APY' as const,
        name: a.name,
        val: Number(a.value) || 0,
        apy: (Number(a.apy) || 0) / 100,
        recurAmt: Number(a.recurAmt) || 0,
        recurFreq: a.recurFreq || 'monthly'
      };
    }
    return { mode: 'Manual' as const, name: a.name, val: Number(a.value) || 0 };
  });

  const debts = initialDebts.map((d) => ({
    name: d.name,
    bal: Number(d.bal) || 0,
    apr: (Number(d.apr) || 0) / 100,
    pmt: Number(d.pmt) || 0
  }));

  const runMonthly = () => {
    const totalMonths = years * 12;
    let cash = initialCash;
    for (let m = 0; m <= totalMonths; m++) {
      const now = addMonths(startDate, m);
      let income = 0;
      let expense = 0;
      let principalPaid = 0;

      const activeAugments = getActiveAugmentsAtDate(augments, now, { seed: options.seed });
      const simulationState = {
        income: alt.income.map((r) => ({ ...r, amount: Number(r.amount) || 0 })),
        expense: alt.expense.map((r) => ({ ...r, amount: Number(r.amount) || 0 })),
        assets: assets.map((a) => ({ ...a })),
        debts: debts.map((d) => ({ ...d })),
        cash,
        temporaryIncome: 0,
        temporaryExpense: 0
      };

      activeAugments.forEach((augment) => applyAugmentEffects(simulationState, augment, now, { seed: options.seed }));

      simulationState.income.forEach((r) => {
        const raise = (Number(r.raise) || 0) / 100;
        const startRow = new Date(r.start || plan.assumptions.start);
        if (now >= startRow) {
          const base = getEffectiveValue(r);
          const fpm = FPM[r.freq || 'monthly'] || 1;
          const yearsElapsed =
            now.getFullYear() - startRow.getFullYear() - (now.getMonth() < startRow.getMonth() ? 1 : 0);
          const amt = (base * Math.pow(1 + raise, Math.max(0, yearsElapsed))) / (r.freq === 'yearly' ? 12 : 1);
          income += amt * fpm;
        }
      });
      income += simulationState.temporaryIncome || 0;

      simulationState.expense.forEach((r) => {
        const rowInfl = (Number(r.infl) || plan.assumptions.inflation) / 100;
        const startRow = new Date(r.start || plan.assumptions.start);
        if (now >= startRow) {
          const base = getEffectiveValue(r);
          const fpm = FPM[r.freq || 'monthly'] || 1;
          const yearsElapsed =
            now.getFullYear() - startRow.getFullYear() - (now.getMonth() < startRow.getMonth() ? 1 : 0);
          const amt = (base * Math.pow(1 + rowInfl, Math.max(0, yearsElapsed))) / (r.freq === 'yearly' ? 12 : 1);
          expense += amt * fpm;
        }
      });
      expense += simulationState.temporaryExpense || 0;

      simulationState.assets.forEach((a, idx) => {
        if (assets[idx] && a.apy !== undefined) {
          assets[idx].apy = a.apy;
        }
      });

      assets.forEach((a) => {
        if (a.mode === 'APY') {
          a.val *= 1 + (a.apy || 0) / 12;
        }
        if (a.mode === 'Ticker') {
          if (a.apy && a.apy > 0) {
            a.price *= 1 + a.apy / 12;
          }
          const add = (a.recurAmt || 0) * (FPM[a.recurFreq || 'monthly'] || 1);
          if (add > 0 && a.price > 0) {
            a.totalContrib += add;
            a.qty += add / a.price;
          }
          a.val = a.qty * a.price;
        }
      });

      simulationState.debts.forEach((d, idx) => {
        if (debts[idx]) {
          debts[idx].pmt = d.pmt || 0;
        }
      });

      debts.forEach((d) => {
        if (d.bal <= 0) return;
        const interest = d.bal * (d.apr / 12);
        d.bal += interest;
        const pay = Math.min(d.pmt || 0, d.bal);
        const interestPaid = Math.min(interest, pay);
        const principal = pay - interestPaid;
        d.bal -= pay;
        principalPaid += principal;
      });

      cash = simulationState.cash || cash;
      const net = income - expense - principalPaid;
      cash += net;

      const netWorth = cash + assets.reduce((s, a) => s + (a.val || 0), 0) - debts.reduce((s, d) => s + d.bal, 0);
      points.push({ date: now, value: netWorth });
      if (cash < 0 && m % 1 === 0) {
        logs.push(`${altName} • ${now.toLocaleDateString()}: Cash went negative`);
      }
      audit.push(
        `[${now.toISOString().slice(0, 10)}] ${altName} income=${income.toFixed(
          2
        )} expense=${expense.toFixed(2)} cash=${cash.toFixed(2)} NW=${netWorth.toFixed(2)}`
      );
    }
  };

  const runDaily = () => {
    const totalDays = Math.round(years * 365);
    let cash = initialCash;
    for (let d = 0; d <= totalDays; d++) {
      const now = addDays(new Date(plan.assumptions.start), d);
      let income = 0;
      let expense = 0;
      let principalPaid = 0;

      const activeAugments = getActiveAugmentsAtDate(augments, now, { seed: options.seed });
      const simulationState = {
        income: alt.income.map((r) => ({ ...r, amount: getEffectiveValue(r) })),
        expense: alt.expense.map((r) => ({ ...r, amount: getEffectiveValue(r) })),
        assets: assets.map((a) => ({ ...a })),
        debts: debts.map((d2) => ({ ...d2 })),
        cash,
        temporaryIncome: 0,
        temporaryExpense: 0
      };

      activeAugments.forEach((augment) => applyAugmentEffects(simulationState, augment, now, { seed: options.seed }));

      simulationState.income.forEach((r) => {
        const startRow = new Date(r.start || plan.assumptions.start);
        if (now >= startRow) {
          const base = getEffectiveValue(r);
          const perMonth =
            r.freq === 'yearly'
              ? base / 12
              : r.freq === 'monthly'
                ? base
                : r.freq === 'biweekly'
                  ? base * (26 / 12)
                  : base * 4.345;
          const yearsElapsed =
            now.getFullYear() - startRow.getFullYear() -
            (now.getMonth() < startRow.getMonth() ||
            (now.getMonth() === startRow.getMonth() && now.getDate() < startRow.getDate())
              ? 1
              : 0);
          const raised = perMonth * Math.pow(1 + (Number(r.raise) || 0) / 100, Math.max(0, yearsElapsed));
          income += raised / 30.4375;
        }
      });
      income += (simulationState.temporaryIncome || 0) / 30.4375;

      simulationState.expense.forEach((r) => {
        const startRow = new Date(r.start || plan.assumptions.start);
        if (now >= startRow) {
          const base = getEffectiveValue(r);
          const perMonth =
            r.freq === 'yearly'
              ? base / 12
              : r.freq === 'monthly'
                ? base
                : r.freq === 'biweekly'
                  ? base * (26 / 12)
                  : base * 4.345;
          const yearsElapsed =
            now.getFullYear() - startRow.getFullYear() -
            (now.getMonth() < startRow.getMonth() ||
            (now.getMonth() === startRow.getMonth() && now.getDate() < startRow.getDate())
              ? 1
              : 0);
          const inflated =
            perMonth * Math.pow(1 + (Number(r.infl) || plan.assumptions.inflation) / 100, Math.max(0, yearsElapsed));
          expense += inflated / 30.4375;
        }
      });
      expense += (simulationState.temporaryExpense || 0) / 30.4375;

      simulationState.assets.forEach((a, idx) => {
        if (assets[idx] && a.apy !== undefined) {
          assets[idx].apy = a.apy;
        }
      });

      assets.forEach((a) => {
        if (a.mode === 'APY') {
          a.val *= 1 + (a.apy || 0) / 365;
        }
        if (a.mode === 'Ticker') {
          if (a.apy && a.apy > 0) {
            a.price *= 1 + a.apy / 365;
          }
          const add = (a.recurAmt || 0) * ((FPM[a.recurFreq || 'monthly'] || 1) / 30.4375);
          if (add > 0 && a.price > 0) {
            a.totalContrib += add;
            a.qty += add / a.price;
          }
          a.val = a.qty * a.price;
        }
      });

      simulationState.debts.forEach((d2, idx) => {
        if (debts[idx]) {
          debts[idx].pmt = d2.pmt || 0;
        }
      });

      debts.forEach((db) => {
        if (db.bal <= 0) return;
        const interest = db.bal * ((db.apr || 0) / 365);
        db.bal += interest;
        const dayPay = (db.pmt || 0) / 30.4375;
        const pay = Math.min(dayPay, db.bal);
        const interestPaid = Math.min(interest, pay);
        const principal = pay - interestPaid;
        db.bal -= pay;
        principalPaid += principal;
      });

      cash = simulationState.cash || cash;
      const net = income - expense - principalPaid;
      cash += net;

      const netWorth = cash + assets.reduce((s, a) => s + (a.val || 0), 0) - debts.reduce((s, d2) => s + d2.bal, 0);
      points.push({ date: now, value: netWorth });
      if (cash < 0 && d % 7 === 0) {
        logs.push(`${altName} • ${now.toLocaleDateString()}: Cash went negative`);
      }
    }
  };

  if (gran === 'monthly') {
    runMonthly();
  } else {
    runDaily();
  }

  const currentNetWorth =
    (alt.asset || []).reduce((sum, a) => sum + getEffectiveValue(a), 0) -
    (alt.debt || []).reduce((sum, d) => sum + getEffectiveValue(d), 0);

  const projectedNetWorth = (() => {
    if (points.length === 0) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < points.length; i++) {
      const pointDate = new Date(points[i].date);
      pointDate.setHours(0, 0, 0, 0);
      if (pointDate.getTime() === today.getTime()) {
        return points[i].value;
      }
      if (pointDate.getTime() > today.getTime()) {
        if (i === 0) return points[i].value;
        const prevDate = new Date(points[i - 1].date);
        prevDate.setHours(0, 0, 0, 0);
        const daysDiff = (pointDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
        const daysSincePrev = (today.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff > 0 && daysSincePrev >= 0) {
          const ratio = Math.min(1, Math.max(0, daysSincePrev / daysDiff));
          const prevValue = points[i - 1].value;
          const nextValue = points[i].value;
          return prevValue + (nextValue - prevValue) * ratio;
        }
        return points[i - 1].value;
      }
    }
    return points[points.length - 1].value;
  })();
  const driftInfo = detectDrift(plan, altName, currentNetWorth, projectedNetWorth);

  return { points, audit, logs, driftInfo };
}

function percentileFromSorted(sorted: number[], percentile: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

export function runSimulation(
  plan: PlanState,
  years: number,
  gran: SimulationGranularity,
  options: SimulationRunOptions = {}
): SimulationResult {
  const enabled = Object.keys(plan.alternatives).filter((alt) => plan.altChartEnabled[alt]);
  if (enabled.length === 0) {
    enabled.push(plan.activeAlt);
  }
  const baseSeed = String(options.seed || plan.forecastSeed || 'tmm-default-seed');
  const monteCarloRuns = Math.max(1, Math.floor(options.monteCarloRuns || 1));

  const series: SimulationSeries[] = [];
  const percentileSeries: NonNullable<SimulationResult['percentileSeries']> = [];
  const historicalSeries: SimulationSeries[] = [];
  const audit: string[] = [];
  const logs: string[] = [];
  let drift: SimulationResult['drift'] = null;

  enabled.forEach((altName) => {
    const runPoints: Array<Array<{ date: Date; value: number }>> = [];
    let firstResult: ReturnType<typeof simulateAlternative> | null = null;
    for (let runIndex = 0; runIndex < monteCarloRuns; runIndex += 1) {
      const runSeed = `${baseSeed}:${altName}:${runIndex}`;
      const result = simulateAlternative(plan, altName, years, gran, { ...options, seed: runSeed });
      if (!firstResult) firstResult = result;
      runPoints.push(result.points);
    }
    const template = runPoints[0] || [];
    const percentilePoints = template.map((point, idx) => {
      const values = runPoints
        .map((points) => points[idx]?.value)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b);
      return {
        date: point.date,
        p10: percentileFromSorted(values, 0.1),
        p50: percentileFromSorted(values, 0.5),
        p90: percentileFromSorted(values, 0.9)
      };
    });
    series.push({ alt: altName, points: percentilePoints.map((p) => ({ date: p.date, value: p.p50 })) });
    if (options.returnPercentiles || monteCarloRuns > 1) {
      percentileSeries.push({ alt: altName, points: percentilePoints });
    }
    if (firstResult) {
      audit.push(...firstResult.audit);
      logs.push(...firstResult.logs);
    }

    const checkpoints = getCheckpoints(plan, altName);
    if (checkpoints.length > 0) {
      historicalSeries.push({
        alt: altName,
        points: checkpoints.map((cp) => ({
          date: new Date(cp.date),
          value: cp.netWorth,
          source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
          confidence: cp.confidence || 'high',
          reconciled: false
        })),
        isHistorical: true
      });
    }

    if (!drift && firstResult?.driftInfo && firstResult.driftInfo.detected) {
      drift = {
        alt: altName,
        variance: firstResult.driftInfo.variance || 0,
        daysSince: firstResult.driftInfo.daysSince || 0,
        checkpointDate: firstResult.driftInfo.checkpointDate || ''
      };
    }
  });

  return {
    series,
    percentileSeries: options.returnPercentiles || monteCarloRuns > 1 ? percentileSeries : undefined,
    historicalSeries,
    audit,
    logs,
    monteCarloRuns,
    seedUsed: baseSeed,
    drift
  };
}

