# Data Model and Persistence Audit

## Where user data lives today (confirmed from code)

| Data | Store | Durability |
|---|---|---|
| **The financial plan** (alternatives, pipeline, goals, augments, checkpoints, assumptions) | Browser localStorage, key `mm-plan::{userId}` | **Device-local only.** Lost on browser clear, device change, private-window use. |
| Plan backup (optional, manual) | Google Sheets (user-triggered sync) + XLSX export | User-controlled; not guaranteed current |
| Auth identity, plan tier, prefs | Supabase (`auth.users`, `profiles`, `user_onboarding`) | Durable |
| Plaid tokens, accounts, transactions | Supabase (encrypted tokens) | Durable |
| Net worth history, snapshots, reconciliation | Supabase (`net_worth_points*`, `account_balance_snapshots`) | Durable |
| Google OAuth tokens | Supabase (encrypted) | Durable |
| UI state (tour, onboarding, restore declines, last run) | localStorage (user-scoped) | Device-local (acceptable) |

**The core problem: the product's primary artifact — the plan — is the least durable thing in the system.** A user can pay for TMM+, connect banks, build a 30-year model, and lose all of it to a browser data wipe. `restoreBridge.ts` contains a comment anticipating a future `tmm_sessions` server-side store; it was never built.

### DATA-1: Server-side plan persistence — Critical (the most important recommendation in this audit)

✅ **RESOLVED (2026-07-06, Phase 2.1–2.3).** `plans` + `plan_revisions` tables (clean baseline), `GET/PUT /api/plan` + revisions endpoints (`backend/lib/planHandlers.js`, size warn 1 MB / reject 5 MB, optimistic locking on `client_saved_at`), frontend sync gate with newer-of reconcile, debounced push, conflict banner (`planSync.ts`, `PlanProvider.tsx`), revision restore UI in Settings, and a sidebar save/backup truth indicator.

