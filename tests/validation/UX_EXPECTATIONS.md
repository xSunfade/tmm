# UX Expectations

This document defines correctness expectations for UI state against simulation and sync state.

## Required UX signals

- Sync in progress indicator must be visible during active sync.
- Last synced timestamp must update after successful sync.
- Failed sync must show explicit error state.
- Stale/connection-lost items must be visually distinct.
- Reconnect flow must preserve links and avoid confusing duplicates.
- Drift/reconciliation events must be visible to users.

## Currency and precision

- Displayed balances and node values must match computed cents exactly.
- Any mismatch of `$0.01` or more is a test failure.
- Tooltip breakdowns must sum to displayed totals.

## Covered by validation

- Playwright parity spec:
  - `tests/validation/scenarios/ux/ui-parity.playwright.spec.ts`
- Drift accountability:
  - `tests/validation/scenarios/drift/drift-forensics.test.ts`
- Chaos/idempotency:
  - `tests/validation/scenarios/plaid/chaos-idempotency.test.ts`
