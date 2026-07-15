import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fc from 'fast-check';
import {
  aggregateDailyNetWorthByMonth,
  positionValueCents,
  runLedgerScenario,
  type LedgerAccountInput,
  type LedgerScenario,
  type RecurringFlow
} from '../../../../frontend/src/lib/simulation/ledger';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function toBigIntCents(n: number): bigint {
  return BigInt(Math.round(n));
}

function eventImpactOnNetWorth(kind: LedgerAccountInput['kind'], delta: bigint): bigint {
  return kind === 'debt' ? -delta : delta;
}

function buildArbitraryScenario() {
  return fc.record({
    days: fc.integer({ min: 30, max: 180 }),
    cashStart: fc.integer({ min: 0, max: 500_000_00 }),
    assetStart: fc.integer({ min: 0, max: 800_000_00 }),
    debtStart: fc.integer({ min: 0, max: 400_000_00 }),
    assetRatePpm: fc.integer({ min: 0, max: 120_000 }),
    debtRatePpm: fc.integer({ min: 0, max: 220_000 }),
    incomeCents: fc.integer({ min: 10_000, max: 600_000 }),
    expenseCents: fc.integer({ min: 5_000, max: 450_000 }),
    transferCents: fc.integer({ min: 0, max: 200_000 }),
    augmentCents: fc.integer({ min: 0, max: 100_000 }),
    augmentStart: fc.integer({ min: 0, max: 60 }),
    incomeFreq: fc.constantFrom('weekly', 'biweekly', 'monthly'),
    expenseFreq: fc.constantFrom('weekly', 'biweekly', 'monthly'),
    positionQuantityMicro: fc.integer({ min: 0, max: 500_000_000 }),
    positionPriceMicroCents: fc.integer({ min: 1_000_000, max: 50_000_000_000 }),
    positionReturnPpm: fc.integer({ min: 0, max: 150_000 }),
    positionContribCents: fc.integer({ min: 0, max: 150_000 })
  }).map((v) => {
    const positionQuantityMicro = BigInt(v.positionQuantityMicro);
    const positionPriceMicroCents = BigInt(v.positionPriceMicroCents);
    const accounts: LedgerAccountInput[] = [
      { id: 'cash', kind: 'cash', balanceCents: toBigIntCents(v.cashStart) },
      { id: 'asset', kind: 'asset', balanceCents: toBigIntCents(v.assetStart), annualRatePpm: BigInt(v.assetRatePpm) },
      { id: 'debt', kind: 'debt', balanceCents: toBigIntCents(v.debtStart), annualRatePpm: BigInt(v.debtRatePpm), allowNegative: false },
      {
        id: 'position',
        kind: 'asset',
        balanceCents: positionValueCents(positionQuantityMicro, positionPriceMicroCents),
        position: {
          quantityMicro: positionQuantityMicro,
          priceMicroCents: positionPriceMicroCents,
          annualReturnPpm: BigInt(v.positionReturnPpm)
        }
      }
    ];
    const flows: RecurringFlow[] = [
      { id: 'income', type: 'income', amountCents: toBigIntCents(v.incomeCents), frequency: v.incomeFreq as any },
      { id: 'expense', type: 'expense', amountCents: toBigIntCents(v.expenseCents), frequency: v.expenseFreq as any },
      { id: 'transfer', type: 'transfer', amountCents: toBigIntCents(v.transferCents), frequency: 'monthly', fromAccountId: 'cash', toAccountId: 'asset' },
      { id: 'position-contrib', type: 'transfer', amountCents: toBigIntCents(v.positionContribCents), frequency: 'monthly', fromAccountId: 'cash', toAccountId: 'position' },
      { id: 'augment-income', type: 'income', amountCents: toBigIntCents(v.augmentCents), frequency: 'weekly', startDayIndex: v.augmentStart }
    ];
    const scenario: LedgerScenario = {
      startDate: '2026-01-01',
      days: v.days,
      accounts,
      recurringFlows: flows
    };
    return scenario;
  });
}

async function writeFailFast(seed: number, error: Error) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.resolve(__dirname, '../../artifacts/simulation_property_fail_fast.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        seed,
        message: error.message,
        timestamp: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );
}

async function run() {
  const configuredSeed = Number(process.env.SIM_PROP_SEED || 424242);
  const numRuns = Number(process.env.SIM_PROP_RUNS || 1000);

  try {
    fc.assert(
      fc.property(buildArbitraryScenario(), (scenario) => {
        const result = runLedgerScenario(scenario);

        // No duplicate event IDs.
        const ids = result.events.map((e) => e.id);
        assert(ids.length === new Set(ids).size, 'event duplicated');

        // Transfers net to zero globally.
        const transferByGroup = new Map<string, bigint>();
        for (const event of result.events) {
          if (!event.groupId) continue;
          transferByGroup.set(event.groupId, (transferByGroup.get(event.groupId) || 0n) + event.deltaCents);
        }
        for (const [groupId, sum] of transferByGroup.entries()) {
          assert(sum === 0n, `transfer group non-zero: ${groupId}`);
        }

        // Integer-cent invariant.
        for (const event of result.events) {
          assert(typeof event.deltaCents === 'bigint', 'delta is not integer cents');
        }

        // Conservation by day.
        const accountKind = new Map(scenario.accounts.map((a) => [a.id, a.kind]));
        const impactByDay = new Map<number, bigint>();
        for (const event of result.events) {
          const kind = accountKind.get(event.accountId) || 'cash';
          const impact = eventImpactOnNetWorth(kind, event.deltaCents);
          impactByDay.set(event.dayIndex, (impactByDay.get(event.dayIndex) || 0n) + impact);
        }
        for (let i = 1; i < result.netWorthByDay.length; i += 1) {
          const prior = result.netWorthByDay[i - 1].valueCents;
          const next = result.netWorthByDay[i].valueCents;
          const observedDelta = next - prior;
          const expectedDelta = impactByDay.get(i) || 0n;
          assert(observedDelta === expectedDelta, `conservation failed at day ${i}`);
        }

        // Monthly aggregate parity.
        const byMonth = aggregateDailyNetWorthByMonth(result.netWorthByDay);
        for (const month of result.monthlyAggregates) {
          assert(byMonth.get(month.month) === month.netWorthEndCents, `monthly mismatch ${month.month}`);
        }

        // Rounding loss policy.
        assert(result.cumulativeRoundingLossCents === 0n, 'rounding loss drifted from zero');

        // Position invariant (D4, PositionSemantics.md): final balance == qty × price.
        for (const report of result.positions) {
          const recomputed = positionValueCents(report.quantityMicro, report.priceMicroCents);
          assert(report.valueCents === recomputed, 'position report value is not qty × price');
          const finalBalances = result.dailyBalances[result.dailyBalances.length - 1];
          assert(
            finalBalances[report.accountId] === recomputed,
            'position balance drifted from qty × price'
          );
        }
      }),
      {
        numRuns,
        seed: configuredSeed,
        endOnFailure: true
      }
    );
    console.log(`✅ Simulation property tests passed (${numRuns} runs, seed ${configuredSeed})`);
  } catch (error) {
    await writeFailFast(configuredSeed, error as Error);
    throw error;
  }
}

run().catch((error) => {
  console.error(`❌ Simulation property tests failed: ${(error as Error).message}`);
  process.exit(1);
});
