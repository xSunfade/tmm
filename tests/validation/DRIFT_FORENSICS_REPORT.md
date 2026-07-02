# Drift Forensics Report

## Scenario

- Injected artificial drift by diverging checkpoint and plaid net worth for same date.

## Evidence

- Expected balance (checkpoint): `95000`
- Actual Plaid balance: `100000`
- Delta: `5000`
- Delta origin classification: `timing_or_missing_transaction`
- UI indicator: `Drift detected`

## Reconciliation Result

- Reconciled flag set: `true`
- Post-reconciliation needsReview: `false`
- Ghost adjustments remaining: `false`
