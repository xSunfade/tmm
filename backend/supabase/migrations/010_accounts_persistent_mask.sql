-- Add Plaid stable identifiers to accounts for reconnect account-id mapping.
-- persistent_account_id: stable across re-link (Plaid; currently Chase only).
-- mask: last 2-4 digits of account number for fallback matching.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS persistent_account_id TEXT,
  ADD COLUMN IF NOT EXISTS mask TEXT;

COMMENT ON COLUMN accounts.persistent_account_id IS 'Plaid persistent_account_id when available (e.g. Chase); used to match accounts after re-link.';
COMMENT ON COLUMN accounts.mask IS 'Last 2-4 alphanumeric characters of account number from Plaid; used for fallback matching on reconnect.';
