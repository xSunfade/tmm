# Stability and Bug Audit

Confirmed bugs first, then fragile areas and reliability risks. File references are to repo state **at audit time** — several findings are since fixed and marked ✅ RESOLVED below.

**Resolution status (2026-07-14):** BUG-1 ✅ · BUG-2 ✅ · BUG-3 ✅ · BUG-4 ✅ · BUG-5 ✅ · **BUG-6 ✅** (Phase 3.2: Ticker assets are positions — quantity × deterministic price path, exact DCA; spec `tests/validation/spec/PositionSemantics.md`) · BUG-7 ✅ (legacy engine deleted) · FRAGILE-1 ✅ · FRAGILE-2 ✅ · FRAGILE-3 ✅ · FRAGILE-5/6 ✅. All audited bugs resolved.

## Confirmed bugs (from code)

### BUG-1: `GET /api/plaid/items` throws on every call — Critical ✅ RESOLVED

`backend/server.js` (~line 2518): the handler builds `items` from `rows` but then reads `connectedItemIds.size`, a variable that is **not defined in that scope** → `ReferenceError` → 500 on every request.

- **Priority:** Critical
- **Risk reduced:** A core Plaid listing endpoint is currently unusable; any UI path that calls it fails.
- **Effort:** <1 hour
- **Files:** `backend/server.js`
- **Dependencies:** none
- **Acceptance criteria:** endpoint returns `{ items, item_count }` for a TMM+ user with 0, 1, and N items; a regression test covers it.

### BUG-2: `removeToken` post-delete check inverted — High ✅ RESOLVED

`backend/storage/supabaseStorage.js` (lines ~166–175): after deleting a token it re-checks existence and throws "Token not found" when the token **still exists** — i.e., the error message and condition are inverted relative to intent, and a successful delete path may behave incorrectly.

- **Priority:** High · **Effort:** ~1 hour · **Files:** `backend/storage/supabaseStorage.js`
- **Acceptance criteria:** deleting an existing token succeeds silently; deleting a missing token produces a clear, correct error; unit test added.

### BUG-3: `POST /api/plaid/remove-item` leaves the encrypted access token behind — High ✅ RESOLVED

`backend/server.js` (~lines 3439–3461): deletes the item's accounts but never removes the `plaid_tokens` row or calls Plaid `itemRemove`. Orphaned live credentials accumulate (data-minimization and Plaid billing concern; Plaid may keep charging for connected items).

- **Priority:** High · **Effort:** 2–4 hours · **Files:** `backend/server.js`, `backend/tokenStore.js`
- **Acceptance criteria:** remove-item deletes accounts, token row, and (best-effort) revokes the item at Plaid; behavior documented vs `/api/plaid/disconnect`.

### BUG-4: Ledger drift detection compares against the wrong projection — High (correctness) ✅ RESOLVED (PR #31)

`frontend/src/lib/simulation/ledger.ts` (~lines 935–940): drift compares current net worth to the **last point of the simulation horizon** (potentially 30 years out) instead of today's interpolated projection. The legacy engine (`simulation.ts` lines 368–394) did this correctly. Result: drift warnings are misleading or never fire.

- **Priority:** High · **Effort:** 0.5–1 day · **Files:** `frontend/src/lib/simulation/ledger.ts`, `checkpoints.ts`
- **Acceptance criteria:** drift uses the projected value at today's date; unit test with a known checkpoint and expected variance passes.

### BUG-5: Checkpoints do not affect the production simulation — High (correctness/spec violation) ✅ RESOLVED (PR #31, per D3)

`tests/validation/spec/CheckpointSemantics.md` specifies checkpoints as state-reset events with deterministic adjustment IDs. The production ledger (`buildPlanLedgerScenario`) ignores checkpoints entirely; they appear only as chart overlay points. The legacy engine implemented the reset. Users who "correct" their plan with a checkpoint will see projections that ignore the correction.

- **Priority:** High · **Effort:** 2–4 days · **Files:** `frontend/src/lib/simulation/ledger.ts`, `checkpoints.ts`
- **Dependencies:** decide intended semantics first (see `open-questions.md`)
- **Acceptance criteria:** ledger seeds state from the latest checkpoint per the spec (or the spec is revised); golden test comparing pre/post-checkpoint projections.

### BUG-6: Ticker assets silently simplified — Medium (correctness/trust)

Ledger treats `mode: 'Ticker'` assets as flat balance + APY (`ledger.ts` ~lines 776–783); the quantity × live-price model exists only in the dead legacy engine. Users tracking brokerage positions get projections that don't match the UI's stated model.

- **Priority:** Medium · **Effort:** 2–5 days (or explicitly document/remove Ticker mode for MVP)
- **Acceptance criteria:** either Ticker assets simulate with price growth + contributions buying quantity, or the UI/docs clearly state Ticker values are simulated as APY balances.

### BUG-7: Legacy daily mode ignores checkpoint start (`simulation.ts` line ~238) — Low ✅ RESOLVED (legacy engine deleted in PR #31)

Test-only engine; matters because tests still exercise it. Fold into the dual-engine cleanup below.

## Fragile areas and reliability risks

### FRAGILE-1: Dual simulation engines — High ✅ RESOLVED (PR #31)

