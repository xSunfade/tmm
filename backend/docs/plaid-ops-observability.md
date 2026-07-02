# Plaid Ops Observability and Alerts

See also: [Plaid Link Telemetry Event Map](./plaid-link-telemetry-map.md) for Link conversion event definitions and funnel metrics.

## Key Log Events

- `plaid_sync_job_enqueued`: emitted when a sync job is enqueued/deduped (`jobId`, `dedupeKey`, `trigger`).
- `plaid_sync_worker_job_finished`: emitted by the worker with `elapsed_ms`.
- `plaid_sync_item`: emitted for direct sync responses.
- `plaid_exchange_token_success` and `plaid_exchange_token_reconnect`: include `linkIntentId` for idempotency tracing.
- `webhook_plaid`: inbound webhook metadata (`webhookType`, `webhookCode`, `itemId`).

## API Telemetry Endpoints

- `GET /api/ops/plaid/health`
  - includes sync run counts, webhook counts, sync job status rollups, and breaker state.
- `GET /api/ops/plaid/jobs?status=&limit=`
  - recent jobs for the current user.
- `GET /api/ops/plaid/breaker`
  - current breaker state and timing.

## Suggested Alerts

- **Breaker Open**
  - Trigger when `/api/ops/plaid/health` reports `circuit_breaker.state = open` for > 5 minutes.
- **Sync Failure Spike**
  - Trigger when `sync_runs_failed / sync_runs_total > 0.2` over a 15-minute window.
- **Queue Backlog**
  - Trigger when `sync_jobs_by_status.queued` remains above threshold for > 10 minutes.
- **Webhook Processing Failure**
  - Trigger when webhook status `failed` appears in `/api/ops/plaid/health`.
- **Quota Saturation**
  - Trigger when `SYNC_USER_DAILY_QUOTA_EXCEEDED` or `SYNC_ITEM_HOURLY_QUOTA_EXCEEDED` errors spike.

## Dashboard Panels (Recommended)

- Plaid breaker state timeline (`closed/open/half_open`)
- Sync jobs by status (queued/running/completed/failed)
- Sync run success ratio and p95 duration
- Webhook ingest volume and dedupe ratio
- Exchange-token success/failure by error code

