# TMM Post-Audit Roadmap — July 2026

This folder is the planning foundation for TMM's next development phases. It was produced **after** the July 2026 project audit (`docs/project-audit/`) and **after** the product owner answered all 30 open questions (`docs/project-audit/project-audit-question-answers.md`). Every document here reflects the updated, decided direction — not the audit's open-ended recommendations.

**No application code was changed as part of this planning phase.**

## What changed since the audit

The audit left 30 decisions open. All 30 are now answered. The most consequential:

1. **Supabase becomes the authoritative source of truth (ASOT)** for user plans. Google Sheets is formally demoted to backup/export/import.
2. **Checkpoints are ground truth** — projections rebase from the latest observed checkpoint (the spec's intent wins over current behavior).
3. **Market assets get real position-based modeling** (quantity × simulated price, DCA-aware) with a domain model deliberately separated from the simulation engine. This is a *canonical product decision*, not an MVP shortcut — and it is new scope beyond the audit's roadmap.
4. **Billing is entitlement-driven**: three tiers (Free, TMM+, TMM+ Pro), monthly + annual, limits enforced server-side, all configurable via Stripe Products/Prices + entitlement mappings.
5. **TMM+ ships at MVP behind a waitlist/invite gate**; free tier is open signup with cost-reactive soft limits.
6. **Hosting topology approved**: static frontend on Vercel (`tmm.finance`), one always-on Node backend (`api.tmm.finance`, Render-class host), Supabase for auth/data. Three Supabase projects (dev/staging/prod).
7. **Plaid production access is approved**, and the Plaid lifecycle on downgrade is fully specified (7-day grace → sync suspension → 30-day token retention → revocation).
8. **The current Supabase project contains only founder dev data** — no backward-compatibility constraint. Clean re-architecture is explicitly preferred over schema preservation.

## Read in this order

| # | File | Covers |
|---|---|---|
| 0 | `00-decision-register.md` | All 30 decisions, each cross-referenced to the audit finding it resolves and the work it creates. **The canonical "what was decided" record.** |
| 1 | `01-architecture-decisions.md` | ADR-style records for the eight load-bearing architecture decisions |
| 2 | `02-implementation-phases.md` | Sequenced phases 0–6 with priorities, dependencies, effort, and acceptance criteria |
| 3 | `03-data-model-and-migration-plan.md` | Target Supabase schema, domain model, migration sequencing, dev→staging→prod promotion |
| 4 | `04-billing-and-entitlements.md` | Stripe architecture: tiers, entitlements, grace periods, pricing floor, waitlist/invites |
| 5 | `05-plaid-lifecycle-policy.md` | Full Plaid item lifecycle: connect, sync, downgrade, restore, revoke, delete |
| 6 | `06-security-privacy-and-retention.md` | Security posture, launch bar, retention schedule, deletion SLA |
| 7 | `07-environments-and-hosting.md` | Topology, domains, env separation, deploy pipeline, environment variables |
| 8 | `08-infrastructure-inventory.md` | **What actually exists today** in the connected Supabase/Vercel/Stripe accounts (inspected 2026-07-03, read-only) and the gaps |
| 9 | `09-risk-register.md` | Ranked risks with mitigations and owners |
| 10 | `10-launch-readiness-gates.md` | Gates A–D: dev-complete → staging burn-in → public launch → TMM+ open |

## Relationship to the audit folder

- `docs/project-audit/` remains the **evidence record** — findings, bug IDs (BUG-x, SEC-x, DATA-x, PAY-x, UX-x, FRAGILE-x), and per-item detail. This folder references those IDs rather than restating them.
- Where an answer **changes** an audit recommendation (e.g., Ticker assets: the audit offered "relabel for MVP"; the answer chose "build the real domain model"), this folder is authoritative.

## Headline schedule

The audit estimated 6–8 focused weeks to public MVP. The answers added real scope — the position-based domain model (D4), the entitlement service with three tiers (D7/D8), the waitlist system (D1/D2), and three-environment separation (D17). The revised estimate is **10–13 focused weeks** to Gate C (public launch), detailed in `02-implementation-phases.md`.
