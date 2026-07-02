# Money Definitions

## Canonical monetary fields

### `accountBalanceOfRecordCents`
- Source: Plaid `accountsGet.balances.current`.
- Scope: per connected account.
- As-of semantics: value is attached to sync completion timestamp (`asOfIsoUtc`) in UTC.
- Pending policy interaction: pending transactions do not directly mutate this value in TMM; this field mirrors Plaid current balance.

### `nodeAutoValueCents`
- Definition: deterministic function of linked account `accountBalanceOfRecordCents`.
- Rule: equals current balance cents for linked account.
- Excludes: available balance and pending-only projections.

### `displayBalanceCents`
- Definition: authoritative UI value for account/node display.
- Default: equals `nodeAutoValueCents`.
- Formatting: UI may format without cents for compact display, but validation compares raw cents.

### `historySnapshotBalanceCents`
- Definition: balance persisted to `account_balance_snapshots.balance`.
- Source: latest `accountBalanceOfRecordCents` at archival point.

### `simulationSeedBalanceCents`
- Definition: initial per-account balance fed into ledger simulation.
- Source priority:
  1. latest history snapshot for account
  2. linked account current balance
  3. explicit manual plan row value

## Production authority

- Balance authority in production is **Plaid current balance**.
- Transactions are event history for auditing, categorization, and drift attribution.
- Transaction summation is not the source-of-record balance path in production.

## Sign conventions

- Internal signs:
  - income: positive
  - expense: negative
  - transfer_out: negative
  - transfer_in: positive
  - debt principal reduction: positive impact on net worth
