# Launch-Readiness Gates

Four gates govern the path to general availability. A gate passes only when every blocker is checked with evidence (test run, screenshot, or log linked from the gate log). The Release Manager role (`tmm-workforce/roles/release-manager.md`) owns gate execution; the founder owns go/no-go.

This supersedes the sequencing in `docs/project-audit/release-readiness-checklist.md` (whose item-level checks are incorporated below) by adding the D1/D2 rollout shape: free tier open at launch, TMM+ live but invite-only, waitlist for everyone else.

---

## Gate A — Dev-complete (end of Phase 4)

*Meaning: all launch-scoped code exists and passes on dev; no known-broken paths.*

- [ ] All Phase 0–4 items merged; CI fully green (unit + harness + money-path + smoke)
- [ ] Confirmed bugs BUG-1..6 fixed, each with a regression test (BUG-7 dissolved with legacy engine)
- [ ] Silent failures eliminated: error boundary, save-truth indicator, corrupt-plan recovery, simulation error state (UX-1..4)
- [ ] Single engine; goldens on ledger; property suite green; checkpoint + position + drift semantics per D3/D4 with golden tests
- [ ] Plan persistence: second-device restore, offline mode, revision restore, oversize rejection all demonstrated
- [ ] Entitlement matrix unit-tested for every Stripe status × price × grace combination
- [ ] Plaid lifecycle state machine tested per the matrix in `05-plaid-lifecycle-policy.md`
- [ ] Free-tier limits enforced server-side (3 alternatives / 5-year horizon) with upgrade UX
- [ ] Waitlist + invite flows working end-to-end on dev
- [ ] Security items SEC-1..7 implemented with tests (verification against staging happens at Gate B)

## Gate B — Staging burn-in (end of Phase 5, pre-launch)

*Meaning: the production shape exists and has been exercised; environments are separated; a rollback exists.*

**Environments**
- [ ] Staging Supabase rebuilt **from migrations alone**; RLS anon-test green on staging (scheduled weekly thereafter)
- [ ] Prod Supabase created on **Pro** (base); daily backups confirmed. **PITR deferred to the first real Plaid invoice** — at that trigger, enable PITR and rehearse a restore once into a scratch project (runbook written). Restore runbook drafted now regardless.
- [ ] Backend on always-on host (staging + prod); **worker + scheduler liveness verified** (a queued job processes; a scheduled sync fires)
- [ ] `api.tmm.finance` live with TLS + HSTS; CORS matrix correct per environment
- [ ] Deploy pipeline: push → CI → staging → promote; **rollback rehearsed** on both tiers
- [ ] Startup config validator refuses to boot with missing prod vars (tested)

**Integrations (on staging)**
- [ ] Stripe test-mode full loop: checkout → entitlement flip → Plaid gate opens → cancel → period-end downgrade → gate closes
- [ ] Stripe test-clock loop: upgrade → `past_due` → day-7 downgrade → restore
- [ ] Plaid sandbox loop: link → sync → values in plan → bank-side revoke → status reflects it
- [ ] Forged (unsigned) Plaid webhook rejected 401 on staging
- [ ] Deletion-cascade test green against staging (zero rows, full footprint)
- [ ] Sheets loop: export backup → edit → import → pre-import snapshot verified
- [ ] Pricing floor analysis signed off; Stripe live catalog created to match; `plan_catalog` populated

**Ops**
- [ ] Monitoring live: uptime, Sentry (front + back), Plaid job-failure daily check, billing alerts — test alert received at founder email
- [ ] Retention sweeps running on staging; row counts bounded
- [ ] Ops runbook complete: kill switches, webhook re-registration, worker restart, restore, incident flow
- [ ] Secret scan green; prod secrets exist only in prod host secret store

## Gate C — Public launch (free tier open; TMM+ invite-only)

*Meaning: real users can sign up; founder cohort uses TMM+ with real billing.*

**Blockers**
- [ ] Privacy policy + ToS published with real operator identity (D26), deletion SLA (D24), retention table (D15), refund policy (D9); linked in-app
- [ ] Security contact live; support email + 2–4 business-day expectation published (D28)
- [ ] Turnstile production key active on signup/login (D22)
- [ ] Leaked-password protection on; Supabase advisors clean or accepted-with-reason on prod (ADR-7)
- [ ] RLS anon-test green **against prod**
- [ ] Stripe **live** webhook endpoint registered on `api.tmm.finance` with live signing secret; one live founder transaction verified end-to-end
- [ ] Plaid production webhook registered; existing items backfilled via `item/webhook/update`; SEC-1 verification confirmed live (signed accepted, unsigned rejected)
- [ ] Manual pre-release scripts executed and logged: 7-step UX reliability script, billing loop, Plaid loop, Sheets loop, sample-XLSX import on a fresh account
- [ ] Free-signup soft cap configured; overflow waitlist tested (D1)
- [ ] Analytics (pageviews only) wired and disclosed (D30)
- [ ] Browser tab title/meta/favicon real; onboarding + sample data verified on a fresh account
- [ ] 48-hour watch plan with written abort thresholds (error rate, signup failures, webhook failures) and the kill-switch decision tree

**Launch-day sequence**
1. Freeze: CI green, gate checklist complete, tag release.
2. Deploy backend → prod smoke (`/api/health`, worker liveness, webhook self-test) → deploy frontend.
3. Verify webhooks: Stripe dashboard test event; Plaid sandbox-fire against prod endpoint (then confirm production traffic).
4. Founder end-to-end pass on prod (fresh account: onboard → plan → simulate → export; TMM+ account: link → sync → billing states visible).
5. Open free signup. Watch dashboards for 48 h against abort thresholds.

## Gate D — TMM+ general availability (waitlist opens)

*Meaning: paid tier proven; open the waitlist in cohorts.*

- [ ] ≥ 1 full **real** billing cycle completed by founder/invitees with zero entitlement corrections
- [ ] Grace-period path observed (or test-clock re-verified against prod config) since launch
- [ ] Plaid production sync healthy across the invite cohort ≥ 2 weeks: no stuck jobs, breaker calm, item counts reconcile with subscriber counts
- [ ] Unit economics validated with real Plaid invoices vs. the pricing floor
- [ ] Support load from the free tier sustainable at 2–4 business-day response (D28)
- [ ] Waitlist cohort mechanics: invite batch size chosen against Plaid cost projections and the Supabase capacity picture; each cohort followed by a 1-week health review before the next
- [ ] Post-MVP items scheduled: entitlement reconciliation job (PAY-7) before the second cohort; grace-period UX polish

---

## Evidence log

Each gate execution appends a dated section here (or a sibling `gate-log.md`): checklist snapshot, evidence links, deviations accepted (with reason and founder sign-off), and the go/no-go decision. No gate passes silently.
