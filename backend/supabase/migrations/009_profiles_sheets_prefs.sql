-- Migration 009: Add sheets preferences to profiles (persist across devices / Clear All Data)
-- sheets_nudge_dismissed: user dismissed "Connect Google Sheets" nudge
-- last_spreadsheet_id: last chosen spreadsheet id for resume after clear or new device

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sheets_nudge_dismissed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_spreadsheet_id TEXT;

COMMENT ON COLUMN profiles.sheets_nudge_dismissed IS 'User dismissed Connect Google Sheets nudge; syncs across devices';
COMMENT ON COLUMN profiles.last_spreadsheet_id IS 'Last used Google Sheet id for resume after clear or new device';
