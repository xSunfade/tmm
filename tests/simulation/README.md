# Simulation Validation Tests

Script: `tests/simulation/simulation-validation.test.ts`

Run from frontend package:

```bash
npm run test:simulation
```

Covers:

- Golden fixture checks for expected early-series values.
- Determinism (same plan input produces identical outputs).
- Connected account override precedence (`autoValue` vs `manualValue` when `overrideActive`).
- Frequency conversion sanity for weekly income.
