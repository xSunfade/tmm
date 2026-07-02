-- TMM Backend Database Schema
-- Migration 002: Add explicit deny policies for anon key
-- This prevents silent failures when anon key is accidentally used from frontend

-- Explicitly deny anon key access (fail loudly, not silently)
-- These policies ensure that if anon key is used, it will get an explicit error
-- rather than silently returning empty results

CREATE POLICY "Anon users cannot access users" 
  ON users FOR ALL 
  TO anon 
  USING (false) 
  WITH CHECK (false);

CREATE POLICY "Anon users cannot access plaid_tokens" 
  ON plaid_tokens FOR ALL 
  TO anon 
  USING (false) 
  WITH CHECK (false);

CREATE POLICY "Anon users cannot access accounts" 
  ON accounts FOR ALL 
  TO anon 
  USING (false) 
  WITH CHECK (false);

CREATE POLICY "Anon users cannot access transactions" 
  ON transactions FOR ALL 
  TO anon 
  USING (false) 
  WITH CHECK (false);

-- Note: Service role policies from migration 001 remain in effect
-- These anon policies are additive and ensure explicit denial for anon users
