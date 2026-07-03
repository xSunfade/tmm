# Decision Register

Every decision from `docs/project-audit/project-audit-question-answers.md`, restated as a canonical decision (D1–D30), cross-referenced to the audit finding it resolves and the implementation work it creates. When any future document or code comment needs to justify behavior, cite the D-number.

Legend for "Changes audit rec?": **Confirms** = adopts the audit's recommendation; **Extends** = adopts it and adds scope; **Overrides** = chooses differently than the audit's default suggestion.

## Product

### D1 — Rollout shape: free tier open, TMM+ waitlisted (Q1)
- **Decision:** Open free signup for the Free tier. TMM+ launches waitlist + invite (founder, friends, family). Plan the rollout to be **cost-reactive**: monitor Supabase usage; define a soft signup limit that, when crossed, switches free signup to a waitlist. Investigate Supabase spend caps / auto-cutoff before launch.
- **Resolves:** open-questions #1. **Changes audit rec?** Confirms (matches free-first, gated-TMM+ recommendation, with the addition of a *free-tier* soft-cap waitlist).
- **Work created:** waitlist system (two lists: TMM+ upgrade waitlist, free-signup overflow waitlist); signup soft-cap kill switch; Supabase usage alerting. See `04-billing-and-entitlements.md` §Waitlist and `09-risk-register.md` R-7.

### D2 — TMM+ ships with the MVP, invite-gated (Q2)
- **Decision:** TMM+ (Plaid) is present at MVP launch: users can join the waitlist and are notified when invited. Founder/friends/family use TMM+ from day one.
- **Resolves:** open-questions #2. **Confirms** (this is exactly the "invited cohort" option).
- **Work created:** invite issuance/redemption; all PAY-x and SEC-1 items become **launch blockers** (money and Plaid are live at launch, even if only for invitees).

