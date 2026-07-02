-- Add per-item cursor for Plaid /transactions/sync incremental updates
ALTER TABLE plaid_tokens
ADD COLUMN IF NOT EXISTS transactions_sync_cursor TEXT;

