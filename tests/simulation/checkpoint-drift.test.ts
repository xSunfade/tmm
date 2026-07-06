/**
 * Engine tests for checkpoint semantics (BUG-5 / D3) and drift-at-today (BUG-4).
 *
 * D3: a checkpoint is observed ground truth — the ledger seeds state from the latest
 * checkpoint and projects forward. Applying a checkpoint produces one deterministic
 * adjustment event (`checkpoint_adjust:<alt>:<date>`); re-applying never duplicates it.
 * Drift compares today's actuals to TODAY's projection from that baseline — never the
 * end of the simulation horizon.
 *
 * Spec: tests/validation/spec/CheckpointSemantics.md
 */
import { DEFAULT_PLAN_STATE } from '../../frontend/src/lib/plan/defaults';
import type { Checkpoint, PlanState } from '../../frontend/src/lib/plan/types';
import {
  buildPlanLedgerScenario,
  runLedgerScenario,
  runSimulationFromLedger
} from '../../frontend/src/lib/simulation/ledger';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual: number, expected: number, tolerance = 1e-6) {
  return Math.abs(actual - expected) <= tolerance;
}

function basePlan(start = '2026-01-01'): PlanState {
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
  plan.assumptions.start = start;
  plan.assumptions.inflation = 0;
  plan.alternatives.Baseline = { income: [], expense: [], asset: [], debt: [] };
  return plan;
}

function makeCheckpoint(params: {
  alt: string;
  date: string;
  netWorth: number;
  assets?: Checkpoint['assets'];
  debts?: Checkpoint['debts'];
}): Checkpoint {
  return {
    checkpointId: `${params.alt}_${params.date}_manual_test`,
    alt: params.alt,
    date: params.date,
    type: 'manual',
    netWorth: params.netWorth,
    assets: params.assets || [],
    debts: params.debts || [],
    income: [],
    expenses: [],
    provenance: 'user-entered',
    source: 'manual-input',
    confidence: 'high',
    createdAt: `${params.date}T00:00:00.000Z`,
    immutable: true
  };
}

/** BUG-5/D3: the latest checkpoint seeds engine state and the projection starts there. */
function testCheckpointSeedsBaseline() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: 5000, apy: 0, dataSource: 'manual' }
  ];

  const withoutCheckpoint = runSimulationFromLedger(plan, 1, 'daily', { today: '2026-03-15' });
  const firstBefore = withoutCheckpoint.series[0]?.points?.[0];
  assert(firstBefore !== undefined, 'Expected points without checkpoint');
  assert(
    firstBefore!.date.toISOString().slice(0, 10) === '2026-01-01',
    `Without checkpoint the projection starts at plan start, got ${firstBefore!.date.toISOString()}`
  );
  assert(approxEqual(firstBefore!.value, 5000), `Expected 5000 at plan start, got ${firstBefore!.value}`);

  plan.checkpoints.Baseline = [
    makeCheckpoint({
      alt: 'Baseline',
      date: '2026-03-01',
      netWorth: 12000,
      assets: [{ uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: 12000, apy: 0, dataSource: 'manual' }]
    })
  ];

  const withCheckpoint = runSimulationFromLedger(plan, 1, 'daily', { today: '2026-03-15' });
  const firstAfter = withCheckpoint.series[0]?.points?.[0];
  assert(firstAfter !== undefined, 'Expected points with checkpoint');
  assert(
    firstAfter!.date.toISOString().slice(0, 10) === '2026-03-01',
    `Projection must start at the checkpoint date, got ${firstAfter!.date.toISOString()}`
  );
  assert(
    approxEqual(firstAfter!.value, 12000),
    `Checkpoint balance must override the current plan value (12000), got ${firstAfter!.value}`
  );
}

/** Ghost-adjustment prevention: one deterministic adjustment id, idempotent re-runs. */
function testDeterministicAdjustmentIdAndIdempotence() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: 5000, apy: 0, dataSource: 'manual' }
  ];
  const checkpoint = makeCheckpoint({
    alt: 'Baseline',
    date: '2026-03-01',
    netWorth: 15000, // 12000 in the asset snapshot + 3000 observed cash
    assets: [{ uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: 12000, apy: 0, dataSource: 'manual' }]
  });

  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    checkpoint,
    startDate: plan.assumptions.start,
    days: 120,
    defaultInflationPct: 0
  });

  assert(scenario.startDate === '2026-03-01', `Scenario must start at checkpoint date, got ${scenario.startDate}`);
  const adjustments = scenario.initialAdjustments || [];
  assert(adjustments.length === 1, `Expected exactly one initial adjustment, got ${adjustments.length}`);
  assert(
    adjustments[0].id === 'checkpoint_adjust:Baseline:2026-03-01',
    `Adjustment id must be deterministic, got ${adjustments[0].id}`
  );
  assert(
    adjustments[0].deltaCents === 300_000n,
    `Cash residual must be netWorth - assets + debts (3000), got ${adjustments[0].deltaCents}`
  );

  const firstRun = runLedgerScenario(scenario);
  const secondRun = runLedgerScenario(scenario);

  const countAdjustEvents = (events: typeof firstRun.events) =>
    events.filter((e) => e.id.startsWith('checkpoint_adjust:')).length;
  assert(
    countAdjustEvents(firstRun.events) === 1,
    `Exactly one checkpoint adjustment event per run, got ${countAdjustEvents(firstRun.events)}`
  );
  assert(
    countAdjustEvents(secondRun.events) === 1,
    'Re-applying the same checkpoint must not create additional adjustment events'
  );
  assert(
    firstRun.netWorthByDay[0].valueCents === 1_500_000n,
    `Day-0 net worth must equal the checkpoint net worth (15000), got ${firstRun.netWorthByDay[0].valueCents}`
  );
  for (let i = 0; i < firstRun.netWorthByDay.length; i += 1) {
    assert(
      firstRun.netWorthByDay[i].valueCents === secondRun.netWorthByDay[i].valueCents,
      `Checkpoint seeding must be idempotent across runs (day ${i})`
    );
  }
}

