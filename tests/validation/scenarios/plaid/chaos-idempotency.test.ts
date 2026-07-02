import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertMonotonicCursor, runPlaidSyncChaosHarness } from '../../harness/plaid/PlaidSyncHarness';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function writeChaosReport(markdown: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const reportPath = path.resolve(__dirname, '../../CHAOS_REPORT.md');
  await fs.writeFile(reportPath, markdown, 'utf8');
}

function toMarkdown(data: {
  seed: number;
  iterations: number;
  baselineCursor: string | null;
  chaosCursor: string | null;
  baselineNodeCents: number;
  chaosNodeCents: number;
  baselineTxCount: number;
  chaosTxCount: number;
  chaosSummary: Record<string, unknown>;
}) {
  return [
    '# Chaos Report',
    '',
    '## Configuration',
    '',
    `- Seed: \`${data.seed}\``,
    `- Iterations: \`${data.iterations}\``,
    '',
    '## Assertions',
    '',
    `- Final DB state identical: \`${data.baselineTxCount === data.chaosTxCount}\``,
    `- Balances/node values identical: \`${data.baselineNodeCents === data.chaosNodeCents}\``,
    `- Cursor only advanced forward: \`true\``,
    `- No duplicate final rows: \`true\``,
    '',
    '## State Summary',
    '',
    `- Baseline cursor: \`${String(data.baselineCursor)}\``,
    `- Chaos cursor: \`${String(data.chaosCursor)}\``,
    `- Baseline node value (cents): \`${data.baselineNodeCents}\``,
    `- Chaos node value (cents): \`${data.chaosNodeCents}\``,
    `- Baseline tx rows: \`${data.baselineTxCount}\``,
    `- Chaos tx rows: \`${data.chaosTxCount}\``,
    '',
    '## Chaos Summary',
    '',
    '```json',
    JSON.stringify(data.chaosSummary, null, 2),
    '```',
    ''
  ].join('\n');
}

async function run() {
  const seed = Number(process.env.CHAOS_SEED || 1337);
  const iterations = Number(process.env.CHAOS_ITERATIONS || 8);
  const chaosMode = String(process.env.CHAOS_MODE || 'true').toLowerCase() === 'true';

  const baseline = await runPlaidSyncChaosHarness({
    chaosMode: false,
    seed,
    iterations
  });
  const chaos = await runPlaidSyncChaosHarness({
    chaosMode,
    seed,
    iterations
  });

  assertMonotonicCursor(baseline.cursorHistory);
  assertMonotonicCursor(chaos.cursorHistory);

  assert(
    JSON.stringify(Object.keys(baseline.transactionsById).sort()) ===
      JSON.stringify(Object.keys(chaos.transactionsById).sort()),
    'Final transaction ID set mismatch under chaos mode'
  );
  assert(
    baseline.nodeValueCents === chaos.nodeValueCents,
    `Node value mismatch: baseline=${baseline.nodeValueCents}, chaos=${chaos.nodeValueCents}`
  );
  assert(
    baseline.duplicatesInFinalState === 0 && chaos.duplicatesInFinalState === 0,
    'Duplicate rows detected in final state'
  );
  if (baseline.cursor && chaos.cursor) {
    assert(
      chaos.cursor >= baseline.cursor,
      `Cursor should not move backward: baseline=${baseline.cursor}, chaos=${chaos.cursor}`
    );
  }

  const report = toMarkdown({
    seed,
    iterations,
    baselineCursor: baseline.cursor,
    chaosCursor: chaos.cursor,
    baselineNodeCents: baseline.nodeValueCents,
    chaosNodeCents: chaos.nodeValueCents,
    baselineTxCount: Object.keys(baseline.transactionsById).length,
    chaosTxCount: Object.keys(chaos.transactionsById).length,
    chaosSummary: chaos.chaosSummary
  });
  await writeChaosReport(report);
  console.log('✅ Chaos idempotency validation passed');
}

run().catch((error) => {
  console.error(`❌ Chaos idempotency validation failed: ${error.message}`);
  process.exit(1);
});
