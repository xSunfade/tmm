-- Migration 016: Add Stripe customer mapping to profiles
-- Used for Stripe Checkout + Billing Portal session creation and webhook user resolution.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

COMMENT ON COLUMN profiles.stripe_customer_id IS 'Stripe Customer ID for billing portal and webhook plan-tier updates';
