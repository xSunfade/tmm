# Prioritized Roadmap

Sequenced phases from today's state to public MVP and beyond. Effort assumes one experienced developer (with AI assistance); calendar estimates are conservative. Every item cites its detailed writeup.

Legend: **[C]**ritical / **[H]**igh / **[M]**edium / **[L]**ow.

---

## Phase 0 — Repo hygiene and audit cleanup (2–4 days)

Goal: a repo where what exists is real and what's real is committed.

| # | Item | Pri | Effort | Files | Acceptance |
|---|---|---|---|---|---|
| 0.1 | Commit in-progress Sheets retry work + `tests/unit/` | [H] | 0.5 d | `backend/server.js`, `frontend/src/lib/sheets/*`, `tests/unit/`, `package.json` | Clean `git status`; sheets diff test runs |
| 0.2 | Delete stale deploy configs: root `vercel.json`, `.fiveserverrc`, EB postdeploy hook, `.ebignore` (unless EB chosen) | [H] | 0.5 d | listed | No config references nonexistent files |
| 0.3 | Delete dead frontend code (FRAGILE-9 list: legacy bridge, unused adapters/panels, `counter.ts`, `optionalAuth`, legacy sync fn, `models/user.js` pending DATA-5) — one revertible commit | [M] | 1 d | see stability audit | Build + tests green; grep finds no imports |
| 0.4 | Fix audit scripts (`verify-no-secrets.sh` TS scope, `run-audit-verification.sh` paths); run secret scan; rotate anything found (SEC-5) | [H] | 0.5 d | `scripts/` | Scan green over full repo |
| 0.5 | Complete both `.env.example`s; startup config validator (ENV-1) | [H] | 0.5 d | `backend/.env.example`, `frontend/.env.example`, `backend/config.js` | Fresh clone boots from example alone |
| 0.6 | Fix `index.html` title/meta; mark stale docs (gap analysis, tests README, implementation summary) | [L] | 0.5 d | docs, `frontend/index.html` | Tab shows product name |
| 0.7 | Branch protection + PR-based flow from now on | [M] | 0.25 d | GitHub settings | Direct pushes to main blocked |

Dependencies: none. Do 0.1 first (protects in-flight work).

## Phase 1 — Stability fixes (1–1.5 weeks)

Goal: nothing known-broken; no silent failures; one simulation truth.

