---
name: tmm-plaid-lifecycle
description: Use when changing Plaid routes, the sync worker/job queue, Plaid webhooks, token storage, item lifecycle transitions (grace/suspend/revoke), or item caps for TMM. Encodes the ADR-6 state machine, webhook verification requirements, and what already works and must not be rebuilt.
---

# TMM Plaid Lifecycle & Sync

Bank credentials are the highest-liability data TMM holds. Every Plaid change follows this skill plus `project-roadmap/05-plaid-lifecycle-policy.md` (the state machine there is normative).

## Do NOT rebuild (already good — audit-verified)

Link-intent idempotency · AES-256-GCM token store (fail-closed in prod) · cursor-based `/transactions/sync` with mutation retry · DB job queue with dedupe keys (15-min buckets) · in-process worker with backoff (max 5) · DB-backed circuit breaker · content-hash webhook dedupe · atomic apply RPC · chaos/idempotency test suites. Extend these; don't replace them.

## The state machine (ADR-6, D12)

ACTIVE → (payment fails) GRACE 7d, sync continues → (not cured) SUSPENDED: sync stops immediately, tokens kept encrypted 30 days (`retention_expires_at`) → resubscribe = ACTIVE with **no re-link** and a catch-up sync, or expiry = REVOKED: `itemRemove` + token row deleted. User removal or account deletion → REVOKED immediately. Historical imported data survives every transition except user-initiated deletion.

Rules:
- Every exit from ACTIVE must provably end in REVOKED (sweeps are scheduled, idempotent, retried, and alert on failure).
- A lingering token row after any revoke path is a defect (BUG-3 class) regardless of cause.
- Transitions log to `plaid_connection_events`; security-relevant ones also to `audit_log`.

## Webhook rules (SEC-1 — critical)

1. Verify the `Plaid-Verification` JWT **before any processing** (key via `/webhook_verification_key/get`, cached by `kid`, rotation-safe). Unsigned/invalid → 401 in production. The validation-mode bypass must be explicit config, default-off in prod.
2. Handlers stay enqueue-fast (insert + enqueue + 200); heavy work belongs to the worker (WH-P3).
3. `USER_PERMISSION_REVOKED` triggers cleanup — which is exactly why verification is non-negotiable (forged revocations = unauthenticated data deletion).
4. Any webhook change ships with accept/reject tests (mock keys) and keeps the chaos suite green.

## Caps and cost

- Item limits come from `tier_entitlements.max_plaid_items` (**TMM+ 3, Pro 6, absolute ceiling 10**) + weekly velocity limit. These bound Plaid spend (Transactions is billed per connected account); don't relax them without a Product Strategist–approved pricing check.
- Sandbox for all agent testing. Production credentials exist only in the prod backend host.

## Deployment couplings

- The in-process worker + `setInterval` schedulers **require an always-on host**. The current Vercel-serverless backend does not run them persistently — deployed sync behavior is unrepresentative until Phase 5.3 (Render migration).
- Webhook URL changes require `item/webhook/update` backfill for existing items (WH-P2). Target URL: `https://api.tmm.finance/api/webhooks/plaid`.
- Kill switches: `RUN_PLAID_WORKER`, `PLAID_SYNC_USE_QUEUE`, scheduler envs, circuit breaker. New background behavior gets a consistent flag.

## Sensitive-action UX

MFA step-up (30-day gate) precedes Plaid connect/reconnect (D23). Don't weaken it; don't add it to read-only views.

## Test matrix before handoff

Run/extend the lifecycle matrix in `05-plaid-lifecycle-policy.md` §Test matrix: downgrade suspension, day-29 vs day-31 restore, user removal token cleanup, forged webhook rejection, account-deletion cascade.
