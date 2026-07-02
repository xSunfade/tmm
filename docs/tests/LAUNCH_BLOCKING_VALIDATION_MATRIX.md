s# TMM Launch-Blocking Validation Matrix (Supabase Local)

This document is a **repo-executable validation strategy** for TMM as a production-ready financial product.
It assumes **exhaustive, realistic datasets** and validates **long-term user behavior** (weeks/months away, Plaid refreshes, reconnect/disconnect, rolling history windows, drift).

It is designed to be **launch-blocking**: you should not ship unless every acceptance gate here is met.

---

## Scope: what must remain correct after months away

### Surfaces
- **Auth + ownership enforcement**: user isolation, tier gating, service-role-only writes.
- **Account integrations & CFAs**: linked accounts inventory + “connected vs current vs stale”.
- **CFA → node linkage**: `connectedAccountId` propagation and remapping across reconnects.
- **Plaid sync correctness**: cursor correctness, backfill correctness, idempotency, remove/modify behavior.
- **History correctness**: Plaid coverage aging, archiving, checkpoints merge, reconciliation overrides.
- **Simulation correctness**: math correctness anywhere values are shown (dashboard, charts, projections, tooltips).

### Priority ladder (history)
For any date \(D\), the chart/history API must deterministically pick:
1. **Plaid_live** (inside observed coverage window)
2. **Plaid_archived** (snapshots/points outside coverage, or after disconnect/downgrade)
3. **Checkpoint** (user/auto)
4. **Manual fallback**

---

## Environment: Supabase local (required)

### Required services
- **Supabase local**: Postgres + Auth (`auth.users`) + RLS enabled.
- **Backend**: `backend/server.js` running locally.
- **Frontend**: `frontend` running locally (for browser E2E).

### Required env vars (minimum)
- Backend: see `backend/.env.example`
- Tests:
  - `BACKEND_URL` (default `http://localhost:3000`)
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (for security/data seeding tests)
  - `TMM_PLUS_JWT` / `FREE_JWT` (for tier scenarios)
  - Plaid sandbox creds if running live Plaid tests; otherwise use fixtures/mocks

---

## Datasets & fixtures (exhaustive + realistic)

You need **deterministic fixtures** for all suites. The goal is repeatability.

### Personas (minimum set)
Create fixtures for at least these 12 users:
1. **Free_manual_only**: no Plaid, heavy checkpoints, 3–5y history
2. **Plus_single_item_low_volume**: 1 item, 2 accounts, low txn volume
3. **Plus_multi_item_high_volume**: 3 items, 12 accounts, 50k–250k txns
4. **Plus_reconnect_frequent**: repeated reconnects; account IDs churn
5. **Plus_partial_selection**: some accounts deselected; stale CFAs exist
6. **Plus_long_absence**: no app opens for 30/60/120 days; sync continues
7. **Plus_downgrade_then_return**: tier drops to free then returns months later
8. **Plus_disconnect_then_return**: disconnect item; history must remain coherent
9. **Multi_currency**: USD + CAD/EUR presence (must be explicit about support)
10. **DST_timezone**: non-UTC timezone; DST boundary dates
11. **Leap_day**: Feb 29 dataset
12. **Corrupt_partial_data**: missing merchant/category/nulls/unexpected strings

### Fixture types
#### A) DB seed fixtures (SQL)
Place/extend SQL scripts under:
- `tests/performance/generate-test-data.sql` (existing)
- Add a second script (recommended): `tests/performance/generate-test-data-longhorizon.sql`

Must seed:
- `auth.users` + `public.profiles` (`plan_tier` per persona)
- `plaid_tokens`, `accounts`, `transactions`
- `account_balance_snapshots`, `net_worth_points`, `history_reconciliation_overrides`, `plaid_sync_runs`

#### B) Plaid sync session fixtures (JSON)
Add deterministic fixtures for `/transactions/sync` and `/transactions/get` windows:
- `tests/fixtures/plaid/sync_runs/*.json`
- Each fixture must include: pages, has_more sequencing, added/modified/removed arrays, and expected `next_cursor`
- Include mutation-during-pagination case to validate retry path

