import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_PLAN_STATE } from '../../frontend/src/lib/plan/defaults';
import type { PlanState } from '../../frontend/src/lib/plan/types';
import { getEffectiveValue } from '../../frontend/src/lib/plan/overrideManager';
import { runSimulationFromLedger } from '../../frontend/src/lib/simulation/ledger';
import { isAugmentActive } from '../../frontend/src/lib/simulation/augments';
import { runSimulationInWorker } from '../../frontend/src/lib/simulation/simulationWorkerHost';
import {
  deserializeSimulationResult,
  serializeSimulationResult
} from '../../frontend/src/lib/simulation/simulationWorkerTransport';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual: number, expected: number, tolerance = 1e-6) {
  return Math.abs(actual - expected) <= tolerance;
}

function buildBasePlan(): PlanState {
  return JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
}

async function loadFixtures() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturePath = path.resolve(__dirname, '../fixtures/plans/simulation-golden-fixtures.json');
  const raw = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(raw);
}

function buildGoldenPlan(incomeMonthly: number, expenseMonthly: number): PlanState {
  const plan = buildBasePlan();
  plan.assumptions.start = '2026-01-01';
  plan.alternatives.Baseline.income = [
    {
      uuid: 'income-1',
      name: 'Salary',
      amount: incomeMonthly,
      freq: 'monthly',
      start: '2026-01-01',
      raise: 0,
      dataSource: 'manual'
    }
  ];
  plan.alternatives.Baseline.expense = [
    {
      uuid: 'expense-1',
      name: 'Bills',
      amount: expenseMonthly,
      freq: 'monthly',
      start: '2026-01-01',
      infl: 0,
      dataSource: 'manual'
    }
  ];
  return plan;
}

function buildConnectedOverridePlan(overrideActive: boolean): PlanState {
  const plan = buildBasePlan();
  plan.assumptions.start = '2026-01-01';
  plan.alternatives.Baseline.asset = [
    {
      uuid: 'asset-1',
      mode: 'Manual',
      name: 'Connected account',
      value: 0,
      dataSource: 'connected',
      connectedAccountId: 'acc_1',
      autoValue: 10000,
      manualValue: 8000,
      overrideActive
    }
  ];
  return plan;
}

function buildWeeklyFrequencyPlan(weeklyIncome: number): PlanState {
  const plan = buildBasePlan();
  plan.assumptions.start = '2026-01-01';
  plan.alternatives.Baseline.income = [
    {
      uuid: 'income-weekly',
      name: 'Weekly income',
      amount: weeklyIncome,
      freq: 'weekly',
      start: '2026-01-01',
      raise: 0,
      dataSource: 'manual'
    }
  ];
  return plan;
}

function buildProbabilityAugmentPlan(probability: number): PlanState {
  const plan = buildGoldenPlan(5000, 3000);
  plan.augments = [
    {
      id: 'augment_prob_income',
      name: 'Probabilistic bonus',
      category: 'income',
      description: 'Monthly bonus with probability',
      enabled: true,
      activation: {
        type: 'fixed-date',
        startDate: '2026-01-01',
        probability
      },
      effects: [{ type: 'add-income', amount: 600 }],
      duration: { type: 'temporary', months: 12 }
    }
  ];
  return plan;
}

async function testGoldenScenario(fixtures: any) {
  const plan = buildGoldenPlan(fixtures.golden.incomeMonthly, fixtures.golden.expenseMonthly);
  const result = runSimulationFromLedger(plan, 1, 'monthly');
  const points = result.series[0]?.points || [];
  assert(points.length >= 3, 'Expected at least three monthly points');

  const expected = fixtures.golden.expectedFirstThreePoints as number[];
  for (let i = 0; i < expected.length; i += 1) {
    assert(
      approxEqual(points[i].value, expected[i]),
      `Golden scenario mismatch at index ${i}. Expected ${expected[i]}, got ${points[i].value}`
    );
  }
}

