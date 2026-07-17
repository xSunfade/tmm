# Implementation Phases

Sequenced plan from today's state to public launch (Gate C) and TMM+ general availability (Gate D). This supersedes `docs/project-audit/prioritized-roadmap.md` where they differ; audit item IDs (BUG-x, DATA-x, PAY-x, SEC-x, UX-x, FRAGILE-x, ENV-x, PERF-x, WH-x) still refer to the audit docs for full detail. D-numbers refer to `00-decision-register.md`.

Effort assumes one experienced developer working with the AI workforce defined in `tmm-workforce/`. Calendar estimates are conservative.

**Total: ~10–13 focused weeks to Gate C.**

**Status (2026-07-17):** Phase 0 ✅ · Phase 1 ✅ · Phase 2 ✅ COMPLETE (server-side persistence live: clean migration baseline on dev, `/api/plan` + revisions, frontend sync with conflict handling, save-truth indicator, Sheets repositioned as beta backup, `server.js` split into routers) · Phase 3 ✅ COMPLETE (domain model package, plan schema v3 with lossless stepped migration + historical fixtures, position-based market assets with deterministic price path and exact DCA per `PositionSemantics.md`, negative-cash policy spec'd + tested, unsupported augments proven inert, XLSX/Sheets at v3 with legacy dual-read, Finnhub key out of exports, Monte Carlo/Resample explainers + sanity warnings) · **Phase 4 ✅ COMPLETE** (merged to `main` via PR #49 on 2026-07-16 with CodeQL clean: table-driven entitlements 4.1–4.5 with grace sweep + dunning banner + free-tier caps server- and client-side, Stripe webhook completeness + idempotency, catalog seed script 4.6, waitlist/invites backend + UI 4.7, Plaid lifecycle state machine 4.8, Plaid webhook JWT verification 4.9, OAuth state nonces 4.10, admin role + MFA-removal step-up 4.11, deletion-cascade test 4.12, `backendApiUrl` origin allowlist 4.13, RLS anon-test scheduled in CI 4.14; ops all done: dev migration applied, Stripe test catalog seeded + legacy $5 price archived, founder `is_admin` set, CI secrets configured) · **Phase 5.1 ✅ DONE** (2026-07-17: `tmm-staging` created and rebuilt from `supabase/migrations/` alone — see 5.1 row). Remaining founder ops task: Supabase Pro at launch; PITR + restore rehearsal deferred to the first real Plaid invoice (DATA-8). Next: core features/optimizations on local/dev, then remainder of Phase 5 (hosting, DNS/webhooks, pipeline, monitoring) toward prod/soft launch.

## Sequencing rationale (why this order)

1. **Hygiene first** (Phase 0) — everything after this happens on branches with CI actually guarding the money paths.
2. **Stability before features** (Phase 1) — confirmed bugs and silent failures are cheap to fix and poison every later verification if left in.
3. **Persistence before the domain-model rework** (Phase 2 before 3) — server-side plans + revisions are schema-agnostic (jsonb + version), deliver the biggest trust win early, and mean the risky plan-schema migration in Phase 3 happens *with* revision history as a safety net.
4. **Domain model before billing** (Phase 3 before 4) — free-tier limits (D8) are defined over plan contents (alternatives, horizon); enforcing them against a schema about to change would be rework.
5. **Environments and deployment last-but-not-launch** (Phase 5) — but the *decisions* (topology, domains) are already made (D18/D19), so webhook URLs and CORS assumptions are stable from day one, and staging is stood up mid-Phase-4 when integration testing needs it.

---

## Phase 0 — Repo, CI, and audit hygiene (~3–4 days) ✅ COMPLETE

Goal: a repo where what exists is real, what's real is committed, and CI guards regressions.

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 0.1 | Commit the audit answers doc; adopt branch/PR flow + branch protection on main | [C] | audit 0.7 | Direct pushes blocked; PRs required |
| 0.2 | Delete stale deploy configs (root `vercel.json`, `.fiveserverrc`, EB remnants) | [H] | audit 0.2 | No config references nonexistent files |
| 0.3 | Delete dead code per FRAGILE-9 list (one revertible commit) | [M] | FRAGILE-9 | Build+tests green; grep clean |
| 0.4 | Fix audit scripts; run full secret scan (incl. TS); rotate anything found | [H] | SEC-5 | Scan green over full repo + history |
| 0.5 | Complete both `.env.example`s; startup config validator | [H] | ENV-1 | Fresh clone boots from examples alone |
| 0.6 | Wire `test:unit` into CI; fix/disable Playwright job honestly; point encryption test at real `tokenStore.js` | [H] | audit 1.8 | PRs run unit tests |
| 0.7 | Fix `index.html` title/meta; mark stale docs | [L] | audit 0.6 | Tab shows product name |

Dependencies: none. Everything else builds on 0.1 and 0.6.

## Phase 1 — Stability and silent-failure fixes (~1 week) ✅ COMPLETE

Goal: nothing known-broken; the app never lies about save state; failures are visible. (Engine-semantics work moves to Phase 3 — see rationale.)

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 1.1 | Fix `/api/plaid/items` ReferenceError | [C] | BUG-1 | Route test green (0/1/N items) |
| 1.2 | Fix inverted `removeToken` check; remove-item revokes at Plaid + deletes token row | [H] | BUG-2, BUG-3, D12 | Unit tests; zero orphan tokens after removal |
| 1.3 | Top-level React error boundary + simulation error state with retry | [H] | UX-1/4, FRAGILE-2/3 | Thrown render error caught; failed sim shows message |
| 1.4 | Save-failure visibility + corrupt-plan recovery (preserve corrupt blob, offer restore) | [C] | UX-2/3, DATA-2 | Quota-full and corrupt-key manual tests pass |
| 1.5 | Lazy Plaid client init; `supabaseAdmin` boot guard | [M] | FRAGILE-5/6 | Backend boots without Plaid creds in dev; refuses prod boot without service key |
| 1.6 | Remove/gate diag endpoints | [H] | SEC-2 | Anonymous 401/404 in production |
| 1.7 | Main-thread fallback cap for Monte Carlo; worker reuse | [M] | PERF-1/2 | No per-run worker spawn; fallback capped |

Regression policy applies from here forward: every bug fix lands with a test in the same PR.

## Phase 2 — Server-side persistence: Supabase becomes ASOT (~2 weeks) ◀ IN PROGRESS

Goal: user data cannot be lost; the server is authoritative (ADR-1).

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 2.1 | ✅ DONE — `plans` + `plan_revisions` tables (clean-baseline migration set begins here — see `03-data-model-and-migration-plan.md`); RLS user-scoped. Baseline `20260706185451` + hardening migrations applied to dev; CI shadow-applies from zero | [C] | DATA-1, D5, D16 | Fresh DB rebuilds from CLI migrations |
| 2.2 | ✅ DONE — `GET/PUT /api/plan`: JWT auth, 1 MB warn / 5 MB reject, schema-version check, `client_saved_at` conflict echo (`backend/lib/planHandlers.js` + unit tests) | [C] | D14 | Integration tests: round-trip, oversize reject, conflict prompt |
| 2.3 | ✅ DONE — Frontend: localStorage → cache layer; debounced server push; newer-of on load; conflict prompt (`planSync.ts`, `PlanServerSyncGate` in `PlanProvider.tsx`) | [C] | DATA-1 | Second-device restore; offline editing still works |
| 2.4 | ✅ DONE — Revision history: revision-per-save, prune to 20, restore UI in Settings → Plan Backups (Account) | [H] | D14 | Restore from any of last 20 revisions |
| 2.5 | ✅ DONE — Pre-import snapshot (`snapshotPlanBeforeReplace`) before Sheets import, XLSX import, sample-data load | [H] | DATA-3 | Every replace preceded by recoverable revision |
| 2.6 | ✅ DONE — Save/backup truth indicator in sidebar (`PlanSaveIndicator`): local save, backing up, backed up, offline, conflict | [H] | UX-A | Reflects all failure modes incl. server-down |
| 2.7 | ✅ DONE — Sheets repositioning: UI copy → "Export backup / Import from sheet"; sync-as-truth language removed; Sheets OAuth already a separate consent flow (Sheets/Drive scopes only), now beta-labeled | [H] | D5, D21, ADR-8 | Sheets connect is explicit, scoped, labeled |
| 2.8 | ✅ DONE — Cross-tab storage guard (`subscribeToExternalPlanWrites` + stale-tab banner; saves pause until the user picks a version) | [M] | data audit §corruption 4 | Stale tab warns instead of clobbering |
| 2.9 | ✅ DONE — `server.js` split into `routes/` (stripe, plaid, google, plan, privacy, history) + `lib/` services; verified identical 56-route table pre/post (`backend/scripts/compare-route-tables.mjs`) and clean boot | [M] | FRAGILE-7, Phase C | Express route table identical pre/post |

Dependencies: 2.1 → 2.2 → 2.3/2.4/2.5/2.6. 2.9 anytime after 2.2 (new plan router lands in the split layout).

Also landed with Phase 2 (from the audit roadmap): retention sweeps (DATA-6, `run_retention_sweeps()` + pg_cron daily 03:30 UTC) and grant hardening (anon fully revoked; token tables service-role-only). Outstanding founder action: Supabase Pro at launch; PITR + restore rehearsal deferred to the first real Plaid invoice (DATA-8).

## Phase 3 — Domain Model Foundation and simulation truth (~2.5–3 weeks) ✅ COMPLETE

Goal: one authoritative engine running the model the UI describes, on a domain model built for the product's future (ADR-2). This is the audit's Phase-1 engine work **expanded by D3/D4**.

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 3.1 | ✅ DONE — Domain model types (`frontend/src/lib/domain/`): Account, Position (+acquisitions), CashFlow, Debt, Checkpoint, Assumptions; plan schema **v3** with stepped `migratePlan` + historical fixtures (`tests/fixtures/plans/historical/`, `tests/unit/plan-migrations.test.ts`) | [C] | D4 | v1/v2 plans migrate losslessly; Ticker quantity derived (value ÷ price) flagged `positionNeedsReview` |
| 3.2 | ✅ DONE — Position-based market assets in the ledger: deterministic fixed-point price path (micro-cents), quantity in micro-shares, contributions buy at `price(t)` (exact DCA). Spec: `tests/validation/spec/PositionSemantics.md`; tests: `tests/simulation/position-semantics.test.ts` | [C] | BUG-6, D4 | Golden: position value = qty × price (exact); DCA zero-return hand-computed + growth vs independent model |
| 3.3 | ✅ DONE EARLY (PR #31) — Checkpoint semantics: engine seeds state from latest checkpoint; deterministic adjustment IDs per spec | [C] | BUG-5, D3 | Pre/post-checkpoint golden tests; spec updated where needed |
| 3.4 | ✅ DONE EARLY (PR #31) — Drift detection compares against **today's** projection from the checkpoint baseline | [H] | BUG-4 | Unit test with known checkpoint + expected variance |
| 3.5 | ✅ DONE EARLY (PR #31) — Migrate golden/determinism/frequency tests to the ledger; delete `simulation.ts` | [H] | FRAGILE-1 | No legacy imports; all goldens target ledger |
| 3.6 | ✅ DONE — Negative cash defined (allowed, no floor, spec'd) + tested; `recurring`/`conditional` augments hidden in editor, proven inert, labeled "Not supported" on legacy rows (`tests/simulation/engine-edge-cases.test.ts`) | [M] | stability edge cases | Tests green |
| 3.7 | ✅ DONE — XLSX/Sheets export at v3 (position columns appended; Finnhub key removed per SEC-10); import keeps reading v1/v2 layouts | [H] | D5 | Legacy import paths unchanged; new columns tolerated absent |
| 3.8 | ✅ DONE — Monte Carlo band + Resample explainer tooltips (augment-probability framing, no market-prediction implication); plan sanity warnings (outflow > income, debt payment ≤ interest) on the dashboard | [M] | UX-D/F | Tooltips/warnings in place |

Dependencies: 3.1 → 3.2/3.3 → 3.4/3.5. The property-test suite (conservation, rounding-loss-zero, now including the position qty×price invariant) stayed green throughout.

## Phase 4 — Entitlements, billing, Plaid lifecycle, and security hardening (~2 weeks)

Goal: money-adjacent systems provably safe; tiers and limits enforced; Plaid item lifecycle policy live (ADR-3, ADR-6, ADR-7).

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 4.1 | Entitlement layer: `plan_catalog` + `tier_entitlements` tables; table-driven (status, price, grace) → tier resolution; middleware reads entitlements | [C] | D7, PAY-1/2 | Every Stripe status maps explicitly; unit-tested |
| 4.2 | Persist subscription state (`subscription_id`, status, `current_period_end`, `grace_expires_at`) | [H] | PAY-3 | Profile reflects live state after each webhook |
| 4.3 | Webhook completeness: `checkout.session.completed`, `invoice.payment_failed`, event-id idempotency log (90-day retention) | [H] | PAY-4/5, WH-S1/S4 | Event log populated; replays no-op |
| 4.4 | 7-day `past_due` grace: banner UX, scheduled expiry sweep → downgrade | [C] | D11 | Stripe test-clock run: upgrade → past_due → day-7 downgrade |
| 4.5 | Free-tier limits: 3 alternatives / 5-year horizon enforced at plan save + UI upgrade prompts | [H] | D8 | Server rejects over-limit saves for free tier; UI prompts |
| 4.6 | Stripe catalog: build TMM+ and TMM+ Pro products, monthly + annual prices in test mode; pricing set per the floor analysis | [H] | D7, `04-billing` | Catalog in test mode; floor analysis signed off |
| 4.7 | Waitlist + invites: TMM+ waitlist table + signup flow; invite issuance/redemption; free-signup soft-cap switch | [H] | D1, D2 | Founder can invite; uninvited users join waitlist; soft-cap flips signup to waitlist |
| 4.8 | Plaid lifecycle: downgrade → suspend sync; 30-day token retention; revocation sweep; restore-without-relink | [C] | D12, ADR-6 | State-machine tests; sweep verified in staging |
| 4.9 | Plaid webhook JWT verification (`Plaid-Verification`) | [C] | SEC-1, WH-P1 | Unsigned rejected in prod; key cache/rotation handled |
| 4.10 | OAuth state nonce (signed, single-use, TTL, user-bound) | [H] | SEC-3 | Replay/expiry/foreign state rejected |
| 4.11 | Admin role for ops routes; MFA-removal gated | [H] | SEC-4 | Non-admin 403 |
| 4.12 | Deletion-cascade verification test (full-footprint user → zero rows) | [H] | SEC audit | Green against staging |
| 4.13 | `plaidConfig.backendApiUrl` trust boundary; Finnhub key out of exports | [M] | SEC-6/10 | Imported plan can't redirect API traffic; no secrets in exports |
| 4.14 | Money-path CI: Stripe scenario vs started backend; webhook verification tests; scheduled RLS anon-test vs staging | [H] | audit 3.8 | Money paths gated by CI |

Dependencies: 4.1 → 4.2/4.4/4.5; staging Supabase project (Phase 5.1) is needed by 4.12/4.14 — stand it up in parallel mid-phase.

## Phase 5 — Environments, deployment, and release prep (~1.5–2 weeks)

Goal: three clean environments; one reproducible deployment; observable and supportable (ADR-4, ADR-5).

| # | Item | Pri | Refs | Acceptance |
|---|---|---|---|---|
| 5.1 | ✅ DONE (2026-07-17) — **staging** Supabase project `tmm-staging` (`wekawukfpdqinesbltnx`, us-east-1, free tier) built from `supabase/migrations/` alone; schema fingerprint-matched dev (drift converged via `20260717025906_converge_legacy_dev_drift.sql`); catalog seeded; RLS anon-test 21/21 green; advisors clean; legacy `backend/supabase/migrations/` deleted — single migration source | [C] | D17 | Staging rebuilt from migrations alone ✓ |
| 5.2 | Create **prod** Supabase project on **Supabase Pro** (base); **PITR deferred to the first real Plaid invoice** (then rehearse restore + write runbook) | [C] | D17, DATA-8 | Pro on before launch; PITR add-on + restore rehearsed once into scratch project when trigger fires |
| 5.3 | Provision always-on backend (Render default) for staging + prod; migrate off Vercel serverless backend | [C] | D18, ADR-4 | Worker + schedulers verified running; Vercel backend demoted to dev |
| 5.4 | DNS/TLS: `api.tmm.finance`; re-register Stripe + Plaid webhooks and OAuth redirects to stable domains; HSTS on | [C] | D19, WH-P2 | Webhook test events received on prod URL |
| 5.5 | Deploy pipeline: push → CI green → deploy; documented + tested rollback for both tiers | [C] | audit 4.1 | Rollback rehearsed |
| 5.6 | Monitoring: uptime on `/api/health`, Sentry front+back, Plaid job-failure daily check, billing alerts — all → founder email | [H] | D25 | Alerts reach a human; test alert fired |
| 5.7 | Retention sweeps live: webhook events 90 d, sync logs 30 d, audit logs 1 y, revision prune, soft-delete purge | [H] | D15, DATA-6 | Row counts bounded; sweep logs visible |
| 5.8 | Legal/docs: privacy policy + ToS with real operator identity (D26); deletion SLA text (D24); refund policy (D9); support expectations (D28); security contact | [C] | D24/26/28 | Published, linked in-app |
| 5.9 | Turnstile production site key; leaked-password protection on; Supabase advisor cleanup (search_path pins, GraphQL exposure) | [H] | D22, ADR-7 | Advisors clean or accepted-with-reason |
| 5.10 | Analytics: privacy-respecting pageviews wired on deployed frontend | [M] | D30 | Pageviews visible; privacy policy discloses |
| 5.11 | One Playwright smoke in CI (seeded local stack); manual pre-release scripts executed (UX 7-step, billing loop, Plaid sandbox loop, Sheets loop, sample XLSX) | [C] | testing strategy P4 | All pass, logged |
| 5.12 | Ops runbook: env vars, kill switches, webhook re-registration, worker restart, Supabase restore, incident flow | [H] | audit 4.7 | Runbook complete; kill switches tested |

## Phase 6 — Launch and post-launch (ongoing)

- **Gate C launch** per `10-launch-readiness-gates.md`: freeze → deploy → verify webhooks → founder end-to-end in prod → open free signup → 48-hour watch with abort thresholds.
- **Burn-in:** founder + invitees run TMM+ through ≥1 full real billing cycle; monitor entitlement correctness, Plaid sync health, costs.
- **Gate D:** open TMM+ to the waitlist in cohorts (see `04-billing-and-entitlements.md` §Rollout).
- **Post-MVP order** (from the audit, still valid): entitlement reconciliation job (PAY-7) → grace-period UX polish → `recurring`/`conditional` augments + goal-simulation tie-ins → frontend monolith decomposition (opportunistic) → styled dialogs → scale steps only as triggered (second instance + `RUN_PLAID_WORKER` split, JWKS local verification, Redis rate limits) → then the vision list (AI assistant, tax-aware planning, Monte Carlo market models, dividends/tax lots on the domain model), each gated by its own design doc.

## Cross-phase workstreams

| Workstream | Runs during | Notes |
|---|---|---|
| Google OAuth app verification (Sheets scopes) | Phases 2–5, parallel | Not a launch gate (D21); submit early, it has lead time |
| Pricing floor analysis + final price points | Phase 4 | Requires current Plaid contract pricing; see `04-billing-and-entitlements.md` |
| Docs upkeep (API reference from route table, stale-doc cleanup) | Every phase | Owned by the Documentation role in `tmm-workforce/` |
| Dependency updates (Dependabot triage) | Every phase | Patch/minor auto-merge on green CI; majors + money-path/core libs (Stripe, Plaid, Express, build tooling) held for deliberate tested upgrades. Procedure + current held-majors backlog: `docs/security/VULNERABILITY_MANAGEMENT_POLICY.md` §2.2.1 / §3.1 |
| Cost review ritual (15 min/month) | From Phase 5 | Four numbers: Plaid items, Supabase usage, host spend, Stripe fees |
