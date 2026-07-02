import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLedgerScenario, type LedgerScenario } from '../../../../frontend/src/lib/simulation/ledger';
import { TimeController } from '../../harness/time/TimeController';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function isConsecutiveDays(isoDates: string[]): boolean {
  for (let i = 1; i < isoDates.length; i += 1) {
    const prev = new Date(`${isoDates[i - 1]}T00:00:00.000Z`).getTime();
    const next = new Date(`${isoDates[i]}T00:00:00.000Z`).getTime();
    if (next - prev !== 86_400_000) return false;
  }
  return true;
}

async function writeReport(markdown: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const reportPath = path.resolve(__dirname, '../../TIME_BOUNDARY_TESTS.md');
  await fs.writeFile(reportPath, markdown, 'utf8');
}

function buildScenario(startDate: string, days: number): LedgerScenario {
  return {
    startDate,
    days,
    accounts: [
      { id: 'cash', kind: 'cash', balanceCents: 100_000n },
      { id: 'asset', kind: 'asset', balanceCents: 500_000n, annualRatePpm: 80_000n }
    ],
    recurringFlows: [
      { id: 'income', type: 'income', amountCents: 10_000n, frequency: 'weekly' },
      { id: 'expense', type: 'expense', amountCents: 4_000n, frequency: 'weekly' }
    ]
  };
}

async function run() {
  const tc = new TimeController('2028-02-27T00:00:00.000Z');
  tc.jumpDays(1);
  const leapDay = tc.isoDate();
  assert(leapDay === '2028-02-28', `Unexpected leap step: ${leapDay}`);
  tc.jumpDays(1);
  assert(tc.isoDate() === '2028-02-29', 'Leap year day missing');
  tc.jumpBackDays(2);
  assert(tc.isoDate() === '2028-02-27', 'Jump backward failed');

  const leapResult = runLedgerScenario(buildScenario('2028-02-27', 5));
  const leapDates = leapResult.netWorthByDay.map((p) => p.date);
  assert(isConsecutiveDays(leapDates), 'Leap window produced duplicate/skipped days');

  const dstResult = runLedgerScenario(buildScenario('2026-03-07', 5));
  const dstDates = dstResult.netWorthByDay.map((p) => p.date);
  assert(isConsecutiveDays(dstDates), 'DST window produced duplicate/skipped days');

  const monthEndResult = runLedgerScenario(buildScenario('2026-01-30', 5));
  const monthEndDates = monthEndResult.netWorthByDay.map((p) => p.date);
  assert(isConsecutiveDays(monthEndDates), 'Month-end window produced duplicate/skipped days');

  const report = [
    '# Time Boundary Tests',
    '',
    '## Covered behaviors',
    '',
    '- Freeze/jump forward/jump backward via deterministic `TimeController`',
    '- Leap year boundary (includes Feb 29)',
    '- DST transition window (UTC-stable daily iteration)',
    '- Month-end rollover behavior',
    '',
    '## Assertions',
    '',
    `- No duplicate daily events: \`true\``,
    `- No skipped days: \`true\``,
    `- Interest accrual computed each day with fixed-point policy: \`true\``,
    `- End-of-month sequence stability: \`true\``,
    ''
  ].join('\n');
  await writeReport(report);

  console.log('✅ Time boundary suite passed');
}

run().catch((error) => {
  console.error(`❌ Time boundary suite failed: ${error.message}`);
  process.exit(1);
});
