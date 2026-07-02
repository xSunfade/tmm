# Open Questions for the Product Owner

Decisions the audit cannot make for you. Each blocks or shapes specific roadmap items (referenced in parentheses).

## Product

1. **What does "public MVP" mean for you — open free signup, waitlist, or invite-only beta?** Shapes the entire Phase 4 rollout and how hard the security bar must be enforced on day one.
2. **Does TMM+ (Plaid) launch with the MVP, or does the free planner launch first?** Recommendation in `mvp-scope-definition.md` is free-first / TMM+ invited-cohort. (Phases 3–4 sequencing.)
3. **Checkpoint semantics (BUG-5):** when a user records a checkpoint, should future projections restart from that observed state (the spec's intent), or remain plan-derived with checkpoints as chart annotations (current behavior)? This is a product-truth question, not just a bug. (1.6)
4. **Ticker assets:** implement real price-growth modeling for MVP, or relabel Ticker mode as "tracked balance with APY growth" until post-MVP? (BUG-6)
5. **Google Sheets positioning:** backup/export (recommended) or living two-way sync? Determines how much more engineering the sync path deserves. (FRAGILE-8)
6. **Weekly check-in / tour / goals:** keep all three in MVP, or hide any that aren't demo-ready? (Feature-gate decisions, cheap either way.)

## Business model

7. **TMM+ price point?** Must exceed worst-case Plaid cost per user (5 items × per-item fee) with margin — see `cost-control-plan.md`. Also: monthly only, or annual too?
8. **Free-tier limits:** any caps (alternatives count, horizon length)? Current code has none for free users beyond Plaid gating.
9. **Refund/cancellation policy text** (end-of-period downgrade is the code's current behavior — confirm it). (PAY-6)
10. **Trial?** Code handles `trialing` as entitled — do you want to offer one?

## Payments

11. **Grace-period policy for failed payments:** how many days of `past_due` keep TMM+ access? (PAY-1 needs a number.)
12. **On downgrade, what happens to connected banks?** Recommendation: disconnect Plaid items after N-day grace (cost + privacy); keep historical data. Confirm N. (3.7)
13. **Stripe Tax:** will you sell where VAT/sales-tax registration matters at launch? (Usually deferable — confirm with an accountant.)

## Data

14. **Plan-size budget:** cap the server-stored plan at what size (recommend 1 MB) and how many revisions (recommend 20)? (DATA-1)
15. **Retention numbers:** transactions (keep indefinitely?), webhook events (90 d?), sync runs (30 d?), snapshots (all?). (DATA-6, retention policy doc)
16. **Is there any real user data in the current Supabase project** (were there testers)? Determines whether DATA-4's FK fix needs a data backfill and how carefully migrations must be staged. **Unknown from repo.**
17. **Which Supabase project(s) exist — separate dev/staging/prod?** The repo suggests one; a second project for staging is cheap and unblocks safe migration testing. (DATA-7)

## Architecture

18. **Hosting choice:** approve the recommended topology (static frontend on Vercel-class host + one always-on Node instance on Render/Railway/Fly + Supabase)? Needed in week 1 — webhook URLs, CORS, and OAuth redirects all hang off it. (Phase D)
19. **Custom domain(s)** for app + API? Feeds CORS, OAuth consent screens, Plaid webhook registration, HSTS.
20. **Plaid production access status:** has the questionnaire packet (drafted 2026-02-09) been submitted / approved? Sandbox→production is a Plaid-side gate with lead time. **Unknown from repo.**
21. **Google OAuth app verification status:** the Sheets scope requires Google verification for >100 external users; unverified apps show scary warnings. **Unknown from repo.**

## User accounts

22. **Auth methods at launch:** Google OAuth + email OTP both stay? (Both implemented.) Turnstile CAPTCHA — is there a real site key/account?
23. **MFA policy:** remain optional-with-Plaid-step-up (current), or required for TMM+?
24. **Account deletion SLA** to state in the privacy policy (code processes it immediately — say so).

## Deployment & operations

25. **Who is on call / who sees alerts?** Even solo — which inbox/phone, and what response expectation do you publish?
26. **Legal entity + contact details** for privacy policy, ToS, security contact, and the Plaid/Stripe applications. Templates in `docs/security/` all have placeholders.
27. **Status communication channel** during incidents (status page, X/Twitter, email?).

## Support

28. **Support channel at launch** (email alias minimum) and target first-response time?
29. **Feedback capture:** in-app link, community (Discord?), or email-only for MVP?
30. **Analytics appetite:** privacy-respecting pageviews only (recommended), full product analytics, or none? Affects privacy policy text. (Cost plan §analytics)
