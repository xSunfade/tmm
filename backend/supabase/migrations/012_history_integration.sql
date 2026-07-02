-- Migration 012: history integration foundation
-- Adds ledger snapshots, precomputed net worth points, reconciliation overrides,
-- Plaid sync run idempotency logs, and data-driven Plaid coverage bounds.

-- Stable "as-of" preference for history point generation.
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS history_timezone TEXT DEFAULT 'UTC';

COMMENT ON COLUMN profiles.history_timezone IS 'IANA timezone used for stable history cutoff (default UTC).';

-- Track observed Plaid transaction coverage per item.
ALTER TABLE plaid_tokens
ADD COLUMN IF NOT EXISTS earliest_txn_date_seen DATE,
ADD COLUMN IF NOT EXISTS latest_txn_date_seen DATE;

COMMENT ON COLUMN plaid_tokens.earliest_txn_date_seen IS 'Earliest transaction date observed for this Plaid item from sync/get.';
COMMENT ON COLUMN plaid_tokens.latest_txn_date_seen IS 'Latest transaction date observed for this Plaid item from sync/get.';

-- Thin deterministic ledger archive: account balances at a stable cut.
CREATE TABLE IF NOT EXISTS account_balance_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of TIMESTAMP WITH TIME ZONE NOT NULL,
  balance NUMERIC(15, 2) NOT NULL,
  available NUMERIC(15, 2),
  currency_code TEXT DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'plaid',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(account_id, as_of)
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user_asof ON account_balance_snapshots(user_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_asof ON account_balance_snapshots(account_id, as_of DESC);

-- Precomputed chart points (performance + deterministic output).
CREATE TABLE IF NOT EXISTS net_worth_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  point_date DATE NOT NULL,
  net_worth NUMERIC(15, 2) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('plaid_live', 'plaid_archived', 'checkpoint_user', 'checkpoint_auto', 'manual')),
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'med', 'low')),
  reconciled BOOLEAN NOT NULL DEFAULT FALSE,
  override_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, point_date)
);

CREATE INDEX IF NOT EXISTS idx_net_worth_points_user_date ON net_worth_points(user_id, point_date DESC);
CREATE INDEX IF NOT EXISTS idx_net_worth_points_source ON net_worth_points(source);

-- User decisions when checkpoint and Plaid disagree.
CREATE TABLE IF NOT EXISTS history_reconciliation_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  point_date DATE NOT NULL,
  chosen_source TEXT NOT NULL CHECK (chosen_source IN ('plaid', 'checkpoint')),
  checkpoint_value NUMERIC(15, 2),
  plaid_value NUMERIC(15, 2),
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, point_date)
);

CREATE INDEX IF NOT EXISTS idx_history_overrides_user_date ON history_reconciliation_overrides(user_id, point_date DESC);

-- Sync run log for idempotency/observability.
CREATE TABLE IF NOT EXISTS plaid_sync_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_run_id UUID NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cursor_before TEXT,
  cursor_after TEXT,
  added_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  upserted_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  skipped_unmapped_accounts INTEGER NOT NULL DEFAULT 0,
  backfill_start_date DATE,
  backfill_end_date DATE,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_plaid_sync_runs_item_started ON plaid_sync_runs(item_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaid_sync_runs_user_started ON plaid_sync_runs(user_id, started_at DESC);

-- Wire override FK now that both tables exist.
ALTER TABLE net_worth_points
ADD CONSTRAINT fk_net_worth_override
FOREIGN KEY (override_id) REFERENCES history_reconciliation_overrides(id) ON DELETE SET NULL;

-- updated_at triggers.
CREATE TRIGGER update_account_balance_snapshots_updated_at BEFORE UPDATE ON account_balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_net_worth_points_updated_at BEFORE UPDATE ON net_worth_points
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_history_overrides_updated_at BEFORE UPDATE ON history_reconciliation_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS + service role policies to match existing pattern.
ALTER TABLE account_balance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE net_worth_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_reconciliation_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE plaid_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON account_balance_snapshots FOR ALL USING (true);
CREATE POLICY "Service role full access" ON net_worth_points FOR ALL USING (true);
CREATE POLICY "Service role full access" ON history_reconciliation_overrides FOR ALL USING (true);
CREATE POLICY "Service role full access" ON plaid_sync_runs FOR ALL USING (true);
