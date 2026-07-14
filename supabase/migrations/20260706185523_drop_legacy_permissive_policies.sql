-- Phase 2.1 cleanup on environments that predate the baseline (dev):
-- remove the service-role-era permissive policies (17 "RLS policy always
-- true" advisor findings) and legacy per-table updated_at functions. The
-- strict policy set was installed by the baseline. No-ops on fresh
-- environments born from the baseline.

drop policy if exists "Service role full access" on public.account_balance_snapshots;
drop policy if exists "Anon users cannot access accounts" on public.accounts;
drop policy if exists "Service role full access" on public.accounts;
drop policy if exists "Service role full access" on public.data_deletion_requests;
drop policy if exists "Service role full access to google_sheets_tokens" on public.google_sheets_tokens;
drop policy if exists "Users can delete own Google tokens" on public.google_sheets_tokens;
drop policy if exists "Users can insert own Google tokens" on public.google_sheets_tokens;
drop policy if exists "Users can read own Google tokens" on public.google_sheets_tokens;
drop policy if exists "Users can update own Google tokens" on public.google_sheets_tokens;
drop policy if exists "Service role full access" on public.history_reconciliation_overrides;
drop policy if exists "Service role full access" on public.net_worth_points;
drop policy if exists "Service role full access" on public.net_worth_points_alt;
drop policy if exists "Service role full access" on public.plaid_circuit_breaker;
drop policy if exists "Service role full access" on public.plaid_connection_events;
drop policy if exists "Service role full access" on public.plaid_item_status;
drop policy if exists "Service role full access" on public.plaid_link_intents;
drop policy if exists "Service role full access" on public.plaid_sync_jobs;
drop policy if exists "Service role full access" on public.plaid_sync_runs;
drop policy if exists "Anon users cannot access plaid_tokens" on public.plaid_tokens;
drop policy if exists "Service role full access" on public.plaid_tokens;
drop policy if exists "Service role full access" on public.plaid_webhook_events;
drop policy if exists "Service role full access" on public.privacy_consents;
drop policy if exists "Service role full access to profiles" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "Anon users cannot access transactions" on public.transactions;
drop policy if exists "Service role full access" on public.transactions;
drop policy if exists "Service role full access" on public.usage_counters;
drop policy if exists "Service role full access to user_onboarding" on public.user_onboarding;
drop policy if exists "Users can delete own onboarding" on public.user_onboarding;
drop policy if exists "Users can insert own onboarding" on public.user_onboarding;
drop policy if exists "Users can read own onboarding" on public.user_onboarding;
drop policy if exists "Users can update own onboarding" on public.user_onboarding;
drop policy if exists "onboarding_select_own" on public.user_onboarding;
drop policy if exists "onboarding_update_own" on public.user_onboarding;

-- Legacy per-table updated_at functions (triggers were re-pointed at the
-- shared public.update_updated_at_column() by the baseline).
drop function if exists public.update_profiles_updated_at();
drop function if exists public.update_user_onboarding_updated_at();
drop function if exists public.update_google_sheets_tokens_updated_at();
drop function if exists public.handle_new_auth_user_profile();
