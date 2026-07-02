-- TMM Backend Database Schema
-- Migration 008: One-time backfill of profiles and user_onboarding for existing auth.users
-- Safe to run multiple times (idempotent): only inserts where row is missing.
-- Run after 007 so new signups are covered by the trigger; this fixes users created before the trigger existed.

-- Backfill profiles (auth.users that have no public.profiles row)
INSERT INTO public.profiles (id, plan_tier)
SELECT u.id, 'free'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- Backfill user_onboarding (auth.users that have no public.user_onboarding row)
INSERT INTO public.user_onboarding (user_id)
SELECT u.id
FROM auth.users u
LEFT JOIN public.user_onboarding o ON o.user_id = u.id
WHERE o.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;
