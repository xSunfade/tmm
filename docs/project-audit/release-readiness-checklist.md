# Release Readiness Checklist

Practical go/no-go list for the first public release. Items marked **[BLOCKER]** must be done; others are strongly recommended. Cross-references point at the audit doc with details.

## Product

- [ ] **[BLOCKER]** Browser tab title / meta / favicon are real (currently "frontend")
- [ ] **[BLOCKER]** Onboarding + sample data verified on a fresh account (exists — verify)
- [ ] Monte Carlo band + Resample Forecast explained in UI (UX-F)
- [ ] Ticker asset mode either works in the ledger or is labeled honestly (BUG-6)
- [ ] Feature gates match the launch decision (TMM+ visible? waitlist?) — open-questions #2/#3

## Technical

- [ ] **[BLOCKER]** BUG-1 (`/api/plaid/items`), BUG-2, BUG-3 fixed with tests
- [ ] **[BLOCKER]** Server-side plan persistence + revisions live (DATA-1); second-device test passes
- [ ] **[BLOCKER]** Error boundary + simulation error state + save-failure visibility (UX-A/B/C)
- [ ] **[BLOCKER]** Single simulation engine; legacy deleted; goldens migrated (FRAGILE-1)
- [ ] **[BLOCKER]** Drift fix (BUG-4) + checkpoint semantics decision implemented (BUG-5)
- [ ] **[BLOCKER]** One reproducible deployment: stale `vercel.json`/EB/`.fiveserverrc` deleted, topology documented, deploy pipeline works, rollback tested (redeploy previous build)
- [ ] **[BLOCKER]** Startup config validation; complete `.env.example`s (ENV-1)
- [ ] **[BLOCKER]** External uptime monitor on `/api/health`; error tracking (Sentry) wired
- [ ] Git: uncommitted Sheets retry work + `tests/unit/` committed; branch protection on main; meaningful commits from now on
- [ ] `server.js` split into routers (Phase C — recommended, not blocking)

## Security (from `security-and-privacy-audit.md` — all §"minimum bar" items)

- [ ] **[BLOCKER]** Plaid webhook signature verification (SEC-1)
- [ ] **[BLOCKER]** Diag endpoints removed/gated (SEC-2)
- [ ] **[BLOCKER]** Google OAuth state nonce (SEC-3)
- [ ] **[BLOCKER]** Secret scan (incl. TS files) + rotation pass (SEC-5)
- [ ] **[BLOCKER]** RLS anon test green against production Supabase
- [ ] **[BLOCKER]** Deletion-cascade test passes across all user tables
- [ ] **[BLOCKER]** HSTS on; TLS-skip guard (SEC-7)
- [ ] Admin gating on ops routes (SEC-4)
- [ ] `plaidConfig.backendApiUrl` trust boundary verified (SEC-6)

## Payments (only if charging at launch — else move to TMM+ opening checklist)

- [ ] **[BLOCKER]** PAY-1 failed-payment states; PAY-2 price verification; PAY-3 subscription persistence
- [ ] **[BLOCKER]** Full loop tested in test mode incl. test clocks (upgrade → past_due → downgrade)
- [ ] **[BLOCKER]** Production webhook endpoint + signing secret configured; one live founder transaction verified
- [ ] Cancellation/refund policy published; Plaid item cleanup on downgrade decided (PAY-6)

## Data

- [ ] **[BLOCKER]** Supabase **Pro** (base) enabled before launch; daily backups confirmed; restore runbook written. **PITR deferred to the first real Plaid invoice** — enable + test a restore once at that trigger (DATA-8)
- [ ] **[BLOCKER]** Corrupt-plan recovery path (DATA-2) + pre-import snapshot (DATA-3)
- [ ] Migration process defined (DATA-7); FK drift resolved (DATA-4)
- [ ] Retention sweeps scheduled (DATA-6)

## Docs & legal

- [ ] **[BLOCKER]** Privacy policy + Terms with real entity/contact (templates exist — fill + legal review)
- [ ] **[BLOCKER]** Security contact reachable (fill `SECURITY_CONTACTS.md`)
- [ ] Backend API doc regenerated from actual routes; stale docs fixed or marked (gap analysis, tests README, implementation summary paths)
- [ ] Ops runbook: env vars, kill-switch flags, webhook re-registration, worker restart, Supabase restore

## Testing (from `testing-strategy.md`)

- [ ] **[BLOCKER]** Unit tests in CI; harness green; encryption test imports real tokenStore
- [ ] **[BLOCKER]** Manual UX reliability script (7 steps) executed and passing
- [ ] **[BLOCKER]** Plaid sandbox loop + Sheets loop + sample-XLSX import executed
- [ ] One Playwright smoke in CI (recommended)

## Analytics & support

- [ ] Privacy-respecting analytics wired (or explicit decision not to)
- [ ] Support channel decided (email at minimum) and linked in-app; expectations set (response time)
- [ ] Error tracker alerts routed somewhere a human sees daily
- [ ] A "known issues / status" page or pinned doc

## Rollback plan

- [ ] **[BLOCKER]** Frontend: previous build redeploy tested
- [ ] **[BLOCKER]** Backend: previous build redeploy tested; DB migrations for the release are additive/backward-compatible (they are jsonb/additive in this plan — verify per release)
- [ ] Kill switches documented: `RUN_PLAID_WORKER=false`, scheduler envs, Stripe env unset → 503, maintenance banner method
- [ ] Decision tree written: who flips what, when (one page in the runbook)

## Launch-day sequence (suggested)

1. Freeze: CI green, checklist above complete, tag release.
2. Deploy backend → run smoke against prod API → deploy frontend.
3. Verify webhooks: Stripe test event via dashboard; Plaid sandbox webhook fire.
4. Founder account end-to-end pass in production.
5. Open signups; watch error tracker + uptime + Supabase dashboards for 48 h (defined "abort" thresholds).
