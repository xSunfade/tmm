# TMM Workforce — AI/Dev Team Design

This folder defines TMM's long-term AI-assisted workforce: specialized roles, their skills, operating rules, handoff protocols, and review systems. It is designed for how TMM is actually built — a solo founder (Stephen Miller) directing AI agents in Cursor — and for the specific product: a trust-first financial simulation app where **the number on the chart is the product** and money-adjacent code (Stripe, Plaid) has the highest blast radius.

## Design principles

1. **Roles match TMM's risk surfaces, not generic software roles.** Simulation correctness, data/ASOT integrity, billing/entitlements, Plaid lifecycle, and security each get a dedicated owner because each has its own way of silently destroying user trust.
2. **Every role is both a builder and a reviewer.** No money-path or engine change ships with only one set of eyes (even AI eyes). The review pairings are fixed in `review-gates.md`.
3. **Rules are written down, not remembered.** Global constraints live in `operating-rules.md`; agents read them before acting. Skills encode TMM-specific procedures so any agent session starts with the same discipline.
4. **The founder is the product owner and the only prod authority.** Agents propose; gates and prod actions require founder sign-off (see `operating-rules.md` §Environment authority).
5. **Documents cite decisions.** D-numbers (`project-roadmap/00-decision-register.md`) and audit IDs (BUG-x, SEC-x…) are the shared vocabulary; agents justify behavior by citation, not vibes.

## Folder map

| Path | Contents |
|---|---|
| `operating-rules.md` | Global rules binding every agent: environment authority, money-path rules, never-log list, migration discipline, evidence standards |
| `handoff-protocol.md` | Task intake format, handoff package format, definition of done |
| `review-gates.md` | Which changes require which reviewer role; per-domain review checklists |
| `workflows.md` | End-to-end collaboration workflows: feature, migration, billing change, engine change, release, incident |
| `roles/` | 11 role definitions (below) |
| `.cursor/skills/tmm-*/` (repo root, not in this folder) | Cursor-discovered `SKILL.md` files encoding TMM-specific procedures; auto-loaded by the agent when relevant |

## The roster

| Role | File | Owns |
|---|---|---|
| **Chief Architect** | `roles/chief-architect.md` | System shape, ADR guardianship, anti-over-engineering, cross-cutting decisions |
| **Simulation Engineer** | `roles/simulation-engineer.md` | Ledger engine, domain model (ADR-2), checkpoint/position semantics, numeric invariants |
| **Data Platform Engineer** | `roles/data-platform-engineer.md` | Supabase schema, migrations, RLS, plan persistence (ASOT), retention |
| **Billing Engineer** | `roles/billing-engineer.md` | Stripe, entitlements, tiers, grace/dunning, waitlist/invites, pricing floor |
| **Integrations Engineer (Plaid)** | `roles/plaid-integrations-engineer.md` | Plaid lifecycle, sync worker, webhooks, Sheets/Google OAuth surfaces |
| **Security & Privacy Officer** | `roles/security-privacy-officer.md` | Security bar, secrets, RLS verification, privacy policy truthfulness, deletion cascade |
| **Frontend/UX Engineer** | `roles/frontend-ux-engineer.md` | React app, silent-failure elimination, save-truth UX, accessibility of trust |
| **QA Engineer** | `roles/qa-engineer.md` | Test strategy execution, CI wiring, golden fixtures, manual pre-release scripts |
| **Technical Writer** | `roles/technical-writer.md` | Docs truthfulness, runbooks, API reference, policy documents |
| **Release Manager** | `roles/release-manager.md` | Gates A–D execution, deploy pipeline, rollback, risk-register upkeep |
| **Product Strategist** | `roles/product-strategist.md` | Scope guardianship, tier/pricing analysis, waitlist cohorts, post-MVP sequencing |

## How to use this with Cursor (practically)

- **Skills:** the six TMM skills live in `.cursor/skills/tmm-*/SKILL.md` (repo root), where Cursor auto-discovers them on startup and the agent invokes them when relevant — no action needed. (They were previously drafted under `tmm-workforce/skills/`; that copy was removed to keep a single source of truth.) Verify they loaded via **Customize → Skills** in the sidebar.
- **Subagents:** each role file ends with a **Subagent launch template** — a self-contained prompt (subagents don't see chat history) to paste into a Task/agent launch. Fill the `{{...}}` slots.
- **Sessions as roles:** for bigger workstreams, start a dedicated chat per role and open it with: *"Adopt the role in `tmm-workforce/roles/<role>.md`. Read `tmm-workforce/operating-rules.md` first. Task: …"*
- **Reviews:** after a builder session produces a PR/diff, launch the paired reviewer role (per `review-gates.md`) on the diff. The reviewer's checklist output goes into the PR description.

## Maintenance

The workforce evolves with the roadmap: when a phase completes, roles' "current focus" sections update; when an incident or review failure reveals a missing rule, it is added to `operating-rules.md` in the same PR as the fix (the rule-capture habit). The Chief Architect role owns this folder's coherence.
