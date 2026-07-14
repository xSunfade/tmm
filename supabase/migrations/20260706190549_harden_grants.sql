-- Phase 2.1 hardening (advisor findings):
--  * anon has no business reading/writing public tables directly — the browser
--    client only talks to auth; signed-in reads go through RLS'd authenticated
--    role or the backend service role. Revoking anon table privileges also
--    removes the tables from the anon-visible GraphQL schema.
--  * trigger/event-trigger functions must not be callable via /rest/v1/rpc.

revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

revoke execute on function public.handle_new_auth_user_bootstrap() from anon, authenticated, public;
revoke execute on function public.update_updated_at_column() from anon, authenticated, public;
revoke execute on function public.increment_usage_counter(text, uuid, text, integer, integer) from anon, authenticated, public;
revoke execute on function public.plaid_apply_transactions_sync(uuid, text, text, jsonb, text[], jsonb, uuid, jsonb) from anon, authenticated, public;

-- rls_auto_enable is a dev-era event-trigger function that fresh environments
-- don't have; guard so this migration replays cleanly from zero.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
  end if;
end;
$$;

