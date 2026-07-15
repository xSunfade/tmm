// Position semantics tests (Phase 3.2, D4 / BUG-6; spec: PositionSemantics.md).
// Market assets are quantity × price(t); contributions buy shares at price(t) (DCA).

import { DEFAULT_PLAN_STATE } from '../../frontend/src/lib/plan/defaults';
import type { PlanState } from '../../frontend/src/lib/plan/types';
import {
  buildPlanLedgerScenario,
  microCentsFromDollars,
  microSharesFromNumber,
  positionValueCents,
  runLedgerScenario,
  runSimulationFromLedger
} from '../../frontend/src/lib/simulation/ledger';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual: number, expected: number, tolerance: number) {
  return Math.abs(actual - expected) <= tolerance;
}

function buildBasePlan(): PlanState {
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
  plan.assumptions.start = '2026-01-01';
  return plan;
}

function buildTickerPlan(params: {
  quantity: number;
  liveprice: number;
  apy: number;
  recurAmt?: number;
}): PlanState {
  const plan = buildBasePlan();
  plan.alternatives.Baseline.asset = [
    {
      uuid: 'pos-1',
      mode: 'Ticker',
      name: 'Index fund',
      ticker: 'VTI',
      value: params.quantity * params.liveprice,
      apy: params.apy,
      quantity: params.quantity,
      liveprice: params.liveprice,
      recurAmt: params.recurAmt || 0,
      recurFreq: 'monthly'
    }
  ];
  return plan;
}

/**
 * Hand-computed DCA golden (zero return): price stays exactly $100, so every
 * monthly $1,000 contribution buys exactly 10 shares. The 90-day horizon spans
 * days 0..90 inclusive (Jan 1 → Apr 1), so 4 purchases fire (Jan 1, Feb 1,
 * Mar 1, Apr 1). Opening 10 shares + 4 × 10 = 50 shares = $5,000.
 */
async function testDcaGoldenZeroReturn() {
  const plan = buildTickerPlan({ quantity: 10, liveprice: 100, apy: 0, recurAmt: 1000 });
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    startDate: '2026-01-01',
    days: 90,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario, { stepDays: 1 });

  const report = run.positions.find((p) => p.accountId === 'asset:pos-1');
  assert(!!report, 'position report missing from run result');
  assert(report!.acquisitions.length === 4, `expected 4 purchases, got ${report!.acquisitions.length}`);
  for (const acq of report!.acquisitions) {
    assert(acq.quantityMicro === 10_000_000n, `expected exactly 10 shares per purchase, got ${acq.quantityMicro}`);
    assert(acq.costCents === 100_000n, 'purchase cost mismatch');
  }
  assert(report!.quantityMicro === 50_000_000n, `expected 50 shares, got ${report!.quantityMicro}`);
  assert(report!.valueCents === 500_000n, `expected $5,000 position, got ${report!.valueCents} cents`);

  const finalBalances = run.dailyBalances[run.dailyBalances.length - 1];
  assert(finalBalances['asset:pos-1'] === 500_000n, 'ledger balance disagrees with position value');
}

/** The invariant: position account balance always equals qty × price (both fixed-point). */
async function testValueEqualsQuantityTimesPrice() {
  const plan = buildTickerPlan({ quantity: 33.5, liveprice: 123.45, apy: 12, recurAmt: 750 });
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    startDate: '2026-01-01',
    days: 365,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario, { stepDays: 1 });
  const report = run.positions.find((p) => p.accountId === 'asset:pos-1')!;
  const finalBalances = run.dailyBalances[run.dailyBalances.length - 1];

  const recomputed = positionValueCents(report.quantityMicro, report.priceMicroCents);
  assert(report.valueCents === recomputed, 'report value is not qty × price');
  assert(finalBalances['asset:pos-1'] === recomputed, 'ledger balance is not qty × price');
}

/**
 * DCA with growth: engine result must match an independent computation of the
 * price path (daily compounding ≈ (1 + r/365)^d) and share purchases at price(t).
 * Tolerance covers fixed-point vs float divergence over a year.
 */
async function testDcaWithGrowthMatchesIndependentComputation() {
  const apy = 12;
  const plan = buildTickerPlan({ quantity: 10, liveprice: 100, apy, recurAmt: 1000 });
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    startDate: '2026-01-01',
    days: 365,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario, { stepDays: 1 });
  const report = run.positions.find((p) => p.accountId === 'asset:pos-1')!;

  // Independent float model. Purchases execute at the day's opening price
  // (= previous day's close); the price then accrues daily at r/365.
  const dailyRate = apy / 100 / 365;
  let price = 100;
  let quantity = 10;
  const purchaseDays = new Set(
    report.acquisitions.map((a) => a.dayIndex)
  );
  for (let day = 0; day <= 365; day += 1) {
    if (purchaseDays.has(day)) {
      quantity += 1000 / price;
    }
    price *= 1 + dailyRate;
  }
  const expectedValue = quantity * price;

  const actualValue = Number(report.valueCents) / 100;
  const actualQuantity = Number(report.quantityMicro) / 1_000_000;
  assert(
    approxEqual(actualValue, expectedValue, expectedValue * 1e-4),
    `DCA growth mismatch: engine ${actualValue}, independent ${expectedValue}`
  );
  assert(
    approxEqual(actualQuantity, quantity, quantity * 1e-4),
    `DCA quantity mismatch: engine ${actualQuantity}, independent ${quantity}`
  );
}