/** Spec precedence: a connected entity's live value beats the checkpoint snapshot. */
function testConnectedLiveValueBeatsCheckpoint() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.asset = [
    {
      uuid: 'ast-1',
      mode: 'Manual',
      name: 'Linked account',
      value: 0,
      apy: 0,
      dataSource: 'connected',
      connectedAccountId: 'acc_1',
      autoValue: 13000,
      manualValue: null,
      overrideActive: false
    }
  ];
  const checkpoint = makeCheckpoint({
    alt: 'Baseline',
    date: '2026-03-01',
    netWorth: 12000,
    assets: [{ uuid: 'ast-1', mode: 'Manual', name: 'Linked account', value: 12000, apy: 0, dataSource: 'manual' }]
  });

  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    checkpoint,
    startDate: plan.assumptions.start,
    days: 120,
    defaultInflationPct: 0
  });

  const asset = scenario.accounts.find((a) => a.id === 'asset:ast-1');
  assert(asset !== undefined, 'Expected the connected asset account');
  assert(
    asset!.balanceCents === 1_300_000n,
    `Connected asset must seed from the live value (13000), got ${asset!.balanceCents}`
  );
  const adjustments = scenario.initialAdjustments || [];
  assert(adjustments.length === 1 && adjustments[0].deltaCents === -100_000n,
    `Residual must reconcile to the checkpoint net worth (-1000 cash), got ${adjustments[0]?.deltaCents}`);
}

/**
 * BUG-4: drift compares today's actuals to today's projection from the checkpoint
 * baseline. Scenario: checkpoint on 2026-03-01 at 10000; income 5000/mo - expense
 * 3000/mo = +2000 on the 1st of each month; today is 2026-04-30, so today's
 * projection is 10000 + 2000 (Mar 1) + 2000 (Apr 1) = 14000. The horizon-end value
 * (~36000 after a year) must play no role.
 */
function buildDriftPlan(currentAssetValue: number): PlanState {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-1', name: 'Salary', amount: 5000, freq: 'monthly', start: '2026-01-01', raise: 0, dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.expense = [
    { uuid: 'exp-1', name: 'Bills', amount: 3000, freq: 'monthly', start: '2026-01-01', infl: 0, dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: currentAssetValue, apy: 0, dataSource: 'manual' }
  ];
  plan.checkpoints.Baseline = [
    makeCheckpoint({
      alt: 'Baseline',
      date: '2026-03-01',
      netWorth: 10000,
      assets: [{ uuid: 'ast-1', mode: 'Manual', name: 'Savings', value: 10000, apy: 0, dataSource: 'manual' }]
    })
  ];
  return plan;
}

function testDriftUsesTodayNotHorizonEnd() {
  // Actuals match today's projection exactly: no drift, even though the horizon-end
  // value (~36000) differs from actuals by far more than the threshold.
  const matchingPlan = buildDriftPlan(14000);
  for (const granularity of ['daily', 'monthly'] as const) {
    const result = runSimulationFromLedger(matchingPlan, 1, granularity, { today: '2026-04-30' });
    assert(
      result.drift === null || result.drift === undefined,
      `No drift expected when actuals equal today's projection (${granularity}), got ${JSON.stringify(result.drift)}`
    );
  }

  // Actuals far from today's projection: drift fires, and the variance is computed
  // against today's projection (|28000-14000|/14000 = 1.0), not the horizon end
  // (which would give |28000-36000|/36000 ≈ 0.22).
  const driftingPlan = buildDriftPlan(28000);
  const drifting = runSimulationFromLedger(driftingPlan, 1, 'daily', { today: '2026-04-30' });
  assert(drifting.drift !== null && drifting.drift !== undefined, 'Expected drift to be detected');
  assert(drifting.drift!.checkpointDate === '2026-03-01', `Wrong checkpoint date: ${drifting.drift!.checkpointDate}`);
  assert(drifting.drift!.daysSince === 60, `Expected 60 days since checkpoint, got ${drifting.drift!.daysSince}`);
  assert(
    approxEqual(drifting.drift!.variance, 1.0, 0.01),
    `Variance must be measured against today's projection (expected 1.0), got ${drifting.drift!.variance}`
  );
}

async function run() {
  console.log('🧪 Running checkpoint + drift engine suite...\n');

  testCheckpointSeedsBaseline();
  console.log('✅ checkpoint seeds the projection baseline (D3 / BUG-5)');

  testDeterministicAdjustmentIdAndIdempotence();
  console.log('✅ deterministic checkpoint_adjust id, idempotent re-application');

  testConnectedLiveValueBeatsCheckpoint();
  console.log('✅ connected live value takes precedence over checkpoint snapshot');

  testDriftUsesTodayNotHorizonEnd();
  console.log("✅ drift compares today's actuals to today's projection (BUG-4)");

  console.log('\n✅ checkpoint + drift engine suite passed');
}

run().catch((error) => {
  console.error(`\n❌ checkpoint + drift engine suite failed: ${error.message}`);
  process.exit(1);
});
