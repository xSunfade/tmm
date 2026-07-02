import { DEFAULT_PLAN_STATE } from '../../../../frontend/src/lib/plan/defaults';
import type { PlanState } from '../../../../frontend/src/lib/plan/types';
import {
  buildPlanLedgerScenario,
  runLedgerScenario,
  runSimulationFromLedger,
  type LedgerScenario,
  type SimulationPoint
} from '../../../../frontend/src/lib/simulation/ledger';

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

function findPoint(points: SimulationPoint[], isoDate: string): SimulationPoint | undefined {
  return points.find((p) => p.date.toISOString().slice(0, 10) === isoDate);
}

/**
 * Debt payments must REDUCE the debt balance (regression: the old generic transfer
 * added the payment to the debt account, ballooning it). Principal payment is
 * net-worth neutral; payments cap at the outstanding balance and stop after payoff.
 */
function testDebtPaydownReducesBalance() {
  const scenario: LedgerScenario = {
    startDate: '2026-01-01',
    days: 200,
    accounts: [
      { id: 'cash', kind: 'cash', balanceCents: 0n },
      { id: 'debt:1', kind: 'debt', balanceCents: 100_000n, annualRatePpm: 0n, allowNegative: false }
    ],
    recurringFlows: [
      {
        id: 'debtpmt:1',
        name: 'Card',
        type: 'debt_payment',
        amountCents: 25_000n,
        frequency: 'monthly',
        toAccountId: 'debt:1'
      }
    ]
  };
  const result = runLedgerScenario(scenario);
  const last = result.dailyBalances[result.dailyBalances.length - 1];
  assert(last['debt:1'] === 0n, `Debt should be fully paid down, got ${last['debt:1']}`);
  assert(
    last.cash === -100_000n,
    `Cash should reflect exactly the principal paid (capped at balance), got ${last.cash}`
  );
  for (const point of result.netWorthByDay) {
    assert(
      point.valueCents === -100_000n,
      `Principal payment must be net-worth neutral; got ${point.valueCents} on ${point.date}`
    );
  }
}

/** Interest accrues before payments, so a payment lowers the post-interest balance. */
function testInterestAccruesBeforePayment() {
  const accounts = (): LedgerScenario['accounts'] => [
    { id: 'cash', kind: 'cash', balanceCents: 0n },
    { id: 'debt:1', kind: 'debt', balanceCents: 100_000n, annualRatePpm: 365_000n, allowNegative: false }
  ];
  const noPayment = runLedgerScenario({
    startDate: '2026-01-01',
    days: 365,
    accounts: accounts(),
    recurringFlows: []
  });
  const withPayment = runLedgerScenario({
    startDate: '2026-01-01',
    days: 365,
    accounts: accounts(),
    recurringFlows: [
      { id: 'pmt', type: 'debt_payment', amountCents: 5_000n, frequency: 'monthly', toAccountId: 'debt:1' }
    ]
  });
  const noPayDebt = noPayment.dailyBalances[noPayment.dailyBalances.length - 1]['debt:1'];
  const payDebt = withPayment.dailyBalances[withPayment.dailyBalances.length - 1]['debt:1'];
  assert(noPayDebt > 100_000n, `Unpaid debt should accrue interest and grow, got ${noPayDebt}`);
  assert(payDebt < noPayDebt, `Payments should reduce the ending balance: ${payDebt} !< ${noPayDebt}`);
}

/** Per-row start dates delay a flow until its start date. */
function testRowStartDateDelaysFlow() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-late', name: 'New job', amount: 1000, freq: 'monthly', start: '2026-07-01', raise: 0, dataSource: 'manual' }
  ];
  const result = runSimulationFromLedger(plan, 1, 'daily');
  const points = result.series[0]?.points || [];
  const beforeStart = findPoint(points, '2026-03-01');
  const afterStart = findPoint(points, '2026-09-15');
  assert(beforeStart !== undefined && approxEqual(beforeStart.value, 0), `Expected 0 before start, got ${beforeStart?.value}`);
  assert(afterStart !== undefined && afterStart.value > 0, `Expected income to have started by Sep, got ${afterStart?.value}`);
}

