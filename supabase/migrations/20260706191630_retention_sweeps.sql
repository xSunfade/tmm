-- Retention sweeps (Phase 2.6 / DATA-6), per the retention policy in
-- docs/project-audit/project-audit-question-answers.md #15:
--   * user-created financial data (plans, transactions, balance snapshots,
--     net-worth history): kept indefinitely — NOT swept here
--   * webhook events: 90 days
--   * sync execution logs (runs + finished queue jobs): 30 days
--   * link intents: 90 days
--   * usage counters (rate-limit buckets): 30 days
--   * connection events (audit): 1 year
--   * plan_revisions: bounded in-app (newest 20 per user, pruned on insert)
--   * privacy consents / deletion requests: compliance records — never swept

create extension if not exists pg_cron;

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

  return jsonb_build_object(
    'plaid_webhook_events', v_webhook_events,
    'plaid_sync_runs', v_sync_runs,
    'plaid_sync_jobs', v_sync_jobs,
    'plaid_link_intents', v_link_intents,
    'usage_counters', v_usage_counters,
    'plaid_connection_events', v_connection_events
  );
end;
$$;

revoke execute on function public.run_retention_sweeps() from anon, authenticated, public;

-- Daily at 03:30 UTC. cron.schedule upserts by job name, so re-running is safe.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tmm_retention_sweeps', '30 3 * * *', 'select public.run_retention_sweeps()');
  end if;
end;
$do$;
