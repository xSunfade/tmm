# Architecture Decision Records

Eight load-bearing decisions, ADR-style. Each cites its D-numbers from `00-decision-register.md`. Status is **Accepted** for all — these were decided by the product owner in the audit answers; this document records rationale, consequences, and the boundaries of each decision so future work doesn't quietly erode them.

---

## ADR-1: Supabase is the authoritative source of truth for user plans

**Decisions:** D5, D14, D16. **Resolves:** DATA-1, FRAGILE-8.

**Context.** The plan — the product's core artifact — lives only in browser localStorage, with optional manual Google Sheets sync. The audit identified this as the single biggest trust gap. Two-way Sheets sync was drifting toward becoming a second writable source of truth.

**Decision.** Server-side Supabase persistence is authoritative:

- `plans` table: one active plan row per user (`user_id` unique), `plan jsonb`, `schema_version`, `updated_at`, `client_saved_at`; RLS user-scoped.
- `plan_revisions`: rolling last-20 revision history (D14), auto-pruned.
- `GET/PUT /api/plan` on the backend (JWT-authed). PUT validates size (warn ≥1 MB, reject >5 MB), validates `schema_version`, echoes `client_saved_at` for conflict detection. Last-writer-wins with a conflict prompt only when both local and server changed.
- localStorage demotes to **fast cache + offline layer**. On load: newer of local vs. server, prompting only on true divergence (reuse the restore-overlay pattern).
- Google Sheets becomes explicit **Export backup** / **Import** flows. No automatic bidirectional sync. Import always takes an automatic pre-import revision snapshot (DATA-3).

**Consequences.**
- The save/backup truth indicator (UX-A) becomes meaningful: *Saved locally · Backed up · Not saved — action needed*.
- The Sheets sync engine (~1,200 lines) is retained but frozen: no further investment in conflict resolution; its retry/backoff work (already committed) is sufficient.
- Entitlement enforcement gains a server-side anchor: plan contents (alternative count, horizon) can be validated at save time (D8).
- The plan schema needs a server-visible version discipline (see ADR-3).

**Boundaries.** Do not build real-time sync, CRDTs, or multi-device live merge. Last-writer-wins + revisions + conflict prompt is the accepted ceiling for MVP (per audit anti-goals).

---

## ADR-2: Domain model separated from the simulation engine; market assets are positions

**Decisions:** D4, D3. **Resolves:** BUG-5, BUG-6, FRAGILE-1 direction.

**Context.** Two engines coexist: the production bigint ledger (correct arithmetic, missing features) and the legacy float engine (dead in production, but implements checkpoints and ticker positions). Ticker assets are silently simplified to balance+APY. Checkpoints don't affect projections despite the spec.

**Decision.** Introduce an explicit **domain model** layer — the financial facts — independent of any simulation method:

- Core concepts: **Account, Holding/Position (quantity, cost basis optional later), Transaction, CashFlow (recurring/one-time), Checkpoint (observed state), Assumptions (expected returns, rates)**.
- Market assets are positions: `quantity × price(t)`, where `price(t)` is a *deterministic simulated price path* derived from user assumptions (e.g., expected annual return) — explicitly not a market prediction. Contributions buy shares at `price(t_contribution)` (correct DCA modeling).
- Checkpoints are observed ground truth (D3): the engine seeds simulation state from the latest checkpoint and projects forward from there. Deterministic adjustment IDs per the existing spec.
- The **simulation engine** consumes the domain model and produces projections. The current bigint/ppm/banker's-rounding ledger core is retained as the arithmetic substrate — no rewrite of the numeric foundations.
- v1 scope discipline: no dividends, splits, tax lots, capital gains, rebalancing, allocation rules, or withdrawal strategies — but interfaces (e.g., a `Position` carrying quantity and acquisition events) must admit them without redesign.

