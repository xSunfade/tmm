# Plaid Resilience Rollout

Use staged rollout to reduce risk.

## Feature Flags

- `PLAID_EXCHANGE_REQUIRE_LINK_INTENT=true`
- `PLAID_SYNC_USE_QUEUE=true`
- `PLAID_SYNC_USE_RPC_APPLY=true`
- `RUN_PLAID_WORKER=true`

## Recommended Sequence

1. Apply DB migration `015_plaid_resilience_primitives.sql`.
2. Deploy backend with all new code, but set:
   - `PLAID_EXCHANGE_REQUIRE_LINK_INTENT=false`
   - `PLAID_SYNC_USE_QUEUE=false`
   - `PLAID_SYNC_USE_RPC_APPLY=false`
3. Deploy frontend (sends `link_intent_id`, CAPTCHA token support).
4. Enable `PLAID_EXCHANGE_REQUIRE_LINK_INTENT=true`.
5. Enable queue/worker:
   - `PLAID_SYNC_USE_QUEUE=true`
   - `RUN_PLAID_WORKER=true`
6. Enable atomic apply:
   - `PLAID_SYNC_USE_RPC_APPLY=true`
7. Monitor `/api/ops/plaid/health`, `/api/ops/plaid/jobs`, `/api/ops/plaid/breaker`.

## Rollback

- If queue issues occur, set `PLAID_SYNC_USE_QUEUE=false` to use direct sync path.
- If RPC apply issues occur, set `PLAID_SYNC_USE_RPC_APPLY=false` (keeps queue path but applies old write path).
- If exchange idempotency causes client friction, temporarily set `PLAID_EXCHANGE_REQUIRE_LINK_INTENT=false`.

