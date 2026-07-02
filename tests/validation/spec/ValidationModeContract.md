# Validation Mode Contract

Validation mode is backend-first and frontend should continue calling real APIs.

## Enablement

- Backend env: `VALIDATION_MODE=true`
- Optional scenario selector: `VALIDATION_SCENARIO=<scenario_id>`

## Overridden endpoints (real frontend routes)

- `GET /api/plaid/items-with-accounts`
- `POST /api/plaid/transactions/sync`
- `GET /api/plaid/transactions/db`
- `POST /api/history/net-worth`
- `GET /api/history/net-worth`
- `POST /api/history/reconciliation`

## Scenario pack format

File: `tests/validation/fixtures/validation_mode/<scenario>.json`

Top-level fields:
- `schemaVersion`
- `scenarioId`
- `seed`
- `accounts`
- `transactionsSyncPages`
- `historyPoints`
- `coverage`
- `expectedUi`
- `driftCases`

## Auth

- Validation mode expects deterministic test JWTs.
- No auth bypass in parity tests.
