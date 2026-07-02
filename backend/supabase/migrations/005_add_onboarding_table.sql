-- TMM Backend Database Schema
-- Migration 005: Add user onboarding table for adaptive tour system
-- Stores survey responses, tour state, and completion tracking

-- Create user_onboarding table
CREATE TABLE IF NOT EXISTS user_onboarding (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Survey responses
  primary_goal TEXT, -- 'tracking', 'planning', 'optimization', 'experimentation'
  experience_level TEXT, -- 'beginner', 'intermediate', 'advanced'
  data_preference TEXT, -- 'manual', 'automated', 'hybrid'
  time_horizon TEXT, -- 'short_term', 'medium_term', 'long_term'
  
  -- Tour state
  onboarding_completed BOOLEAN DEFAULT FALSE,
  onboarding_scope JSONB, -- { included_modules: [...], deferred_modules: [...] }
  current_module_id TEXT,
  completed_modules JSONB DEFAULT '[]'::jsonb, -- Array of completed module IDs
  tour_version TEXT DEFAULT '1.0',
  
  -- Metadata
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_onboarding_user_id 
  ON user_onboarding(user_id);

-- Enable RLS on user_onboarding
ALTER TABLE user_onboarding ENABLE ROW LEVEL SECURITY;

-- RLS Policies for user_onboarding
-- Users can only access their own onboarding data

CREATE POLICY "Users can read own onboarding"
  ON user_onboarding FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own onboarding"
  ON user_onboarding FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own onboarding"
  ON user_onboarding FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own onboarding"
  ON user_onboarding FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can access all onboarding data (for backend operations)
CREATE POLICY "Service role full access to user_onboarding"
  ON user_onboarding FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_user_onboarding_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_onboarding_updated_at
  BEFORE UPDATE ON user_onboarding
  FOR EACH ROW
  EXECUTE FUNCTION update_user_onboarding_updated_at();