/** Yearly income fires once per year (not every month). */
function testYearlyFrequencyFiresAnnually() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-year', name: 'Annual bonus', amount: 12000, freq: 'yearly', start: '2026-01-01', raise: 0, dataSource: 'manual' }
  ];
  const result = runSimulationFromLedger(plan, 1, 'monthly');
  const points = result.series[0]?.points || [];
  assert(points.length >= 7, 'Expected at least 7 monthly points');
  assert(approxEqual(points[0].value, 12000), `Jan should reflect one annual fire of 12000, got ${points[0].value}`);
  assert(
    approxEqual(points[6].value, 12000),
    `Mid-year must still be a single annual fire (not monthly), got ${points[6].value}`
  );
}

/** Raises compound on each anniversary of the flow start. */
function testRaiseAppliesAnnually() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-raise', name: 'Salary', amount: 1000, freq: 'monthly', start: '2026-01-01', raise: 100, dataSource: 'manual' }
  ];
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    startDate: plan.assumptions.start,
    days: 365 * 2,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario);
  const incomeEvents = run.events.filter((e) => e.id.startsWith('income:inc-raise'));
  const y2026 = incomeEvents.find((e) => e.date.startsWith('2026'));
  const y2027 = incomeEvents.find((e) => e.date.startsWith('2027'));
  assert(y2026?.deltaCents === 100_000n, `2026 income should be base 1000, got ${y2026?.deltaCents}`);
  assert(y2027?.deltaCents === 200_000n, `2027 income should double after 100% raise, got ${y2027?.deltaCents}`);
}

/** Expense inflation grows the expense each year. */
function testExpenseInflationGrows() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.expense = [
    { uuid: 'exp-infl', name: 'Rent', amount: 1000, freq: 'monthly', start: '2026-01-01', infl: 50, dataSource: 'manual' }
  ];
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    startDate: plan.assumptions.start,
    days: 365 * 2,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario);
  const events = run.events.filter((e) => e.id.startsWith('expense:exp-infl'));
  const y2026 = events.find((e) => e.date.startsWith('2026'));
  const y2027 = events.find((e) => e.date.startsWith('2027'));
  assert(y2026?.deltaCents === -100_000n, `2026 expense should be base 1000, got ${y2026?.deltaCents}`);
  assert(y2027?.deltaCents === -150_000n, `2027 expense should grow 50%, got ${y2027?.deltaCents}`);
}

/** Asset recurring contributions move cash into the asset (net-worth neutral). */
function testAssetRecurringContribution() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'Manual', name: 'Brokerage', value: 0, apy: 0, recurAmt: 100, recurFreq: 'monthly', dataSource: 'manual' }
  ];
  const scenario = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    startDate: plan.assumptions.start,
    days: 365,
    defaultInflationPct: 0
  });
  const run = runLedgerScenario(scenario);
  const last = run.dailyBalances[run.dailyBalances.length - 1];
  assert(last['asset:ast-1'] > 0n, `Asset should accumulate contributions, got ${last['asset:ast-1']}`);
  assert(last.cash === -last['asset:ast-1'], 'Contributions must be funded from cash (net-worth neutral)');
  for (const point of run.netWorthByDay) {
    assert(point.valueCents === 0n, `Contribution-only plan must keep net worth flat, got ${point.valueCents}`);
  }
}

