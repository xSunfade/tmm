# Simulation Property Tests

This suite uses property-based testing to stress the daily ledger with randomized, reproducible financial plans.

## Engine under test

- `frontend/src/lib/simulation/ledger.ts`

## Generated dimensions per case

- income streams
- expenses
- transfer flows
- debt accounts with APR
- investment/asset accounts with returns
- augment-like delayed income injections

## Invariants asserted

- Conservation law by day:
  - `netWorth[t+1] - netWorth[t] == sum(eventImpactsForDay[t+1])`
- Transfers net to zero globally.
- No event ID appears twice (no double application).
- Integer-cent invariants (all deltas are bigint cents).
- Monthly aggregate equals derived daily month-end value.
- Cumulative rounding loss is zero (residuals carried, no dropped cents).

## Fail-fast and reproducibility

- Default run count: `1000` (override with `SIM_PROP_RUNS`).
- Seed controlled by `SIM_PROP_SEED`.
- On first violation, run fails immediately and writes:
  - `tests/validation/artifacts/simulation_property_fail_fast.json`

## Commands

- `SIM_PROP_RUNS=1000 SIM_PROP_SEED=424242 tsx tests/validation/scenarios/simulation/property-based.test.ts`
