---
name: tmm-simulation-correctness
description: Use when changing anything under frontend/src/lib/simulation/, the TMM domain model, plan schema entity shapes, checkpoints, positions, augments, or golden/property test fixtures. Encodes TMM's numeric invariants, checkpoint/position semantics (D3/D4), and the golden-fixture change procedure.
---

# TMM Simulation Correctness

The number on the chart is the product. Follow this procedure for any simulation/domain-model change.

## Before writing code

1. Read `project-roadmap/01-architecture-decisions.md` ADR-2 and decisions D3/D4 in `project-roadmap/00-decision-register.md`.
2. Write a **semantics note** (5–15 lines, in the PR description): what number changes, for whom, and why — citing the D-number or spec section. No output-changing PR merges without one.
3. Locate the relevant spec in `tests/validation/spec/`; if your change contradicts it, the spec must be updated in the same PR (deliberately, cited), never silently diverged from.

## Inviolable invariants (reject any change that breaks these)

- Money math is integer `bigint` cents; rates are ppm fixed-point; rounding is banker's with residual carry; `cumulativeRoundingLossCents === 0` always.
- Determinism: same plan + same seed + same horizon = identical output. No `Date.now()`, no unseeded randomness inside the engine; use the injected clock/seed.
- ADR-2 boundaries: engine internals are not imported outside the simulation package; the domain model imports nothing from the engine.
- Checkpoints (D3): the engine seeds state from the **latest checkpoint** and projects forward; checkpoints use deterministic adjustment IDs; drift compares today's actuals to **today's** projection from that baseline (never horizon-end — that was BUG-4).
- Positions (D4): market assets are `quantity × price(t)`; `price(t)` is a deterministic path from user assumptions; contributions buy shares at `price(t_contribution)` (exact DCA). v1 scope excludes dividends, splits, tax lots, capital gains, rebalancing, withdrawal strategies — do not add them without a design doc.

## Test procedure

1. Run the property suites first and keep them green on every commit: conservation, transfer symmetry, zero rounding loss (they run in the validation harness; `npm run test:validation` locally).
2. New behavior gets a golden fixture or property test plus edge cases: negative cash, zero quantity, horizon boundaries, leap/DST (time-boundary suite exists — extend it).
3. **Golden fixture changes** require: a dedicated commit containing only fixture updates, the semantics note referenced in the commit message, and Simulation Engineer sign-off. A golden diff hidden in a feature commit is a review-blocking defect.
4. Worker parity: if you touched the worker host or engine entry points, run the worker-parity test (worker result === main-thread result).

## Common traps in this codebase

- The legacy float engine (`simulation.ts`) is dead in production but may still be referenced by tests until Phase 3.5 completes — never "fix" behavior by matching it; the ledger + specs are the truth.
- `lastRun.series` cached output must not leak into persistence or fingerprints.
- The 16-entry result cache is keyed by full input fingerprint — if you add an engine input, add it to the fingerprint or stale results will be served.
- Monte Carlo today = augment probability only. Don't let copy or code imply market-path simulation.

## Handoff

Finish with the handoff package per `tmm-workforce/handoff-protocol.md`, explicitly stating: property-suite status, golden status (unchanged / changed-with-note), and specs touched.
