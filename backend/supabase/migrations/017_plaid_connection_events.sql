-- Migration 017: Plaid connection event tracking for cap/velocity guardrails

CREATE TABLE IF NOT EXISTS plaid_connection_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connect', 'disconnect')),
  connection_type TEXT NOT NULL CHECK (connection_type IN ('new', 'reconnect', 'update')),
  institution_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plaid_connection_events_user_created
  ON plaid_connection_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plaid_connection_events_user_type_created
  ON plaid_connection_events(user_id, event_type, connection_type, created_at DESC);

ALTER TABLE plaid_connection_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON plaid_connection_events FOR ALL USING (true);
