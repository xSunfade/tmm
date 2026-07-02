import { createCallTracker, enforceProductionGuard } from '../../harness/productionGuard';
import { runPlaidSyncChaosHarness } from '../../harness/plaid/PlaidSyncHarness';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  // Guard must fail in production without explicit ack.
  let failedAsExpected = false;
  try {
    enforceProductionGuard({
      plaidEnv: 'production',
      guardEnabled: true,
      acknowledged: false,
      estimatedCalls: 50,
      maxCalls: 100
    });
  } catch {
    failedAsExpected = true;
  }
  assert(failedAsExpected, 'Expected production guard to block without ack');

  // Guard must fail when estimated calls exceed budget.
  failedAsExpected = false;
  try {
    enforceProductionGuard({
      plaidEnv: 'production',
      guardEnabled: true,
      acknowledged: true,
      estimatedCalls: 1000,
      maxCalls: 100
    });
  } catch {
    failedAsExpected = true;
  }
  assert(failedAsExpected, 'Expected production guard to block over-budget runs');

  // Mock mode must never allow live calls.
  const tracker = createCallTracker('mock');
  let blocked = false;
  try {
    tracker.track('POST', '/transactions/sync');
  } catch {
    blocked = true;
  }
  assert(blocked, 'Expected live-call tracker to block in mock mode');

  // Reconciliation transparency log coverage.
  const run = await runPlaidSyncChaosHarness({ chaosMode: true, seed: 2026, iterations: 4 });
  const reasons = new Set(run.reconciliationLog.map((r) => r.reason));
  assert(reasons.has('added') || reasons.has('modified_or_replayed'), 'Missing add/modify reconciliation logs');
  assert(reasons.has('removed'), 'Missing remove reconciliation logs');
  for (const row of run.reconciliationLog) {
    assert(typeof row.previousCents === 'number', 'previous value missing');
    assert(typeof row.nextCents === 'number', 'new value missing');
    assert(typeof row.reason === 'string' && row.reason.length > 0, 'reason missing');
  }

  console.log('✅ Production guard and reconciliation log tests passed');
}

run().catch((error) => {
  console.error(`❌ Production guard/reconciliation tests failed: ${error.message}`);
  process.exit(1);
});
