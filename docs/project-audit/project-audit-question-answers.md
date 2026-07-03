## **Product**

1. **What does "public MVP" mean for you — open free signup, waitlist, or invite-only beta?** Shapes the entire Phase 4 rollout and how hard the security bar must be enforced on day one.

**Open free signup for TMM free tier and a waitlist for TMM+.** 

**Free: I want to be able to have as many users at least see the website and sign up for free accounts, but we must also consider that I’m still on the free plan in Supabase. I am not against upgrading, but I do want to plan the rollout to be reactive for cost-effectiveness. In the event there is a spike in signups, I do want to look into if Supabase has an auto cutoff, and/or if we can set a soft limit and begin offering a waitlist.** 

**TMM+: I want to use it as the developer and I also want to invite friends and family. Other users who don’t have an invite can sign up for the waitlist.**

2. **Does TMM+ (Plaid) launch with the MVP, or does the free planner launch first?** Recommendation in `mvp-scope-definition.md` is free-first / TMM+ invited-cohort. (Phases 3–4 sequencing.)

**TMM+ (Plaid) should launch with the MVP but in a waitlist state in which users can signup for the waitlist and then be notified when TMM+ is available for upgrade. This way, my family, friends, and I can use TMM+ while the rest of the user base can sign up for the waitlist.**

