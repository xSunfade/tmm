# Plaid Item Lifecycle Policy

Implements ADR-6. Decisions: D12 (downgrade lifecycle), D11 (grace), D2 (invite-gated launch), D20 (production approved), D15 (retention), D24 (account deletion). Fixes BUG-3 by policy.

## The state machine

Every Plaid item is always in exactly one state. Transitions are logged to `plaid_connection_events` (existing table) and, where security-relevant, `audit_log`.

```
                       ┌──────────────────────────────────────────────┐
                       │                                              ▼
 LINKED ──────────► ACTIVE ──payment fails──► GRACE (7d) ──not cured──► SUSPENDED (30d)
   ▲                  │  ▲                      │  cured                   │        │
   │                  │  └──────────────────────┘                          │        │
 (re-link            user removes item                              resubscribed  30d sweep
  after revoke)       │                                                    │        │
   │                  ▼                                                    ▼        ▼
   └───────────── REVOKED ◄────────── account deletion ────────────── ACTIVE   REVOKED
                 (itemRemove + token deleted)                        (no re-link)
```

### State definitions and rules

| State | Sync | Token | User sees |
|---|---|---|---|
| **ACTIVE** | Webhook-driven + daily scheduled | Encrypted at rest (AES-256-GCM, unchanged) | Live connected values, `lastSyncedAt` staleness indicator (UX-E) |
| **GRACE** (7 days from `past_due`) | **Continues normally** — the user is still entitled (D11) | Retained | Payment-issue banner |
| **SUSPENDED** (downgrade occurred) | **Suspended immediately** — no scheduled sync, webhooks acknowledged but jobs not enqueued for this user | Retained encrypted, `retention_expires_at = downgrade + 30 days` — *solely* to enable seamless restore (D12) | Connected values frozen with "as of {date}"; upgrade prompt to resume |
| **REVOKED** | — | `itemRemove` called at Plaid (best-effort with retry), token row deleted | Historical imported data **remains** in their plan/history (D12); item listed as disconnected |

### Transition details

1. **ACTIVE → GRACE:** driven by the entitlement layer (`past_due`). No Plaid-side change.
2. **GRACE → ACTIVE:** payment cured. No Plaid-side change.
3. **GRACE → SUSPENDED:** day-7 sweep downgrades the account. Actions: mark all the user's items suspended; stamp `retention_expires_at`; stop enqueueing sync jobs for the user (worker checks suspension before claiming); preserve everything else.
4. **SUSPENDED → ACTIVE (restore):** user resubscribes within 30 days. Actions: clear suspension, resume scheduled sync, trigger an immediate catch-up sync per item. **No Plaid Link re-authentication required** — this is the entire reason tokens are retained.
5. **SUSPENDED → REVOKED (expiry):** daily sweep finds `retention_expires_at < now`: call `itemRemove`, delete `plaid_tokens` row, mark item revoked, log. If `itemRemove` fails transiently, retry with backoff; if the item is already gone at Plaid, proceed with local deletion.
6. **ANY → REVOKED (user removes item):** `POST /api/plaid/remove-item` must delete accounts *and* the token row *and* call `itemRemove` (BUG-3 fix, Phase 1.2). Historical transactions/history stay unless the user separately deletes them.
7. **ANY → REVOKED (account deletion):** deletion flow revokes all items and deletes tokens **immediately** (D24), then cascades the rest.
8. **Bank-side revocation (`USER_PERMISSION_REVOKED` webhook):** verified webhook (SEC-1) triggers local cleanup: token deleted, item marked revoked, user notified in-app. Signature verification is what makes this path safe — today it is an unauthenticated deletion vector.

## Connection-time policy (unchanged, reaffirmed)

- Item cap per tier via entitlements (`max_plaid_items`; **TMM+ 3, TMM+ Pro 6, absolute safety ceiling 10** — decided 2026-07-03, see `04-billing-and-entitlements.md`) — the existing global `PLAID_ITEM_CAP=5` constant becomes per-tier entitlement rows.
- Weekly connection-velocity limit stays.
- Link-intent idempotency, duplicate-institution fingerprinting, MFA step-up before Plaid actions (D23) all stay as built.
- Webhook registration uses the stable `api.tmm.finance` URL (D19); existing dev items get `item/webhook/update` backfill when the domain goes live (WH-P2).

## Cost properties this policy guarantees

- No item bills Plaid for more than **grace (7d) + retention (30d) ≈ 37 days** past the last paid day.
- Orphaned tokens cannot accumulate: every path out of ACTIVE ends in REVOKED, and sweeps are scheduled, not manual.
- The Plaid dashboard billing alert (cost-control plan) plus a weekly item-count vs. paying-subscriber reconciliation catches drift.

## Privacy properties

- Access tokens exist only while they serve the user (active use or the 30-day restore window the user benefits from). This is the data-minimization story for the privacy policy and the Plaid questionnaire packet.
- Historical imported financial data belongs to the user's plan and is never deleted by lifecycle transitions — only by user-initiated deletion (D12/D24).

## Operational monitoring (Phase 5.6)

- Daily check: count of items in SUSPENDED past expiry (should be 0 after sweep), failed `itemRemove` retries, stuck sync jobs (WH-P5).
- Alert to founder on: sweep failures, revocation API errors, item count exceeding paying-subscriber-derived expectations.

## Test matrix (Phase 4.8)

| Scenario | Expected |
|---|---|
| Downgrade with 3 active items | All suspended same day; no new sync jobs; values frozen with staleness indicator |
| Resubscribe day 29 | Sync resumes without Link; catch-up sync runs |
| Resubscribe day 31 | Items revoked; user must re-link; history intact |
| User removes item while ACTIVE | Token deleted + `itemRemove` called (BUG-3 regression test) |
| Forged revocation webhook (no signature) | 401, no cleanup (SEC-1 test) |
| Account deletion with active items | Immediate revocation + full cascade, zero rows (Phase 4.12 test) |
