-- TMM Backend Database Schema
-- Migration 004: Add Google Sheets tokens table with user authentication
-- This associates Google API tokens with authenticated TMM users from auth.users

-- Create google_sheets_tokens table
CREATE TABLE IF NOT EXISTS google_sheets_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL, -- Encrypted token
  refresh_token TEXT, -- Encrypted refresh token (optional)
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  google_user_id TEXT,
  google_user_email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_google_sheets_tokens_user_id 
  ON google_sheets_tokens(user_id);

-- Enable RLS on google_sheets_tokens
ALTER TABLE google_sheets_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policies for google_sheets_tokens
-- Users can only access their own tokens

CREATE POLICY "Users can read own Google tokens"
  ON google_sheets_tokens FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own Google tokens"
  ON google_sheets_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own Google tokens"
  ON google_sheets_tokens FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own Google tokens"
  ON google_sheets_tokens FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can access all tokens (for backend operations)
CREATE POLICY "Service role full access to google_sheets_tokens"
  ON google_sheets_tokens FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_google_sheets_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_google_sheets_tokens_updated_at
  BEFORE UPDATE ON google_sheets_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_google_sheets_tokens_updated_at();

-- Note: This migration requires Supabase Auth to be enabled
-- The auth.users table is automatically created by Supabase Auth
-- Make sure to run this migration after enabling Supabase Auth
