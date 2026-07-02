# Plaid Live Validation (Production-focused, Sandbox-compatible)

This suite validates your real webhook + sync pipeline end-to-end against your running dev stack:

- Plaid webhook delivery over your tunnel URL
- webhook recording in `plaid_webhook_events`
- sync trigger + execution behavior via `/api/plaid/transactions/sync`
- sync status updates in `/api/plaid/sync/status`

Run this only when you intentionally want live Plaid checks.

## Command

From repo root:

```bash
npm run test:plaid:live
```

## Required environment

Set these in `.env`, `frontend/.env`, or `backend/.env` (the script loads all three):

- `BACKEND_URL` (optional, defaults to `http://localhost:3000`)
- `PLAID_ENVIRONMENT=sandbox|production`
- `PLAID_WEBHOOK_URL=https://<public-host>/api/webhooks/plaid`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `PLAYWRIGHT_TEST_USER`
- `PLAYWRIGHT_TEST_PASSWORD`

If `PLAID_ENVIRONMENT=production`, also set:

- `I_ACK_PROD=true`

## Exact local workflow (ngrok/tunnel changes)

1. Start your app stack:
   - `npm run dev:all`
2. Copy the current public tunnel URL for backend port 3000.
3. Set in `backend/.env`:
   - `PLAID_WEBHOOK_URL=https://<current-tunnel>/api/webhooks/plaid`
4. Restart backend so new env is loaded.
5. Run:
   - `npm run test:plaid:live`

The tunnel URL usually changes every restart on free plans. Re-run steps 2-4 whenever it changes.

## What the script does

1. Runs preflight checks (env, URL shape, production acknowledgment).
2. Signs in test user via Supabase and obtains JWT.
3. Calls:
   - `GET /api/health`
   - `GET /api/ops/plaid/health`
   - `GET /api/plaid/sync/status`
4. Calls:
   - `POST /api/ops/plaid/dev/webhook-smoke`
   - This performs `itemWebhookUpdate` on your items (and, if sandbox + enabled, `sandboxItemFireWebhook`).
5. Polls `GET /api/ops/plaid/health` until webhook count increases.
6. Calls `POST /api/plaid/transactions/sync` and verifies `202` or `204`.
7. Polls `GET /api/plaid/sync/status` and verifies `last_sync_finished_at` advances for at least one eligible item.

## Expected successful output

- `Plaid live validation: preflight checks`
- `Plaid live validation passed`
- Summary lines with environment, webhook baseline count, sync status code, and eligible items count.

## Common failure modes

- **`PLAID_WEBHOOK_URL must be https://.../api/webhooks/plaid`**
  - Fix URL shape and ensure it is not localhost.
- **No webhook count increase**
  - Tunnel is down, URL changed, backend not restarted after env update, or Plaid webhook routing mismatch.
- **`No items currently eligible for sync`**
  - Staleness gates are active; wait until `next_eligible_at` and rerun.
- **`Unexpected sync trigger status` or 500s**
  - Backend sync path regression; verify recent backend changes and worker status.
- **`increment_usage_counter` SQL ambiguity error**
  - Re-apply the function fix using `ON CONFLICT ON CONSTRAINT usage_counters_user_id_metric_bucket_start_item_id_key`.
- **Supabase sign-in failure**
  - Verify `PLAYWRIGHT_TEST_USER`/`PLAYWRIGHT_TEST_PASSWORD`, user exists, and CAPTCHA/service-role setup.

## Safety notes

- Endpoint `POST /api/ops/plaid/dev/webhook-smoke` is blocked when `NODE_ENV=production`.
- For `PLAID_ENVIRONMENT=production`, explicit `I_ACK_PROD=true` is required.
- This suite is opt-in and is not part of the default `npm run test:validation` run.
