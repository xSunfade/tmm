/**
 * Generate SQL to seed net_worth_points_alt using baseline fixture history.
 *
 * Usage:
 *   npx tsx frontend/scripts/generate-baseline-history.ts > baseline-history.sql
 *
 * Then:
 *   1) Replace __USER_ID__ in the generated SQL with your test user's UUID.
 *   2) Run the SQL in Supabase SQL Editor.
 *   3) Use a TMM+ test account and a plan that includes alt "Baseline" so chart history can render.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_PLAN_STATE } from '../src/lib/plan/defaults';
import type { PlanState } from '../src/lib/plan/types';
import { runSimulationFromLedger } from '../src/lib/simulation/ledger';

type Fixture = {
  runYears?: number;
  granularity?: 'monthly' | 'daily';
  plan?: Partial<PlanState>;
};

type SqlRow = {
  userId: string;
  alt: string;
  pointDate: string;
  netWorth: number;
  source: 'tmm_total';
  confidence: 'high';
};

const USER_ID_PLACEHOLDER = '__USER_ID__';
const FIXED_RUN_YEARS = 3;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(2)).toString();
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturePath = path.resolve(__dirname, '../src/dev/parity/fixtures/baseline.json');
  const fixtureRaw = await fs.readFile(fixturePath, 'utf8');
  const fixture = JSON.parse(fixtureRaw) as Fixture;

  const mergedPlan = {
    ...DEFAULT_PLAN_STATE,
    ...(fixture.plan || {})
  } as PlanState;

  const simulation = runSimulationFromLedger(mergedPlan, FIXED_RUN_YEARS, 'monthly', {
    monteCarloRuns: 1
  });

  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);

  const rows: SqlRow[] = [];
  for (const series of simulation.series || []) {
    for (const point of series.points || []) {
      if (point.date.getTime() > today.getTime()) continue;
      rows.push({
        userId: USER_ID_PLACEHOLDER,
        alt: series.alt,
        pointDate: point.date.toISOString().slice(0, 10),
        netWorth: point.value,
        source: 'tmm_total',
        confidence: 'high'
      });
    }
  }

  rows.sort((a, b) => {
    if (a.alt !== b.alt) return a.alt.localeCompare(b.alt);
    return a.pointDate.localeCompare(b.pointDate);
  });

  if (!rows.length) {
    console.log('-- No rows produced. Verify fixture and simulation inputs.');
    return;
  }

  console.log('-- Generated baseline history seed for net_worth_points_alt');
  console.log('-- Replace __USER_ID__ with your test user UUID before running.\n');
  console.log('BEGIN;\n');
  console.log(
    'INSERT INTO net_worth_points_alt (user_id, alt, point_date, net_worth, source, confidence) VALUES'
  );
  rows.forEach((row, index) => {
    const suffix = index === rows.length - 1 ? '' : ',';
    console.log(
      `  (${sqlString(row.userId)}::uuid, ${sqlString(row.alt)}, ${sqlString(row.pointDate)}::date, ${sqlNumber(row.netWorth)}, ${sqlString(row.source)}, ${sqlString(row.confidence)})${suffix}`
    );
  });
  console.log('ON CONFLICT (user_id, alt, point_date) DO UPDATE');
  console.log('SET net_worth = EXCLUDED.net_worth,');
  console.log('    source = EXCLUDED.source,');
  console.log('    confidence = EXCLUDED.confidence,');
  console.log('    updated_at = NOW();\n');
  console.log('COMMIT;');
}

main().catch((error) => {
  console.error('-- Failed to generate baseline history seed SQL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
