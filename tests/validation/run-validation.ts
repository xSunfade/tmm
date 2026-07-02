import { spawnSync } from 'child_process';
import { enforceProductionGuard } from './harness/productionGuard';

const root = process.cwd();
const scripts = [
  'tests/validation/scenarios/plaid/injectable-workflow.test.ts',
  'tests/validation/scenarios/plaid/workflow-chaos-boundary.test.ts',
  'tests/validation/scenarios/plaid/chaos-idempotency.test.ts',
  'tests/validation/scenarios/simulation/ledger-invariants.test.ts',
  'tests/validation/scenarios/simulation/plan-ledger-integration.test.ts',
  'tests/validation/scenarios/simulation/property-based.test.ts',
  'tests/validation/scenarios/drift/drift-forensics.test.ts',
  'tests/validation/scenarios/time/time-boundary.test.ts',
  'tests/validation/scenarios/stripe/stripe-upgrade-validation.test.ts',
  'tests/validation/scenarios/stress/stress-test.ts',
  'tests/validation/scenarios/guards/production-guard.test.ts'
];

function runTsx(scriptPath: string) {
  const command = `npx tsx "${scriptPath}"`;
  const result = spawnSync(command, [], {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`Validation step failed: ${scriptPath}`);
  }
}

function main() {
  const plaidEnv = String(process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const guardEnabled = String(process.env.PRODUCTION_GUARD || 'true').toLowerCase() === 'true';
  const acknowledged = String(process.env.I_ACK_PROD || 'false').toLowerCase() === 'true';
  const estimatedCalls = Number(process.env.ESTIMATED_API_CALLS || scripts.length * 4);
  const maxCalls = Number(process.env.PROD_MAX_API_CALLS || 300);
  enforceProductionGuard({ plaidEnv, guardEnabled, acknowledged, estimatedCalls, maxCalls });

  console.log('Running validation harness...');
  for (const script of scripts) {
    if (script.includes('/stress/') && String(process.env.RUN_DB_VALIDATION || 'false').toLowerCase() !== 'true') {
      console.log(`Skipping opt-in DB/stress suite: ${script}`);
      continue;
    }
    if (script.includes('/stripe/') && String(process.env.RUN_STRIPE_VALIDATION || 'false').toLowerCase() !== 'true') {
      console.log(`Skipping opt-in Stripe suite: ${script}`);
      continue;
    }
    runTsx(script);
  }

  if (String(process.env.RUN_PLAYWRIGHT_PARITY || 'false').toLowerCase() === 'true') {
    const result = spawnSync('npx playwright test -c tests/validation/playwright.config.ts', [], {
      shell: true,
      cwd: root,
      stdio: 'inherit',
      env: process.env
    });
    if (result.status !== 0) {
      throw new Error('Playwright parity step failed');
    }
  }

  console.log('\nValidation artifacts:');
  console.log('- tests/validation/CHAOS_REPORT.md');
  console.log('- tests/validation/SIMULATION_PROPERTY_TESTS.md');
  console.log('- tests/validation/DRIFT_FORENSICS_REPORT.md');
  console.log('- tests/validation/TIME_BOUNDARY_TESTS.md');
  console.log('- tests/validation/STRIPE_VALIDATION_REPORT.md');
  console.log('- tests/validation/ROUNDING_POLICY.md');
  console.log('- tests/validation/UI_PARITY_REPORT.md');
  console.log('- tests/validation/STRESS_TEST_RESULTS.md');
}

main();