async function testDeterminism(fixtures: any) {
  const plan = buildGoldenPlan(fixtures.golden.incomeMonthly, fixtures.golden.expenseMonthly);
  const first = runSimulationFromLedger(plan, 2, 'monthly');
  const second = runSimulationFromLedger(plan, 2, 'monthly');
  const firstSeries = first.series[0]?.points || [];
  const secondSeries = second.series[0]?.points || [];
  assert(firstSeries.length === secondSeries.length, 'Determinism check failed: point length mismatch');

  for (let i = 0; i < firstSeries.length; i += 1) {
    assert(
      approxEqual(firstSeries[i].value, secondSeries[i].value),
      `Determinism mismatch at index ${i}. ${firstSeries[i].value} vs ${secondSeries[i].value}`
    );
  }
}

async function testConnectedOverride(fixtures: any) {
  const overridePlan = buildConnectedOverridePlan(true);
  const connectedPlan = buildConnectedOverridePlan(false);
  const overrideAsset = overridePlan.alternatives.Baseline.asset[0];
  const connectedAsset = connectedPlan.alternatives.Baseline.asset[0];

  assert(
    getEffectiveValue(overrideAsset) === fixtures.connectedOverride.manualOverrideExpected,
    'Expected manual override to take precedence for connected asset'
  );
  assert(
    getEffectiveValue(connectedAsset) === fixtures.connectedOverride.connectedExpected,
    'Expected connected auto value to be used when override is inactive'
  );

  const overrideResult = runSimulationFromLedger(overridePlan, 1, 'monthly');
  const connectedResult = runSimulationFromLedger(connectedPlan, 1, 'monthly');
  const overrideFirst = overrideResult.series[0]?.points?.[0]?.value ?? 0;
  const connectedFirst = connectedResult.series[0]?.points?.[0]?.value ?? 0;

  assert(
    approxEqual(overrideFirst, fixtures.connectedOverride.manualOverrideExpected),
    `Expected first point to use manual override value ${fixtures.connectedOverride.manualOverrideExpected}, got ${overrideFirst}`
  );
  assert(
    approxEqual(connectedFirst, fixtures.connectedOverride.connectedExpected),
    `Expected first point to use connected value ${fixtures.connectedOverride.connectedExpected}, got ${connectedFirst}`
  );
}

async function testFrequency(fixtures: any) {
  const plan = buildWeeklyFrequencyPlan(fixtures.frequency.weeklyIncome);
  const result = runSimulationFromLedger(plan, 1, 'monthly');
  const firstPoint = result.series[0]?.points?.[0]?.value ?? 0;
  // Calendar-accurate: weekly income starting Thu 2026-01-01 fires on
  // Jan 1/8/15/22/29 — five occurrences in the first month.
  assert(
    approxEqual(firstPoint, fixtures.frequency.expectedFirstPoint),
    `Expected weekly frequency first-month total ${fixtures.frequency.expectedFirstPoint}, got ${firstPoint}`
  );
}

async function testMonteCarloDeterminism() {
  const plan = buildProbabilityAugmentPlan(0.5);
  const first = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'determinism-seed',
    monteCarloRuns: 80,
    returnPercentiles: true
  });
  const second = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'determinism-seed',
    monteCarloRuns: 80,
    returnPercentiles: true
  });
  const firstP50 = first.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  const secondP50 = second.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  assert(firstP50.length === secondP50.length, 'Monte Carlo determinism length mismatch');
  for (let i = 0; i < firstP50.length; i += 1) {
    assert(approxEqual(firstP50[i], secondP50[i]), `Monte Carlo determinism mismatch at ${i}`);
  }
}

async function testSeedVariation() {
  const plan = buildProbabilityAugmentPlan(0.5);
  const first = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'seed-a',
    monteCarloRuns: 80,
    returnPercentiles: true
  });
  const second = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'seed-b',
    monteCarloRuns: 80,
    returnPercentiles: true
  });
  const firstP50 = first.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  const secondP50 = second.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  const hasDifference = firstP50.some((value, idx) => !approxEqual(value, secondP50[idx] ?? value));
  assert(hasDifference, 'Expected different seeds to produce different percentile projections');
}

