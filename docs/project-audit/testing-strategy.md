# Testing Strategy

TMM already has an unusually rich test asset base — the problem is **wiring and coverage gaps**, not absence. Strategy: make what exists run automatically, migrate simulation tests off the legacy engine, and add a thin layer of high-value tests around the money paths.

## Current inventory (confirmed)

| Layer | What exists | Runs in CI? |
|---|---|---|
| Simulation | Golden fixtures, determinism, worker parity (`tests/simulation/`), ledger invariants, plan-ledger integration, fast-check property tests (1000 runs), time-boundary (leap/DST/month-end) | Property/invariant suites: **yes** (validation harness). Golden/`test:simulation`: **no** |
| Plaid | Chaos/idempotency/mutation suites vs mocks; live webhook test (manual, tunneled); backend unit tests (`node --test`) | Chaos: yes. Backend unit: **no**. Live: manual |
| Stripe | Upgrade validation scenario + JWT helper | **Skipped** by flag |
| Security | Token encryption (reimplemented, not importing `tokenStore.js`); RLS anon test; service-role isolation | Encryption: yes. RLS/isolation: **no** |
| E2E | Live-backend scripts (health, CORS, history, reconciliation); offline temporal suite; Playwright UI parity | **No** (Playwright configured but cannot run: no server startup, no secrets) |
| Sheets | New `tests/unit/sheets-diff.test.ts` (untracked, in-progress) | Not yet |
| Static | CodeQL, npm audit, Dependabot | Yes |

## Priority 1 — wire what exists (Phase 0/1, ~2 days)

1. **Add `npm run test:unit` to a CI workflow** (backend unit + frontend simulation + sheets diff). Commit the untracked `tests/unit/` file first. *Acceptance: PRs fail on unit regressions.*
2. **Fix the CI Playwright job or disable it honestly** — currently configured to run without servers/secrets, so it either fails or misleads. Recommended: disable `RUN_PLAYWRIGHT_PARITY` in CI until a `webServer` block + seeded test user exist.
3. **Point `token-encryption.test.js` at the real `backend/tokenStore.js`** instead of a local reimplementation — right now it can pass while production code breaks.
4. **Run the RLS anon test against a real (staging) Supabase in a scheduled workflow** with repo secrets. *Acceptance: weekly green check that anon can read nothing.*
5. Fix `verify-no-secrets.sh` to scan `*.ts/tsx` and correct `run-audit-verification.sh` paths.

## Priority 2 — single-engine simulation truth (Phase 1)

- Migrate golden fixtures + determinism + frequency tests from `simulation.ts` to the ledger engine; then delete the legacy engine.
- Add missing engine tests: checkpoint seeding (per resolved BUG-5 semantics), drift-at-today (BUG-4), Ticker behavior (per BUG-6 decision), negative-cash behavior, `recurring`/`conditional` augments (or assert they're rejected).
- Keep the property-test suite exactly as is — it is the crown jewel (conservation, transfer symmetry, zero rounding loss).
- **The rounding-policy invariant (`cumulativeRoundingLossCents === 0`) must run on every PR** (already does via harness — keep it).

## Priority 3 — money-path integration tests (Phase 3)

- **Stripe:** run the existing scenario in CI against a started backend with test keys + Stripe CLI fixtures or mocked `constructEvent`; add cases for `past_due`/`unpaid`/price-mismatch once PAY-1/2 land. Use Stripe test clocks for the grace-period flow.
- **Plaid webhook verification:** unit test accept/reject of `Plaid-Verification` JWTs (mock keys); keep chaos suites as the durability net.
- **Plan persistence (DATA-1):** integration tests for GET/PUT plan, revision restore, conflict prompt logic, oversized-plan rejection.
- **Deletion cascade:** create a full-footprint user (profile, tokens, accounts, transactions, history, consents) → delete → assert zero rows across all user tables.

## Priority 4 — one real E2E smoke (Phase 4, keep tiny)

A single Playwright flow, run on PR with a seeded local stack (`webServer` starts Vite + backend + validation-mode fixtures):

> sign in (seeded user) → default plan loads → add income + expense → run simulation → chart renders non-zero → export XLSX → reload → plan persists.

Resist a large E2E suite; one bulletproof smoke beats twenty flaky specs. Fix the current UI-parity spec's self-comparison (it asserts DOM text equals itself) or drop it.

## Manual test scripts (pre-release, ~2 hours per release)

1. The 7-step UX reliability script (see `user-experience-reliability-audit.md`).
2. Billing loop in Stripe test mode: upgrade → gate opens → cancel → gate closes.
3. Plaid sandbox loop: link → sync → values appear → revoke at bank → item status reflects it.
4. Sheets loop: connect → sync → edit sheet → refresh → verify prompt + snapshot.
5. Import the sample XLSX from `frontend/public` on a fresh account.

## Regression policy

- Every bug fixed from `stability-and-bug-audit.md` gets a test in the same PR (BUG-1 route test, BUG-2 unit test, BUG-4/5 engine tests…).
- Golden fixtures freeze the simulation's numeric output; any intentional change to results requires updating fixtures in a dedicated, explained commit (this is your defense of the product's core promise).

## What NOT to invest in yet

- React component test suite (screens are churning; the E2E smoke covers integration).
- Load/perf testing automation (client-side compute; revisit when backend load exists).
- The full 12-persona `LAUNCH_BLOCKING_VALIDATION_MATRIX.md` — aspirational; either trim it to what's automated or move it to a post-MVP plan so docs match reality.
- Contract-testing frameworks — freeze the error shape and document routes instead.