**Consequences.**
- Engine consolidation (FRAGILE-1) happens **against the new domain model**, in this order: define domain types → implement checkpoint seeding + position pricing in the ledger → migrate golden/determinism tests to the ledger → delete `simulation.ts`. Migrating tests to the old ledger shape first would be double work.
- Plan schema moves to v3 (see `03-data-model-and-migration-plan.md`) with a migration from v2 shapes; XLSX/Sheets import must map old columns onto the new model.
- The property-test suite (conservation, transfer symmetry, zero rounding loss) is the regression net for the refactor and must stay green throughout.

**Boundaries.** The engine's public contract is: `(domain model, assumptions, seed, horizon) → percentile series + events`. Nothing outside the simulation package may depend on engine internals; nothing in the domain model may depend on the engine.

---

## ADR-3: Entitlement-driven billing on Stripe

**Decisions:** D7, D8, D9, D10, D11. **Resolves:** PAY-1/2/3/6, extends the single-tier gate.

**Context.** Today: one hardcoded tier (`tmm_plus`) flipped by subscription webhooks with no price verification, no failed-payment handling, and no persisted subscription state. The answers require three tiers, monthly+annual, per-tier limits, and evolution without code changes.

**Decision.** Introduce a thin **entitlement layer** between Stripe and the app:

