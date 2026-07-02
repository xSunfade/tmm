# Performance and Scalability Audit

## Simulation engine (the dominant compute cost)

**Confirmed from code** (`frontend/src/lib/simulation/ledger.ts`, `DashboardScreen.tsx`):

- Daily stepping regardless of output granularity: 30 years ≈ 10,950 iterations per run per alternative.
- Complexity per run: `O(days × (flows + accounts + augments))`.
- Dashboard runs 20 Monte Carlo runs immediately, refined to 80 after ~2.5 s idle. Worst realistic case (80 runs × 3 alternatives × 30 y daily) ≈ **2.6 M day-steps** plus event array allocation.
- Runs in a web worker (UI stays responsive); results cached in a 16-entry module-level map keyed by a full input fingerprint; monthly granularity skips daily balance capture (memory win).
- The committed stress report claims a 10-year scenario in ~28 ms — bigint day-loops are cheap; the multiplier is Monte Carlo × alts.

### Findings

| ID | Finding | Priority |
|---|---|---|
| PERF-1 | **A fresh `new Worker()` per simulation request** (`simulationWorkerHost.ts`), with the entire `PlanState` structured-cloned in each time. Worker startup + clone can rival simulation time for small plans. Reuse one long-lived worker; terminate only on error. Effort: 0.5–1 day. Acceptance: no per-run worker spawn; identical results (existing worker-parity test). | Medium |
| PERF-2 | **Main-thread fallback runs the full Monte Carlo load** if workers are unavailable — would freeze the tab. Cap fallback at 1 run / monthly granularity. Effort: ~2 h. | Medium |
| PERF-3 | **`events[]` accumulates every ledger event across the horizon** even when only net-worth series are consumed. For 30 y × many flows this is the main memory cost. Make event capture opt-in (audit view only). Effort: 0.5 day. | Low–Medium |
| PERF-4 | **Percentile aggregation stores all runs' full series** before computing P10/50/90. Could use online selection, but at 80 runs it's fine. Note only. | Low |
| PERF-5 | `EXPORT_RUNS = 500` constant is display copy, never executed — remove to avoid someone "enabling" it casually. | Low |

**Verdict:** simulation performance is in good shape for MVP. Do PERF-1/2, skip the rest until users report problems.

## Rendering / frontend

- `NetWorthChart.tsx` (~1,100 lines) is custom SVG/canvas work — **unknown** how it behaves with daily granularity × 30 years (~11 k points × up to 4 series). If sluggish, downsample to ~1–2 points per pixel before rendering (standard technique). Verify with a manual test before launch.
- Plan edits rewrite localStorage on **every** reducer change (`PlanPersistenceGate`) — `JSON.stringify` of the whole plan per keystroke-ish change. Fine for plans < ~1 MB; debounce (250–500 ms) is a one-liner improvement when server sync (DATA-1) lands anyway.
- Bundle: React 19 + xlsx + charts. `xlsx` is heavy (~400 KB min) and only needed for import/export — lazy-load it on first use (`import()` in the xlsx module). Effort: ~2 h. **Medium** — improves first paint for everyone.
- No route-level code splitting (hand-rolled routing, single bundle). Acceptable for MVP; consider `React.lazy` per screen later.

## Backend

- Express monolith, stateless per request except in-memory rate limits and worker/schedulers → **scale ceiling is one instance** until those move out (documented in architecture plan). One modest instance should comfortably serve early MVP traffic; the heavy compute is client-side by design (a genuinely cost-friendly architecture).
- Google Sheets proxy: the new (uncommitted) retry/backoff + `valuesBatchUpdate` work directly addresses the 60-writes/min/user Google quota — the previous per-row updates were the biggest real-world throttling risk. **Finish and commit this.**
- Plaid sync worker: 2 s DB poll is ~43 k queries/day against Supabase — cheap but nonzero; raise poll interval to 10–15 s (webhook-triggered jobs still get picked up promptly because enqueue happens before the poll wait; if snappier reaction is wanted, nudge the worker in-process after enqueue). Effort: trivial. **Low–Medium.**
- History endpoints paginate by date range; composite indexes exist (migration 003, 012). Fine.

## Data size limits

| Boundary | Current limit | Risk |
|---|---|---|
| API JSON body | 256 KB | A very large plan pushed to a future `PUT /api/plan` could exceed this — set the plan-size budget deliberately (e.g., 1 MB) when building DATA-1 |
| localStorage | ~5 MB/origin | Plan + lastRun series + queues share it; excluding `lastRun` from persistence buys headroom |
| Google Sheets | 10 M cells/spreadsheet; 60 writes/min/user | Retry work mitigates; UUID-diff minimizes writes |
| Supabase free tier | 500 MB DB, pauses after inactivity | Transactions table grows fastest; see cost plan |

## Caching opportunities (already good, minor additions)

- Simulation result cache: exists, correctly fingerprinted. ✔
- `authFetch` token cache: exists. ✔
- Add: HTTP cache headers on truly static endpoints (none critical now), and memoize `profiles.plan_tier` per request burst on the backend (tier is fetched per Plaid request; a 30 s in-memory TTL cache is safe and cuts Supabase reads). **Low.**

## Bottleneck summary (ranked)

1. Google Sheets write quota — being fixed now (finish it).
2. Worker-per-run + full-plan clone (PERF-1).
3. xlsx in the main bundle.
4. Chart rendering at daily granularity — verify, then downsample if needed.
5. Single-instance backend ceiling — accept and document for MVP.
