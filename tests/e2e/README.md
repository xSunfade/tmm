# E2E Tests

## Plaid transactions sync test

Script: `tests/e2e/plaid-transactions-sync.test.js`

This script covers:
- sync one item via `POST /api/plaid/transactions/sync`
- sync all user items via `POST /api/plaid/transactions/sync`
- webhook double-delivery acceptance via `POST /api/webhooks/plaid`
- account ownership guard via `GET /api/plaid/transactions/db?account_id=...`

### Required environment variables

- `TMM_PLUS_JWT` - JWT for a user with `tmm_plus` plan tier
- `TEST_ITEM_ID` - item id owned by that user
- `TEST_ACCOUNT_ID` - account id owned by that user
- `OTHER_USERS_ACCOUNT_ID` - account id owned by a different user

### Optional environment variables

- `BACKEND_URL` (default: `http://localhost:3000`)
- `PLAID_WEBHOOK_SECRET` (if backend enforces webhook secret header)

### Run

```bash
node tests/e2e/plaid-transactions-sync.test.js
```

If required env vars are missing, the script exits successfully and prints a skip message.

## Plaid sync fixture validation

Script: `tests/e2e/plaid-sync-fixture-validation.test.js`

This script covers deterministic logic validation for:
- `/transactions/sync` mutation-during-pagination retry behavior
- dedupe semantics across `added`, `modified`, and backfill windows
- non-mutation error propagation

Fixtures:
- `tests/fixtures/plaid/sync_runs/mutation_retry_fixture.json`
- `tests/fixtures/plaid/sync_runs/dedupe_backfill_fixture.json`

### Run

```bash
node tests/e2e/plaid-sync-fixture-validation.test.js
```

## History net-worth test

Script: `tests/e2e/history-net-worth.test.js`

This script covers:
- `GET /api/history/net-worth`
- `POST /api/history/net-worth` with checkpoints payload merge behavior

### Required environment variables

- `TMM_PLUS_JWT` or `FREE_JWT`

### Optional environment variables

- `BACKEND_URL` (default: `http://localhost:3000`)

### Run

```bash
node tests/e2e/history-net-worth.test.js
```

## Reconciliation override test

Script: `tests/e2e/reconciliation-override.test.js`

This script covers:
- `POST /api/history/reconciliation` for both checkpoint-wins and plaid-wins
- verification via subsequent `GET /api/history/net-worth`

### Required environment variables

- `TMM_PLUS_JWT` or `FREE_JWT`

### Optional environment variables

- `BACKEND_URL` (default: `http://localhost:3000`)

### Run

```bash
node tests/e2e/reconciliation-override.test.js
```

## Temporal suite (T0 -> T+180d)

Script: `tests/e2e/temporal-suite.test.js`

This deterministic suite validates long-horizon behavior with persona fixtures:
- connected value evolution while user is away
- disconnect fallback and reconnect remapping
- manual override stability across connection churn
- source-ladder sanity (`plaid_live` vs `plaid_archived`) on late slices

Fixture:
- `tests/fixtures/temporal/personas.json`

### Run

```bash
node tests/e2e/temporal-suite.test.js
```