async function testProbabilityConvergence() {
  const augment = {
    id: 'augment_prob_convergence',
    name: 'Convergence augment',
    category: 'global',
    description: '',
    enabled: true,
    activation: {
      type: 'fixed-date',
      startDate: '2026-01-01',
      probability: 0.35
    },
    effects: [{ type: 'add-income', amount: 100 }],
    duration: { type: 'instant', months: 0 }
  } as any;
  const checkDate = new Date('2026-01-01T00:00:00.000Z');
  let activeCount = 0;
  const totalRuns = 1000;
  for (let i = 0; i < totalRuns; i += 1) {
    if (isAugmentActive(augment, checkDate, { seed: `conv-seed-${i}` })) {
      activeCount += 1;
    }
  }
  const observed = activeCount / totalRuns;
  const tolerance = 0.05;
  assert(
    Math.abs(observed - 0.35) <= tolerance,
    `Probability convergence failed. observed=${observed.toFixed(3)} expected=0.35 tolerance=${tolerance}`
  );
}

async function testSeededGoldenPercentileFixture(fixtures: any) {
  const plan = buildGoldenPlan(fixtures.golden.incomeMonthly, fixtures.golden.expenseMonthly);
  const result = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'golden-seed-v1',
    monteCarloRuns: 50,
    returnPercentiles: true
  });
  const points = result.percentileSeries?.[0]?.points || [];
  const expected = fixtures.golden.seededLedgerP50FirstThreePoints as number[];
  for (let i = 0; i < expected.length; i += 1) {
    assert(approxEqual(points[i]?.p50 ?? NaN, expected[i]), `Seeded golden P50 mismatch at ${i}`);
  }
}

async function testWorkerParity() {
  const plan = buildProbabilityAugmentPlan(0.5);
  const direct = runSimulationFromLedger(plan, 1, 'monthly', {
    seed: 'worker-parity-seed',
    monteCarloRuns: 50,
    returnPercentiles: true
  });
  const workerResult = await runSimulationInWorker(plan, 1, 'monthly', {
    seed: 'worker-parity-seed',
    monteCarloRuns: 50,
    returnPercentiles: true
  });
  const workerPayload = serializeSimulationResult(workerResult);
  const workerRoundTrip = deserializeSimulationResult(workerPayload);

  const directP50 = direct.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  const workerP50 = workerRoundTrip.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  assert(directP50.length === workerP50.length, 'Worker parity length mismatch');
  for (let i = 0; i < directP50.length; i += 1) {
    assert(approxEqual(directP50[i], workerP50[i]), `Worker parity mismatch at ${i}`);
  }

  const directDate = direct.series[0]?.points?.[0]?.date?.toISOString() || '';
  const workerDate = workerPayload.series[0]?.points?.[0]?.date || '';
  assert(directDate === workerDate, 'Worker serialized ISO date mismatch');
}

async function run() {
  console.log('🧪 Running simulation validation suite...\n');
  const fixtures = await loadFixtures();

  await testGoldenScenario(fixtures);
  console.log('✅ golden scenario points');

  await testDeterminism(fixtures);
  console.log('✅ determinism for identical inputs');

  await testConnectedOverride(fixtures);
  console.log('✅ connected value + manual override precedence');

  await testFrequency(fixtures);
  console.log('✅ frequency conversion sanity check');

  await testMonteCarloDeterminism();
  console.log('✅ monte carlo determinism for same seed');

  await testSeedVariation();
  console.log('✅ monte carlo seed variation');

  await testProbabilityConvergence();
  console.log('✅ probabilistic augment convergence sanity');

  await testSeededGoldenPercentileFixture(fixtures);
  console.log('✅ seeded percentile golden fixture');

  await testWorkerParity();
  console.log('✅ worker parity + serialization round-trip');

  console.log('\n✅ simulation validation suite passed');
}

run().catch((err) => {
  console.error(`\n❌ simulation validation suite failed: ${err.message}`);
  process.exit(1);
});
