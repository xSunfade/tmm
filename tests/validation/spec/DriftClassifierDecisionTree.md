# Drift Classifier Decision Tree

## Inputs

- `plaidBalanceCents`
- `ledgerBalanceCents`
- `transactionsPlaid[]`
- `transactionsLedger[]`
- `syncRunMetadata` (added/modified/removed counts)
- `coverageWindow`

## Thresholds

- `rounding_drift` threshold: `abs(delta) <= 1 cent`
- `material_drift` threshold: `abs(delta) > 1 cent`

## Classification order

1. **rounding_drift**
   - if `abs(delta) <= 1`.
2. **missing_tx**
   - exists in Plaid tx set by id but missing in ledger set.
3. **removed_tx**
   - exists in ledger set and appears in Plaid `removed[]` lineage.
4. **modified_tx**
   - same id exists in both sets and tracked fields differ.
5. **timing**
   - tx sets equivalent on ids + values, but as-of ordering/window causes balance mismatch.

## Evidence payload

- `classification`
- `deltaCents`
- `matchingIdsCount`
- `missingIds[]`
- `removedIds[]`
- `modifiedDiffs[]` (`id`, `field`, `before`, `after`)
- `syncRunId`
- `asOfIsoUtc`

## Confidence

- `high`: classifier condition met with explicit ids/diffs.
- `medium`: timing inferred from window/cutover and no direct id diffs.
