// Plan schema migration tests (Phase 3.1, D4 / ADR-2, DATA-2 discipline):
// every historical plan shape must migrate losslessly to the current version.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { migratePlan, CURRENT_PLAN_SCHEMA_VERSION } from '../../frontend/src/lib/plan/migrations';
import { buildDomainModel } from '../../frontend/src/lib/domain/fromPlan';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual: number, expected: number, tolerance = 1e-9) {
  return Math.abs(actual - expected) <= tolerance;
}

async function loadFixture(name: string): Promise<unknown> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturePath = path.resolve(__dirname, `../fixtures/plans/historical/${name}`);
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

async function testV1PlanMigratesLosslessly() {
  const raw = await loadFixture('v1-plan.json');
  const plan = migratePlan(raw);

  assert(plan.schemaVersion === CURRENT_PLAN_SCHEMA_VERSION, 'v1 plan not stamped to current version');
  const alt = plan.alternatives.Baseline;
  assert(alt.income.length === 1 && alt.income[0].amount === 5000, 'v1 income lost');
  assert(alt.expense.length === 1 && alt.expense[0].amount === 1800, 'v1 expense lost');
  assert(alt.asset.length === 1 && alt.asset[0].value === 12000, 'v1 asset lost');
  assert(alt.debt.length === 1 && alt.debt[0].bal === 9000, 'v1 debt lost');
  assert(!!alt.income[0].uuid, 'v1 rows did not receive uuids');
  assert(plan.assumptions.inflation === 2.5, 'v1 assumptions lost');
  assert(!!plan.pipeline.byAlt.Baseline, 'v1 pipeline shape not initialized');
}

async function testV2PlanMigratesLosslessly() {
  const raw = await loadFixture('v2-plan.json');
  const plan = migratePlan(raw);

  assert(plan.schemaVersion === CURRENT_PLAN_SCHEMA_VERSION, 'v2 plan not stamped to current version');

  // Entities preserved across both alternatives.
  const alt = plan.alternatives.Baseline;
  assert(alt.income.length === 1 && alt.income[0].uuid === 'inc-1', 'v2 income lost');
  assert(alt.expense.length === 1, 'v2 expense lost');
  assert(alt.asset.length === 4, 'v2 assets lost');
  assert(alt.debt.length === 1, 'v2 debts lost');
  assert(Object.keys(plan.alternatives).length === 2, 'v2 alternatives lost');

  // Ticker row with explicit quantity: untouched, no review flag.
  const withQty = alt.asset.find((a) => a.uuid === 'asset-ticker-qty')!;
  assert(withQty.quantity === 100, 'explicit quantity was modified');
  assert(withQty.positionNeedsReview !== true, 'explicit quantity wrongly flagged for review');
  assert(Array.isArray(withQty.acquisitions), 'acquisitions not initialized on ticker row');

  // Ticker row without quantity: derived from value ÷ liveprice, flagged for review.
  const noQty = alt.asset.find((a) => a.uuid === 'asset-ticker-noqty')!;
  assert(approxEqual(noQty.quantity || 0, 5000 / 250), 'quantity not derived from value ÷ price');
  assert(noQty.positionNeedsReview === true, 'derived quantity not flagged for review');
  assert(noQty.value === 5000, 'original value overwritten (not lossless)');

  // Non-ticker rows untouched.
  const apyRow = alt.asset.find((a) => a.uuid === 'asset-apy')!;
  assert(apyRow.acquisitions === undefined, 'acquisitions wrongly added to APY row');

  // Checkpoints, augments (incl. unsupported activation types), goals, pipeline preserved.
  assert(plan.checkpoints.Baseline?.length === 1, 'checkpoints lost');
  assert(plan.checkpoints.Baseline[0].netWorth === 46200, 'checkpoint contents changed');
  assert(plan.augments.length === 2, 'augments lost');
  assert(
    plan.augments.some((a) => a.activation.type === 'recurring'),
    'unsupported augment activation type dropped (must be lossless)'
  );
  assert(plan.goals.Baseline?.length === 1, 'goals lost');
  assert(plan.pipeline.byAlt.Baseline.edges.length === 1, 'pipeline edges lost');

  // Device-local secret survives migration in the local document (it is stripped
  // at the export/server boundary, not by migration).
  assert(plan.assumptions.finnhubKey === 'test-local-key', 'finnhubKey dropped by migration');
}

async function testMigrationIsIdempotent() {
  const raw = await loadFixture('v2-plan.json');
  const once = migratePlan(raw);
  const twice = migratePlan(JSON.parse(JSON.stringify(once)));
  // forecastSeed regenerates only when the fingerprint changes; the second pass
  // must be a no-op for entities and version.
  assert(twice.schemaVersion === CURRENT_PLAN_SCHEMA_VERSION, 'second migration changed version');
  assert(
    JSON.stringify(twice.alternatives) === JSON.stringify(once.alternatives),
    'second migration mutated entities (not idempotent)'
  );
}

async function testDomainModelMapping() {
  const raw = await loadFixture('v2-plan.json');
  const plan = migratePlan(raw);
  const domain = buildDomainModel({
    alt: plan.alternatives.Baseline,
    assumptions: plan.assumptions
  });

  // Ticker rows with quantity+price become positions; APY/connected rows stay accounts.
  assert(domain.positions.length === 2, `expected 2 positions, got ${domain.positions.length}`);
  const vti = domain.positions.find((p) => p.instrument.symbol === 'VTI')!;
  assert(vti.quantity === 100 && vti.lastObservedPrice === 300, 'position quantity/price mismapped');
  assert(vti.assumedAnnualReturnPct === 8, 'assumed annual return not taken from apy');
  assert(domain.accounts.length === 2, 'APY + connected rows should map to accounts');

  // Income/expense map to directional cash flows; contributions target their asset.
  const inflows = domain.cashFlows.filter((f) => f.direction === 'in');
  const outflows = domain.cashFlows.filter((f) => f.direction === 'out');
  assert(inflows.length === 1 && inflows[0].amount === 6500, 'income cash flow mismapped');
  assert(
    outflows.some((f) => f.targetId === 'asset-ticker-qty' && f.amount === 1000),
    'position contribution cash flow missing'
  );
  assert(domain.debts.length === 1 && domain.debts[0].aprPct === 5.5, 'debt mismapped');
}

async function run() {
  console.log('🧪 Running plan migration suite...\n');

  await testV1PlanMigratesLosslessly();
  console.log('✅ v1 plan migrates losslessly');

  await testV2PlanMigratesLosslessly();
  console.log('✅ v2 plan migrates losslessly (positions derived + flagged)');

  await testMigrationIsIdempotent();
  console.log('✅ migration is idempotent');

  await testDomainModelMapping();
  console.log('✅ domain model mapping (plan → accounts/positions/cashFlows/debts)');

  console.log('\n✅ plan migration suite passed');
}

run().catch((err) => {
  console.error(`\n❌ plan migration suite failed: ${err.message}`);
  process.exit(1);
});