### D3 — Checkpoints are observed ground truth (Q3, resolves BUG-5)
- **Decision:** A checkpoint is an observed state. Once recorded, it becomes the baseline from which all future projections are simulated. The spec (`tests/validation/spec/CheckpointSemantics.md`) wins; the current ledger behavior (checkpoints as chart annotations only) is a bug.
- **Resolves:** BUG-5, part of BUG-7; interacts with BUG-4 (drift must compare against today's projection *from the latest checkpoint baseline*).
- **Confirms** the spec's intent.
- **Work created:** ledger state-seeding from latest checkpoint; deterministic adjustment IDs; golden tests pre/post checkpoint; drift-at-today fix in the same workstream. See `02-implementation-phases.md` Phase 2.

### D4 — Position-based market asset modeling + domain/engine separation (Q4, resolves BUG-6)
- **Decision:** Market assets are ownership positions (quantity × simulated price), not balances with APY. Simulated prices are deterministic outputs of user-configured assumptions (e.g., expected annual return) — not market predictions. Contributions purchase shares at the simulated price at contribution time (dollar-cost averaging is modeled correctly). The **domain model** (accounts, holdings, positions, transactions, cash flows, checkpoints) is architecturally separate from the **simulation engine**, so future methods (Monte Carlo market models, historical returns, AI optimization) evolve without changing the financial model. Do not overbuild: no dividends, splits, tax lots, capital gains, rebalancing, or withdrawal strategies in v1 — but data structures and interfaces must admit them without redesign.
- **Resolves:** BUG-6. **Overrides** the audit's MVP shortcut option ("relabel Ticker as APY balance"). This is the single largest scope addition to the roadmap.
- **Work created:** the "Domain Model Foundation" workstream (Phase 2 in `02-implementation-phases.md`); plan schema v3 (see `03-data-model-and-migration-plan.md`); simulation engine consolidation happens **against the new domain model**, not the old shape.

### D5 — Supabase is ASOT; Google Sheets demoted to backup/export/import (Q5, resolves FRAGILE-8)
- **Decision:** TMM's authoritative source of truth is server-side Supabase. Google Sheets becomes a user-controlled portability layer: explicit "Export backup to Google Sheets" and "Import from Google Sheets" flows. Remove "living two-way sync" language and stop investing in last-writer-wins sync as a persistence strategy. Persistence is designed around Supabase-authenticated users, per-user plan ownership, RLS, versioned plan records, server-authoritative saves, and Stripe entitlement/quota enforcement. Preserve existing Sheets import/export compatibility so no user is stranded.
- **Resolves:** FRAGILE-8, DATA-1 direction. **Confirms and extends** (audit recommended exactly this; the answer additionally frames Supabase persistence as the foundation for entitlements).
- **Work created:** `plans` + `plan_revisions` tables; `GET/PUT /api/plan`; localStorage demotion to cache/offline layer; Sheets UI copy overhaul; separate Sheets OAuth consent flow (D21).

### D6 — Weekly check-in, tour, and goals all stay in MVP (Q6)
- **Decision:** Keep all three, with polish folded into general audit fixes.
- **Work created:** goals type-tightening; tour/check-in QA passes in Gate B testing; no feature-gating work.

## Business model

### D7 — Entitlement-driven billing; three tiers; monthly + annual (Q7)
- **Decision:** Server-side feature **entitlements**, not hardcoded plans. Tiers at launch: **Free, TMM+, TMM+ Pro**. Monthly and annual billing from initial release. Every paid tier must be profitable under worst-case legitimate usage (max Plaid items × per-item fee + Stripe fees + infra + healthy margin). Plaid connectivity is a premium entitlement with explicit per-plan item limits. Pricing lives in Stripe Products/Prices + entitlement mappings so plans, limits, promotions, grandfathering, and future tiers evolve without app-code changes.
- **Resolves:** open-questions #7. **Extends** the audit (audit assumed a single `tmm_plus` tier; this adds a tier, annual billing, and an entitlement layer).
- **Work created:** entitlement service + `entitlements`/`plan_catalog` data model; webhook rework (PAY-1/2/3 implemented against entitlements); Stripe catalog build-out (currently only one $5/mo test price exists — see `08-infrastructure-inventory.md`); pricing analysis vs. Plaid worst case (see `04-billing-and-entitlements.md` §Pricing floor).
- **Pricing floor update (2026-07-03):** real Plaid contract rates obtained — Transactions **$0.30 per connected account/month** (per-account, not per-item), Balance $0.10/call (on-demand), Auth/Identity unused in production. Item caps dropped to **TMM+ 3 / Pro 6** to bound worst-case cost (see D8). Recomputed floor: TMM+ ~$8.50 typical / ~$12 worst case; Pro ~$13.50 typical / ~$19 worst case. **Recommended prices: TMM+ $12/mo · $120/yr; TMM+ Pro $25/mo · $250/yr** — both clear ≥30% margin even at worst-case usage (monthly). The $5 test price is confirmed below floor. Pending: founder's final confirmation of the exact price numbers; re-verify vs the first real Plaid invoice before Gate D.

### D8 — Free-tier limits: analytical capability, not tracking (Q8)
- **Decision:** Free tier: unlimited manual accounts and core budgeting; **3 Alternatives max; 5-year projection horizon max**. Paid tiers: unlimited scenarios, unlimited horizon, Plaid, future advanced analysis.
- **Plaid item caps (2026-07-03):** **TMM+ = 3 items, TMM+ Pro = 6 items**, absolute safety ceiling **10**. Chosen to bound worst-case Plaid cost (Transactions bills per connected account). Implemented as `tier_entitlements.max_plaid_items` in Phase 4.5, replacing the global `PLAID_ITEM_CAP=5` constant.
- **Work created:** limit enforcement in the entitlement service (server-side where data is server-side; client-enforced with server validation for plan contents); upgrade-prompt UX at the limits; migrate the item cap from a constant to per-tier entitlement rows.

### D9 — Cancellation = end-of-period downgrade; manual-only refunds (Q9, resolves PAY-6)
- **Decision:** Confirm current behavior: cancel disables renewal, access persists to period end, then auto-downgrade to Free with all data retained. Premium features lock; nothing is deleted or modified. Refunds are manual exceptions (accidental purchase, duplicate charge, billing error).
- **Work created:** policy text for ToS/refund page; verify `customer.subscription.deleted` timing; downgrade path testing with Stripe test clocks.

### D10 — No public trial; keep `trialing` support (Q10)
- **Decision:** Free tier is the evaluation experience. Keep entitlement support for `trialing` states so promos/referrals/beta campaigns can enable trials without architecture changes.
- **Work created:** none beyond keeping the status→entitlement table complete.

## Payments

### D11 — 7-day past_due grace period (Q11, resolves PAY-1's open number)
- **Decision:** `past_due` keeps entitlements for **7 calendar days**, then automatic downgrade to Free with data retained.
- **Work created:** `billing_state` + grace-expiry tracking; dunning banner UX; scheduled grace-expiry sweep; test-clock coverage.

### D12 — Plaid lifecycle on downgrade: suspend immediately, 30-day token retention, then revoke (Q12)
- **Decision:** At downgrade (after D11 grace): suspend all Plaid sync immediately; preserve all historical imported data, edits, and account history; retain **encrypted** Plaid access tokens for **30 days** solely for seamless restore; if not restored, call `itemRemove` and securely delete tokens. Historical data stays unless the user deletes the account.
- **Resolves:** PAY-6/cost-control item 3.7, and makes BUG-3 (orphaned tokens) a policy violation, not just a bug.
- **Work created:** the full lifecycle state machine in `05-plaid-lifecycle-policy.md`; scheduled revocation sweep; restore-without-relink path.

### D13 — Defer Stripe Tax; U.S. launch (Q13)
- **Decision:** Standard Checkout without automatic tax at launch; consult a CPA as thresholds approach; architecture must allow enabling Stripe Tax without touching subscription/entitlement logic.
- **Work created:** none now; a "tax-enablement" note in the billing doc.

## Data

### D14 — Plan size: 1 MB soft warning, 5 MB hard cap; 20 rolling revisions (Q14, resolves DATA-1 parameters)
- **Decision:** Server-side plans warn at 1 MB, reject above 5 MB. Rolling 20 revisions per plan (oldest auto-deleted). Revision-per-save initially; meaningful-snapshot optimization later.
- **Work created:** size validation in `PUT /api/plan` (raise the 256 KB body limit for this route specifically); revision pruning; revision-restore UI.

### D15 — Retention schedule (Q15, resolves DATA-6 numbers)
- **Decision:** User-created financial data: **indefinite** (until user deletion). Plan revisions: last 20. Stripe/Plaid webhook events: **90 days**. Sync execution logs: **30 days**. Audit/security logs: **1 year**. Soft-delete window for deleted plans/accounts: **30 days**. Plaid tokens: 30 days after premium ends, or immediately on account deletion.
- **Work created:** retention sweep jobs; documented in `06-security-privacy-and-retention.md`.

### D16 — No backward-compatibility constraint; clean architecture preferred (Q16)
- **Decision:** Current Supabase data is founder dev/testing only. The redesign should **not** be constrained by the current schema. Evaluate migrating test data vs. starting fresh; prefer the cleaner long-term design (includes the DATA-4 FK fix).
- **Work created:** freedom to rebuild the schema as migrations-from-zero in the dev project (see `03-data-model-and-migration-plan.md` §Strategy). This significantly de-risks Phase 3.

### D17 — Three Supabase projects: dev / staging / prod (Q17, resolves DATA-7 direction)
- **Decision:** Current project = dev, free to evolve. Create staging (migration + Stripe/Plaid integration validation) and production (real users only) once architecture stabilizes.
- **Work created:** project creation, config matrices, migration promotion pipeline, secrets per environment. See `07-environments-and-hosting.md`.

## Architecture

### D18 — Hosting topology approved (Q18, resolves Phase D)
- **Decision:** Static React frontend on a Vercel-class host; **one small always-on Node backend** on Render/Railway/Fly (Render is the default); Supabase for auth/Postgres/storage. The Node backend owns Stripe webhooks, Plaid webhooks, OAuth callbacks, entitlement enforcement, server-side Supabase operations, background/retry logic, and all secret-bearing integrations. Not serverless-only.
- **Note from infrastructure inspection:** the backend is *currently* deployed to Vercel serverless (`tmm-backend`), where the in-process Plaid worker and `setInterval` schedulers cannot run reliably. Migration to an always-on host is required before production Plaid traffic. See `08-infrastructure-inventory.md`.
- **Work created:** Render (or equivalent) service provisioning for staging + prod; deploy pipeline; backend remains on Vercel only for dev convenience.

### D19 — Domains: `tmm.finance` + `api.tmm.finance` (Q19)
- **Decision:** `https://tmm.finance` is the canonical production frontend (already attached to the Vercel project). `https://api.tmm.finance` is the stable API domain for CORS, OAuth redirect URIs, Stripe/Plaid webhooks, cookies, HSTS — independent of backend host. Provider URLs only for dev/preview.
- **Work created:** DNS + TLS for `api.tmm.finance`; webhook/OAuth re-registration to the stable domain; CORS matrix per environment.

### D20 — Plaid production access is approved (Q20)
- **Decision/fact:** Plaid dashboard shows Production environment enabled. No Plaid-side gate blocks the schedule.
- **Work created:** none, but SEC-1 (webhook verification) becomes the last Plaid-side launch blocker.

### D21 — Sheets OAuth is a separate, deferred consent flow (Q21)
- **Decision:** Google **Sign-In** (openid/email/profile) stays first-class and unaffected. Google **Sheets** scopes move to a separate consent flow triggered only when a user connects Sheets for export/import. Before broad public availability of Sheets OAuth, complete Google app verification with the narrowest scopes; until then keep it internal/test-labeled or beta-labeled. Google verification is **not** a launch blocker.
- **Work created:** split OAuth flows (auth vs. Sheets scopes); beta label on Sheets connect; verification submission task (parallel, non-blocking).

## User accounts

### D22 — Auth at launch: Google OAuth + Email OTP; Turnstile required (Q22)
- **Decision:** Keep both auth methods. Cloudflare Turnstile is the CAPTCHA for signup/login/high-risk unauthenticated endpoints. A production Turnstile site key is a **required launch task** (not a dev blocker).
- **Work created:** Turnstile production key provisioning; verify CAPTCHA coverage on abuse-prone endpoints.

### D23 — MFA stays optional with step-up (Q23)
- **Decision:** MFA optional for general access; step-up required for Plaid connect/reconnect, credential changes, future API keys, and security-sensitive actions. Not required merely for subscribing to TMM+.
- **Work created:** none (current behavior confirmed); document in security policy.

### D24 — Account deletion processed immediately (Q24)
- **Decision:** Privacy policy states deletion is processed immediately on confirmation: account inaccessible, sessions invalidated, Plaid credentials revoked, data enters deletion workflow. Encrypted backups may persist only for their normal retention window and are never used for restoration.
- **Work created:** privacy policy text; deletion-cascade verification test (all tables, including post-014 additions).

## Deployment & operations

### D25 — Solo-founder ops; all alerts → stephen3miller@gmail.com (Q25)
- **Decision:** All production, payment, security, and infra alerts route to the founder. No formal 24/7 SLA; critical incidents ASAP, general support best-effort.
- **Work created:** alert routing config across Sentry/uptime/Stripe/Plaid/Supabase; published support expectations.

### D26 — Operator identity: Stephen Miller (individual) until an entity exists (Q26)
- **Decision:** Legal docs name the individual founder; contact stephen3miller@gmail.com; structured for later swap to an LLC without substantive rewrites.
- **Work created:** fill `docs/security/` templates with real details; entity-swap notes in each doc.

### D27 — Incident comms via email now; status page later (Q27)
- **Decision:** Email is the incident channel at launch. `status.tmm.finance` is the planned future status page; design incident workflow so in-app/email announcements can reference it later without rework.
- **Work created:** incident-response contact update; reserve the subdomain when convenient.

## Support & analytics

### D28 — Support: stephen3miller@gmail.com; 2–4 business-day first response (Q28)
### D29 — Feedback: email only for MVP (Q29)
### D30 — Analytics: privacy-respecting pageviews only (Q30)
- **Work created (D28–D30):** in-app support link + expectations text; privacy policy analytics disclosure; wire one pageview tool (Vercel Analytics or Plausible) on the deployed frontend — the audit noted `@vercel/analytics` sits in the root package, which is not the deployed frontend.

---

## Decisions that expand the audit roadmap (summary of new scope)

| Decision | New workstream | Rough added effort |
|---|---|---|
| D4 | Domain Model Foundation (positions, holdings, cash flows) + engine consolidation against it | +2–3 weeks |
| D7/D8 | Entitlement service, 3-tier catalog, annual billing, free-tier limits | +1–1.5 weeks |
| D1/D2 | Waitlist + invite system (two lists), signup soft cap | +0.5–1 week |
| D17/D18/D19 | Three-environment separation, always-on backend migration, stable API domain | +0.5–1 week |
| D12 | Plaid lifecycle state machine + scheduled sweeps | +0.5 week (partly overlaps PAY/BUG fixes) |

Everything else confirms audit recommendations already costed in `docs/project-audit/prioritized-roadmap.md`.
