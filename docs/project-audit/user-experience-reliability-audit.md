# User Experience Reliability Audit

Trust is TMM's stated most important feature. This audit covers the invisible reliability users expect: does the app ever lie, lose data, or fail silently?

## What exists (confirmed from code)

- Loading states: `AppSpinner`, full-screen sync overlay, Plaid sync overlay, dashboard `simulationLoading`.
- Sheets sync status: queue count + last error surfaced in the sidebar; toasts (3 s) on sync actions.
- Confirm dialogs before destructive actions (sheet replace, unlink, delete alternative/node) — via `window.confirm`.
- Offline handling: Sheets write queue with online/visibility flush.
- Auth resilience: session timeouts, 401 retry-once, sign-out watchdog with forced cleanup.
- Restore prompt: local snapshot restore overlay with decline memory.
- Empty state on the simulation chart (dashed placeholder).

## Silent-failure inventory (the trust killers)

Ranked by severity; each is confirmed from code.

| ID | Failure | Where | Severity |
|---|---|---|---|
| UX-1 | **Simulation error → blank/stale chart, no message** (`.catch(() => {})`) | `DashboardScreen.tsx` ~104 | Critical |
| UX-2 | **Plan save failure → `console.warn` only.** localStorage full/blocked = user's edits silently unsaved | `planPersistence.ts` savePlanSnapshot | Critical |
| UX-3 | **Corrupt plan → silent reset to defaults.** User opens app to an empty plan with no explanation or recovery | `planPersistence.ts` loadPlanSnapshot | Critical |
| UX-4 | **Any render exception → white screen** (no error boundary anywhere) | `frontend/src` | High |
| UX-5 | Auto sheet-load failure on startup → `console.warn` only; user may believe they're seeing synced data | `AppLayout.tsx` ~71–98 | High |
| UX-6 | Token prefetch / profile fetch silent catches | `AuthProvider.tsx`, `AppLayout.tsx`, `SettingsScreen.tsx` | Medium |
| UX-7 | `GET /api/plaid/items` 500s (BUG-1) — whatever UI consumes it degrades | backend | High |

### Recommendation UX-A: a "save/sync truth" indicator — High

One persistent, honest indicator: *Saved locally · Backed up (server/Sheets) · Not saved — action needed*. This is the single highest-leverage trust feature and it becomes natural once server persistence (DATA-1) exists.

- **Priority:** High · **Effort:** 1–2 days (after DATA-1) · **Files:** `AppLayout.tsx`, `planPersistence.ts`, sheets storage/status modules
- **Acceptance criteria:** every failure in UX-2/3/5 produces a visible, actionable state; QA script includes "fill localStorage quota" and "corrupt the plan key" cases.

### Recommendation UX-B: error boundary + simulation error state — High

Top-level ErrorBoundary ("Something went wrong — your data is saved; reload") + inline chart error with retry (fixes UX-1, UX-4). **Effort:** 1 day.

### Recommendation UX-C: recovery, not amnesia — High

On plan parse failure: keep the corrupt blob, show "We couldn't read your saved plan — restore from backup (server revision / Sheet / XLSX) or start fresh." (Pairs with DATA-2.) **Effort:** included in DATA-2.

## Validation and input UX

- Entity edits accept whatever parses; there's no field-level validation surfacing (e.g., negative APR, payment smaller than interest accrual → debt never pays off silently). The ledger caps payments at balance but a debt that grows forever is presented without comment. **UX-D (Medium):** add lightweight sanity warnings ("this debt never reaches zero within the horizon", "expense exceeds income by X") — these double as the educational voice the brief calls for. Effort: 2–3 days, purely additive.
- Import (XLSX/Sheets) reports success/failure but not *what changed* — with DATA-3's pre-import snapshot, add a simple "imported N income, M assets…" summary toast. **Low.**

## Empty, degraded, and first-run states

- First-run: onboarding + sample data exists (good).
- Degraded: **free tier + backend down** → app functions fully from localStorage (genuinely good architecture); **TMM+ + backend down** → connected values go stale with no staleness indicator. `lastSyncedAt` fields exist on rows — surface "as of {date}" on connected values. **UX-E (Medium, 1 day).**
- Sheets disconnected/expired: `isGoogleTokenError` detection exists and routes to a reconnect flow (good).

## Undo / recovery

- No undo anywhere. Full undo stacks are out of MVP scope, but the plan-revision history from DATA-1 gives "restore a previous version" for the worst cases; the automatic pre-import snapshot (DATA-3) covers the most dangerous action. That combination is the MVP-appropriate answer.

## Copy and polish issues that undermine trust

- `frontend/index.html` `<title>` is **"frontend"** — visible in every browser tab. Fix in Phase 0 (5 minutes).
- `window.confirm`/native dialogs read as unfinished for a paid product; replace with styled modals **post-MVP** (the semantics are fine, only polish).
- Monte Carlo band (P10–P90) and probabilistic augments need one explanatory tooltip ("what does this shaded area mean?") — trust requires users understanding why numbers move between runs; there is a "Resample Forecast" button whose effect is otherwise mysterious. **UX-F (Medium, 1 day incl. copy).**

## Suggested UX reliability acceptance test (manual, pre-release)

1. Kill the backend mid-session → edit plan → reload → nothing lost, clear indicator shown.
2. Corrupt `mm-plan::{uid}` in devtools → reload → recovery flow, no silent reset.
3. Fill localStorage to quota → edit → visible failure, no fake success.
4. Import a malformed XLSX → clear error, plan unchanged.
5. Disconnect network → Sheets sync → queued indicator → reconnect → flush confirmed.
6. Throw inside a screen component (dev hook) → boundary catches, data intact.
7. Revoke Google token in account settings → Sheets action → reconnect prompt.
