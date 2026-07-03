# Plaid Production Gap Analysis (TMM)

> **⚠️ STALE (marked 2026-07-03, Phase 0.7).** Written before Plaid production approval was granted; several items listed as "Open" (e.g. tests) now exist. Kept for historical context. Current source of truth: `docs/project-audit/` and `project-roadmap/05-plaid-lifecycle-policy.md`.

This document maps Plaid launch readiness requirements to current TMM implementation and identifies what must be completed for production approval and safe operation.

## Scope assumptions

- TMM production scope is **Transactions-first**.
- Refresh model is **webhooks + server-side jobs**.
- Auth and Balance endpoints may still be used, but only where needed by product behavior.

## Must / Should / Could matrix

| Area | Requirement | Priority | Current state in TMM | Gap | Required implementation |
|---|---|---:|---|---|---|
| Production setup | Plaid Application Profile + Company Profile complete | Must | Not in repo (Dashboard task) | Open | Complete in Plaid Dashboard before production request |
| Production setup | Plaid Security Questionnaire complete | Must | Not in repo (Dashboard task) | Open | Complete in Plaid Dashboard |
| Environment separation | Production-only keys/host and no sandbox leakage | Must | `backend/config.js` supports env split, but no hard guard for CORS origin in production | Partial | Add fail-closed config guards + deployment checklist |
| Link setup | Limit products to intended usage | Must | `backend/server.js` uses `products: ['transactions', 'auth']` | Open | Remove `auth` unless explicitly required |
| Link setup | OAuth support + redirect handling + tests | Must | Link exists, but explicit update-mode/OAuth regression tests missing | Partial | Add update-mode token flow and test matrix |
| Link setup | Duplicate item prevention | Must | Reconnect/orphan matching exists in `/api/plaid/exchange-token` | Partial | Add deterministic duplicate checks and integration tests |
| Link callbacks | Handle `onExit` / `onEvent` and log `link_session_id` | Must | Frontend uses `onSuccess` only | Open | Add callback handlers and structured analytics logging |
| Webhooks | Verify Plaid webhook authenticity robustly | Must | Shared secret header supported in `/api/webhooks/plaid` | Partial | Add stronger verification + IP allowlist guidance + event replay protection |
| Webhooks | Idempotent and durable webhook processing | Must | Debounced in-memory sync scheduling | Open | Persist webhook events and dedupe by event hash; durable queue/retry |
| Webhooks | Handle item lifecycle states (`ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`, etc.) | Must | No durable state tracking surfaced to UI | Open | Persist per-item status + drive update-mode reconnect UX |
| Transactions sync | Handle pagination and mutation-during-pagination | Must | Implemented in `fetchAllTransactionsSyncUpdates()` | Partial | Add deterministic tests for mutation retry + cursor behavior |
| Transactions sync | Backfill correction window | Must | `PLAID_TRANSACTIONS_BACKFILL_DAYS` implemented | Partial | Validate with fixtures + tune and document policy |
| Transactions sync | Dedupe + removed semantics | Must | Implemented via map dedupe + delete by plaid ID | Partial | Add deterministic fixtures and idempotency tests |
| Storage/logging | Access token server-side only and encrypted | Must | Implemented in `backend/tokenStore.js` AES-256-GCM | Closed | Keep and verify no client exposure in tests |
| Storage/logging | Supportability IDs (`request_id`, `item_id`, `account_id`, `link_session_id`) | Must | Structured request logs exist; `link_session_id` not captured | Partial | Add Link event logging and include Plaid response IDs where available |
| Item management | `/item/remove` lifecycle + user delete flow | Must | Local remove endpoints exist; no guaranteed Plaid item removal call path | Open | Add explicit `/item/remove` path and deletion policy runbook |
| Security baseline | Rate limiting on abuse-prone and cost-prone endpoints | Must | Not implemented | Open | Add route-aware rate limiting middleware |
| Security baseline | Strict production CORS | Must | Production checks origin list but lacks fail-closed env validation | Partial | Enforce non-empty allowlist + remove permissive fallback in production |
| Security baseline | Dual-layer request validation | Must | Ad hoc field checks | Open | Add schema-based backend validation middleware and typed payload guards |
| Security baseline | Request hardening (size limits/timeouts/security headers) | Must | Basic `express.json()` only | Open | Add body limits, request timeout, and baseline security headers |
| Security baseline | RLS verification on all user data tables | Must | Tests exist for subset | Partial | Extend security tests to all history/sync/webhook tables |
| Security baseline | Secrets hygiene and dependency scanning | Must | Secret scan script exists | Partial | Add CI dependency scan and documented key rotation steps |
| Validation | Simulation math invariants + determinism tests | Must | Runtime logic exists, no exhaustive unit suite | Open | Add scenario fixtures + invariant checks |
| Validation | Long-horizon temporal tests (T0..T+180) | Must | Strategy exists in docs | Open | Implement deterministic temporal suite |
| Ops readiness | Sync/webhook alerts + runbooks | Should | Some logs available | Open | Add operational runbooks + metrics/alerting spec |
| Product polish | Link conversion analytics and UX copy hardening | Could | Minimal | Open | Add event dashboard and conversion funnel metrics |

## Codepath map (current)

- Backend Plaid entrypoints:
  - `backend/server.js`:
    - `/api/plaid/create-link-token`
    - `/api/plaid/exchange-token`
    - `/api/plaid/reconnect-in-place`
    - `/api/plaid/disconnect`
    - `/api/plaid/remove-item`
    - `/api/plaid/remove-account`
    - `/api/plaid/transactions/sync`
    - `/api/webhooks/plaid`
- Token handling:
  - `backend/tokenStore.js`
  - `backend/storage/supabaseStorage.js`
- Account/transaction persistence:
  - `backend/models/account.js`
  - `backend/models/transaction.js`
- Sync/history observability:
  - `backend/models/history.js` (`plaid_sync_runs`, coverage window, points)
- Frontend Link integration:
  - `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
  - `frontend/src/features/accountIntegration/legacyAdapters.ts`

## Launch-blocking acceptance criteria

TMM is production-ready only when all of the below are true:

1. Dashboard compliance tasks completed (Application Profile, Company Profile, Security Questionnaire).
2. Link initialization only requests products TMM actively uses in production.
3. Webhook processing is authenticated, idempotent, and durable across process restarts.
4. Item error states and update-mode are implemented and user-actionable in UI.
5. Transactions sync correctness is validated with deterministic fixtures for pagination/mutations/removals.
6. Security baseline is enforced in code (rate limits, strict CORS, schema validation, request hardening).
7. Simulation and history correctness tests pass for connected-account override scenarios and long-horizon temporal cases.

## Notes for Plaid approval narrative

When filling Plaid review responses, describe TMM as:

- Server-side token exchange and encrypted token storage.
- OAuth-ready Link with update-mode support for item recovery.
- Webhook-driven transactions synchronization with replay-safe processing.
- User-scoped data isolation backed by Supabase RLS and ownership tests.
- Deterministic financial simulation and history reconciliation with explicit user-visible review states.
