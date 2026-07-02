# Plaid Operations Runbook

This runbook defines production operations for Plaid sync reliability, webhook health, and secret rotation.

## Operational telemetry available in TMM

- `plaid_sync_runs` table
  - per-run status, cursor movement, and transaction deltas
- `plaid_webhook_events` table
  - webhook receipt/process trail with dedupe hash
- `plaid_item_status` table
  - per-item health and update-mode requirements
- API health summary:
  - `GET /api/ops/plaid/health` (auth + TMM+)

## Recommended alert thresholds

Use your monitoring system (Datadog/Grafana/CloudWatch) to alert on:

1. **Sync failure rate**
   - Trigger: `plaid_sync_runs.status='failed'` > 5 in 15 minutes (per environment)
2. **Webhook ingestion failure**
   - Trigger: no `processed` Plaid webhooks in last 30 minutes during expected activity window
3. **Action-required items backlog**
   - Trigger: `plaid_item_status.needs_update_mode=true` count rising > 20% day over day
4. **Latency SLO breach**
   - Trigger: p95 `POST /api/plaid/transactions/sync` > 15s for 3 consecutive windows

## Incident: webhook outage

Symptoms:

- `webhooks_total` drops unexpectedly
- stale account values and missing transaction refreshes
- sync runs show no recent webhook-driven activity

Actions:

1. Verify webhook endpoint availability and TLS.
2. Verify `PLAID_WEBHOOK_SECRET` and gateway forwarding headers.
3. Check `plaid_webhook_events` for `failed` or missing inserts.
4. Run manual catch-up:
   - `POST /api/plaid/transactions/sync` (item-specific first, then all items).
5. Confirm `plaid_item_status` recovers to healthy where expected.
6. Publish customer comms if user-facing delays exceeded SLA.

## Incident: repeated ITEM_LOGIN_REQUIRED / PENDING_DISCONNECT

Symptoms:

- `plaid_item_status.needs_update_mode=true`
- `last_error_code` contains `ITEM_LOGIN_REQUIRED` or webhook code `PENDING_DISCONNECT`

Actions:

1. Confirm item is still token-present in `plaid_tokens`.
2. User recovery path:
   - launch Link update mode (`/api/plaid/create-link-token` with `update_item_id`).
3. After successful update:
   - verify item status transitions to healthy.
4. If unresolved:
   - disconnect and reconnect workflow (reconnect-in-place with account remap).

## Key rotation playbook

### TOKEN_ENCRYPTION_KEY

1. Generate new 32-byte hex key.
2. Deploy maintenance job:
   - read encrypted tokens
   - decrypt with old key
   - encrypt with new key
   - write back atomically
3. Roll application env to new key.
4. Verify token reads for sample items.
5. Retire old key from secrets manager.

### Plaid secret (`PLAID_SECRET`)

1. Rotate secret in Plaid dashboard.
2. Update backend secret store.
3. Restart backend and run smoke checks:
   - create link token
   - exchange token (sandbox smoke)
   - transactions sync

## Weekly operations checklist

- [ ] Review failed sync runs from last 7 days.
- [ ] Review action-required item count and top error codes.
- [ ] Validate webhook volume trend and dedupe ratio.
- [ ] Run deterministic sync fixture test:
  - `node tests/e2e/plaid-sync-fixture-validation.test.js`
- [ ] Run temporal suite:
  - `node tests/e2e/temporal-suite.test.js`
- [ ] Run simulation validation:
  - `cd frontend && npm run test:simulation`