3. **Checkpoint semantics (BUG-5):** when a user records a checkpoint, should future projections restart from that observed state (the spec's intent), or remain plan-derived with checkpoints as chart annotations (current behavior)? This is a product-truth question, not just a bug. (1.6)

**A checkpoint represents an observed ground truth. Once recorded, it becomes the new baseline from which all future projections are simulated.** 

4. **Ticker assets:** implement real price-growth modeling for MVP, or relabel Ticker mode as "tracked balance with APY growth" until post-MVP? (BUG-6)

**This is a canonical product decision rather than an MVP-only decision.**

**Implement real position-based modeling for market assets. Market assets should be modeled as ownership positions (quantity × simulated price), not simply balances with an APY. Future prices are not market predictions; they are deterministic simulations derived from user-configured assumptions (such as an expected annual return). Periodic contributions should purchase additional shares based on the simulated price at the time of contribution, allowing the simulation to accurately model dollar-cost averaging and ownership over time.**

**Design the architecture so that the domain model reflects financial reality while remaining independent from the simulation engine. The domain model should represent concepts such as accounts, holdings, positions, transactions, cash flows, and checkpoints. The simulation engine should operate on that model to produce projections. This separation allows future simulation methods (Monte Carlo, historical return models, AI optimization, etc.) to evolve without requiring changes to the underlying financial model.**

**Do not overbuild the initial implementation. Focus on the minimum functionality necessary to establish a correct, position-based foundation. Advanced capabilities such as dividends, stock splits, tax lots, capital gains, rebalancing, allocation rules, and withdrawal strategies can be implemented later. However, the underlying data structures and interfaces should be designed so these features can be added naturally without requiring a fundamental redesign.**

**Prioritize correctness, extensibility, maintainability, and user trust over implementing a temporary balance-based approximation that would eventually need to be replaced.**

5. **Google Sheets positioning:** backup/export (recommended) or living two-way sync? Determines how much more engineering the sync path deserves. (FRAGILE-8)

**Resolve FRAGILE-8 by formally demoting Google Sheets from authoritative storage to backup/export/import only. TMM’s long-term ASOT should be server-side Supabase, with Google Sheets retained as a user-controlled portability layer. Remove or de-emphasize living two-way sync language and replace it with explicit “Export backup to Google Sheets” and “Import from Google Sheets” flows. Do not continue investing in last-writer-wins two-way sync as a core persistence strategy. Begin designing persistence around Supabase-authenticated users, per-user plan ownership, row-level security, versioned plan records, server-authoritative saves, and future Stripe entitlement/quota enforcement. For MVP, preserve existing Sheets import/export compatibility so users are not stranded, but make the product behavior clear: Supabase/local app state is authoritative; Sheets is a backup and portability artifact, not a second source of truth.**

6. **Weekly check-in / tour / goals:** keep all three in MVP, or hide any that aren't demo-ready? (Feature-gate decisions, cheap either way.)

**Keep all three in the MVP. They need work, but with the general enhancements/fixes throughout this project audit as a whole, I trust that you can put the pieces together for these three.** 

## **Business model**

7. **TMM+ price point?** Must exceed worst-case Plaid cost per user (5 items × per-item fee) with margin — see `cost-control-plan.md`. Also: monthly only, or annual too?

**Design the billing and entitlement system around server-side feature entitlements rather than hardcoded subscription plans. Support both monthly and annual billing from the initial release. Launch with a simple three-tier structure (Free, TMM+, TMM+ Pro) and ensure every paid tier remains profitable under worst-case legitimate usage, including maximum allowed Plaid Items, Stripe fees, infrastructure costs, and a healthy operating margin. Treat Plaid connectivity as a premium entitlement with explicit per-plan limits rather than bundling unlimited bank connections. Keep pricing data configurable through Stripe Products/Prices and entitlement mappings so plans, limits, promotions, grandfathered users, and future tiers can evolve without application code changes.** 

8. **Free-tier limits:** any caps (alternatives count, horizon length)? Current code has none for free users beyond Plaid gating.

**Limit the free tier by analytical capability rather than by basic financial tracking. Allow unlimited manual account creation and core budgeting features, but restrict free users to three Alternatives and a maximum five-year projection horizon. Reserve unlimited scenarios, unlimited projection length, Plaid connectivity, and future advanced analysis features for paid tiers.** 

9. **Refund/cancellation policy text** (end-of-period downgrade is the code's current behavior — confirm it). (PAY-6)

**Confirm the existing end-of-billing-period cancellation behavior. Canceling disables automatic renewal immediately but preserves premium access until the paid subscription expires. Upon expiration, automatically downgrade the account to the Free tier while retaining all user data. Premium functionality should become unavailable without deleting or modifying the user's financial plans. Refunds should generally not be automatic, with manual support exceptions for accidental purchases, duplicate charges, or billing errors.** 

10. **Trial?** Code handles `trialing` as entitled — do you want to offer one?

**Do not publicly offer a free trial for the initial release. The permanent Free tier serves as the primary evaluation experience. Retain entitlement support for trialing subscription states so promotional, referral, beta, or future marketing campaigns can enable trials without requiring architectural changes. The billing system should remain fully compatible with Stripe trial periods even if no public trial is offered at launch.** 

## **Payments**

11. **Grace-period policy for failed payments:** how many days of `past_due` keep TMM+ access? (PAY-1 needs a number.)

**7 calendar days after entering past\_due, after which the account automatically downgrades to the Free tier while retaining all user data.** 

12. **On downgrade, what happens to connected banks?** Recommendation: disconnect Plaid items after N-day grace (cost \+ privacy); keep historical data. Confirm N. (3.7)

**After the 7-day payment grace period, automatically downgrade the account to the Free tier and immediately suspend all Plaid synchronization. Preserve all historical imported financial data, user edits, and account history. Retain encrypted Plaid access tokens for up to 30 additional days solely to enable seamless subscription restoration without requiring users to reconnect their financial institutions. If the subscription is not restored within that retention window, permanently revoke the associated Plaid Items and securely delete all Plaid access tokens. Historical imported data remains part of the user's plan unless the user explicitly requests account deletion.** 

13. **Stripe Tax:** will you sell where VAT/sales-tax registration matters at launch? (Usually deferable — confirm with an accountant.)

**Defer Stripe Tax for the initial launch. TMM will initially target U.S. customers and use standard Stripe Checkout without automatic tax calculation. As the business grows and approaches state or international tax registration thresholds, consult a qualified CPA/tax advisor and enable Stripe Tax when appropriate. Architect the billing system so Stripe Tax can be enabled later without requiring changes to subscription or entitlement logic.** 

## **Data**

14. **Plan-size budget:** cap the server-stored plan at what size (recommend 1 MB) and how many revisions (recommend 20)? (DATA-1)

**Store financial plans server-side with a soft size warning at 1 MB and a hard maximum of 5 MB per plan. This provides ample headroom for future TMM capabilities (Alternatives, Pipeline Builder, AI metadata, event simulation, and long-term financial history) while preventing abusive or pathological plan sizes. Implement a rolling revision history retaining the 20 most recent revisions per plan. When a new revision is created beyond the limit, automatically delete the oldest revision. Initially, revisions may be created on each save; future iterations may optimize this into meaningful snapshot creation based on significant plan changes rather than every minor edit.** 

15. **Retention numbers:** transactions (keep indefinitely?), webhook events (90 d?), sync runs (30 d?), snapshots (all?). (DATA-6, retention policy doc)

**Adopt a retention policy that distinguishes permanent user data from operational metadata. Retain financial plans, transactions, historical imported data, Alternatives, Pipeline Builder layouts, categories, and other user-created financial information indefinitely unless the user explicitly deletes it or deletes their account. Maintain a rolling history of the 20 most recent plan revisions for recovery purposes. Retain Stripe and Plaid webhook events for 90 days, sync execution logs for 30 days, and audit/security logs for 1 year. Use a 30-day soft-delete window for user-deleted plans or accounts before permanent deletion. Delete Plaid access tokens 30 days after premium access ends (or immediately upon account deletion), while preserving all imported financial history. This minimizes storage growth for operational data while ensuring users never lose the financial work they have created.** 

16. **Is there any real user data in the current Supabase project** (were there testers)? Determines whether DATA-4's FK fix needs a data backfill and how carefully migrations must be staged. **Unknown from repo.**

**Yes, the current Supabase project contains my own development and testing data, but no real external users are using TMM yet. This is still a pre-launch development environment, so the project audit should not be constrained by backward compatibility concerns. If a cleaner long-term architecture requires restructuring tables, relationships, or migrations (including the DATA-4 foreign-key fix), prioritize the best design over preserving the current schema. The Cursor workspace is connected to the existing Supabase project and may inspect the current schema and development data as needed. Before making significant changes, evaluate whether any existing test data is worth migrating or whether starting fresh is the cleaner approach.**

17. **Which Supabase project(s) exist — separate dev/staging/prod?** The repo suggests one; a second project for staging is cheap and unblocks safe migration testing. (DATA-7)

**Currently there is a single Supabase project, which is being used as the development environment. Going forward, establish separate development, staging, and production Supabase projects as part of the project's long-term infrastructure. The current project should continue to serve as the development environment and remain free to evolve during this audit. Once the architecture stabilizes, use the development project for active implementation, a staging project for validating migrations and testing integrations (Stripe, Plaid, etc.), and reserve the production project exclusively for future real users and production data.**

## **Architecture**

18. **Hosting choice:** approve the recommended topology (static frontend on Vercel-class host \+ one always-on Node instance on Render/Railway/Fly \+ Supabase)? Needed in week 1 — webhook URLs, CORS, and OAuth redirects all hang off it. (Phase D)

**Approve the Phase D hosting topology: deploy the React/static frontend on a Vercel-class host, run one small always-on Node backend service on Render/Railway/Fly, and use Supabase for Auth/Postgres/storage. The Node backend should own Stripe webhooks, Plaid webhooks, OAuth callbacks, entitlement enforcement, server-side Supabase operations, background/retry logic, and any secret-bearing integrations. Do not rely solely on frontend code or ad hoc serverless functions for these responsibilities. For MVP, prefer a simple always-on backend because webhook URLs, CORS rules, OAuth redirects, Stripe/Plaid callback handling, and future background jobs all need stable server-side infrastructure. Render is an acceptable default choice unless implementation constraints make Railway or Fly clearly better.**

19. **Custom domain(s)** for app \+ API? Feeds CORS, OAuth consent screens, Plaid webhook registration, HSTS.

**Approve `https://tmm.finance` as the canonical production frontend domain. The backend currently uses the temporary Vercel deployment URL (`https://tmm-backend-seven.vercel.app`) during development, but the long-term architecture should adopt a stable custom API domain, preferably `https://api.tmm.finance`. This provides a permanent endpoint for CORS, OAuth redirect URIs, Stripe webhooks, Plaid webhooks, cookies, HSTS, and future integrations regardless of where the backend is hosted. The backend may initially remain on Vercel during development, but the architecture should assume it can later migrate to a dedicated always-on Node host (e.g., Render, Railway, or Fly) without requiring changes to client applications or third-party integrations. Configure all production infrastructure around `tmm.finance` and `api.tmm.finance`, using provider-specific deployment URLs only for development and preview environments.**

20. **Plaid production access status:** has the questionnaire packet (drafted 2026-02-09) been submitted / approved? Sandbox→production is a Plaid-side gate with lead time. **Unknown from repo.**

**Yes, Plaid production has been approved. I can see in the Plaid dashboard logs that Environment says “Production”.**

21. **Google OAuth app verification status:** the Sheets scope requires Google verification for \>100 external users; unverified apps show scary warnings. **Unknown from repo.**

**Google OAuth verification should not block MVP because Google Sheets should no longer be treated as TMM’s authoritative storage layer. For launch, keep Google Sheets integration optional and limited to export/import or backup workflows. Do not require Google OAuth for core account creation, plan storage, subscription access, or normal product usage. If Sheets integration remains available before Google verification is complete, keep it limited to internal/test users or clearly label it as a beta/experimental feature. Before enabling Sheets OAuth broadly for external users, complete Google OAuth app verification using the narrowest possible Sheets/Drive scopes. This avoids scary unverified-app warnings and prevents Google OAuth limits from becoming a launch blocker.**

**Google Sign-In remains a first-class authentication method and is unaffected by the decision to demote Google Sheets from authoritative storage. The OAuth scopes used for authentication (OpenID, email, profile) remain part of the core onboarding flow. Google Sheets integration should use a separate OAuth consent flow requesting only the additional Sheets/Drive scopes when a user explicitly chooses to connect Google Sheets for export/import or backup. This keeps core authentication simple while allowing Google OAuth verification for Sheets to be completed independently before broad public rollout.** 

## **User accounts**

22. **Auth methods at launch:** Google OAuth \+ email OTP both stay? (Both implemented.) Turnstile CAPTCHA — is there a real site key/account?

**Keep both Google OAuth and Email OTP authentication for the initial release. Google Sign-In provides the fastest onboarding experience, while Email OTP offers a provider-independent option for users who prefer not to use Google. Neither authentication method should be removed. Continue using Cloudflare Turnstile as the primary CAPTCHA solution for account creation, login abuse prevention, and other high-risk unauthenticated endpoints. If a production Turnstile site key has not yet been configured, treat it as a required launch task rather than a blocker for ongoing development.**

23. **MFA policy:** remain optional-with-Plaid-step-up (current), or required for TMM+?

**Retain the current MFA strategy. MFA should remain optional for general account access and should not be required solely because a user subscribes to TMM+. Continue using step-up authentication for higher-risk operations such as connecting or reconnecting Plaid accounts, changing authentication credentials, managing future API keys, or performing other security-sensitive account actions. This balances strong security with a low-friction user experience while leaving room to strengthen requirements as enterprise or business features are introduced.**

24. **Account deletion SLA** to state in the privacy policy (code processes it immediately — say so).

**State in the Privacy Policy that account deletion requests are processed immediately upon confirmation. Once initiated, the account becomes inaccessible, active sessions are invalidated, Plaid credentials are revoked, and user data enters the deletion workflow without unnecessary delay. Any remaining copies that exist solely within encrypted backup or disaster recovery systems may persist only for their normal retention period before expiring automatically, but they are not used for normal application operations or account restoration.**

## **Deployment & operations**

25. **Who is on call / who sees alerts?** Even solo — which inbox/phone, and what response expectation do you publish?

**TMM will initially be operated by a single developer/founder. All production alerts, infrastructure notifications, payment alerts, security notifications, and operational monitoring should be routed to the founder. The primary operational contact email is stephen3miller@gmail.com. During the initial release, TMM does not provide a formal 24/7 operational support SLA. Critical production incidents will be addressed as soon as reasonably possible, while general support requests will be handled on a best-effort basis. As the platform grows, monitoring and operational responsibilities can expand to additional team members without changing the overall architecture.**

26. **Legal entity \+ contact details** for privacy policy, ToS, security contact, and the Plaid/Stripe applications. Templates in `docs/security/` all have placeholders.

**Until a formal legal entity is established, identify the service operator as the individual developer/founder. Use Stephen Miller as the operator name and stephen3miller@gmail.com as the primary contact for customer support, privacy requests, security reports, and communications required by the Privacy Policy, Terms of Service, Stripe, Plaid, and other platform registrations. Structure the legal documents so these details can later be replaced with a formal business entity (e.g., an LLC) without requiring substantial revisions to the policies or application.**

27. **Status communication channel** during incidents (status page, X/Twitter, email?).

**For the initial public release, use stephen3miller@gmail.com as the primary communication channel for service issues and support inquiries. Do not require a dedicated public status page at launch. As the platform grows and the user base expands, introduce a dedicated status page (e.g., `status.tmm.finance`) as the primary location for publishing service incidents, maintenance windows, and operational updates. Design the architecture so future in-app notifications and email announcements can reference the status page without requiring changes to the incident management workflow.**

## **Support**

28. **Support channel at launch** (email alias minimum) and target first-response time?

**Use stephen3miller@gmail.com as the primary support channel. Target first response time is within 2-4 business days.**

29. **Feedback capture:** in-app link, community (Discord?), or email-only for MVP?

**Email only for MVP**

30. **Analytics appetite:** privacy-respecting pageviews only (recommended), full product analytics, or none? Affects privacy policy text. (Cost plan §analytics)

**Privacy plan views only.**