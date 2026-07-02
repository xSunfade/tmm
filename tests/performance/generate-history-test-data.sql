-- History Test Data Seed (Supabase local)
-- Purpose: deterministic baseline data for history/reconciliation e2e scripts.
-- Safe to re-run (uses upsert/conflict guards).
--
-- Preconditions:
-- 1) Apply migrations through 012.
-- 2) At least one row exists in public.profiles (preferably plan_tier='tmm_plus').
-- 3) Run in Supabase local SQL editor or psql connected to local DB.

-- Pick one deterministic test user from profiles.
WITH selected_user AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC
  LIMIT 1
)
-- Ensure there is at least one plaid token row for coverage metadata.
INSERT INTO public.plaid_tokens (item_id, user_id, access_token, earliest_txn_date_seen, latest_txn_date_seen)
SELECT
  'item_history_seed_1',
  su.id,
  'seed_access_token_history_1',
  DATE '2024-01-01',
  DATE '2025-12-31'
FROM selected_user su
ON CONFLICT (item_id)
DO UPDATE SET
  user_id = EXCLUDED.user_id,
  earliest_txn_date_seen = EXCLUDED.earliest_txn_date_seen,
  latest_txn_date_seen = EXCLUDED.latest_txn_date_seen;

WITH selected_user AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC
  LIMIT 1
)
-- Ensure there is at least one account row.
INSERT INTO public.accounts (
  user_id,
  plaid_item_id,
  plaid_account_id,
  name,
  type,
  subtype,
  balance,
  currency_code,
  last_synced_at,
  persistent_account_id,
  mask
)
SELECT
  su.id,
  'item_history_seed_1',
  'plaid_account_history_seed_1',
  'History Seed Checking',
  'depository',
  'checking',
  2500.00,
  'USD',
  NOW(),
  'persist_history_seed_1',
  '1234'
FROM selected_user su
ON CONFLICT (user_id, plaid_account_id)
DO UPDATE SET
  balance = EXCLUDED.balance,
  last_synced_at = EXCLUDED.last_synced_at;

-- Snapshot rows at fixed monthly as_of timestamps.
WITH selected_user AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC
  LIMIT 1
),
selected_account AS (
  SELECT a.id, a.user_id
  FROM public.accounts a
  JOIN selected_user su ON su.id = a.user_id
  WHERE a.plaid_account_id = 'plaid_account_history_seed_1'
  LIMIT 1
),
seed_points AS (
  SELECT *
  FROM (VALUES
    ('2025-01-31T23:59:59Z'::timestamptz, 1500.00::numeric),
    ('2025-02-28T23:59:59Z'::timestamptz, 1700.00::numeric),
    ('2025-03-31T23:59:59Z'::timestamptz, 1800.00::numeric),
    ('2025-04-30T23:59:59Z'::timestamptz, 2000.00::numeric)
  ) AS t(as_of, balance)
)
INSERT INTO public.account_balance_snapshots (
  user_id,
  account_id,
  as_of,
  balance,
  available,
  currency_code,
  source
)
SELECT
  sa.user_id,
  sa.id,
  sp.as_of,
  sp.balance,
  sp.balance,
  'USD',
  'plaid'
FROM selected_account sa
CROSS JOIN seed_points sp
ON CONFLICT (account_id, as_of)
DO UPDATE SET
  balance = EXCLUDED.balance,
  available = EXCLUDED.available,
  source = EXCLUDED.source;

-- Precomputed net worth points.
WITH selected_user AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC
  LIMIT 1
),
seed_net_worth AS (
  SELECT *
  FROM (VALUES
    ('2025-01-31'::date, 1500.00::numeric, 'plaid_archived'::text, 'high'::text, false),
    ('2025-02-28'::date, 1700.00::numeric, 'plaid_archived'::text, 'high'::text, false),
    ('2025-03-31'::date, 1800.00::numeric, 'plaid_live'::text, 'high'::text, false),
    ('2025-04-30'::date, 2000.00::numeric, 'plaid_live'::text, 'high'::text, false)
  ) AS t(point_date, net_worth, source, confidence, reconciled)
)
INSERT INTO public.net_worth_points (
  user_id,
  point_date,
  net_worth,
  source,
  confidence,
  reconciled,
  metadata
)
SELECT
  su.id,
  snw.point_date,
  snw.net_worth,
  snw.source,
  snw.confidence,
  snw.reconciled,
  jsonb_build_object('seed', true, 'fixture', 'history_local')
FROM selected_user su
CROSS JOIN seed_net_worth snw
ON CONFLICT (user_id, point_date)
DO UPDATE SET
  net_worth = EXCLUDED.net_worth,
  source = EXCLUDED.source,
  confidence = EXCLUDED.confidence,
  reconciled = EXCLUDED.reconciled,
  metadata = EXCLUDED.metadata;

-- Optional seed override date to exercise GET merge behavior.
WITH selected_user AS (
  SELECT id
  FROM public.profiles
  ORDER BY created_at ASC
  LIMIT 1
)
INSERT INTO public.history_reconciliation_overrides (
  user_id,
  point_date,
  chosen_source,
  checkpoint_value,
  plaid_value,
  reason
)
SELECT
  su.id,
  DATE '2025-03-31',
  'plaid',
  1500.00,
  1800.00,
  'seed baseline override'
FROM selected_user su
ON CONFLICT (user_id, point_date)
DO UPDATE SET
  chosen_source = EXCLUDED.chosen_source,
  checkpoint_value = EXCLUDED.checkpoint_value,
  plaid_value = EXCLUDED.plaid_value,
  reason = EXCLUDED.reason;

-- Summary
SELECT 'plaid_tokens' AS table_name, COUNT(*)::bigint AS row_count FROM public.plaid_tokens WHERE item_id = 'item_history_seed_1'
UNION ALL
SELECT 'accounts', COUNT(*)::bigint FROM public.accounts WHERE plaid_account_id = 'plaid_account_history_seed_1'
UNION ALL
SELECT 'account_balance_snapshots', COUNT(*)::bigint FROM public.account_balance_snapshots abs
JOIN public.accounts a ON a.id = abs.account_id
WHERE a.plaid_account_id = 'plaid_account_history_seed_1'
UNION ALL
SELECT 'net_worth_points', COUNT(*)::bigint FROM public.net_worth_points nwp
JOIN public.profiles p ON p.id = nwp.user_id
WHERE nwp.metadata ->> 'fixture' = 'history_local'
UNION ALL
SELECT 'history_reconciliation_overrides', COUNT(*)::bigint FROM public.history_reconciliation_overrides
WHERE reason = 'seed baseline override';
