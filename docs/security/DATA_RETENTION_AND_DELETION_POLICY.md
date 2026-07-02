# Data Retention and Deletion Policy (TMM)

Version: 1.0  
Owner: Security Lead  
Review cadence: Quarterly

## 1. Retention schedule

- Plaid transactions (`transactions`): retained until user deletes account or disconnects data source.
- Account metadata (`accounts`, `plaid_tokens`, `plaid_item_status`): retained while connection is active.
- Webhook events (`plaid_webhook_events`): operational retention target 180 days.
- Sync run telemetry (`plaid_sync_runs`): operational retention target 180 days.
- Logs: retention determined by logging platform policy (default target 90 days unless legally required otherwise).

## 2. User-initiated deletion

When user confirms deletion using the in-app flow:

1. TMM calls Plaid `/item/remove` for linked items where access is available.
2. TMM deletes financial/account data and integration metadata.
3. TMM deletes the auth user record and related profile/onboarding data.

## 3. Evidence and auditability

- Deletion request is recorded in `data_deletion_requests`.
- Consent records are retained in `privacy_consents` until account deletion.
- Deletion outcomes are logged for operational verification.
