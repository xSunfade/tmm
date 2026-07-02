-- Migration 013: Plaid webhook durability + item status tracking

CREATE TABLE IF NOT EXISTS plaid_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_hash TEXT NOT NULL UNIQUE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id TEXT,
  webhook_type TEXT,
  webhook_code TEXT,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed', 'duplicate')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plaid_webhook_events_item_created
  ON plaid_webhook_events(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaid_webhook_events_user_created
  ON plaid_webhook_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS plaid_item_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  needs_update_mode BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT,
  last_webhook_type TEXT,
  last_webhook_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_webhook_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_plaid_item_status_user_item
  ON plaid_item_status(user_id, item_id);

CREATE TRIGGER update_plaid_item_status_updated_at BEFORE UPDATE ON plaid_item_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE plaid_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE plaid_item_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON plaid_webhook_events FOR ALL USING (true);
CREATE POLICY "Service role full access" ON plaid_item_status FOR ALL USING (true);