| # | Item | Pri | Effort | Files | Acceptance (details in stability/UX audits) |
|---|---|---|---|---|---|
| 1.1 | BUG-1 `/api/plaid/items` ReferenceError | [C] | 1 h | `backend/server.js` | Route test green |
| 1.2 | BUG-2 inverted removeToken check; BUG-3 remove-item token cleanup | [H] | 0.5 d | `storage/supabaseStorage.js`, `server.js` | Unit tests; no orphan tokens |
| 1.3 | Error boundary + simulation error state (UX-B, fixes UX-1/4) | [H] | 1 d | `AppShell.tsx`, `DashboardScreen.tsx` | Thrown render error caught; failed sim shows retry |
| 1.4 | Save-failure visibility + corrupt-plan recovery (UX-2/3, DATA-2) | [C] | 1.5 d | `planPersistence.ts`, `AppLayout.tsx` | Manual script steps 2–3 pass |
| 1.5 | Single engine: migrate tests to ledger, delete `simulation.ts` (FRAGILE-1) | [H] | 2–3 d | `tests/simulation/*`, `frontend/src/lib/simulation/` | No legacy imports; goldens on ledger |
| 1.6 | BUG-4 drift-at-today fix; BUG-5 checkpoint semantics (needs decision, open-questions #6) | [H] | 3–4 d | `ledger.ts`, `checkpoints.ts` | Engine tests for both |
| 1.7 | Lazy Plaid client init (FRAGILE-5); supabaseAdmin boot guard (FRAGILE-6) | [M] | 0.5 d | `plaidClient.js`, `server.js` | Backend boots without Plaid creds in dev |
| 1.8 | Wire `test:unit` into CI; fix/disable CI Playwright honestly; real tokenStore in encryption test | [H] | 1 d | `.github/workflows/` | PRs run unit tests |

Dependencies: 1.5 before 1.6 (write engine tests once, against the ledger).

## Phase 2 — Data and persistence hardening (1.5–2 weeks)

Goal: user data cannot be lost.

| # | Item | Pri | Effort | Files | Acceptance |
|---|---|---|---|---|---|
| 2.1 | **Server-side plan persistence + revisions (DATA-1)** | [C] | 4–5 d | new migration, backend routes, `planPersistence.ts`, `PlanProvider.tsx` | Second-device restore; offline still works; revision restore UI |
| 2.2 | Pre-import snapshot on Sheets refresh / XLSX import (DATA-3) | [H] | 0.5 d | import flows | Every replace preceded by recoverable revision |
| 2.3 | Save/backup truth indicator (UX-A) | [H] | 1.5 d | `AppLayout.tsx` | Indicator reflects all failure modes |
| 2.4 | Resolve FK drift (DATA-4); deprecate legacy `users` (DATA-5); adopt migration tooling (DATA-7) | [H] | 1–2 d | migrations | Fresh DB rebuilds from migrations; prod schema matches |
| 2.5 | Supabase Pro + PITR + tested restore runbook (DATA-8) | [H] | 0.5 d | ops | Restore rehearsed once |
| 2.6 | Retention sweeps for unbounded tables (DATA-6) | [M] | 1 d | migration/scheduler | Row counts bounded |
| 2.7 | Cross-tab storage guard | [M] | 0.5 d | `planPersistence.ts` | Stale tab warns instead of clobbering |
| 2.8 | Split `server.js` into routers (Phase C, mechanical) | [M] | 1.5 d | `backend/` | Route table identical pre/post |

Dependencies: 2.1 → 2.2/2.3; 2.4 before any new prod deploy.

## Phase 3 — API / payment / webhook foundation (1.5–2 weeks)

Goal: money-adjacent systems provably safe.

| # | Item | Pri | Effort | Files | Acceptance |
|---|---|---|---|---|---|
| 3.1 | **Plaid webhook signature verification (SEC-1/WH-P1)** | [C] | 1.5 d | webhook route + verifier | Unsigned rejected in prod; tests |
| 3.2 | Remove/gate diag endpoints (SEC-2) | [H] | 1 h | `server.js` | Anonymous 401/404 |
| 3.3 | OAuth state nonce (SEC-3) | [H] | 1 d | `server.js` | Replay/expiry rejected; test |
| 3.4 | Stripe: PAY-1 failed-payment states, PAY-2 price verification, PAY-3 subscription persistence, PAY-5 event log | [H] | 3 d | webhook, migration | Status→entitlement table tested for every Stripe status |
| 3.5 | Admin role for ops routes + MFA removal (SEC-4) | [H] | 0.5 d | `middleware/auth.js` | Non-admin 403 |
| 3.6 | Deletion-cascade verification test | [H] | 1 d | `tests/` | Zero rows post-delete |
| 3.7 | Plaid item cleanup on downgrade (PAY-6/cost) | [H] | 1 d | webhook, cleanup fn | Downgraded users stop accruing Plaid items after grace |
| 3.8 | Stripe scenario in CI vs started backend; webhook verification tests; RLS scheduled check | [M] | 2 d | CI | Money paths gated by CI |
| 3.9 | `plaidConfig.backendApiUrl` trust boundary (SEC-6); Finnhub key out of exports (SEC-10) | [M] | 1 d | frontend | Imported plan can't redirect API traffic |

Dependencies: deployment topology decision (open-questions #8) needed for webhook URLs; 3.4 before charging anyone.

## Phase 4 — MVP release prep (1–1.5 weeks)

Goal: shippable, observable, supportable.

| # | Item | Pri | Effort | Acceptance |
|---|---|---|---|---|
| 4.1 | Deployment pipeline per architecture plan Phase D | [C] | 2 d | push→deploy; rollback tested |
| 4.2 | Monitoring: uptime, Sentry, Plaid job-failure check, billing alerts | [H] | 1 d | Alerts reach a human |
| 4.3 | Privacy policy + ToS finalized; security contact live | [C] | 1–2 d (+legal) | Published, linked in-app |
| 4.4 | Playwright smoke in CI (testing strategy P4) | [M] | 1.5 d | Green on PR |
| 4.5 | Manual pre-release scripts executed (UX 7-step, Plaid loop, Sheets loop, billing loop) | [C] | 0.5 d | All pass, logged |
| 4.6 | UX polish: staleness indicators (UX-E), sanity warnings (UX-D), Monte Carlo explainer (UX-F) | [M] | 3 d | In place |
| 4.7 | Ops runbook + kill-switch doc; release checklist walk | [H] | 1 d | Checklist 100% blockers |
| 4.8 | Perf quick wins: worker reuse (PERF-1), fallback cap (PERF-2), xlsx lazy-load | [M] | 1.5 d | Verified in profiler |

**Launch** per the release-checklist sequence. Recommended: free tier open; TMM+ invite-only until 3.x has burned in.

## Phase 5 — Post-MVP upgrades (ongoing)

In rough order:

1. Open TMM+ broadly (after one clean billing cycle + Plaid production approval).
2. Entitlement reconciliation job (PAY-7); Stripe grace-period UX polish.
3. Ticker asset modeling done properly (BUG-6 full fix) or removal.
4. `recurring`/`conditional` augments; goal-progress tie-ins to simulation.
5. Frontend monolith decomposition (opportunistic); styled dialogs; component tests where churn has stopped.
6. Scale steps only as triggered: separate worker instance flag, JWKS auth verification, Redis rate limits, worker pool.
7. Then — and only then — the vision list (AI assistant, tax-aware planning, Monte Carlo market modeling), each gated by its own design doc.

**Total to MVP: roughly 6–8 working weeks** of focused effort from today.
