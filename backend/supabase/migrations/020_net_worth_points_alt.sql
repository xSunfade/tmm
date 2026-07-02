-- Migration 020: per-alt TMM net worth history points
-- Stores daily total net worth per alternative (manual + connected as represented in plan state).

CREATE TABLE IF NOT EXISTS net_worth_points_alt (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alt TEXT NOT NULL,
  point_date DATE NOT NULL,
  net_worth NUMERIC(15, 2) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('tmm_total', 'manual', 'plaid_live', 'plaid_archived')),
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'med', 'low')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, alt, point_date)
);

CREATE INDEX IF NOT EXISTS idx_net_worth_points_alt_user_alt_date
  ON net_worth_points_alt(user_id, alt, point_date DESC);

CREATE INDEX IF NOT EXISTS idx_net_worth_points_alt_user_date
  ON net_worth_points_alt(user_id, point_date DESC);

CREATE TRIGGER update_net_worth_points_alt_updated_at
  BEFORE UPDATE ON net_worth_points_alt
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE net_worth_points_alt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON net_worth_points_alt FOR ALL USING (true);

