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
- **Gap — Medium (DATA-3):** no dry-run/preview on import; "Refresh from Sheet" replaces the local plan after a single `window.confirm`. With DATA-1 in place, take an automatic server revision snapshot before any import/replace. Acceptance: every destructive import is preceded by an automatic recoverable snapshot.
- **Gap — Low:** `assumptions.finnhubKey` is exported into Sheets/XLSX (secret leakage into shareable files — see API audit).

## Supabase schema health (from migrations 001–021)

Good: incremental migrations, updated_at triggers, signup bootstrap trigger (007) with backfill (008), composite indexes (003), partial unique indexes for job dedupe, RLS on user-facing tables, explicit anon-deny policies (002), atomic sync-apply RPC (015).

Issues:

| ID | Issue | Priority |
|---|---|---|
| DATA-4 | Migration 001 defines `plaid_tokens.user_id REFERENCES users(id)` (legacy table) while runtime writes Supabase `auth.users` UUIDs. Either the FK was relaxed manually (drift between migrations and live schema) or inserts should be failing. **Unknown / needs verification against the live database.** Re-point or drop the FK in a new migration; never edit old ones. | High (integrity) |
| DATA-5 | Legacy `users` table + `backend/models/user.js` + `_getOrCreateUser` are dead weight; deletion flow still references them. Deprecate explicitly. | Medium |
| DATA-6 | Unbounded growth: `plaid_webhook_events`, `plaid_sync_runs`, `plaid_connection_events`, `account_balance_snapshots` (prune function was added in 019 then dropped in 021 — pruning is currently absent). Add simple retention sweeps. | Medium |
| DATA-7 | Migration hygiene going forward: migrations appear hand-applied (no migration runner in repo, no `supabase/config.toml`). Adopt `supabase db push`/CLI or a checked-in apply script so environments can be rebuilt identically. **Unknown:** how prod schema is currently applied. | High (process) |

## Backup and recovery posture

- **Unknown / needs clarification:** Supabase plan tier and whether PITR (point-in-time recovery) is enabled. Free tier has only limited daily backups; a financial product should have PITR (Pro plan) before public launch.
- **Recommended (DATA-8, High, ~0):** enable Supabase Pro + PITR; document restore procedure; test one restore into a scratch project before launch. Acceptance: a written, tested restore runbook.
- Local plan data: after DATA-1, server revisions are the user-facing backup; XLSX export is the user-controlled escape hatch (keep it prominent — it builds trust).

## Data corruption risks summary

1. Silent reset-to-default on plan parse failure (DATA-2) — worst current risk.
2. Last-writer-wins Sheets refresh replacing newer local edits (DATA-3).
3. FK/schema drift between migrations and live DB (DATA-4).
4. Concurrent multi-tab editing: two tabs share the same localStorage key with no cross-tab sync — last write wins per keystroke, and a stale tab can clobber a newer plan. Mitigate cheaply with a `storage`-event listener that reloads or warns (Medium, 0.5 day).
