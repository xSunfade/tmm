# Third-Party Risk Register (TMM)

Version: 1.0

| Vendor | Service | Data types | Owner | Risk notes | Review cadence |
|---|---|---|---|---|---|
| Plaid | Financial account aggregation and transactions | Account metadata, transactions, item linkage metadata | Engineering | OAuth and webhook reliability requirements; production checklist obligations | Quarterly |
| Supabase | Database, auth, storage | User profile data, linked account and transaction data, auth metadata | Engineering | RLS policy correctness and secret-key protection are critical | Quarterly |
| Hosting provider | App hosting and TLS termination | Application traffic and logs | Engineering | Enforce MFA and least-privilege admin access | Quarterly |
| Monitoring platform | Logging and alerting | Operational logs and metadata | Engineering | Ensure no sensitive token/PII leakage in logs | Quarterly |
