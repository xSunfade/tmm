# Cost Control Plan

TMM's architecture is already cost-friendly: simulation runs in the user's browser, the backend is a thin proxy, and there's no AI spend. The material cost risks are **Plaid per-item billing**, Supabase tier, and always-on hosting. Estimates below are order-of-magnitude, based on public pricing as of mid-2026 — verify current pricing before committing.

## Expected monthly baseline (MVP, ~first 1,000 users)

| Item | Estimate | Notes |
|---|---|---|
| Frontend hosting (Vercel/Netlify/CF Pages free–pro) | $0–20 | Static build; bandwidth is the only variable |
| Backend (1 small always-on instance, Render/Railway/Fly) | $7–25 | In-process worker requires always-on |
| Supabase Pro (base) | $25 | Non-negotiable at launch: daily backups (7-day retention), no project pausing. Micro compute covered by the $10 credit. |
| Supabase PITR add-on (deferred) | +~$105 | 7-day PITR is **$100/mo** and requires a Small compute add-on (~$15, ~$5 net after credit). **Not covered by the spend cap.** Graduated trigger: enable at the **first real Plaid invoice** (DATA-8). |
| Stripe | % of revenue only | No fixed cost |
| Google Sheets API | $0 | Free; quota-limited (retry work handles it) |
| Plaid | **$0 until users connect; then per-item/month** | THE cost to control — see below |
| Domain/email/monitoring | $5–20 | UptimeRobot/healthchecks free tiers exist |

Total fixed floor at launch: **roughly $40–90/month** before Plaid (Supabase at the $25 Pro base). Enabling PITR later adds **~$105/month** (see below), pushing the floor to ~$145–195 — deferred to the first real Plaid invoice.

## Plaid — the one cost that scales badly

Confirmed from code — good controls already exist: item cap 5/user (safety ceiling 10), weekly connection velocity limit, usage counters, circuit breaker, TMM+ paywall in front of every Plaid route.

Actions:

1. **Keep Plaid strictly behind payment** (already enforced) and gate the launch cohort (see MVP scope). Price TMM+ above expected per-user Plaid cost — with a 5-item cap and typical per-connected-item pricing, worst-case Plaid cost per paying user needs to be below the subscription price. **Decision in open-questions: TMM+ price.**
2. **Fix BUG-3 / decide PAY-6:** orphaned tokens and items belonging to downgraded users keep billing. Add a cleanup: on downgrade (after a grace window) call `itemRemove` and delete tokens. *Priority: High for cost; Effort: 1 day.*
3. **Verify Plaid billing model for your contract:** sandbox is free; production `transactions` is typically per-connected-item/month. Set a billing alert in the Plaid dashboard.
4. Scheduled daily sync + webhook-driven sync is the right pattern (no polling Plaid directly on page load — already true).

## Supabase

- **Tier posture (DATA-8, graduated).** Launch on **Pro base (~$25/mo)**: daily backups with 7-day retention, no project pausing, Micro compute covered by the $10 credit. This is the launch floor — free tier is disqualified (projects pause after 1 week; no managed recovery). **PITR is deferred**, not skipped: the $100/mo add-on (7-day retention) plus its required Small compute add-on (~$15, ~$5 net) is **excluded from the spend cap** and roughly 5× the base, so it is not justified at single/double-digit user counts. Interim recovery rests on the application-level layer already shipped in Phase 2 (20 server-side plan revisions/user, pre-import snapshots, XLSX export, Sheets backup) on top of Pro's daily backups (<24h worst-case DB exposure). **Trigger to enable PITR: the first real Plaid invoice** — that event proves paying users with connected financial data exist, at which point seconds-granularity recovery becomes worth ~$105/mo. Accepted-with-reason until then.
- Growth tables: `transactions` (largest), webhook events, sync runs, snapshots. Add retention sweeps (DATA-6): e.g., webhook events 90 days, sync runs 30 days, keep transactions (product data).
- The worker's 2 s poll ≈ 43 k queries/day — raise to 10–15 s (see performance audit) mostly to keep query metrics clean; Supabase doesn't bill per query, but connection/CPU pressure is real on small tiers.
- Per-request `auth.getUser` adds Auth API volume — fine now; JWKS verification later removes it entirely.
- Watch: egress (chart/history payloads are small — fine), storage (transactions dominate).

## Logging / observability (keep nearly free)

- Structured JSON to stdout + host log retention (7–14 days) is enough for MVP. **Do not** buy a log SaaS yet.
- One free uptime monitor on `/api/health` + a Plaid job-failure check (a daily query for stuck jobs — can be a scheduled GitHub Action hitting an admin endpoint or Supabase scheduled function). *Effort: 0.5 day.*
- Error tracking: Sentry free tier (5k events/mo) front + back is worth it at launch — silent client errors are otherwise invisible. Optional but recommended.

## Analytics

- `@vercel/analytics` is in root package.json dependencies (**confirmed**) but the root package isn't the deployed frontend — **unknown whether analytics is actually wired**. For MVP: one privacy-respecting pageview tool (Vercel Analytics/Plausible, $0–19) — no funnels/session-replay spend yet.

## AI

- No AI features in MVP (per project brief) → $0. When the AI assistant eventually lands, the local-orchestration ambition in the brief is also the cost-control strategy; defer entirely.

## Cost guardrails to institute now (cheap, one-time)

| Guardrail | Effort |
|---|---|
| Billing alerts: Plaid dashboard, Stripe email, Supabase usage alerts, host spend cap | 1 hour |
| `PLAID_ITEM_CAP` stays at 5; document why | 0 |
| Item cleanup on downgrade (above) | 1 day |
| Retention sweeps (DATA-6) | 1 day |
| Rate limits on expensive proxies (exists; keep) | 0 |
| A monthly 15-minute cost review ritual (one doc page, four numbers) | recurring |

## Kill-switch inventory (already built — document them)

`PLAID_SYNC_USE_QUEUE`, `RUN_PLAID_WORKER`, scheduler interval envs, circuit breaker, Stripe 503-on-unset, validation mode. These flags mean runaway integration costs can be halted with an env change and restart. Write them into the ops runbook.
