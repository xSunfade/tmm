# MVP Scope Definition

The smallest public release that is actually safe, given what already exists. The guiding rule: **ship the deterministic planning core with bulletproof persistence; treat everything touching other people's money systems (Plaid, Stripe) as gated, deliberate rollouts.**

## Recommended MVP shape

A free product where users model their finances and simulate outcomes, with accounts and data that cannot be lost — plus TMM+ (Plaid via Stripe) either **held back at launch or opened to a small invited cohort**, because those two integrations carry the highest blast radius and the remaining Critical fixes.

## Must-have for MVP (blocking)

| Item | Why | Source |
|---|---|---|
| Server-side plan persistence + revisions (DATA-1) | The product's core artifact must survive a browser wipe | data audit |
| Fix silent failures UX-1/2/3 + error boundary (UX-A/B/C) | No lying about save state; no white screens | UX audit |
| Fix BUG-1 (plaid/items 500), BUG-2, BUG-3 | Confirmed broken code paths | stability audit |
| Plaid webhook signature verification (SEC-1) | Required before any production Plaid traffic | security audit |
| Remove/gate diag endpoints (SEC-2), OAuth state fix (SEC-3) | Unauthenticated attack surface | security audit |
| One defined, reproducible deployment (delete stale vercel.json, document topology, deploy pipeline) | There is currently no way to ship | tests/CI audit |
| Simulation single-engine cleanup (FRAGILE-1) + drift fix (BUG-4) + checkpoint decision (BUG-5) | The number on the chart is the product; it must have one authoritative, tested implementation | simulation audit |
| Ticker-mode honesty (BUG-6: implement or clearly label) | Don't display a model the engine doesn't run | simulation audit |
| Corrupt-plan recovery + pre-import snapshot (DATA-2/3) | Data-loss protection on the riskiest flows | data audit |
| Complete `.env.example`s + startup config validation (ENV-1) | Deployability and operator safety | API audit |
| CI runs unit tests + RLS test; secret scan pass (SEC-5) | Minimum verification before each release | testing strategy |
| Real privacy policy + ToS; deletion-cascade test | Legal/trust floor for financial data | security audit |
| Supabase backups/PITR confirmed (DATA-8) | Recoverability | data audit |
| Browser tab title + basic first-run polish | Visible-in-two-seconds credibility | UX audit |

## Should-have soon after (fast follow, weeks 1–6 post-launch)

- Stripe unhappy paths (PAY-1/2/3) — **must precede charging anyone**; if TMM+ launches with the MVP, these move up into must-have.
- Staleness indicators on connected values (UX-E); sanity warnings on plan inputs (UX-D); Monte Carlo explainer (UX-F).
- Worker reuse + xlsx lazy-load (PERF-1, bundle).
- Admin role for ops routes (SEC-4); Stripe event log (PAY-5).
- Retention sweeps for unbounded tables (DATA-6); migration tooling (DATA-7).
- Split `server.js` into routers (mechanical).
- Cross-tab localStorage guard.

## Explicitly NOT MVP (defer deliberately)

- AI assistant/coaching, tax-aware planning, Monte Carlo market modeling (beyond current augment probability), life-event templates, estate/insurance planning, financial health scoring, document management — the brief's long-term list.
- Multi-currency; internationalization.
- Real-time collaboration / multi-device live merge (last-writer with revision restore is enough).
- Native mobile; offline-first sync framework.
- Distributed rate limiting, external job queues, microservices, worker processes — single instance is fine.
- Replacing hand-rolled routing, styled dialog overhaul, component library migration.
- Goals feature polish beyond type-tightening (works; not core to the value proposition).
- Public API, plugin system, template marketplace.

## Dangerous to include too early

| Item | Danger |
|---|---|
| **Open Plaid access for all signups at launch** | Plaid production approval obligations, per-item costs that scale with signups, support burden for bank-connection edge cases, and the unfixed items above. Gate behind TMM+ payment + invite/waitlist until the Plaid checklist is green. |
| **Charging money before PAY-1/2/3** | Users in `past_due` limbo, wrong entitlements, refund chaos — billing bugs destroy trust faster than feature bugs. |
| **"Sync everything automatically" to Google Sheets** | Auto-sync turns Sheets into a second writable source of truth and multiplies conflict/data-loss scenarios. Keep manual + queued. |
| **Monte Carlo marketed as market simulation** | Current randomness is only augment probability. Overclaiming accuracy is a trust time bomb; label carefully (UX-F). |
| **Aggressive marketing of checkpoint "reconciliation"** | Until BUG-4/BUG-5 are resolved, drift/checkpoint features can show contradictory numbers. |

## MVP tiering recommendation

- **Free:** full planner, simulation, alternatives, pipeline, XLSX import/export, Google Sheets backup, server persistence.
- **TMM+ (paid, gated rollout):** Plaid-connected accounts, automatic history, reconciliation.

This matches the code's existing gate exactly (`requireTmmPlus` on Plaid routes) — no rework needed, only a rollout decision (see `open-questions.md`).