/** Pipeline edges are routed into the ledger as asset contributions / extra debt payments. */
function testPipelineEdgesMapIntoLedger() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-1', name: 'Salary', amount: 5000, freq: 'monthly', start: '2026-01-01', raise: 0, dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'Manual', name: 'Brokerage', value: 0, apy: 0, dataSource: 'manual' }
  ];

  const withoutPipeline = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    startDate: plan.assumptions.start,
    days: 365
  });
  assert(
    !withoutPipeline.recurringFlows.some((f) => f.toAccountId === 'asset:ast-1' && f.type === 'transfer'),
    'No asset contribution should exist without a pipeline edge'
  );

  const pipeline = {
    edges: [{ from: 'income:0', to: 'asset:0', mode: 'fixed' as const, amount: 500, freq: 'monthly' as const }],
    layout: {}
  };
  const withPipeline = buildPlanLedgerScenario({
    alt: plan.alternatives.Baseline,
    pipeline,
    startDate: plan.assumptions.start,
    days: 365
  });
  const contribution = withPipeline.recurringFlows.find(
    (f) => f.toAccountId === 'asset:ast-1' && f.type === 'transfer'
  );
  assert(contribution !== undefined, 'Pipeline income->asset edge should create an asset contribution flow');
  assert(
    contribution!.amountCents === 50_000n,
    `Routed contribution should be $500/mo, got ${contribution!.amountCents}`
  );
}

/**
 * Daily and monthly views must come from the same underlying daily simulation: each
 * monthly point equals the daily net worth on the last day of that month. (Regression
 * for the daily-vs-monthly divergence caused by 30-day stepping.)
 */
function testDailyMonthlyParity() {
  const plan = basePlan('2026-01-01');
  plan.alternatives.Baseline.income = [
    { uuid: 'inc-1', name: 'Salary', amount: 5000, freq: 'monthly', start: '2026-01-01', raise: 3, dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.expense = [
    { uuid: 'exp-1', name: 'Bills', amount: 3000, freq: 'monthly', start: '2026-01-01', infl: 2, dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.asset = [
    { uuid: 'ast-1', mode: 'APY', name: 'Index', value: 10000, apy: 6, recurAmt: 200, recurFreq: 'monthly', dataSource: 'manual' }
  ];
  plan.alternatives.Baseline.debt = [
    { uuid: 'debt-1', name: 'Loan', bal: 20000, apr: 18, pmt: 600, freq: 'monthly', start: '2026-01-01' }
  ];

  const daily = runSimulationFromLedger(plan, 2, 'daily');
  const monthly = runSimulationFromLedger(plan, 2, 'monthly');
  const dailyPoints = daily.series[0]?.points || [];
  const monthlyPoints = monthly.series[0]?.points || [];
  assert(dailyPoints.length > 0 && monthlyPoints.length > 0, 'Both granularities must produce points');

  const lastByMonth = new Map<string, number>();
  for (const p of dailyPoints) {
    lastByMonth.set(p.date.toISOString().slice(0, 7), p.value);
  }
  for (const mp of monthlyPoints) {
    const key = mp.date.toISOString().slice(0, 7);
    const dailyValue = lastByMonth.get(key);
    assert(dailyValue !== undefined, `Daily series missing month ${key}`);
    assert(
      approxEqual(mp.value, dailyValue as number, 0.5),
      `Daily/monthly mismatch for ${key}: monthly=${mp.value} daily=${dailyValue}`
    );
  }
}

async function run() {
  console.log('🧪 Running plan -> ledger integration suite...\n');

  testDebtPaydownReducesBalance();
  console.log('✅ debt payments reduce balance (net-worth neutral, capped, stop at payoff)');

  testInterestAccruesBeforePayment();
  console.log('✅ interest accrues before debt payments');

  testRowStartDateDelaysFlow();
  console.log('✅ per-row start dates delay flows');

  testYearlyFrequencyFiresAnnually();
  console.log('✅ yearly frequency fires once per year');

  testRaiseAppliesAnnually();
  console.log('✅ income raises compound annually');

  testExpenseInflationGrows();
  console.log('✅ expense inflation compounds annually');

  testAssetRecurringContribution();
  console.log('✅ asset recurring contributions modeled as cash -> asset');

  testPipelineEdgesMapIntoLedger();
  console.log('✅ pipeline edges map into the ledger');

  testDailyMonthlyParity();
  console.log('✅ daily and monthly views agree (same underlying simulation)');

  console.log('\n✅ plan -> ledger integration suite passed');
}

run().catch((error) => {
  console.error(`\n❌ plan -> ledger integration suite failed: ${error.message}`);
  process.exit(1);
});
