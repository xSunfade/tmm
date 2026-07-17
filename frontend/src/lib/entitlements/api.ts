// Client for GET /api/entitlements (Phase 4): the UI mirror of the server's
// table-driven entitlement resolution. Server middleware remains the actual
// enforcement; this exists for banners, prompts, and limit-aware controls.

import { authFetch } from '../api/authFetch';
import type { PlanTier } from './tier';

export type EntitlementsResponse = {
  tier: PlanTier;
  is_admin: boolean;
  entitlements: {
    max_alternatives: number | null;
    max_horizon_years: number | null;
    plaid_enabled: boolean;
    max_plaid_items: number;
    extras: Record<string, unknown>;
  };
  subscription: {
    status: string | null;
    current_period_end: string | null;
    grace_expires_at: string | null;
    has_subscription: boolean;
  };
  invite: { redeemed: boolean; tier: PlanTier | null };
  waitlist: { joined: boolean; status: string | null };
};

export async function fetchEntitlements(): Promise<EntitlementsResponse | null> {
  try {
    return (await authFetch('/api/entitlements', { method: 'GET' })) as EntitlementsResponse;
  } catch (error) {
    console.warn('[entitlements] Failed to load entitlements', error);
    return null;
  }
}

export async function joinTmmPlusWaitlist(): Promise<boolean> {
  try {
    await authFetch('/api/waitlist', { method: 'POST', body: JSON.stringify({}) });
    return true;
  } catch (error) {
    console.warn('[entitlements] Failed to join waitlist', error);
    return false;
  }
}

export async function redeemInviteCode(code: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await authFetch('/api/invites/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    return { ok: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      return { ok: false, message: parsed.error || 'Invite code could not be redeemed' };
    } catch {
      return { ok: false, message: 'Invite code could not be redeemed' };
    }
  }
}
