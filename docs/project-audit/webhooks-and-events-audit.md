# Webhooks and Events Audit

Two webhook endpoints exist today: Stripe and Plaid. Both are implemented in `backend/server.js`. There is also an internal event-ish system (Plaid sync job queue). No other event-driven flows exist or are needed for MVP.

## Stripe webhook — `POST /api/webhooks/stripe`

**Confirmed from code:**

- Raw-body parsing is correctly scoped to this route only (required for signature verification).
- Signature verified via `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`; returns 503 if unconfigured, 400 on bad signature.
- Bearer tokens explicitly rejected on webhook routes (defense against confused auth).
- Handles `customer.subscription.created/updated/deleted` → flips `profiles.plan_tier`; resolves the user via subscription metadata or `stripe_customer_id` lookup; archives a snapshot on downgrade.

**Gaps:**

| ID | Gap | Priority |
|---|---|---|
| WH-S1 | **No event idempotency store.** Stripe redelivers events; handlers appear naturally idempotent (tier flip is a state set, not an increment), but nothing records processed `event.id`s, and future handlers may not be idempotent by accident. | Medium |
| WH-S2 | **No handling of `checkout.session.completed`, `past_due`, `incomplete`, `invoice.payment_failed`** — see payments doc. | High (before charging) |
| WH-S3 | **No price/product verification** — any active subscription on the customer flips the tier, whether or not it's the TMM+ price. | High (before charging) |
| WH-S4 | **No dead-letter/audit trail** — a failed handler returns 500 (Stripe retries), but there is no record of what was received/skipped. Log every event id + type + outcome to a table or structured log. | Medium |

## Plaid webhook — `POST /api/webhooks/plaid`

**Confirmed from code:**

- **No signature or JWT verification whatsoever.** Any party who discovers the URL can POST arbitrary JSON.
- Mitigations that exist: rate limit (180/min default), content-hash dedupe into `plaid_webhook_events` (unique `event_hash`), payload size limit, and handlers that only *enqueue* work (a forged `SYNC_UPDATES_AVAILABLE` triggers a legitimate sync against real Plaid — cost/noise, not data corruption). But forged **revocation** webhooks (`USER_PERMISSION_REVOKED` etc.) trigger cleanup paths — that is a potential unauthenticated data-deletion vector for a known item_id.

### WH-P1: Verify Plaid webhooks — Critical (before production Plaid)

Plaid signs webhooks with a JWT in the `Plaid-Verification` header; the verification key is fetched via `/webhook_verification_key/get` and cached by `kid`. The `plaid` npm package supports this.

- **Priority:** Critical
- **Risk reduced:** unauthenticated actors triggering syncs, revocation cleanup, or queue flooding.
- **Effort:** 1–2 days including tests.
- **Files:** `backend/server.js` (webhook route), new small verifier module, `backend/models/plaidWebhook.js` (record verification outcome).
- **Dependencies:** none.
- **Acceptance criteria:** requests without a valid `Plaid-Verification` JWT are rejected 401 in production (behind a config flag defaulting on in prod, off in sandbox/mock validation mode); key caching + rotation handled; validation-harness mock path still works; a test covers accept/reject.

### What already exists and is good (keep, don't rebuild)

- **Idempotency:** content-hash dedupe on webhook events; dedupe keys on sync jobs (15-min buckets); link-intent idempotency on token exchange; `sync_run_id` audit trail; atomic apply RPC. This is genuinely solid design — the chaos test suite (`tests/validation/scenarios/plaid/chaos-idempotency.test.ts`) exercises duplicate injection, replay, crash, and concurrency against mocks.
- **Retry:** worker retries failed jobs with backoff (max 5); mutation-during-pagination retry inside the sync engine; circuit breaker prevents retry storms.

### Remaining Plaid webhook gaps

| ID | Gap | Priority |
|---|---|---|
| WH-P2 | `PLAID_WEBHOOK_URL` must be publicly reachable and stable in production; nothing in the repo defines what that URL will be (deployment undefined). Webhook registration is per-link-token; items created before the URL existed won't receive webhooks (Plaid `/item/webhook/update` exists for backfill — there's a dev smoke route but no bulk backfill). | High (deploy-time) |
| WH-P3 | Webhook handler does its DB work inline before responding. Plaid times out slow webhook responses; current work is light (insert + enqueue) so this is fine — just keep it that way (respond 200 fast, do heavy work in the worker). | Note only |
| WH-P4 | `plaid_webhook_events` table grows unbounded; no pruning job. | Low |
| WH-P5 | Failure recovery: if the worker is down, jobs queue up (good), but nothing alerts anyone. Minimum viable ops: a daily check of `plaid_sync_jobs` stuck/failed counts (see cost/ops docs). | Medium |

## Correct target architecture (MVP-appropriate)

No message broker, no serverless event bus — the current DB-backed queue is the right level of complexity. The complete, boring, correct shape is:

1. Webhook endpoint: verify signature → dedupe by event id/hash → persist raw event → enqueue job → 200 immediately.
2. Worker: claim job (DB lock) → do work idempotently → record outcome; retries with capped backoff; failures visible in a table.
3. One scheduled reconciliation sweep per day (already exists as scheduled sync) to catch missed webhooks.
4. Structured log line per event with correlation id (correlation middleware already exists).

Items 2–4 largely exist. The one Critical missing piece is signature verification (WH-P1); the Stripe-side gaps are WH-S2/S3.