The float-based `simulation.ts` is dead in production but still drives golden-fixture and determinism tests. The two engines diverge on checkpoints, Ticker, and calendar scheduling, so "passing tests" doesn't fully validate the production path.

- **Recommendation:** migrate all tests to the ledger engine, then delete `simulation.ts` (Phase 1). **Effort:** 2–3 days. **Acceptance:** no imports of `simulation.ts` outside history; all golden fixtures target the ledger.

### FRAGILE-2: Silent simulation failure in the dashboard — High ✅ RESOLVED (error state + retry in `DashboardScreen`)

`DashboardScreen.tsx` (~line 104) swallows worker errors with `.catch(() => {})`. A failed simulation leaves a stale or empty chart with no message — the worst kind of failure for a trust-critical product.

- **Recommendation:** surface an error state in the chart area with a retry. **Effort:** 0.5 day.

### FRAGILE-3: No React error boundary — High ✅ RESOLVED (`ErrorBoundary` wraps app in `main.tsx`)

No `ErrorBoundary` anywhere in `frontend/src`. Any render-time exception white-screens the entire app.

- **Recommendation:** top-level boundary with a "reload / your data is saved locally" message; optional per-screen boundaries. **Effort:** 0.5 day.

### FRAGILE-4: In-process worker + schedulers + in-memory rate limits — Medium now, High at scale

`backend/lib/plaidSyncWorker.js` polls in-process; daily sync and weekly snapshots are `setInterval` in the web process; rate limiting (`middleware/rateLimit.js`) is per-process memory. With one instance this works; with 2+ instances, rate limits stop being enforced globally and every instance runs schedulers (job claiming partially mitigates duplicate sync work).

- **Recommendation (MVP):** run exactly one backend instance and document it. Defer distributed rate limiting/queues (see `architecture-upgrade-plan.md`).

### FRAGILE-5: `plaidClient.js` throws at import when Plaid creds are absent — Medium ✅ RESOLVED (lazy proxy init)

Contradicts `config.js`, which only warns in development. A developer without Plaid keys cannot start the backend at all, even for Sheets-only work.

- **Recommendation:** lazy-init the Plaid client; return 503 from Plaid routes when unconfigured. **Effort:** ~2 hours.

### FRAGILE-6: `supabaseAdmin` null-guard inconsistency — Medium ✅ RESOLVED (prod boot guard in `config.js` + route 503s)

Some routes check for a missing service-role client (Stripe, privacy, MFA); most Plaid/history routes don't and will throw a raw 500 on the first DB call if `SUPABASE_SECRET_KEY` is absent.

- **Recommendation:** one startup check: refuse to boot in production without the service key. **Effort:** ~1 hour.

### FRAGILE-7: Giant files concentrate risk — Medium

`backend/server.js` (~4,300 lines), `AccountIntegrationScreen.tsx` (~2,100), `sync.ts` (~1,200), `AppLayout.tsx` (~1,150), `NetWorthChart.tsx` (~1,100). Any change in these files carries wide blast radius and merges poorly.

- **Recommendation:** split `server.js` into routers by domain (mechanical move, no logic changes) in Phase 2; leave frontend monoliths until behavior is frozen by tests.

### FRAGILE-8: Sheets sync is manual and last-writer-wins — Medium

Sync is user-triggered; "Refresh from Sheet" replaces the local plan after a `window.confirm`. A user who edits in two places or forgets to sync can silently lose changes. The write queue helps with transient failures but not with divergence.

- **Recommendation:** for MVP, keep Sheets as **export/backup**, not a second source of truth; move authoritative persistence server-side (see `data-model-and-persistence-audit.md`).

### FRAGILE-9: Dead code and stale config mislead maintainers — Low (but cheap)

Unwired: `AlternativesPanel.tsx`, `AccountTable.tsx`, `ParityRunner.tsx`, `counter.ts`, most `legacyAdapters.ts`, `restoreBridge.ts`, `embeddedMode.ts`, `legacy.d.ts`, `optionalAuth` middleware, `syncTransactionsForItemLegacy` (~200 lines in server.js), `_getOrCreateUser`, `backend/models/user.js`, `VITE_LEGACY_*` env vars, root `vercel.json`, `.fiveserverrc`, EB postdeploy hook. Delete in Phase 0 (a dedicated commit, easily revertible).

### FRAGILE-10: Probabilistic augments re-roll per Monte Carlo run — Low (document)

By design, P50 with probabilistic augments is a median over scenario draws, not "the plan with expected values." Fine — but explain it in the UI so users trust the number.

## Edge cases with no current guard

- ~~**localStorage quota exceeded** during plan save~~ ✅ save failure now returns `false` and surfaces a banner (`PlanProvider`), tested in `tests/unit/plan-persistence.test.ts`.
- ~~**Corrupt plan JSON** falls back silently~~ ✅ corrupt snapshots are backed up before fallback, with a recovery/download/discard banner; tested.
- ~~**Worker unavailable** main-thread freeze~~ ✅ fallback run count is capped on the browser main thread (`simulationWorkerHost`), tested in `worker-host.test.ts`.
- **Negative cash / overdraft** behavior in the ledger is untested.
- **`recurring` / `conditional` augment activation types** exist in types but always evaluate inactive (`augments.ts`) — hide them in the UI or implement them.
