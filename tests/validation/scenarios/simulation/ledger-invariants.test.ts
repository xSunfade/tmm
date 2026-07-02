import { aggregateDailyNetWorthByMonth, runLedgerScenario, type LedgerScenario } from '../../../../frontend/src/lib/simulation/ledger';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function bankersRoundRational(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  const q = abs / denominator;
  const r = abs % denominator;
  const doubled = r * 2n;
  let rounded = q;
  if (doubled > denominator) rounded = q + 1n;
  else if (doubled === denominator && q % 2n !== 0n) rounded = q + 1n;
  return rounded * sign;
}

function closedFormCompound(principalCents: bigint, annualRatePpm: bigint, years: number): bigint {
  const days = BigInt(Math.round(years * 365)) + 1n;
  let value = principalCents;
  const denom = 1_000_000n * 365n;
  let residual = 0n;
  for (let i = 0n; i < days; i += 1n) {
    const numer = value * annualRatePpm + residual;
    const interest = bankersRoundRational(numer, denom);
    residual = numer - interest * denom;
    value += interest;
  }
  return value;
}

async function run() {
  const scenario: LedgerScenario = {
    startDate: '2026-01-01',
    days: 365 * 10,
    accounts: [
      { id: 'cash', kind: 'cash', balanceCents: 0n },
      { id: 'invest', kind: 'asset', balanceCents: 100_000_00n, annualRatePpm: 50_000n }
    ],
    recurringFlows: [
      { id: 'salary', type: 'income', amountCents: 300_000n, frequency: 'biweekly' },
      { id: 'bills', type: 'expense', amountCents: 180_000n, frequency: 'monthly' },
      { id: 'invest-transfer', type: 'transfer', amountCents: 50_000n, frequency: 'monthly', fromAccountId: 'cash', toAccountId: 'invest' }
    ]
  };

  const result = runLedgerScenario(scenario);
  const ids = new Set(result.events.map((e) => e.id));
  assert(ids.size === result.events.length, 'Duplicate event IDs detected');
  assert(result.cumulativeRoundingLossCents === 0n, 'Cumulative rounding error must be zero');

  // Transfer symmetry: out + in for same group must sum to zero.
  const transferSums = new Map<string, bigint>();
  for (const event of result.events) {
    if (!event.groupId) continue;
    transferSums.set(event.groupId, (transferSums.get(event.groupId) || 0n) + event.deltaCents);
  }
  for (const [groupId, sum] of transferSums.entries()) {
    assert(sum === 0n, `Transfer group ${groupId} does not net to zero`);
  }

  // Monthly aggregate parity with daily ledger map.
  const fromDaily = aggregateDailyNetWorthByMonth(result.netWorthByDay);
  for (const month of result.monthlyAggregates) {
    const fromDailyValue = fromDaily.get(month.month);
    assert(
      fromDailyValue === month.netWorthEndCents,
      `Monthly aggregate mismatch for ${month.month}`
    );
  }

  // Closed-form style long-run interest sanity check for no-flow case.
  const noFlowScenario: LedgerScenario = {
    startDate: '2026-01-01',
    days: 365 * 10,
    accounts: [{ id: 'savings', kind: 'asset', balanceCents: 50_000_00n, annualRatePpm: 45_000n }],
    recurringFlows: []
  };
  const noFlowResult = runLedgerScenario(noFlowScenario);
  const observed = noFlowResult.dailyBalances[noFlowResult.dailyBalances.length - 1].savings;
  const expectedApprox = closedFormCompound(50_000_00n, 45_000n, 10);
  const delta = observed > expectedApprox ? observed - expectedApprox : expectedApprox - observed;
  assert(delta === 0n, `Closed-form check drifted by ${delta} cents`);

  console.log('✅ Ledger invariant suite passed');
}

run().catch((error) => {
  console.error(`❌ Ledger invariant suite failed: ${error.message}`);
  process.exit(1);
});
