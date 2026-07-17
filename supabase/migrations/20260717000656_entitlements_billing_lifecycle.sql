-- Phase 4: entitlements, billing state, Plaid lifecycle, waitlist/invites,
-- OAuth state nonces, audit log (ADR-3, ADR-6, D1/D2/D7/D8/D11/D12, PAY-2/3/5,
-- SEC-3, WH-S1). All new tables are service-role-only: the backend mediates
-- every read/write, so no authenticated policies exist (and anon is denied
-- explicitly on top of the wholesale grant revocation from harden_grants).

-- =============================================================================
-- 1. Entitlement catalog (ADR-3): prices, tiers, and limits are rows, not code
-- =============================================================================

create table if not exists public.plan_catalog (
  stripe_price_id text primary key,
  lookup_key text unique,
  tier text not null check (tier in ('tmm_plus', 'tmm_pro')),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.plan_catalog is 'Stripe price -> tier mapping (ADR-3/PAY-2). Only subscriptions whose price is here grant a paid tier; unknown prices are logged and ignored.';
comment on column public.plan_catalog.lookup_key is 'Stripe price lookup_key; stable across test/live modes (e.g. tmm_plus_monthly).';

create table if not exists public.tier_entitlements (
  tier text primary key,
  max_alternatives integer,
  max_horizon_years integer,
  plaid_enabled boolean not null default false,
  max_plaid_items integer not null default 0,
  extras jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
comment on table public.tier_entitlements is 'Tier -> limits (D7/D8). null = unlimited. The single source of truth for feature limits; PLAID_ITEM_CAP as a global constant is obsolete.';

insert into public.tier_entitlements (tier, max_alternatives, max_horizon_years, plaid_enabled, max_plaid_items, extras) values
  ('free',     3,    5,    false, 0, '{}'::jsonb),
  ('tmm_plus', null, null, true,  3, '{"advanced_analysis": false}'::jsonb),
  ('tmm_pro',  null, null, true,  6, '{"advanced_analysis": true}'::jsonb)
on conflict (tier) do nothing;

-- =============================================================================
-- 2. Stripe webhook idempotency + audit ledger (PAY-5 / WH-S1); 90-day retention
-- =============================================================================

create table if not exists public.stripe_events (
  event_id text primary key,
  type text not null,
  outcome text not null default 'received' check (outcome in ('received', 'processed', 'ignored', 'error')),
  payload jsonb not null,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
comment on table public.stripe_events is 'Every Stripe webhook event, recorded before side effects; replayed event_ids no-op (PAY-5). 90-day retention.';
create index if not exists idx_stripe_events_received_at on public.stripe_events (received_at);

-- =============================================================================
-- 3. Subscription state on the profile (PAY-3) + third tier (D7) + admin (4.11)
-- =============================================================================

alter table public.profiles
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text,
  add column if not exists stripe_price_id text,
  add column if not exists current_period_end timestamptz,
  add column if not exists grace_expires_at timestamptz,
  add column if not exists is_admin boolean not null default false;
comment on column public.profiles.subscription_status is 'Raw Stripe subscription status (active/trialing/past_due/...). plan_tier is DERIVED from this via resolveEntitlements; never set plan_tier from the client.';
comment on column public.profiles.grace_expires_at is 'past_due grace deadline (= entry + 7 days, D11). The grace-expiry sweep downgrades when this passes.';
comment on column public.profiles.is_admin is 'Ops/admin role (Phase 4.11): gates /api/admin/* and ops routes. Set only via SQL/founder action, never via API.';

alter table public.profiles drop constraint if exists profiles_plan_tier_check;
alter table public.profiles add constraint profiles_plan_tier_check
  check (plan_tier in ('free', 'tmm_plus', 'tmm_pro'));

create index if not exists idx_profiles_grace_expiry on public.profiles (grace_expires_at)
  where grace_expires_at is not null;

-- =============================================================================
-- 4. Plaid item lifecycle (ADR-6 / D12): suspend + 30-day retention + revoke
-- =============================================================================

alter table public.plaid_tokens
  add column if not exists suspended_at timestamptz,
  add column if not exists retention_expires_at timestamptz;
comment on column public.plaid_tokens.suspended_at is 'Set on downgrade (SUSPENDED state, ADR-6): sync stops; token retained for seamless restore.';
comment on column public.plaid_tokens.retention_expires_at is 'suspended_at + 30 days (D12). The revocation sweep calls itemRemove and deletes this row when passed.';

create index if not exists idx_plaid_tokens_retention_expiry on public.plaid_tokens (retention_expires_at)
  where retention_expires_at is not null;

-- Lifecycle transitions log to plaid_connection_events (ADR-6).
alter table public.plaid_connection_events drop constraint if exists plaid_connection_events_event_type_check;
alter table public.plaid_connection_events add constraint plaid_connection_events_event_type_check
  check (event_type in ('connect', 'disconnect', 'suspend', 'restore', 'revoke'));
alter table public.plaid_connection_events drop constraint if exists plaid_connection_events_connection_type_check;
alter table public.plaid_connection_events add constraint plaid_connection_events_connection_type_check
  check (connection_type in ('new', 'reconnect', 'update', 'lifecycle'));

-- =============================================================================
-- 5. Audit log (security-relevant transitions; 1-year retention)
-- =============================================================================

create table if not exists public.audit_log (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade,
  actor text not null default 'system' check (actor in ('user', 'system', 'webhook', 'admin')),
  action text not null,
  resource text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
comment on table public.audit_log is 'Security-relevant events (lifecycle transitions, entitlement changes, admin actions). Never contains tokens or plan contents. 1-year retention.';
create index if not exists idx_audit_log_user_created on public.audit_log (user_id, created_at desc);
create index if not exists idx_audit_log_created on public.audit_log (created_at);

-- =============================================================================
-- 6. Waitlist + invites (D1 / D2)
-- =============================================================================

create table if not exists public.waitlist (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  kind text not null check (kind in ('tmm_plus', 'free_signup')),
  status text not null default 'waiting' check (status in ('waiting', 'invited', 'removed')),
  created_at timestamptz not null default now(),
  constraint waitlist_kind_email_key unique (kind, email)
);
comment on table public.waitlist is 'TMM+ upgrade waitlist (signed-in users) and free-signup overflow waitlist (email only, pre-account) per D1.';
create index if not exists idx_waitlist_user on public.waitlist (user_id) where user_id is not null;

create table if not exists public.invites (
  code text primary key,
  tier text not null default 'tmm_plus' check (tier in ('tmm_plus', 'tmm_pro')),
  issued_by uuid references auth.users(id) on delete set null,
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.invites is 'TMM+ invite codes (D2): redemption unlocks checkout for that user. redeemed_by/issued_by are ON DELETE SET NULL deliberately - a consumed code must stay consumed even if the account is deleted (documented cascade exception).';
create index if not exists idx_invites_redeemed_by on public.invites (redeemed_by) where redeemed_by is not null;

-- =============================================================================
-- 7. App settings (free-signup soft cap switch, D1)
-- =============================================================================

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.app_settings is 'Operational switches (service-role only). free_signup: {"mode": "open"|"waitlist", "soft_cap": int|null} - crossing soft_cap flips signup to waitlist mode.';

insert into public.app_settings (key, value) values
  ('free_signup', '{"mode": "open", "soft_cap": null}'::jsonb)
on conflict (key) do nothing;

-- =============================================================================
-- 8. OAuth state nonces (SEC-3): signed, single-use, TTL-bound, user-bound
-- =============================================================================

create table if not exists public.oauth_states (
  nonce text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null default 'google_sheets',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
comment on table public.oauth_states is 'Single-use OAuth state nonces (SEC-3). Callback consumes exactly once; expired/consumed/foreign states are rejected.';
create index if not exists idx_oauth_states_expires on public.oauth_states (expires_at);

-- =============================================================================
-- 9. updated_at triggers (baseline convention)
-- =============================================================================

drop trigger if exists update_plan_catalog_updated_at on public.plan_catalog;
create trigger update_plan_catalog_updated_at before update on public.plan_catalog
  for each row execute function public.update_updated_at_column();

drop trigger if exists update_tier_entitlements_updated_at on public.tier_entitlements;
create trigger update_tier_entitlements_updated_at before update on public.tier_entitlements
  for each row execute function public.update_updated_at_column();

drop trigger if exists update_app_settings_updated_at on public.app_settings;
create trigger update_app_settings_updated_at before update on public.app_settings
  for each row execute function public.update_updated_at_column();

-- =============================================================================
-- 10. RLS: enable + explicit anon deny; service-role-only (no authenticated
--     policies -> authenticated cannot pass RLS; grants also revoked below)
-- =============================================================================

alter table public.plan_catalog enable row level security;
alter table public.tier_entitlements enable row level security;
alter table public.stripe_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.waitlist enable row level security;
alter table public.invites enable row level security;
alter table public.app_settings enable row level security;
alter table public.oauth_states enable row level security;

drop policy if exists anon_deny_all on public.plan_catalog;
create policy anon_deny_all on public.plan_catalog for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.tier_entitlements;
create policy anon_deny_all on public.tier_entitlements for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.stripe_events;
create policy anon_deny_all on public.stripe_events for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.audit_log;
create policy anon_deny_all on public.audit_log for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.waitlist;
create policy anon_deny_all on public.waitlist for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.invites;
create policy anon_deny_all on public.invites for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.app_settings;
create policy anon_deny_all on public.app_settings for all to anon using (false) with check (false);
drop policy if exists anon_deny_all on public.oauth_states;
create policy anon_deny_all on public.oauth_states for all to anon using (false) with check (false);

revoke all on table public.plan_catalog from authenticated;
revoke all on table public.tier_entitlements from authenticated;
revoke all on table public.stripe_events from authenticated;
revoke all on table public.audit_log from authenticated;
revoke all on table public.waitlist from authenticated;
revoke all on table public.invites from authenticated;
revoke all on table public.app_settings from authenticated;
revoke all on table public.oauth_states from authenticated;

-- =============================================================================
-- 11. Retention sweeps: add stripe_events (90d), audit_log (1y), oauth_states
--     (expired + 1d), and keep every existing sweep unchanged
-- =============================================================================

create or replace function public.run_retention_sweeps()
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_webhook_events integer;
  v_sync_runs integer;
  v_sync_jobs integer;
  v_link_intents integer;
  v_usage_counters integer;
  v_connection_events integer;
  v_stripe_events integer;
  v_audit_log integer;
  v_oauth_states integer;
begin
  delete from plaid_webhook_events where created_at < now() - interval '90 days';
  get diagnostics v_webhook_events = row_count;

  delete from plaid_sync_runs where started_at < now() - interval '30 days';
  get diagnostics v_sync_runs = row_count;

  delete from plaid_sync_jobs
  where status in ('completed', 'failed', 'cancelled')
    and created_at < now() - interval '30 days';
  get diagnostics v_sync_jobs = row_count;

  delete from plaid_link_intents where created_at < now() - interval '90 days';
  get diagnostics v_link_intents = row_count;

  delete from usage_counters where bucket_start < now() - interval '30 days';
  get diagnostics v_usage_counters = row_count;

  delete from plaid_connection_events where created_at < now() - interval '365 days';
  get diagnostics v_connection_events = row_count;

  delete from stripe_events where received_at < now() - interval '90 days';
  get diagnostics v_stripe_events = row_count;

  delete from audit_log where created_at < now() - interval '365 days';
  get diagnostics v_audit_log = row_count;

  delete from oauth_states where expires_at < now() - interval '1 day';
  get diagnostics v_oauth_states = row_count;

  return jsonb_build_object(
    'plaid_webhook_events', v_webhook_events,
    'plaid_sync_runs', v_sync_runs,
    'plaid_sync_jobs', v_sync_jobs,
    'plaid_link_intents', v_link_intents,
    'usage_counters', v_usage_counters,
    'plaid_connection_events', v_connection_events,
    'stripe_events', v_stripe_events,
    'audit_log', v_audit_log,
    'oauth_states', v_oauth_states
  );
end;
$$;

revoke execute on function public.run_retention_sweeps() from anon, authenticated, public;