#### C) Plan fixtures (JSON)
Add plan JSON fixtures with:
- multiple alternatives
- mixed manual/connected rows
- `connectedAccountId` set across row types
- checkpoints spanning 5+ years

Recommended directory:
- `tests/fixtures/plans/*.json`

---

## Validation layers

### Layer 0: static & hygiene (ship gate)
**Objective**: zero footguns before running dynamic tests.

Run:
- `scripts/verify-no-secrets.sh`

Acceptance:
- No secrets committed.
- No `.env` leak.

---

### Layer 1: unit tests (math + determinism)
**Objective**: simulation engine and history merge logic are correct in isolation.

#### Targets
- `frontend/src/lib/simulation/*`
- `frontend/src/lib/plan/*` (override rules)
- Backend merge logic for history and reconciliation

#### Required unit cases (must be automated)
1. Net worth invariants: assets − debts, negative balances, zero/NaN guards
2. Frequency correctness (weekly/biweekly/monthly/yearly) across month boundaries
3. Determinism: same plan → same series points and historicalSeries
4. Checkpoint sorting/dedup and date parsing hardening
5. History ladder selection: live vs archived vs checkpoint vs manual
6. Coverage boundary: inside window vs outside window blending
7. Reconciliation threshold: exactly-on-boundary vs over-boundary
8. Reconciliation override stability: override persists across reloads

Acceptance:
- 100% pass.
- Determinism checks: repeated runs match byte-for-byte for same inputs.

---

### Layer 2: security & RLS tests (ship gate)
**Objective**: impossible for user A to access user B data.

Use existing scripts:
- `tests/security/rls-anon-test.js`
- `tests/security/service-role-isolation.test.js`
- `tests/security/token-encryption.test.js`

Add coverage for new history tables:
- `account_balance_snapshots`
- `net_worth_points`
- `history_reconciliation_overrides`
- `plaid_sync_runs`

Required scenarios:
1. Anon key cannot read/write any user data
2. User JWT can only read their own rows
3. Attempted cross-user access is rejected (403/404)
4. Service role can read/write as required, but is never exposed to client

Acceptance:
- All RLS tests pass.
- At least one explicit cross-user attack per endpoint/table.

---

### Layer 3: backend integration tests (API + DB invariants)
**Objective**: APIs behave correctly with seeded large datasets, including failure modes.

Use and extend existing `tests/e2e/*.test.js` style scripts (node-runner scripts).

#### Required API suites (must exist)
1. **Plaid item/account inventory**:
   - `GET /api/plaid/items-with-accounts`
   - Validate `connected` flag (token presence) and `current` flag (accountsGet)
2. **Transactions sync correctness**:
   - `POST /api/plaid/transactions/sync`
   - Validate: cursor advances, backfill window resync, dedupe, removed deletes
3. **Reconnect mapping**:
   - `POST /api/plaid/reconnect-in-place`
   - Validate mapping returned; old item preserved; no orphan drift
4. **Disconnect / remove item**:
   - `POST /api/plaid/disconnect`, `POST /api/plaid/remove-item`
   - Validate final snapshot/archive point written before removal
5. **History APIs**:
   - `GET /api/history/net-worth`
   - `POST /api/history/net-worth` (with checkpoints payload)
   - Validate ladder correctness, needsReview flags, coverage correctness
6. **Reconciliation override**:
   - `POST /api/history/reconciliation`
   - Validate override stored + net_worth_points updated and stable across reruns

Acceptance:
- Each suite passes against:
  - low volume persona
  - high volume persona
  - disconnect/downgrade persona
- No nondeterministic failures.

---

### Layer 4: temporal testing (time passing; weeks/months away)
**Objective**: prove the “leave for months and return” contract.

#### Time control requirements
You must be able to simulate:
- T0, T+7d, T+30d, T+90d, T+180d

Recommended approach:
- E2E test harness that runs in steps and seeds DB state for each “time slice”.
- Use deterministic timestamps in seeded rows (`created_at`, `as_of`, `date`, etc.).

