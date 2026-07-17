-- Converge dev-only drift left over from the hand-applied legacy era so every
-- environment is bit-identical to a from-zero rebuild of supabase/migrations
-- (verified against tmm-staging 2026-07-17). No-ops on fresh environments.

-- Redundant dev indexes: the unique constraints already provide these.
drop index if exists public.idx_transactions_plaid_transaction_id;
drop index if exists public.idx_google_sheets_tokens_user_id;

-- Legacy FK name from migration 012; baseline names it net_worth_points_override_id_fkey.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'fk_net_worth_override' and conrelid = 'public.net_worth_points'::regclass
  ) then
    alter table public.net_worth_points
      rename constraint fk_net_worth_override to net_worth_points_override_id_fkey;
  end if;
end;
$$;

-- Dev-era RLS auto-enable tooling (harden_grants already treats it as legacy).
-- Migrations enable RLS explicitly per table; CI shadow-apply + the RLS
-- anon-test are the enforcement mechanisms now.
drop event trigger if exists ensure_rls;
drop function if exists public.rls_auto_enable();
