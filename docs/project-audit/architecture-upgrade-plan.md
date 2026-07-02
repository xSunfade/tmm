# Architecture Upgrade Plan

Phased plan from current state to a stable MVP. The current architecture is fundamentally sound for this product — client-heavy compute, thin API, Supabase persistence. **No rewrite is proposed anywhere in this plan.**

## Current architecture (one paragraph)

React SPA (all simulation compute in-browser via web worker) → Express monolith (auth verification, Plaid/Sheets/Stripe proxying, history) → Supabase (auth + Postgres + RLS). Plan data lives in localStorage; Plaid sync runs as an in-process DB-polled worker; schedulers are `setInterval` in the web process.

## What to change, in order

### Phase A (with Phase 1 of the roadmap): correctness and safety inside the existing shape

- Single simulation engine (delete legacy float engine after test migration).
- Plaid webhook verification; OAuth state nonce; diag endpoint removal.
- Startup config validation; lazy Plaid client init.
- No structural change.

### Phase B (with Phase 2): make the server the source of truth for plans

- Add `plans` + `plan_revisions` tables and `GET/PUT /api/plan` (design in `data-model-and-persistence-audit.md`). localStorage demotes to cache/offline layer.
- This is the only *architectural* addition the MVP needs.

### Phase C (with Phase 2–3): mechanical decomposition of `server.js`

Split ~4,300 lines into routers with zero logic change: `routes/health.js`, `routes/stripe.js`, `routes/plaid.js`, `routes/google.js`, `routes/history.js`, `routes/privacy.js`, `routes/plan.js` + `app.js` wiring. Do it in one PR with no behavior edits so the diff is reviewable as a pure move.

- **Priority:** Medium · **Effort:** 1–2 days · **Acceptance:** all existing tests pass; route inventory identical (diff the Express route table before/after).

### Phase D (with Phase 4): one reproducible deployment

Decide the topology (recommendation below), delete stale configs (root `vercel.json`, `.fiveserverrc`, EB hook), and add a deploy pipeline.

**Recommended topology (cheapest boring option that fits the code):**

- **Frontend:** static Vite build on Vercel (or Netlify/Cloudflare Pages). `VITE_API_BASE_URL` → API host.
- **Backend:** one always-on Node instance on Render/Railway/Fly (the in-process worker + schedulers **require an always-on process — not serverless**; this rules out Vercel functions for the backend without restructuring, which is not worth it now).
- **DB/auth:** Supabase (already).
- **Acceptance:** `git push` → CI green → deploy; a documented rollback (redeploy previous build); health check monitored externally.

## What to defer (and when to revisit)

| Deferral | Revisit when |
|---|---|
| Distributed rate limiting (Redis) | >1 backend instance needed |
| External job queue / separate worker process | Sync job latency or instance CPU becomes a problem; first step is just `RUN_PLAID_WORKER=true` on a second small instance with the flag off on web — the DB-claim design already supports this cleanly |
| Moving schedulers to cron (Supabase cron / host cron hitting an admin endpoint) | Second instance, or missed-interval incidents |
| Local JWT verification (JWKS) instead of per-request Supabase call | Supabase Auth latency/availability shows up in p95 |
| Splitting frontend monolith components (`AccountIntegrationScreen` 2.1 k lines etc.) | When a feature change forces you in — do it opportunistically, behind the E2E smoke |
| React-router adoption | Only if routing needs (deep links, guards) outgrow the hand-rolled version — it currently works |
| Server-driven simulation | Probably never — client compute is a feature (privacy + cost) |

## What NOT to over-engineer (explicit anti-goals)

- **No microservices, no GraphQL, no tRPC migration, no ORM adoption** — the model layer is thin and works.
- **No event bus/message broker** — the Postgres queue is correct at this scale.
- **No Kubernetes/containers-for-their-own-sake** — one PaaS instance.
- **No monorepo tooling (Nx/Turbo)** — two npm workspaces with plain scripts are fine.
- **No CQRS/event sourcing for the plan** — jsonb + revisions gives 95% of the value.
- **No rewrite of the Sheets sync** — the UUID-diff design is good; it just gained retries. Keep it as backup/export, not a sync engine.

## Sequencing rationale

Persistence (B) before decomposition (C): decomposition is safer once the highest-value new endpoint exists and is tested, and B unblocks the biggest user-facing risk. Deployment (D) last-but-before-release because topology decisions (webhook URLs, CORS origins, `PLAID_WEBHOOK_URL`) feed the Plaid/Stripe production configuration in Phase 3–4 — but the *decision* (which hosts) should be made in week 1 (see `open-questions.md`) so nothing is built against a wrong assumption.
