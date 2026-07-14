-- =============================================================================
-- TMM clean baseline (Phase 2.1 — project-roadmap/03-data-model-and-migration-plan.md)
--
-- Replaces the 21 hand-applied legacy migrations in backend/supabase/migrations/
-- (kept for history only). This file captures the verified live dev schema
-- (2026-07-06) with the planned corrections:
--   * no legacy `users` table (DATA-5); all FKs point at auth.users (DATA-4)
--   * strict user-scoped RLS everywhere — no `USING (true)` service-era policies
--     (the backend uses the service-role key, which bypasses RLS entirely)
--   * pinned search_path on every function (advisor finding)
--   * new tables: plans, plan_revisions (ADR-1 / D14 server-side persistence)
--
-- Any environment (dev / staging / prod) must be rebuildable from this file
-- plus later migrations, with zero hand-applied SQL.
-- =============================================================================

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- =============================================================================
-- Functions
-- =============================================================================

-- Generic updated_at maintenance (single function; legacy per-table copies dropped).
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Bootstrap profile + onboarding rows for every new auth user.
create or replace function public.handle_new_auth_user_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  insert into public.profiles (id, plan_tier)
  values (new.id, 'free')
  on conflict (id) do nothing;

  insert into public.user_onboarding (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- =============================================================================
-- Tables (kept from live schema, re-expressed)
-- =============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan_tier text not null default 'free' check (plan_tier in ('free', 'tmm_plus')),
  sheets_nudge_dismissed boolean not null default false,
  last_spreadsheet_id text,
  history_timezone text default 'UTC',
  stripe_customer_id text unique,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
comment on table public.profiles is 'User profile and plan tier; plan_tier free = manual only, tmm_plus = Plaid allowed';
comment on column public.profiles.sheets_nudge_dismissed is 'User dismissed Connect Google Sheets nudge; syncs across devices';
comment on column public.profiles.last_spreadsheet_id is 'Last used Google Sheet id for resume after clear or new device';
comment on column public.profiles.history_timezone is 'IANA timezone used for stable history cutoff (default UTC).';
comment on column public.profiles.stripe_customer_id is 'Stripe Customer ID for billing portal and webhook plan-tier updates';
create index if not exists idx_profiles_plan_tier on public.profiles (plan_tier);

create table if not exists public.user_onboarding (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  primary_goal text,
  experience_level text,
  data_preference text,
  time_horizon text,
  onboarding_completed boolean default false,
  onboarding_scope jsonb,
  current_module_id text,
  completed_modules jsonb default '[]'::jsonb,
  tour_version text default '1.0',
  started_at timestamptz,
  completed_at timestamptz,
  last_accessed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_user_onboarding_user_id on public.user_onboarding (user_id);

create table if not exists public.plaid_tokens (
  item_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text not null,
  transactions_sync_cursor text,
  earliest_txn_date_seen date,
  latest_txn_date_seen date,
  institution_id text,
  institution_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
comment on column public.plaid_tokens.earliest_txn_date_seen is 'Earliest transaction date observed for this Plaid item from sync/get.';
comment on column public.plaid_tokens.latest_txn_date_seen is 'Latest transaction date observed for this Plaid item from sync/get.';
comment on column public.plaid_tokens.institution_id is 'Plaid institution_id from Link success metadata (e.g. ins_123).';
comment on column public.plaid_tokens.institution_name is 'Human-readable institution name from Link (e.g. Truist).';
create index if not exists idx_plaid_tokens_user_id on public.plaid_tokens (user_id);

create table if not exists public.accounts (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id text not null,
  plaid_account_id text not null,
  name text not null,
  type text not null,
  subtype text,
  balance numeric default 0,
  currency_code text default 'USD',
  persistent_account_id text,
  mask text,
  last_synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, plaid_account_id)
);
comment on column public.accounts.persistent_account_id is 'Plaid persistent_account_id when available (e.g. Chase); used to match accounts after re-link.';
comment on column public.accounts.mask is 'Last 2-4 alphanumeric characters of account number from Plaid; used for fallback matching on reconnect.';
create index if not exists idx_accounts_user_id on public.accounts (user_id);
create index if not exists idx_accounts_plaid_item_id on public.accounts (plaid_item_id);

create table if not exists public.transactions (
  id uuid primary key default extensions.uuid_generate_v4(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plaid_transaction_id text not null unique,
  amount numeric not null,
  date date not null,
  name text not null,
  category text[],
  merchant_name text,
  pending boolean default false,
  iso_currency_code text,
  unofficial_currency_code text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_transactions_account_id on public.transactions (account_id);
create index if not exists idx_transactions_date on public.transactions (date);

create table if not exists public.google_sheets_tokens (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  google_user_id text,
  google_user_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.account_balance_snapshots (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  as_of timestamptz not null,
  balance numeric not null,
  available numeric,
  currency_code text default 'USD',
  source text not null default 'plaid',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (account_id, as_of)
);
create index if not exists idx_balance_snapshots_user_asof on public.account_balance_snapshots (user_id, as_of desc);
create index if not exists idx_balance_snapshots_account_asof on public.account_balance_snapshots (account_id, as_of desc);

create table if not exists public.history_reconciliation_overrides (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  point_date date not null,
  chosen_source text not null check (chosen_source in ('plaid', 'checkpoint')),
  checkpoint_value numeric,
  plaid_value numeric,
  reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, point_date)
);
create index if not exists idx_history_overrides_user_date on public.history_reconciliation_overrides (user_id, point_date desc);

create table if not exists public.net_worth_points (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  point_date date not null,
  net_worth numeric not null,
  source text not null check (source in ('plaid_live', 'plaid_archived', 'checkpoint_user', 'checkpoint_auto', 'manual')),
  confidence text not null default 'high' check (confidence in ('high', 'med', 'low')),
  reconciled boolean not null default false,
  override_id uuid references public.history_reconciliation_overrides(id) on delete set null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, point_date)
);
create index if not exists idx_net_worth_points_user_date on public.net_worth_points (user_id, point_date desc);
create index if not exists idx_net_worth_points_source on public.net_worth_points (source);

create table if not exists public.net_worth_points_alt (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alt text not null,
  point_date date not null,
  net_worth numeric not null,
  source text not null check (source in ('tmm_total', 'manual', 'plaid_live', 'plaid_archived')),
  confidence text not null default 'high' check (confidence in ('high', 'med', 'low')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, alt, point_date)
);
create index if not exists idx_net_worth_points_alt_user_date on public.net_worth_points_alt (user_id, point_date desc);
create index if not exists idx_net_worth_points_alt_user_alt_date on public.net_worth_points_alt (user_id, alt, point_date desc);

create table if not exists public.plaid_sync_runs (
  id uuid primary key default extensions.uuid_generate_v4(),
  sync_run_id uuid not null unique,
  item_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  cursor_before text,
  cursor_after text,
  added_count integer not null default 0,
  modified_count integer not null default 0,
  removed_count integer not null default 0,
  upserted_count integer not null default 0,
  deleted_count integer not null default 0,
  skipped_unmapped_accounts integer not null default 0,
  backfill_start_date date,
  backfill_end_date date,
  status text not null default 'completed' check (status in ('queued', 'running', 'completed', 'failed')),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_plaid_sync_runs_user_started on public.plaid_sync_runs (user_id, started_at desc);
create index if not exists idx_plaid_sync_runs_item_started on public.plaid_sync_runs (item_id, started_at desc);

create table if not exists public.plaid_webhook_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  event_hash text not null unique,
  user_id uuid references auth.users(id) on delete cascade,
  item_id text,
  webhook_type text,
  webhook_code text,
  request_id text,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed', 'duplicate')),
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_plaid_webhook_events_user_created on public.plaid_webhook_events (user_id, created_at desc);
create index if not exists idx_plaid_webhook_events_item_created on public.plaid_webhook_events (item_id, created_at desc);

create table if not exists public.plaid_item_status (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null,
  status text not null default 'healthy',
  needs_update_mode boolean not null default false,
  last_error_code text,
  last_webhook_type text,
  last_webhook_code text,
  metadata jsonb not null default '{}'::jsonb,
  sync_locked_until timestamptz,
  sync_lock_owner uuid,
  cooldown_until timestamptz,
  consecutive_failures integer not null default 0,
  last_sync_started_at timestamptz,
  last_sync_finished_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, item_id)
);
create index if not exists idx_plaid_item_status_user_item on public.plaid_item_status (user_id, item_id);

create table if not exists public.plaid_link_intents (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  link_intent_id text not null,
  status text not null default 'started' check (status in ('started', 'completed', 'failed')),
  request_id text,
  public_token_hash text,
  result_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, link_intent_id)
);
create index if not exists idx_plaid_link_intents_user_created on public.plaid_link_intents (user_id, created_at desc);

create table if not exists public.plaid_sync_jobs (
  id uuid primary key default extensions.uuid_generate_v4(),
  job_id uuid not null unique default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text,
  job_type text not null default 'sync_item' check (job_type in ('sync_item', 'sync_all')),
  trigger text not null default 'manual' check (trigger in ('manual', 'webhook', 'scheduled')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  lock_owner uuid,
  dedupe_key text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index if not exists idx_plaid_sync_jobs_active_dedupe on public.plaid_sync_jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');
create index if not exists idx_plaid_sync_jobs_status_run_after on public.plaid_sync_jobs (status, run_after);
create index if not exists idx_plaid_sync_jobs_user_created on public.plaid_sync_jobs (user_id, created_at desc);
create index if not exists idx_plaid_sync_jobs_item_created on public.plaid_sync_jobs (item_id, created_at desc);

create table if not exists public.usage_counters (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text,
  metric text not null,
  bucket_start timestamptz not null,
  count integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint usage_counters_user_id_metric_bucket_start_item_id_key unique (user_id, metric, bucket_start, item_id)
);
create index if not exists idx_usage_counters_user_metric on public.usage_counters (user_id, metric, bucket_start desc);
create index if not exists idx_usage_counters_metric_bucket on public.usage_counters (metric, bucket_start desc);

create table if not exists public.plaid_circuit_breaker (
  id uuid primary key default extensions.uuid_generate_v4(),
  scope text not null unique default 'global',
  state text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  opened_at timestamptz,
  next_try_at timestamptz,
  last_failure_at timestamptz,
  failure_count_window integer not null default 0,
  window_started_at timestamptz,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.privacy_consents (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_type text not null,
  policy_version text not null,
  accepted boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  consented_at timestamptz not null default now(),
  created_at timestamptz default now()
);
create index if not exists idx_privacy_consents_user_type_time on public.privacy_consents (user_id, consent_type, consented_at desc);

create table if not exists public.data_deletion_requests (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'processing', 'completed', 'failed')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_data_deletion_requests_user_time on public.data_deletion_requests (user_id, requested_at desc);

create table if not exists public.plaid_connection_events (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null,
  event_type text not null check (event_type in ('connect', 'disconnect')),
  connection_type text not null check (connection_type in ('new', 'reconnect', 'update')),
  institution_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_plaid_connection_events_user_created on public.plaid_connection_events (user_id, created_at desc);
create index if not exists idx_plaid_connection_events_user_type_created on public.plaid_connection_events (user_id, event_type, connection_type, created_at desc);

-- =============================================================================
-- New tables: server-side plan persistence (ADR-1 / D14)
-- =============================================================================

create table if not exists public.plans (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan jsonb not null,
  schema_version text not null,
  size_bytes integer not null default 0,
  client_saved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
comment on table public.plans is 'Authoritative plan document, one row per user (ADR-1). client_saved_at echoes the client save timestamp for conflict detection (D14).';

create table if not exists public.plan_revisions (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan jsonb not null,
  schema_version text not null,
  size_bytes integer not null default 0,
  reason text not null default 'save' check (reason in ('save', 'pre_import', 'pre_migration', 'manual')),
  client_saved_at timestamptz,
  created_at timestamptz default now()
);
comment on table public.plan_revisions is 'Rolling plan history, newest 20 per user pruned on insert (D14). Destructive flows snapshot before acting (reason pre_import / pre_migration).';
create index if not exists idx_plan_revisions_user_created on public.plan_revisions (user_id, created_at desc);

-- =============================================================================
-- updated_at triggers
-- =============================================================================

drop trigger if exists update_profiles_updated_at on public.profiles;
create trigger update_profiles_updated_at before update on public.profiles
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_user_onboarding_updated_at on public.user_onboarding;
create trigger update_user_onboarding_updated_at before update on public.user_onboarding
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plaid_tokens_updated_at on public.plaid_tokens;
create trigger update_plaid_tokens_updated_at before update on public.plaid_tokens
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_accounts_updated_at on public.accounts;
create trigger update_accounts_updated_at before update on public.accounts
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_transactions_updated_at on public.transactions;
create trigger update_transactions_updated_at before update on public.transactions
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_google_sheets_tokens_updated_at on public.google_sheets_tokens;
create trigger update_google_sheets_tokens_updated_at before update on public.google_sheets_tokens
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_account_balance_snapshots_updated_at on public.account_balance_snapshots;
create trigger update_account_balance_snapshots_updated_at before update on public.account_balance_snapshots
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_history_overrides_updated_at on public.history_reconciliation_overrides;
create trigger update_history_overrides_updated_at before update on public.history_reconciliation_overrides
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_net_worth_points_updated_at on public.net_worth_points;
create trigger update_net_worth_points_updated_at before update on public.net_worth_points
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_net_worth_points_alt_updated_at on public.net_worth_points_alt;
create trigger update_net_worth_points_alt_updated_at before update on public.net_worth_points_alt
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plaid_item_status_updated_at on public.plaid_item_status;
create trigger update_plaid_item_status_updated_at before update on public.plaid_item_status
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plaid_link_intents_updated_at on public.plaid_link_intents;
create trigger update_plaid_link_intents_updated_at before update on public.plaid_link_intents
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plaid_sync_jobs_updated_at on public.plaid_sync_jobs;
create trigger update_plaid_sync_jobs_updated_at before update on public.plaid_sync_jobs
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_usage_counters_updated_at on public.usage_counters;
create trigger update_usage_counters_updated_at before update on public.usage_counters
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plaid_circuit_breaker_updated_at on public.plaid_circuit_breaker;
create trigger update_plaid_circuit_breaker_updated_at before update on public.plaid_circuit_breaker
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_plans_updated_at on public.plans;
create trigger update_plans_updated_at before update on public.plans
  for each row execute function public.update_updated_at_column();

-- New-auth-user bootstrap (profiles + onboarding).
drop trigger if exists on_auth_user_created_bootstrap on auth.users;
create trigger on_auth_user_created_bootstrap after insert on auth.users
  for each row execute function public.handle_new_auth_user_bootstrap();

-- =============================================================================
-- Data-path functions (need tables to exist)
-- =============================================================================

create or replace function public.increment_usage_counter(
  p_metric text,
  p_user_id uuid,
  p_item_id text,
  p_window_seconds integer,
  p_max integer
)
returns table(allowed boolean, count integer, bucket_start timestamptz)
language plpgsql
set search_path = 'public'
as $$
declare
  v_window integer := greatest(1, coalesce(p_window_seconds, 60));
  v_max integer := greatest(1, coalesce(p_max, 1));
  v_epoch bigint;
  v_bucket_epoch bigint;
  v_bucket_start timestamptz;
  v_count integer;
begin
  v_epoch := floor(extract(epoch from now()));
  v_bucket_epoch := (v_epoch / v_window) * v_window;
  v_bucket_start := to_timestamp(v_bucket_epoch);

  insert into usage_counters (user_id, item_id, metric, bucket_start, count)
  values (p_user_id, p_item_id, p_metric, v_bucket_start, 1)
  on conflict on constraint usage_counters_user_id_metric_bucket_start_item_id_key
  do update set
    count = usage_counters.count + 1,
    updated_at = now()
  returning usage_counters.count into v_count;

  return query select (v_count <= v_max), v_count, v_bucket_start;
end;
$$;

create or replace function public.plaid_apply_transactions_sync(
  p_user_id uuid,
  p_item_id text,
  p_next_cursor text,
  p_upserts jsonb,
  p_removed_ids text[],
  p_coverage jsonb,
  p_sync_run_id uuid,
  p_counts jsonb
)
returns jsonb
language plpgsql
set search_path = 'public'
as $$
declare
  v_upserted integer := 0;
  v_deleted integer := 0;
  v_skipped integer := 0;
  v_earliest date := null;
  v_latest date := null;
  v_added_count integer := coalesce((p_counts->>'added_count')::integer, 0);
  v_modified_count integer := coalesce((p_counts->>'modified_count')::integer, 0);
  v_removed_count integer := coalesce((p_counts->>'removed_count')::integer, 0);
begin
  if p_coverage is not null then
    v_earliest := nullif(p_coverage->>'earliest', '')::date;
    v_latest := nullif(p_coverage->>'latest', '')::date;
  end if;

  with input_rows as (
    select
      nullif(j->>'plaid_transaction_id', '') as plaid_transaction_id,
      nullif(j->>'plaid_account_id', '') as plaid_account_id,
      coalesce((j->>'amount')::numeric, 0) as amount,
      nullif(j->>'date', '')::date as date,
      coalesce(nullif(j->>'name', ''), 'Unknown') as name,
      case
        when jsonb_typeof(j->'category') = 'array' then (
          select coalesce(array_agg(value), array[]::text[])
          from jsonb_array_elements_text(j->'category')
        )
        else array[]::text[]
      end as category,
      nullif(j->>'merchant_name', '') as merchant_name,
      coalesce((j->>'pending')::boolean, false) as pending,
      nullif(j->>'iso_currency_code', '') as iso_currency_code,
      nullif(j->>'unofficial_currency_code', '') as unofficial_currency_code
    from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) j
  ),
  mapped_rows as (
    select
      a.id as account_id,
      i.plaid_transaction_id,
      i.amount,
      i.date,
      i.name,
      i.category,
      i.merchant_name,
      i.pending,
      i.iso_currency_code,
      i.unofficial_currency_code
    from input_rows i
    join accounts a
      on a.user_id = p_user_id
      and a.plaid_item_id = p_item_id
      and a.plaid_account_id = i.plaid_account_id
    where i.plaid_transaction_id is not null
      and i.date is not null
  ),
  upserted_rows as (
    insert into transactions (
      account_id,
      plaid_transaction_id,
      amount,
      date,
      name,
      category,
      merchant_name,
      pending,
      iso_currency_code,
      unofficial_currency_code
    )
    select
      account_id,
      plaid_transaction_id,
      amount,
      date,
      name,
      category,
      merchant_name,
      pending,
      iso_currency_code,
      unofficial_currency_code
    from mapped_rows
    on conflict (plaid_transaction_id) do update set
      account_id = excluded.account_id,
      amount = excluded.amount,
      date = excluded.date,
      name = excluded.name,
      category = excluded.category,
      merchant_name = excluded.merchant_name,
      pending = excluded.pending,
      iso_currency_code = excluded.iso_currency_code,
      unofficial_currency_code = excluded.unofficial_currency_code,
      updated_at = now()
    returning 1
  )
  select count(*) into v_upserted from upserted_rows;

  with input_count as (
    select count(*)::integer as total
    from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) j
    where nullif(j->>'plaid_transaction_id', '') is not null
  )
  select greatest(0, input_count.total - v_upserted)
    into v_skipped
  from input_count;

  if coalesce(array_length(p_removed_ids, 1), 0) > 0 then
    with deleted_rows as (
      delete from transactions t
      using accounts a
      where t.account_id = a.id
        and a.user_id = p_user_id
        and a.plaid_item_id = p_item_id
        and t.plaid_transaction_id = any(p_removed_ids)
      returning 1
    )
    select count(*) into v_deleted from deleted_rows;
  end if;

  update plaid_tokens
  set
    transactions_sync_cursor = p_next_cursor,
    earliest_txn_date_seen = case
      when v_earliest is null then earliest_txn_date_seen
      when earliest_txn_date_seen is null then v_earliest
      else least(earliest_txn_date_seen, v_earliest)
    end,
    latest_txn_date_seen = case
      when v_latest is null then latest_txn_date_seen
      when latest_txn_date_seen is null then v_latest
      else greatest(latest_txn_date_seen, v_latest)
    end,
    updated_at = now()
  where item_id = p_item_id and user_id = p_user_id;

  update plaid_sync_runs
  set
    cursor_after = p_next_cursor,
    added_count = v_added_count,
    modified_count = v_modified_count,
    removed_count = v_removed_count,
    upserted_count = v_upserted,
    deleted_count = v_deleted,
    skipped_unmapped_accounts = v_skipped,
    status = 'completed',
    error_message = null,
    finished_at = now()
  where sync_run_id = p_sync_run_id;

  return jsonb_build_object(
    'upserted_count', v_upserted,
    'deleted_count', v_deleted,
    'skipped_unmapped_accounts', v_skipped
  );
end;
$$;

-- =============================================================================
-- Row Level Security
--
-- The backend uses the service-role key (bypasses RLS). Policies below protect
-- the anon/browser path only, and are written strictly:
--   * anon: explicit deny on every table (fail loudly, per audit)
--   * authenticated: own-rows only (auth.uid() scoping); no USING (true)
--   * plaid_circuit_breaker (global, no user_id): no authenticated policy at
--     all — service-role access only
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.user_onboarding enable row level security;
alter table public.plaid_tokens enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.google_sheets_tokens enable row level security;
alter table public.account_balance_snapshots enable row level security;
alter table public.history_reconciliation_overrides enable row level security;
alter table public.net_worth_points enable row level security;
alter table public.net_worth_points_alt enable row level security;
alter table public.plaid_sync_runs enable row level security;
alter table public.plaid_webhook_events enable row level security;
alter table public.plaid_item_status enable row level security;
alter table public.plaid_link_intents enable row level security;
alter table public.plaid_sync_jobs enable row level security;
alter table public.usage_counters enable row level security;
alter table public.plaid_circuit_breaker enable row level security;
alter table public.privacy_consents enable row level security;
alter table public.data_deletion_requests enable row level security;
alter table public.plaid_connection_events enable row level security;
alter table public.plans enable row level security;
alter table public.plan_revisions enable row level security;

-- Explicit anon deny on every table. Drop-first keeps this block re-runnable
-- on environments that already carry these policies (e.g. dev convergence).
drop policy if exists anon_deny_all on public.profiles;
drop policy if exists anon_deny_all on public.user_onboarding;
drop policy if exists anon_deny_all on public.plaid_tokens;
drop policy if exists anon_deny_all on public.accounts;
drop policy if exists anon_deny_all on public.transactions;
drop policy if exists anon_deny_all on public.google_sheets_tokens;
drop policy if exists anon_deny_all on public.account_balance_snapshots;
drop policy if exists anon_deny_all on public.history_reconciliation_overrides;
drop policy if exists anon_deny_all on public.net_worth_points;
drop policy if exists anon_deny_all on public.net_worth_points_alt;
drop policy if exists anon_deny_all on public.plaid_sync_runs;
drop policy if exists anon_deny_all on public.plaid_webhook_events;
drop policy if exists anon_deny_all on public.plaid_item_status;
drop policy if exists anon_deny_all on public.plaid_link_intents;
drop policy if exists anon_deny_all on public.plaid_sync_jobs;
drop policy if exists anon_deny_all on public.usage_counters;
drop policy if exists anon_deny_all on public.plaid_circuit_breaker;
drop policy if exists anon_deny_all on public.privacy_consents;
drop policy if exists anon_deny_all on public.data_deletion_requests;
drop policy if exists anon_deny_all on public.plaid_connection_events;
drop policy if exists anon_deny_all on public.plans;
drop policy if exists anon_deny_all on public.plan_revisions;

create policy anon_deny_all on public.profiles for all to anon using (false) with check (false);
create policy anon_deny_all on public.user_onboarding for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_tokens for all to anon using (false) with check (false);
create policy anon_deny_all on public.accounts for all to anon using (false) with check (false);
create policy anon_deny_all on public.transactions for all to anon using (false) with check (false);
create policy anon_deny_all on public.google_sheets_tokens for all to anon using (false) with check (false);
create policy anon_deny_all on public.account_balance_snapshots for all to anon using (false) with check (false);
create policy anon_deny_all on public.history_reconciliation_overrides for all to anon using (false) with check (false);
create policy anon_deny_all on public.net_worth_points for all to anon using (false) with check (false);
create policy anon_deny_all on public.net_worth_points_alt for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_sync_runs for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_webhook_events for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_item_status for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_link_intents for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_sync_jobs for all to anon using (false) with check (false);
create policy anon_deny_all on public.usage_counters for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_circuit_breaker for all to anon using (false) with check (false);
create policy anon_deny_all on public.privacy_consents for all to anon using (false) with check (false);
create policy anon_deny_all on public.data_deletion_requests for all to anon using (false) with check (false);
create policy anon_deny_all on public.plaid_connection_events for all to anon using (false) with check (false);
create policy anon_deny_all on public.plans for all to anon using (false) with check (false);
create policy anon_deny_all on public.plan_revisions for all to anon using (false) with check (false);

-- Authenticated users: own rows only.
drop policy if exists profiles_own on public.profiles;
drop policy if exists user_onboarding_own on public.user_onboarding;
drop policy if exists plaid_tokens_own on public.plaid_tokens;
drop policy if exists accounts_own on public.accounts;
drop policy if exists transactions_own on public.transactions;
drop policy if exists google_sheets_tokens_own on public.google_sheets_tokens;
drop policy if exists account_balance_snapshots_own on public.account_balance_snapshots;
drop policy if exists history_reconciliation_overrides_own on public.history_reconciliation_overrides;
drop policy if exists net_worth_points_own on public.net_worth_points;
drop policy if exists net_worth_points_alt_own on public.net_worth_points_alt;
drop policy if exists plaid_sync_runs_own on public.plaid_sync_runs;
drop policy if exists plaid_webhook_events_own on public.plaid_webhook_events;
drop policy if exists plaid_item_status_own on public.plaid_item_status;
drop policy if exists plaid_link_intents_own on public.plaid_link_intents;
drop policy if exists plaid_sync_jobs_own on public.plaid_sync_jobs;
drop policy if exists usage_counters_own on public.usage_counters;
drop policy if exists privacy_consents_own on public.privacy_consents;
drop policy if exists data_deletion_requests_own on public.data_deletion_requests;
drop policy if exists plaid_connection_events_own on public.plaid_connection_events;
drop policy if exists plans_own on public.plans;
drop policy if exists plan_revisions_own on public.plan_revisions;

create policy profiles_own on public.profiles for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
create policy user_onboarding_own on public.user_onboarding for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_tokens_own on public.plaid_tokens for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy accounts_own on public.accounts for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy transactions_own on public.transactions for all to authenticated
  using (auth.uid() = (select a.user_id from public.accounts a where a.id = transactions.account_id))
  with check (auth.uid() = (select a.user_id from public.accounts a where a.id = transactions.account_id));
create policy google_sheets_tokens_own on public.google_sheets_tokens for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy account_balance_snapshots_own on public.account_balance_snapshots for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy history_reconciliation_overrides_own on public.history_reconciliation_overrides for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy net_worth_points_own on public.net_worth_points for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy net_worth_points_alt_own on public.net_worth_points_alt for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_sync_runs_own on public.plaid_sync_runs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_webhook_events_own on public.plaid_webhook_events for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_item_status_own on public.plaid_item_status for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_link_intents_own on public.plaid_link_intents for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_sync_jobs_own on public.plaid_sync_jobs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy usage_counters_own on public.usage_counters for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy privacy_consents_own on public.privacy_consents for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy data_deletion_requests_own on public.data_deletion_requests for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plaid_connection_events_own on public.plaid_connection_events for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plans_own on public.plans for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy plan_revisions_own on public.plan_revisions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- plaid_circuit_breaker: intentionally no authenticated policy (service-role only).
