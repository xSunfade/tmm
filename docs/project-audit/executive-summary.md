# Executive Summary

*The plain-English version. Everything here is expanded, with evidence and file references, in the other documents in this folder.*

## What shape is TMM in?

Much better than "prototype," meaningfully short of "shippable."

The hard, differentiating work is largely done and done well: the simulation engine computes in exact integer cents with a documented rounding policy and property tests proving zero rounding loss; it runs off the main thread; forecasts are deterministic and reproducible by seed. The Plaid integration has engineering most startups add only after their first outage — idempotent webhooks, a job queue, retry with backoff, a circuit breaker, encrypted tokens. Auth, MFA, tier gating, and Stripe subscription plumbing all exist and mostly work. There's a real test harness with chaos and property-based suites.

What's missing is the unglamorous last mile: the app currently has no way to be deployed (the deploy config points at files that don't exist), the most important user data (the financial plan itself) lives only in the browser's localStorage, a handful of confirmed bugs sit in live code paths, and several failures happen silently — which is precisely what a trust-first financial product cannot afford.

## What is risky?

1. **Plan data can vanish.** The user's entire financial model exists only in their browser (plus optional manual Google Sheets sync). Clear browsing data, switch devices, or hit a corrupt-parse bug — and it's gone, silently replaced with an empty default plan.
2. **The Plaid webhook is unauthenticated.** Anyone who finds the URL can POST to it; forged revocation events can trigger data cleanup.
3. **Silent failures.** A failed simulation shows a blank chart with no message; a failed save logs to the console and tells the user nothing; there is no error boundary, so one rendering bug white-screens the app.
4. **Confirmed bugs:** the Plaid item-listing endpoint crashes on every call (undefined variable); removed bank connections leave live credentials in the database; drift detection compares today's net worth against the projection 30 years out.
5. **Two simulation engines.** The old float-based engine is dead in production but still drives some tests, and it implements features (checkpoints resetting the projection, ticker-priced assets) that the production engine quietly doesn't. Users can be shown a model the engine isn't actually running.
6. **CI is thinner than it looks.** Unit tests, database security (RLS) tests, and Stripe checks don't run in any workflow; the browser-test job is configured in a way that cannot pass.
7. **No deployment, no history.** Git has a single commit; there's no deploy pipeline, no rollback, no monitoring.

## What is promising?

- **The core is correct-by-construction:** integer-cent ledger, banker's rounding, seeded determinism, property-tested invariants. That's the hardest thing to retrofit and it's already here.
- **The architecture is cheap and private by design:** simulation runs on the user's device; the backend is a thin proxy. Fixed costs before Plaid are roughly $40–90/month.
- **Cost controls already exist:** Plaid item caps, velocity limits, usage counters, a paywall in front of every Plaid route, and kill-switch flags.
- **The Pipeline Builder, alternatives, augments, and the reconciliation loop are real, wired features** — the product vision is substantially implemented, not aspirational.

## What must be fixed before public users?

In one sentence each (full details and acceptance criteria in the roadmap):

1. Store plans server-side with revision history — data loss must become impossible.
2. Verify Plaid webhook signatures; remove the unauthenticated diagnostic endpoints; fix the Google OAuth state weakness.
3. Fix the four confirmed backend/engine bugs and add tests for each.
4. Kill the silent failures: error boundary, visible save state, corrupt-plan recovery.
5. Consolidate to one simulation engine and settle checkpoint semantics — the chart's number is the product.
6. Define one reproducible deployment with monitoring and a tested rollback.
7. Run the tests that already exist in CI; do one secret-scan and rotation pass.
8. Publish a real privacy policy and terms (the templates are ready to fill), and confirm database backups are on (Pro daily backups at launch; PITR added at the first real Plaid invoice).
9. If charging at launch: handle failed-payment states and verify the subscribed price in the Stripe webhook first.

## The recommended MVP path

Launch the **free planner first**: modeling, simulation, alternatives, pipeline, XLSX/Sheets backup — with bulletproof persistence. Keep **TMM+ (bank connections via Plaid, billed through Stripe) invite-only** until the payment unhappy-paths are handled and Plaid production access is confirmed, then open it. This matches the code's existing tier gate exactly; it's a rollout decision, not new engineering.

Estimated effort to public MVP: **6–8 focused weeks**, phased as: repo hygiene (days) → stability fixes (~1.5 wk) → persistence hardening (~2 wk) → payments/webhooks/security (~2 wk) → release prep (~1.5 wk). No rewrites anywhere — every recommendation improves code that already works.

## What to do next — this week

1. **Commit the in-progress work** (Google Sheets retry + the new unit test are sitting uncommitted) and start using branches/PRs — the single-commit history means there's currently nothing to roll back to.
2. **Fix the two one-hour items:** the crashing `/api/plaid/items` endpoint and removal of the unauthenticated diag endpoints.
3. **Answer the week-one questions** in `open-questions.md`: hosting choice (#18), domain (#19), TMM+-at-launch (#2), and checkpoint semantics (#3) — several workstreams hang off these four.
4. **Turn on Supabase Pro** (base) — the cheapest insurance in this entire audit. Add PITR at the first real Plaid invoice (graduated for cost; DATA-8).
5. **Read `prioritized-roadmap.md`** and, if it matches your intent, start Phase 0.