- **Priority:** Critical
- **Risk reduced:** total loss of user's financial model; cross-device inaccessibility; support burden; trust collapse.
- **Approach (boring, incremental):** a `plans` table in Supabase — `user_id (PK or unique)`, `plan jsonb`, `schema_version`, `updated_at`, `client_saved_at`. Backend endpoints `GET/PUT /api/plan` (JWT-authed; PUT validates size + `schemaVersion` and is last-writer-wins with the client's `lastSaved` echoed back for conflict detection). Frontend: keep localStorage as the fast local cache and offline layer; debounce-push to the server on change; on load, take the newer of local vs server (prompt only when both changed — reuse the existing restore-overlay pattern). Keep a small history: `plan_revisions` table storing the last N revisions (e.g., 20) for undo/recovery.
- **Effort:** 3–5 days including migration, tests, and conflict prompt.
- **Files:** new migration, `backend/server.js` (or new router), `frontend/src/lib/plan/planPersistence.ts`, `PlanProvider.tsx`, restore overlay.
- **Dependencies:** none — Supabase and auth already exist. RLS: user-scoped policies like existing tables.
- **Acceptance criteria:** sign in on a second device → plan appears; clear browser storage → plan restores from server; server unreachable → app still works from localStorage and shows a "not backed up" indicator; revisions restorable from Settings.

## Plan format and migrations (confirmed)

- `schemaVersion: '2.0'`; `migratePlan()` (`frontend/src/lib/plan/migrations.ts`) normalizes missing fields, ensures UUIDs, seeds forecast fingerprint. Legacy unscoped `mm-plan` key migrates once on load.
- **Gap — Medium (DATA-2):** migration is silent and unversioned per-step. There is no recorded history of what version a stored plan was, no migration test fixtures for old shapes, and a failed parse silently resets to `DEFAULT_PLAN_STATE` (`planPersistence.ts` — the user's plan "vanishes"). *Recommendation:* on parse/migration failure, preserve the raw blob under a `mm-plan-corrupt::{userId}::{timestamp}` key and show a recovery message; add fixture tests for each historical shape you still support. Effort: 1 day. Acceptance: corrupted plan JSON never silently discards data.
- **Gap — Low:** `lastRun.series` is persisted inside the plan (`lastRun: { series: unknown }`) — cached simulation output stored with source data bloats every save/sync. Consider excluding from persistence.

## Import/export behavior (confirmed)

- **XLSX:** `src/lib/plan/xlsx.ts` (~357 lines) + sample workbook in `frontend/public`. Import runs UUID-ensure + migrate.
- **Google Sheets:** UUID-diff sync per entity tab; fixed tabs rewritten; import parses legacy column layouts; write failures queue in localStorage with online/visibility flush; per-sheet errors abort with `{ ok:false, queued, errors }`.
- **Gap — Medium (DATA-3):** ✅ **RESOLVED (2026-07-06).** `snapshotPlanBeforeReplace()` posts a `pre_import` revision before every plan-replacing flow (Sheets connect/refresh/choose, XLSX import, sample-data load); restorable from Settings → Plan Backups.
- **Gap — Low:** `assumptions.finnhubKey` is exported into Sheets/XLSX (secret leakage into shareable files — see API audit).

## Supabase schema health (from migrations 001–021)

Good: incremental migrations, updated_at triggers, signup bootstrap trigger (007) with backfill (008), composite indexes (003), partial unique indexes for job dedupe, RLS on user-facing tables, explicit anon-deny policies (002), atomic sync-apply RPC (015).

Issues:

| ID | Issue | Priority |
|---|---|---|
| DATA-4 | ✅ **RESOLVED (2026-07-06).** Verified against live dev: legacy `users` table absent; all FKs point at `auth.users(id) ON DELETE CASCADE`. Codified in the clean baseline (`supabase/migrations/20260706185451_baseline.sql`). | High (integrity) |
| DATA-5 | ✅ **RESOLVED (2026-07-06).** Legacy `users` table does not exist in the live schema and is excluded from the clean baseline. (`backend/models/user.js` was deleted in Phase 0.3.) | Medium |
| DATA-6 | ✅ **RESOLVED (2026-07-06).** `run_retention_sweeps()` + pg_cron daily job (03:30 UTC): webhook events 90 d, sync runs/finished jobs 30 d, link intents 90 d, usage counters 30 d, connection events 1 y. `account_balance_snapshots` kept (user financial history per D15). | Medium |
| DATA-7 | ✅ **RESOLVED (2026-07-06).** Supabase CLI migrations adopted: `supabase/config.toml` + clean baseline; dev `schema_migrations` tracking matches the repo; CI shadow-applies the full set from zero (`.github/workflows/migrations-shadow-apply.yml`). Legacy `backend/supabase/migrations/` kept as history only. Prod project doesn't exist yet — it will be born from these migrations. | High (process) |

## Backup and recovery posture

- **Resolved posture (DATA-8, graduated).** Free tier is disqualified (projects pause after a week; no managed recovery). Prod launches on **Supabase Pro base (~$25/mo)**: daily backups, 7-day retention, no pausing. **PITR is deferred, not skipped:** the 7-day PITR add-on is **$100/mo** plus a required Small compute add-on (~$15) and is **not covered by the spend cap** — ~5× the base, unjustified at launch scale. Interim recovery leans on Pro daily backups plus the app-level layer shipped in Phase 2 (20 revisions/user, pre-import snapshots, XLSX export, Sheets backup).
- **PITR trigger:** enable seconds-granularity PITR at the **first real Plaid invoice** (proof that paying users with connected financial data exist). Acceptance: a written, tested restore runbook rehearsed once into a scratch project when PITR is turned on. Accepted-with-reason until the trigger fires.
- Local plan data: after DATA-1, server revisions are the user-facing backup; XLSX export is the user-controlled escape hatch (keep it prominent — it builds trust).

## Data corruption risks summary

1. Silent reset-to-default on plan parse failure (DATA-2) — worst current risk.
2. Last-writer-wins Sheets refresh replacing newer local edits (DATA-3).
3. FK/schema drift between migrations and live DB (DATA-4).
4. Concurrent multi-tab editing: two tabs share the same localStorage key with no cross-tab sync — last write wins per keystroke, and a stale tab can clobber a newer plan. Mitigate cheaply with a `storage`-event listener that reloads or warns (Medium, 0.5 day).
