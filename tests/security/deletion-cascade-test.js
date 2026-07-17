// Deletion Cascade Verification (Phase 4.12 / D24)
//
// Proves that deleting an auth user actually removes every row keyed to
// them across all user-keyed tables — the FK backstop behind the explicit
// delete list in POST /api/privacy/delete-account.
//
// What it does (against the DEV project, service role required):
//   1. Creates a throwaway auth user.
//   2. Seeds rows in a representative set of user-keyed tables.
//   3. Deletes the auth user via the admin API.
//   4. Asserts zero remaining rows for that user id in EVERY user-keyed
//      table (seeded or not), and that invites.redeemed_by was nulled.
//
// Run: node tests/security/deletion-cascade-test.js
// Needs: SUPABASE_URL + SUPABASE_SECRET_KEY (service role). Never run
// against production.

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Every table with a user-keyed column. Cascade must leave zero rows.
// NOTE: `transactions` is intentionally absent — it has no user_id column and
// cascades through accounts (transactions.account_id -> accounts.id ON DELETE
// CASCADE). It is verified separately via a seeded account->transaction chain.
const USER_KEYED_TABLES = [
  { table: 'profiles', column: 'id' },
  { table: 'user_onboarding', column: 'user_id' },
  { table: 'plaid_tokens', column: 'user_id' },
  { table: 'accounts', column: 'user_id' },
  { table: 'google_sheets_tokens', column: 'user_id' },
  { table: 'account_balance_snapshots', column: 'user_id' },
  { table: 'history_reconciliation_overrides', column: 'user_id' },
  { table: 'net_worth_points', column: 'user_id' },
  { table: 'net_worth_points_alt', column: 'user_id' },
  { table: 'plaid_sync_runs', column: 'user_id' },
  { table: 'plaid_webhook_events', column: 'user_id' },
  { table: 'plaid_item_status', column: 'user_id' },
  { table: 'plaid_link_intents', column: 'user_id' },
  { table: 'plaid_sync_jobs', column: 'user_id' },
  { table: 'usage_counters', column: 'user_id' },
  { table: 'privacy_consents', column: 'user_id' },
  { table: 'data_deletion_requests', column: 'user_id' },
  { table: 'plaid_connection_events', column: 'user_id' },
  { table: 'plans', column: 'user_id' },
  { table: 'plan_revisions', column: 'user_id' },
  // Phase 4
  { table: 'audit_log', column: 'user_id' },
  { table: 'waitlist', column: 'user_id' },
  { table: 'oauth_states', column: 'user_id' }
];

// Seeds are best-effort: some tables have NOT NULL columns tied to real
// Plaid/Stripe objects and are hard to fabricate. Every table is still
// VERIFIED post-delete regardless of whether seeding succeeded.
function seedRows(userId) {
  return [
    { table: 'plans', row: { user_id: userId, plan: { seeded: true }, schema_version: 'v3' } },
    { table: 'plan_revisions', row: { user_id: userId, plan: { seeded: true }, schema_version: 'v3', reason: 'save' } },
    { table: 'privacy_consents', row: { user_id: userId, consent_type: 'privacy_policy', policy_version: 'test' } },
    { table: 'data_deletion_requests', row: { user_id: userId, status: 'requested' } },
    { table: 'plaid_item_status', row: { user_id: userId, item_id: `cascade_test_${Date.now()}` } },
    { table: 'audit_log', row: { user_id: userId, action: 'cascade_test', actor: 'system' } },
    { table: 'waitlist', row: { user_id: userId, email: `cascade-test-${Date.now()}@example.com`, kind: 'tmm_plus' } },
    { table: 'oauth_states', row: { nonce: `cascade_test_${Date.now()}`, user_id: userId, purpose: 'google_sheets', expires_at: new Date(Date.now() + 60_000).toISOString() } }
  ];
}

async function main() {
  console.log('🧪 Deletion cascade verification\n');

  const email = `cascade-test-${Date.now()}@example.com`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: `Cascade-${Date.now()}-x!`
  });
  if (createErr || !created?.user) {
    console.error('❌ Could not create throwaway user:', createErr?.message);
    process.exit(1);
  }
  const userId = created.user.id;
  console.log(`created throwaway user ${userId} (${email})`);

  let seeded = 0;
  for (const { table, row } of seedRows(userId)) {
    const { error } = await admin.from(table).insert(row);
    if (error) {
      console.log(`   seed skipped for ${table}: ${error.message}`);
    } else {
      seeded += 1;
      console.log(`   seeded ${table}`);
    }
  }

  // Seed a full account -> transaction chain to exercise the account_id
  // cascade path (transactions have no user_id). Capture ids to verify by id
  // after the user is deleted.
  let seededTxnId = null;
  const uniq = `${Date.now()}`;
  const { data: acct, error: acctErr } = await admin
    .from('accounts')
    .insert({
      user_id: userId,
      plaid_item_id: `cascade_test_item_${uniq}`,
      plaid_account_id: `cascade_test_acct_${uniq}`,
      name: 'Cascade Test Account',
      type: 'depository'
    })
    .select('id')
    .single();
  if (acctErr) {
    console.log(`   seed skipped for accounts->transactions chain: ${acctErr.message}`);
  } else {
    const { data: txn, error: txnErr } = await admin
      .from('transactions')
      .insert({
        account_id: acct.id,
        plaid_transaction_id: `cascade_test_txn_${uniq}`,
        amount: 1.23,
        date: '2026-01-01',
        name: 'Cascade Test Transaction'
      })
      .select('id')
      .single();
    if (txnErr) {
      console.log(`   seed skipped for transactions: ${txnErr.message}`);
    } else {
      seededTxnId = txn.id;
      seeded += 1;
      console.log('   seeded accounts + transactions chain');
    }
  }

  if (seeded < 3) {
    console.error(`❌ Only ${seeded} tables seeded — schema drift? Aborting (deleting throwaway user).`);
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteErr) {
    console.error('❌ deleteUser failed:', deleteErr.message);
    process.exit(1);
  }
  console.log('\ndeleted auth user; verifying cascade...\n');

  let passed = 0;
  let failed = 0;
  for (const { table, column } of USER_KEYED_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, userId);
    if (error) {
      console.log(`❌ ${table}.${column}: query failed (${error.message})`);
      failed++;
    } else if ((count ?? 0) === 0) {
      console.log(`✅ ${table}: no rows remain`);
      passed++;
    } else {
      console.log(`❌ ${table}: ${count} orphaned row(s) remain — cascade gap`);
      failed++;
    }
  }

  // transactions cascade via accounts.account_id, not user_id — verify the
  // seeded transaction row is gone by its own id.
  if (seededTxnId) {
    const { count, error } = await admin
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('id', seededTxnId);
    if (error) {
      console.log(`❌ transactions (by id): query failed (${error.message})`);
      failed++;
    } else if ((count ?? 0) === 0) {
      console.log('✅ transactions: seeded row cascaded via account');
      passed++;
    } else {
      console.log('❌ transactions: seeded row survived account cascade — gap');
      failed++;
    }
  }

  // invites references users via SET NULL, not cascade delete.
  for (const column of ['issued_by', 'redeemed_by']) {
    const { count, error } = await admin
      .from('invites')
      .select('*', { count: 'exact', head: true })
      .eq(column, userId);
    if (error) {
      console.log(`❌ invites.${column}: query failed (${error.message})`);
      failed++;
    } else if ((count ?? 0) === 0) {
      console.log(`✅ invites.${column}: no dangling references`);
      passed++;
    } else {
      console.log(`❌ invites.${column}: ${count} dangling reference(s)`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
