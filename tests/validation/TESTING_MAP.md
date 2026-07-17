# TMM Validation Testing Map

This map defines the validation boundaries for deterministic, end-to-end correctness checks across Plaid sync, CFA mapping, simulation math, and UX state fidelity.

## 1) Plaid Integration Entrypoints

Primary backend entrypoints are in `backend/server.js`:

- `POST /api/plaid/create-link-token`
- `POST /api/plaid/exchange-token`
- `GET /api/plaid/items`
- `GET /api/plaid/items-with-accounts`
- `GET /api/plaid/item-status`
- `GET /api/plaid/user-accounts`
- `POST /api/plaid/accounts`
- `POST /api/plaid/reconnect-in-place`
- `POST /api/plaid/remove-item`
- `POST /api/plaid/remove-account`
- `POST /api/plaid/transactions/sync`
- `POST /api/plaid/transactions`
- `GET /api/plaid/transactions/db`
- `POST /api/webhooks/plaid`

Plaid pagination + mutation retry + dedupe helpers:

- `backend/lib/plaidSyncEngine.js`

Queue worker surface:

- `backend/lib/plaidSyncWorker.js`

## 2) Supabase Tables in Scope

Defined by the canonical migrations in `supabase/migrations/`:

- `plaid_tokens`: encrypted access token by item/user + sync cursor and coverage window.
- `accounts`: connected financial accounts (CFA rows) and metadata.
- `transactions`: Plaid transaction rows keyed by `plaid_transaction_id`.
- `plaid_item_status`: item health, connection loss flags, locks/cooldowns.
- `plaid_webhook_events`: webhook intake + dedupe.
- `plaid_link_intents`: exchange/link idempotency and polling.
- `plaid_sync_jobs`: queued sync jobs.
- `plaid_sync_runs`: sync run accounting and status.
- `plaid_circuit_breaker`: upstream failure controls.
- `usage_counters`: per-user/item quota windows.
- `account_balance_snapshots`: archived account balances.
- `net_worth_points`: historical net worth points.
- `history_reconciliation_overrides`: manual source override for reconciliation.

## 3) CFA Creation + Mapping to TMM Nodes

### CFA creation

- Backend exchange flow writes CFA rows:
  - `backend/server.js` in `/api/plaid/exchange-token`
  - `backend/models/account.js` via `upsertAccountsForItem()`

### Node mapping

- Frontend link state is stored on plan entities via `connectedAccountId`:
  - `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
  - entity types: income/expense/asset/debt in plan model.
- Pipeline node connected status derives from link metadata:
  - `frontend/src/lib/pipeline/engine.ts`
- Plan persistence path (including linked account IDs):
  - `frontend/src/lib/plan/planPersistence.ts`
  - `frontend/src/lib/sheets/sync.ts` (sheet import/export parity).

## 4) Reconnect-in-Place and Takeover Rules

Current rule surfaces:

- Mapping helper in backend:
  - `backend/server.js` function `buildReconnectAccountIdMapping()`
- Explicit reconnect endpoint:
  - `POST /api/plaid/reconnect-in-place` in `backend/server.js`
- Frontend mapping application:
  - `applyAccountMapping` behavior in `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`

Matching rule order:

1. `persistent_account_id` match when available.
2. Fallback key: `type|subtype|mask`.
3. Deterministic first-unused candidate tiebreaking.

## 5) Simulation Engine Interfaces and Boundaries

Current simulation entrypoints (single engine — the legacy float engine
`simulation.ts` was deleted in Phase 1.5):

- `frontend/src/lib/simulation/ledger.ts` (authoritative daily ledger in integer cents)
  - `runSimulationFromLedger()`
  - `buildPlanLedgerScenario()` (seeds state from the latest checkpoint per D3)
  - `runLedgerScenario()`

Current simulation dependencies:

- `frontend/src/lib/simulation/augments.ts`
- `frontend/src/lib/simulation/checkpoints.ts`
- `frontend/src/lib/simulation/dateUtils.ts`
- `frontend/src/lib/plan/overrideManager.ts`
- `frontend/src/lib/plan/types.ts`

Current outputs:

- `SimulationResult.series` (value points by date)
- `SimulationResult.historicalSeries`
- audit/log strings
- optional drift metadata (today's actuals vs today's projection from the latest checkpoint)

## 6) UX Surfaces That Must Reflect Data Correctly

Primary UI views:

- Accounts + link/reconnect/remove workflows:
  - `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
- Pipeline node state:
  - `frontend/src/features/pipeline/*`
  - `frontend/src/lib/pipeline/engine.ts`
- Settings (MFA, sync state messaging):
  - `frontend/src/features/settings/SettingsScreen.tsx`
- Global sync overlays/toasts:
  - `frontend/src/app/AppLayout.tsx`
  - `frontend/src/components/AppSpinner.tsx`

Parity-critical UX fields:

- displayed balances and node values
- loading and progress overlays
- stale/connection-lost indicators
- last synced labels
- reconciliation/drift warnings
- "what changed" traces for sync mutations

## 7) Chaos, Drift, and Time-Determinism Insertion Points

Chaos insertion points:

- transaction page fetch stage
- mutation array ordering
- duplicate transaction injection
- replay passes over same payload
- crash/resume between page collection and apply
- concurrent `syncTransactionsForItem` calls for same item

Drift insertion points:

- snapshot-vs-simulated balance mismatch generation
- reconciliation override + post-reconciliation verification

Time-determinism insertion points:

- sync run timestamps/cursor update windows
- daily ledger date iteration
- month-end rollover and leap-day handling
- DST transition boundaries

## 8) Reconciliation and Audit Log Sinks

Existing durable history sources:

- `plaid_sync_runs`
- `plaid_webhook_events`
- `net_worth_points`
- `history_reconciliation_overrides`

Validation harness extends this with deterministic artifacts:

- `tests/validation/artifacts/*.json`
- `tests/validation/artifacts/*.csv`
- diff snapshots and fail-first seeds for reproducibility.
