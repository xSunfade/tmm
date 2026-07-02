# Identity and Equality Rules

## Transaction identity

- Primary external identity: `plaid_transaction_id`.
- Storage uniqueness: one row per `plaid_transaction_id` (global unique in current schema).
- Removed records in Plaid sync are keyed by `transaction_id` and map directly to the same identity key.

## Equality model for mutation classification

A transaction with the same `plaid_transaction_id` is considered:

- **Unchanged** if these fields are equal:
  - `amount`
  - `date`
  - `pending`
  - normalized category mapping result
  - `merchant_name` (null-safe)
- **Modified** if any of those fields differ.
- **Removed** if the id appears in `removed[]` from `/transactions/sync`.
- **Added** if id was not previously present and appears in upserts.

## Upsert precedence

When the same id appears multiple times in one run:

1. `modified` overwrites `added` by id.
2. Later page values overwrite earlier page values.
3. Backfill rows do not overwrite same-id values already present in current sync payload unless payload omits those fields.

## Authorized vs posted handling

- Current TMM storage does not maintain separate authorized and posted identities.
- If Plaid reuses the same `transaction_id` with `pending` changes, treat as **modified**.
- If institution emits a new id for posted transaction, treat as remove+add lineage in reconciliation traces.
