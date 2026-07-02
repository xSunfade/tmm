# UI Parity Contract

Required selectors and tooltip schema for deterministic parity assertions.

## Required `data-testid` selectors

- Dashboard:
  - `dashboard-net-worth-value`
  - `dashboard-cashflow-value`
- Account integration:
  - `account-list-row-<account_id>`
  - `account-row-balance-<account_id>`
  - `account-row-status-<account_id>`
- Net worth tooltip:
  - `networth-tooltip`
  - `networth-tooltip-date`
  - `networth-tooltip-row-<alt>`
  - `networth-tooltip-row-source-<alt>`
- Drift:
  - `drift-badge`
  - `reconciliation-modal`
  - `reconciliation-classification`
  - `reconciliation-delta`
  - `reconciliation-evidence-list`
  - `reconciliation-action-accept-plaid`
  - `reconciliation-action-keep-ledger`

## Tooltip row schema

For each alt row:
- `altName`
- `valueCents`
- `displayValue`
- `source`
- `needsReview`
