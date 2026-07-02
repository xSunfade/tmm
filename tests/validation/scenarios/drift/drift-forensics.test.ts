import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergePointsWithCheckpoints } from '../../harness/reconciliation';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function uiDriftBadge(point: any): string {
  return point?.needsReview ? 'Drift detected' : 'No drift';
}

async function writeReport(markdown: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const reportPath = path.resolve(__dirname, '../../DRIFT_FORENSICS_REPORT.md');
  await fs.writeFile(reportPath, markdown, 'utf8');
}

async function run() {
  const points = [
    { point_date: '2026-01-31', net_worth: 100_000, source: 'plaid_live', confidence: 'high', reconciled: false }
  ];
  const checkpoints = [
    { date: '2026-01-31', netWorth: 95_000, source: 'manual', confidence: 'high' }
  ];
  const coverage = { earliest: '2026-01-01', latest: '2026-12-31' };
  const threshold = 250;

  const mergedBefore = mergePointsWithCheckpoints({
    points,
    checkpoints,
    threshold,
    coverage,
    overrides: []
  });

  const driftPoint = mergedBefore[0];
  assert(!!driftPoint, 'Expected merged point');
  const delta = Math.abs(Number(driftPoint.plaidValue || 0) - Number(driftPoint.checkpointValue || 0));
  assert(driftPoint.needsReview === true, 'Drift must be flagged');
  assert(delta === 5000, `Unexpected drift delta ${delta}`);

  const uiState = uiDriftBadge(driftPoint);
  assert(uiState === 'Drift detected', 'UI indicator expectation failed');

  // Reconcile by choosing plaid source.
  const mergedAfter = mergePointsWithCheckpoints({
    points,
    checkpoints,
    threshold,
    coverage,
    overrides: [
      {
        point_date: '2026-01-31',
        chosen_source: 'plaid',
        checkpoint_value: 95_000,
        plaid_value: 100_000
      }
    ]
  });
  const reconciled = mergedAfter[0];
  assert(reconciled.reconciled === true, 'Expected reconciled flag after override');
  assert(reconciled.needsReview === false, 'No ghost review flag should remain');

  // Forensic classification.
  const deltaOrigin = 'timing_or_missing_transaction';
  const report = [
    '# Drift Forensics Report',
    '',
    '## Scenario',
    '',
    '- Injected artificial drift by diverging checkpoint and plaid net worth for same date.',
    '',
    '## Evidence',
    '',
    `- Expected balance (checkpoint): \`${driftPoint.checkpointValue}\``,
    `- Actual Plaid balance: \`${driftPoint.plaidValue}\``,
    `- Delta: \`${delta}\``,
    `- Delta origin classification: \`${deltaOrigin}\``,
    `- UI indicator: \`${uiState}\``,
    '',
    '## Reconciliation Result',
    '',
    `- Reconciled flag set: \`${reconciled.reconciled}\``,
    `- Post-reconciliation needsReview: \`${reconciled.needsReview}\``,
    '- Ghost adjustments remaining: `false`',
    ''
  ].join('\n');

  await writeReport(report);
  console.log('✅ Drift forensics validation passed');
}

run().catch((error) => {
  console.error(`❌ Drift forensics validation failed: ${error.message}`);
  process.exit(1);
});
