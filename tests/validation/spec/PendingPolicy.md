# Pending Policy

## Storage policy

- Pending transactions are stored in `transactions.pending`.
- Pending rows are retained as event history until modified/removed by Plaid sync.

## Balance policy

- `nodeAutoValueCents` is derived from Plaid account current balance, not from transaction sums.
- Pending transactions do not directly adjust node autoValue in simulation or UI parity.

## Lifecycle handling

### pending -> posted
- Same id with `pending` changed to `false` is classified as `modified_tx`.
- Reconciliation log records previous/new values and pending-state change.

### pending amount/date/category changes
- Same id with changed fields remains `modified_tx`.

### pending disappears
- If id appears in `removed[]`, classify as `removed_tx`.
- If not present in payload and no remove marker, no mutation is inferred for that run.

## Drift evidence usage

- Pending rows can be evidence for `timing` classification when:
  - all posted rows match
  - net delta is explainable by pending-only discrepancy window.
