// Engine edge cases (Phase 3.6): negative cash policy and unsupported augment
// activation types. Spec: PositionSemantics.md §Negative cash policy.

import { DEFAULT_PLAN_STATE } from '../../frontend/src/lib/plan/defaults';
import type { PlanState } from '../../frontend/src/lib/plan/types';
import { runLedgerScenario, runSimulationFromLedger } from '../../frontend/src/lib/simulation/ledger';
import { isAugmentActive } from '../../frontend/src/lib/simulation/augments';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function buildBasePlan(): PlanState {
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
  plan.assumptions.start = '2026-01-01';
  return plan;
}

/**
 * Expenses exceed income: cash goes negative and stays negative — no floor, no
 * clamp, no adjustment events on the cash account. Net worth reflects the
 * shortfall at face value.
 */
async function testNegativeCashIsAllowedAndDeterministic() {
  const run = runLedgerScenario(
    {
      startDate: '2026-01-01',
      days: 90,
      accounts: [{ id: 'cash', kind: 'cash', balanceCents: 50_000n }],
      recurringFlows: [
        { id: 'income', type: 'income', amountCents: 100_000n, frequency: 'monthly' },
        { id: 'expense', type: 'expense', amountCents: 250_000n, frequency: 'monthly' }
      ]
    },
    { stepDays: 1 }
  );

  const finalCash = run.dailyBalances[run.dailyBalances.length - 1]['cash'];
  // 4 firings each (Jan 1, Feb 1, Mar 1, Apr 1 within 90 days): 500 + 4×(1000 − 2500) = −5500.
  assert(finalCash === -550_000n, `expected -550000 cash cents, got ${finalCash}`);

  const cashAdjustments = run.events.filter(
    (e) => e.accountId === 'cash' && e.type === 'adjustment'
  );
  assert(cashAdjustments.length === 0, 'cash must not be floored/adjusted when negative');

  const finalNetWorth = run.netWorthByDay[run.netWorthByDay.length - 1].valueCents;
  assert(finalNetWorth === -550_000n, 'net worth must include negative cash at face value');
}

/** Debts floor at zero: payments stop once the balance is fully paid. */
async function testDebtFloorsAtZero() {
  const run = runLedgerScenario(
    {
      startDate: '2026-01-01',
      days: 120,
      accounts: [
        { id: 'cash', kind: 'cash', balanceCents: 1_000_000n },
        { id: 'debt', kind: 'debt', balanceCents: 50_000n, allowNegative: false }
      ],
      recurringFlows: [
        { id: 'pmt', type: 'debt_payment', amountCents: 30_000n, frequency: 'monthly', toAccountId: 'debt' }
      ]
    },
    { stepDays: 1 }
  );
  const finalDebt = run.dailyBalances[run.dailyBalances.length - 1]['debt'];
  assert(finalDebt === 0n, `debt must floor at zero, got ${finalDebt}`);
  // Second payment is capped at the outstanding 200_00: total paid = 500_00.
  const finalCash = run.dailyBalances[run.dailyBalances.length - 1]['cash'];
  assert(finalCash === 950_000n, `debt payment must cap at outstanding balance, got cash ${finalCash}`);
}

/**
 * `recurring` / `conditional` activation types are not implemented and are hidden
 * in the UI (the editor only offers fixed-date / date-range). The engine must
 * treat them as deterministically inert — never active, no effects applied.
 */
async function testUnsupportedAugmentTypesAreInert() {
  const recurringAugment = {
    id: 'aug-recurring',
    name: 'Recurring (unsupported)',
    category: 'global',
    description: '',
    enabled: true,
    activation: {
      type: 'recurring' as const,
      startDate: '2026-01-01',
      probability: 1,
      frequency: 'monthly'
    },
    effects: [{ type: 'add-income', amount: 5000 }],
    duration: { type: 'permanent' as const }
  };
  const conditionalAugment = {
    ...recurringAugment,
    id: 'aug-conditional',
    name: 'Conditional (unsupported)',
    activation: { ...recurringAugment.activation, type: 'conditional' as const }
  };

  assert(
    !isAugmentActive(recurringAugment, new Date('2026-06-01T00:00:00.000Z'), { seed: 's' }),
    'recurring augment must never be active'
  );
  assert(
    !isAugmentActive(conditionalAugment, new Date('2026-06-01T00:00:00.000Z'), { seed: 's' }),
    'conditional augment must never be active'
  );

  const withAugments = buildBasePlan();
  withAugments.alternatives.Baseline.income = [
    { uuid: 'i-1', name: 'Salary', amount: 4000, freq: 'monthly', start: '2026-01-01' }
  ];
  withAugments.augments = [recurringAugment, conditionalAugment];

  const without = buildBasePlan();
  without.alternatives.Baseline.income = [
    { uuid: 'i-1', name: 'Salary', amount: 4000, freq: 'monthly', start: '2026-01-01' }
  ];

  const a = runSimulationFromLedger(withAugments, 1, 'monthly', { seed: 'inert' });
  const b = runSimulationFromLedger(without, 1, 'monthly', { seed: 'inert' });
  const aPoints = a.series[0]?.points || [];
  const bPoints = b.series[0]?.points || [];
  assert(aPoints.length === bPoints.length, 'inert augment changed series length');
  for (let i = 0; i < aPoints.length; i += 1) {
    assert(aPoints[i].value === bPoints[i].value, `inert augment changed output at ${i}`);
  }
}

async function run() {
  console.log('🧪 Running engine edge-case suite...\n');

  await testNegativeCashIsAllowedAndDeterministic();
  console.log('✅ negative cash allowed, deterministic, no floor');

  await testDebtFloorsAtZero();
  console.log('✅ debt floors at zero with capped payments');

  await testUnsupportedAugmentTypesAreInert();
  console.log('✅ recurring/conditional augments are inert');

  console.log('\n✅ engine edge-case suite passed');
}

run().catch((err) => {
  console.error(`\n❌ engine edge-case suite failed: ${err.message}`);
  process.exit(1);
});
