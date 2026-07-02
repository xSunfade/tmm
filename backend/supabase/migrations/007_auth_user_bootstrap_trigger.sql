-- TMM Backend Database Schema
-- Migration 007: Auth signup bootstrap trigger
-- Ensures every new auth.users row gets public.profiles and public.user_onboarding rows.
-- Exactly ONE trigger on auth.users for this; idempotent inserts via ON CONFLICT DO NOTHING.

-- Drop any existing bootstrap-style trigger so we have exactly one
DROP TRIGGER IF EXISTS on_auth_user_created_bootstrap ON auth.users;

-- Function: idempotent bootstrap for new auth user
CREATE OR REPLACE FUNCTION public.handle_new_auth_user_bootstrap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- profiles row (required for plan_tier / Plaid gating)
  INSERT INTO public.profiles (id, plan_tier)
  VALUES (NEW.id, 'free')
  ON CONFLICT (id) DO NOTHING;

  -- user_onboarding row (for future sync; app currently uses localStorage)
  INSERT INTO public.user_onboarding (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_auth_user_bootstrap() IS
  'Runs after insert on auth.users; creates profiles and user_onboarding rows. Idempotent.';

-- Single bootstrap trigger
CREATE TRIGGER on_auth_user_created_bootstrap
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user_bootstrap();
