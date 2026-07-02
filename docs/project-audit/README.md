# TMM Project Audit — July 2026

This folder is a documentation-first audit of The Money Machine (TMM) as it stands today, performed in preparation for a first public release. **No application code was changed as part of this audit.**

## How this audit was performed

Every finding is based on direct inspection of the repository (source files, migrations, CI workflows, tests, and docs). Throughout the folder, findings are labeled with one of four evidence levels:

- **Confirmed from code** — read directly in a source file (usually with a file path cited).
- **Inferred from code** — a reasonable conclusion from code structure, but not directly stated anywhere.
- **Unknown / needs clarification** — could not be determined from the repo; listed in `open-questions.md`.
- **Recommended next step** — an action item, always with priority/effort/acceptance criteria.

## Read in this order

1. **`executive-summary.md`** — plain-English state of the project, what's risky, what to do this week. **Start here.**
2. **`current-state-map.md`** — what the repo actually contains: structure, data flows, feature maturity.
3. **`mvp-scope-definition.md`** — the smallest safely-releasable product.
4. **`prioritized-roadmap.md`** — sequenced phases from today to public MVP.
5. **`open-questions.md`** — decisions only the product owner can make.

Then the topic-specific audits, in rough order of risk:

| File | Covers |
|---|---|
| `stability-and-bug-audit.md` | Confirmed bugs, fragile areas, silent failures |
| `security-and-privacy-audit.md` | Auth, secrets, webhook exposure, minimum bar for public release |
| `data-model-and-persistence-audit.md` | Where user data lives, loss/corruption risks, backup posture |
| `api-and-integration-audit.md` | Backend API surface, Plaid, Google Sheets, env vars, failure modes |
| `webhooks-and-events-audit.md` | Plaid + Stripe webhooks, idempotency, signature verification |
| `payments-and-stripe-readiness.md` | Stripe integration state and gaps before charging real users |
| `performance-and-scalability-audit.md` | Simulation cost, rendering, worker architecture, scaling limits |
| `user-experience-reliability-audit.md` | Loading/error/empty states, save confidence, silent failure |
| `testing-strategy.md` | What is tested, what is not, recommended test plan |
| `architecture-upgrade-plan.md` | Phased plan; explicitly what NOT to over-engineer |
| `cost-control-plan.md` | Keeping hosting/API/DB costs bounded during MVP |
| `release-readiness-checklist.md` | The practical go/no-go checklist |

## Major findings at a glance

1. **The project is much further along than a prototype** — real Plaid resilience engineering (job queue, circuit breaker, idempotency), an integer-cents deterministic simulation ledger, encrypted token storage, RLS-era migrations, and a substantial validation harness. The foundation is worth keeping. Incremental hardening, not a rewrite, is the right path.
2. **User plan data lives only in browser localStorage** (plus optional manual Google Sheets sync). There is no server-side plan persistence. This is the single biggest trust gap for a financial product: clearing the browser loses the user's financial model.
3. **The Plaid webhook endpoint accepts unauthenticated POSTs** — no signature/JWT verification (`backend/server.js`). Must be fixed before production Plaid traffic.
4. **One confirmed runtime bug**: `GET /api/plaid/items` references an undefined variable (`connectedItemIds`) and will throw on every call.
5. **Deployment is not defined.** Root `vercel.json` references three files that do not exist (`scripts/inject-env.js`, `splash.html`, `auth-callback.html`); Elastic Beanstalk remnants are obsolete; there is no deploy pipeline.
6. **Two simulation engines coexist.** The production bigint ledger is good, but the legacy float engine still drives some tests, checkpoints don't reset ledger state (contradicting the written spec), Ticker assets are silently simplified, and drift detection compares against the wrong point.
7. **CI validates less than it appears to.** Unit tests, RLS security tests, and Stripe checks are not wired into any workflow; the Playwright job is configured but can't run (no server startup, no secrets).
8. **Git history is a single commit** ("Initial commit!") — no incremental history to bisect or roll back to.

## Recommended order of action

Phase 0 (repo hygiene) → Phase 1 (stability + security fixes) → Phase 2 (server-side plan persistence) → Phase 3 (webhook/payment hardening) → Phase 4 (deploy + release prep). Details and per-item acceptance criteria are in `prioritized-roadmap.md`.