/** Ticker rows without a resolvable price degrade to balance + APY (identical series). */
async function testTickerWithoutPriceFallsBackToBalance() {
  const tickerPlan = buildBasePlan();
  tickerPlan.alternatives.Baseline.asset = [
    {
      uuid: 'a-1',
      mode: 'Ticker',
      name: 'No price',
      ticker: 'XXX',
      value: 10000,
      apy: 6,
      quantity: 0,
      liveprice: 0
    }
  ];
  const apyPlan = buildBasePlan();
  apyPlan.alternatives.Baseline.asset = [
    { uuid: 'a-1', mode: 'APY', name: 'No price', value: 10000, apy: 6 }
  ];

  const tickerResult = runSimulationFromLedger(tickerPlan, 1, 'monthly');
  const apyResult = runSimulationFromLedger(apyPlan, 1, 'monthly');
  const tickerPoints = tickerResult.series[0]?.points || [];
  const apyPoints = apyResult.series[0]?.points || [];
  assert(tickerPoints.length === apyPoints.length, 'fallback series length mismatch');
  for (let i = 0; i < tickerPoints.length; i += 1) {
    assert(
      tickerPoints[i].value === apyPoints[i].value,
      `fallback mismatch at ${i}: ${tickerPoints[i].value} vs ${apyPoints[i].value}`
    );
  }
}

/** Same plan + seed + horizon ⇒ identical output, including position accounts. */
async function testPositionDeterminism() {
  const plan = buildTickerPlan({ quantity: 12.25, liveprice: 87.65, apy: 9, recurAmt: 300 });
  const first = runSimulationFromLedger(plan, 2, 'monthly', { seed: 'pos-seed' });
  const second = runSimulationFromLedger(plan, 2, 'monthly', { seed: 'pos-seed' });
  const a = first.series[0]?.points || [];
  const b = second.series[0]?.points || [];
  assert(a.length === b.length, 'determinism length mismatch');
  for (let i = 0; i < a.length; i += 1) {
    assert(a[i].value === b[i].value, `position determinism mismatch at ${i}`);
  }
}

/** Checkpoint precedence: position quantity/price seed from the checkpoint snapshot. */
async function testCheckpointSeedsPositionState() {
  const plan = buildTickerPlan({ quantity: 100, liveprice: 300, apy: 0 });
  plan.checkpoints = {
    Baseline: [
      {
        checkpointId: 'cp-1',
        alt: 'Baseline',
        date: '2026-03-01',
        type: 'manual',
        netWorth: 29000,
        assets: [
          {
            uuid: 'pos-1',
            mode: 'Ticker',
            name: 'Index fund',
            ticker: 'VTI',
            value: 29000,
            apy: 0,
            quantity: 100,
            liveprice: 290
          }
        ],
        debts: [],
        income: [],
        expenses: [],
        provenance: 'user',
        source: 'manual',
        confidence: 'high',
        createdAt: '2026-03-01T00:00:00.000Z',
        immutable: true
      }
    ]
  };

  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    altName: 'Baseline',
    checkpoint: plan.checkpoints.Baseline[0],
    startDate: '2026-01-01',
    days: 30,
    defaultInflationPct: 0
  });

  assert(scenario.startDate === '2026-03-01', 'scenario must start at the checkpoint date');
  const account = scenario.accounts.find((a) => a.id === 'asset:pos-1')!;
  assert(!!account.position, 'checkpointed ticker row did not produce a position');
  assert(
    account.position!.priceMicroCents === microCentsFromDollars(290),
    'position price must seed from the checkpoint snapshot'
  );
  assert(
    account.position!.quantityMicro === microSharesFromNumber(100),
    'position quantity must seed from the checkpoint snapshot'
  );
  assert(account.balanceCents === 2_900_000n, 'position balance must be qty × snapshot price');
}

async function run() {
  console.log('🧪 Running position semantics suite...\n');

  await testDcaGoldenZeroReturn();
  console.log('✅ DCA golden (zero return, hand-computed)');

  await testValueEqualsQuantityTimesPrice();
  console.log('✅ position value = quantity × price invariant');

  await testDcaWithGrowthMatchesIndependentComputation();
  console.log('✅ DCA with growth matches independent computation');

  await testTickerWithoutPriceFallsBackToBalance();
  console.log('✅ ticker without price falls back to balance + APY');

  await testPositionDeterminism();
  console.log('✅ position determinism');

  await testCheckpointSeedsPositionState();
  console.log('✅ checkpoint seeds position quantity/price (D3 precedence)');

  console.log('\n✅ position semantics suite passed');
}

run().catch((err) => {
  console.error(`\n❌ position semantics suite failed: ${err.message}`);
  process.exit(1);
});
