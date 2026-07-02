-- Migration 018: store institution name and id on plaid_tokens for display (e.g. "Truist" instead of item_id).
ALTER TABLE plaid_tokens
ADD COLUMN IF NOT EXISTS institution_id TEXT,
ADD COLUMN IF NOT EXISTS institution_name TEXT;

COMMENT ON COLUMN plaid_tokens.institution_id IS 'Plaid institution_id from Link success metadata (e.g. ins_123).';
COMMENT ON COLUMN plaid_tokens.institution_name IS 'Human-readable institution name from Link (e.g. Truist).';
