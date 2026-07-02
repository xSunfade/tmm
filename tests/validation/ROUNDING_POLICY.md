# Rounding Policy

## Policy

- Monetary storage and computation in validation harness uses **integer cents** (`bigint`).
- Interest/rate math uses fixed-point integer rates:
  - annual rates represented as **ppm** (parts per million).
  - daily interest denominator is `1_000_000 * 365`.
- Tie-breaking uses **banker’s rounding** (round-half-to-even).

## Why this policy

- Removes floating-point drift from critical money operations.
- Ensures deterministic replay under seeded runs and chaos mode.
- Makes one-cent mismatches explicit and testable.

## Invariants enforced

- No event can produce fractional cents.
- No persisted/report values contain more than 2 decimal places.
- Transfer out + transfer in always net to zero for the same transfer group.
- Cumulative dropped rounding loss is zero (residuals are carried, not discarded).

## Implementation locations

- `frontend/src/lib/simulation/ledger.ts`
  - `bankersRoundRational()`
  - `runLedgerScenario()`
- `tests/validation/scenarios/simulation/ledger-invariants.test.ts`
  - transfer symmetry checks
  - monthly-vs-daily aggregate parity
  - 10-year compounding sanity check against closed-form approximation

## Repro command

- `tsx tests/validation/scenarios/simulation/ledger-invariants.test.ts`