#### Required temporal scenarios (explicit)
For each scenario, execute at multiple time slices:
1. **User absent; sync continues**: history grows; chart remains coherent
2. **Connection degrades**: item stale/disconnected; history falls back to archived/checkpoints
3. **Reconnect after absence**: account IDs change; node link remapping correct
4. **Plaid coverage aging**: points outside coverage remain stable, inside coverage updates
5. **Retroactive corrections**: modified/removed txns; changes bounded and explainable
6. **Tier downgrade**: final archive written; user returns free with coherent history
7. **Checkpoint mismatch**: needsReview → user override → stable thereafter

Acceptance:
- Across all time slices:
  - No broken links (`connectedAccountId` maps correctly or is explicitly unlinked)
  - History point selection deterministic and explainable (source shown)
  - Any value changes are attributable to sync/snapshot/override events

---

### Layer 5: browser E2E (frontend + backend + Supabase local)
**Objective**: verify user-visible correctness and explainability.

Tooling recommendation:
- **Playwright** (preferred) for time mocking + browser automation.

#### Required E2E journeys
1. Sign in; verify plan tier indicator (FREE/PLUS)
2. Connect Plaid; CFAs load; link CFA to nodes; values propagate
3. Refresh tab after “weeks” \(time jump\); verify values & history
4. Reconnect-in-place; verify node links preserved and correct
5. Disconnect item; verify chart still has coherent archived history + UI messaging
6. Trigger “needs review”; resolve via reconciliation; reload and confirm stable

Acceptance:
- UI is never silently wrong:
  - provenance visible in tooltips
  - “needs review” visible and actionable
  - stale/disconnected state visible

---

## Global invariants (must always hold)

### Ownership
- A user cannot read/write other user’s items/accounts/transactions/history via any endpoint.

### Link correctness
- `connectedAccountId` must never silently repoint to the wrong account after reconnect.
- If mapping fails, the link must be explicitly cleared.

### History determinism
- For any \(user, date\), point selection is deterministic:
  - override > ladder > checkpoint > manual

### As-of stability
- “Yesterday” should not shift during the day without a sync/snapshot cause.

### Math correctness
- Net worth and chart points agree with the underlying sources (within defined tolerance).

---

## Ship gates (launch-blocking acceptance criteria)

TMM is **trustworthy** only if:
1. All unit + integration + E2E suites pass on Supabase local.
2. Temporal suite passes across T0…T+180d for all personas.
3. Cross-user attack matrix is explicitly tested for every endpoint/table.
4. High-volume persona performance stays within defined SLAs:
   - history endpoint p95 < 300ms for 5y monthly points
   - sync run bounded (no OOM, no runaway)
5. No silent correctness failure is possible without a visible degraded state indicator.

---

## Repo-executable command matrix (current + recommended)

### Existing scripts you can run today
```bash
# security
node tests/security/token-encryption.test.js
cd backend && node ../tests/security/rls-anon-test.js
node tests/security/service-role-isolation.test.js

# backend e2e (node scripts)
node tests/e2e/backend-health.test.js
node tests/e2e/cors.test.js
node tests/e2e/plaid-transactions-sync.test.js
```

### Recommended additions (to implement next)
1. `tests/e2e/history-net-worth.test.js` (GET/POST history + merge + needsReview)
2. `tests/e2e/reconciliation-override.test.js` (override write + persistence)
3. `tests/e2e/reconnect-mapping.test.js` (reconnect-in-place + node remap fixture)
4. `tests/e2e/temporal-suite.test.js` (T0→T+180d slice runner)
5. `tests/playwright/` (browser E2E; connects UI expectations to provenance)

---

## Notes / constraints

- **Multi-currency**: do not silently sum mixed currencies. Either normalize with FX (explicit) or mark unsupported and ensure tests enforce “no silent sum”.
- **Plaid sandbox realism**: where live Plaid is impractical in CI, use deterministic fixtures for sync responses and test backend logic against those fixtures.

