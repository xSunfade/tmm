# Simulation Validation Tests

Scripts (all run against the production ledger engine, `frontend/src/lib/simulation/ledger.ts`):

- `tests/simulation/simulation-validation.test.ts`
- `tests/simulation/checkpoint-drift.test.ts`
- `tests/simulation/worker-host.test.ts`

Run from frontend package:

```bash
npm run test:simulation
```

Covers:

- Golden fixture checks for expected early-series values.
- Determinism (same plan input + seed produces identical outputs); Monte Carlo seed variation.
- Connected account override precedence (`autoValue` vs `manualValue` when `overrideActive`).
- Calendar-accurate frequency behavior for weekly income (fires on actual weekdays, not an FPM approximation).
- Checkpoint semantics (D3/BUG-5): latest checkpoint seeds engine state; deterministic `checkpoint_adjust:<alt>:<date>` adjustment id; idempotent re-application; connected live values take precedence over checkpoint snapshots.
- Drift-at-today (BUG-4): drift compares today's actuals to today's projection from the checkpoint baseline, never the horizon end.
- Worker parity + serialization round-trip.