- **Catalog:** Stripe Products/Prices carry pricing; a server-side mapping (DB table `plan_catalog`: `stripe_price_id → tier`) resolves any subscription to a tier. Tier → entitlements mapping (`tier_entitlements`: max_alternatives, max_horizon_years, plaid_enabled, max_plaid_items, …) is data, not code.
- **State:** `profiles` (or a dedicated `billing_state` table) persists `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `current_period_end`, `grace_expires_at`, `tier`.
- **Resolution:** one table-driven function maps (subscription status, price, grace state) → tier. Every Stripe status has an explicit row; `trialing` = entitled (D10); `past_due` = entitled for 7 days then Free (D11); unknown statuses = Free + alert.
- **Enforcement:** middleware asks the entitlement service, never reads `plan_tier` strings directly. Free-tier plan limits (3 alternatives, 5-year horizon) enforced at plan save (server) and mirrored in UI.
- **Webhooks:** signature-verified (already), event-id idempotency log (PAY-5/WH-S1), price verification (PAY-2), `checkout.session.completed` handled (PAY-4), full status table (PAY-1).

**Consequences.** Grandfathering, promos, TMM+ Pro, annual discounts, and future tiers are catalog rows. Stripe Tax can be enabled later (D13) without touching this layer. A daily reconciliation sweep (PAY-7) becomes trivial to add post-MVP.

**Boundaries.** Do not build usage-metered billing, seat licensing, or coupon engines. The entitlement layer is a lookup, not a rules engine.

---

## ADR-4: Hosting topology — static frontend + one always-on backend + Supabase

**Decisions:** D18, D19. **Resolves:** Phase D, ENV-2, WH-P2.

**Context.** Deployment was undefined in the repo; inspection shows the backend currently deployed to **Vercel serverless**, where the in-process DB-polled Plaid worker and `setInterval` schedulers cannot run reliably (see `08-infrastructure-inventory.md`).

**Decision.**
- Frontend: static Vite build on Vercel, canonical domain `tmm.finance` (already attached).
- Backend: **one small always-on Node instance** (Render default; Railway/Fly acceptable) behind `api.tmm.finance`. It owns webhooks (Stripe + Plaid), OAuth callbacks, entitlement enforcement, service-role Supabase access, the sync worker, and schedulers.
- Supabase: auth + Postgres + RLS (three projects — ADR-5).
- The stable API domain decouples third-party registrations (webhooks, OAuth redirects, HSTS, cookies) from the hosting provider, so the backend can move hosts without re-registering integrations.

**Consequences.** Webhook URLs, CORS matrices, and OAuth redirect URIs are defined per environment now (see `07-environments-and-hosting.md`); the Vercel `tmm-backend` project becomes dev/preview-only; scale-out beyond one instance stays deferred exactly as the audit prescribed (flags exist: `RUN_PLAID_WORKER`).

**Boundaries.** No containers-for-their-own-sake, no Kubernetes, no serverless restructuring of the backend, no message broker. The Postgres-backed job queue is the accepted design.

---

## ADR-5: Three-environment separation (dev / staging / prod)

**Decisions:** D16, D17. **Resolves:** DATA-7.

**Context.** One Supabase project exists, hand-migrated (live `list_migrations` is empty; live schema already drifted from repo migrations — the legacy `users` table is absent live and the `plaid_tokens` FK points at `auth.users`). It contains only founder dev data.

**Decision.**
- **dev** = the current project (`mkhmaqksodfwccheflpw`). Free to evolve/reset during re-architecture.
- **staging** = new project; receives every migration before prod; hosts Stripe test-mode + Plaid sandbox integration testing; RLS anon-tests run against it on a schedule.
- **prod** = new project; created at Gate B; real users only; Supabase Pro + PITR from day one (DATA-8).
- Migration discipline: Supabase CLI-managed migrations from a **clean baseline** (D16 permits a fresh schema); the same migration set applies to all three; hand-applied SQL is forbidden from now on.
- Parallel environment axes: Stripe test-mode keys for dev/staging, live keys only in prod; Plaid sandbox for dev/staging, production credentials only in prod backend.

**Consequences.** The DATA-4 FK question dissolves — the clean baseline schema simply defines correct FKs. Existing dev data is migrated only if worth it (a founder-data export/import script is cheaper than schema compatibility).

---

## ADR-6: Plaid item lifecycle policy

**Decisions:** D12, D2, D20. **Resolves:** BUG-3, PAY-6, cost-control §Plaid.

**Decision.** A single state machine governs every Plaid item (full detail in `05-plaid-lifecycle-policy.md`): active → (payment failure) 7-day grace with sync active → downgrade: sync suspended immediately, tokens retained encrypted 30 days → restore (resubscribe: sync resumes, no re-link) or revoke (`itemRemove` + token deletion). Account deletion revokes immediately. User-initiated removal revokes immediately (fixing BUG-3's orphaned tokens).

**Consequences.** Plaid per-item costs are bounded by policy, not just caps; data-minimization commitments in the privacy policy become true by construction; scheduled sweeps become part of the ops runbook.

---

## ADR-7: Security posture and launch bar

**Decisions:** D22, D23, D24, plus the audit's minimum bar (unchanged). **Resolves:** SEC-1..7 sequencing.

**Decision.** The audit's minimum security bar is adopted verbatim as Gate C blockers (see `10-launch-readiness-gates.md`): Plaid webhook JWT verification, diag endpoints removed, OAuth state nonce, secret scan + rotation, RLS anon-test green on prod, deletion-cascade test, HSTS + TLS-skip guard, published privacy policy/ToS, admin role for ops routes. MFA stays optional-with-step-up (D23). Turnstile production key is a launch task (D22). Additional items surfaced by live inspection: enable Supabase leaked-password protection; disable or lock down the GraphQL/`graphql_public` exposure; pin `search_path` on SECURITY DEFINER functions (advisor warnings — see `08-infrastructure-inventory.md`).

---

## ADR-8: Google Sheets OAuth split and verification path

**Decisions:** D21, D5. **Resolves:** open-questions #21, part of SEC-3's blast radius.

**Decision.** Two independent OAuth surfaces: (1) Google **Sign-In** (openid/email/profile) — core onboarding, unaffected; (2) Google **Sheets** connect — separate consent flow requesting only Sheets/Drive scopes, initiated explicitly from the export/import feature. Sheets connect ships beta-labeled until Google app verification completes (narrowest scopes). Verification is pursued in parallel and is not a launch gate.

**Consequences.** The OAuth `state` hardening (SEC-3) applies to the Sheets flow; the auth flow is Supabase-managed and unaffected. Unverified-app warnings never appear in core signup.
