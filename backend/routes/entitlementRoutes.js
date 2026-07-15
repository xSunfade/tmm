// Entitlements, waitlist, and invites (Phase 4 — ADR-3, D1, D2).
//
//   GET  /api/entitlements        resolved tier + limits + subscription state (UI mirror)
//   GET  /api/signup-status       public: free signup open vs waitlist (soft cap, D1)
//   POST /api/waitlist            join the TMM+ waitlist (signed in)
//   POST /api/waitlist/free       join the free-overflow waitlist (email only, pre-account)
//   POST /api/invites/redeem      redeem an invite code -> unlocks TMM+ checkout (D2)
//   POST /api/admin/invites       issue invite codes (admin)
//   GET  /api/admin/waitlist      list waitlist entries (admin)

import crypto from 'crypto';
import express from 'express';
import { requireAuth, requireAdmin, getEntitlementsForUser } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { supabaseAdmin } from '../supabaseClient.js';
import { writeAuditLog } from '../lib/auditLog.js';

const signupStatusRateLimit = createRateLimiter({
  id: 'signup-status',
  windowMs: 60_000,
  max: Number(process.env.SIGNUP_STATUS_RATE_LIMIT_MAX || 60)
});

const waitlistJoinRateLimit = createRateLimiter({
  id: 'waitlist-join',
  windowMs: 60_000,
  max: Number(process.env.WAITLIST_RATE_LIMIT_MAX || 10)
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

async function getFreeSignupSettings() {
  const { data, error } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', 'free_signup')
    .maybeSingle();
  if (error) throw new Error(`Failed to load signup settings: ${error.message}`);
  const value = data?.value && typeof data.value === 'object' ? data.value : {};
  return {
    mode: value.mode === 'waitlist' ? 'waitlist' : 'open',
    softCap: Number.isFinite(Number(value.soft_cap)) && Number(value.soft_cap) > 0
      ? Number(value.soft_cap)
      : null
  };
}

/** D1: signup flips to waitlist when explicitly switched OR the soft cap is crossed. */
async function computeSignupMode() {
  const settings = await getFreeSignupSettings();
  if (settings.mode === 'waitlist') return 'waitlist';
  if (settings.softCap != null) {
    const { count, error } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true });
    if (error) throw new Error(`Failed to count profiles: ${error.message}`);
    if ((count || 0) >= settings.softCap) return 'waitlist';
  }
  return 'open';
}

async function userHasRedeemedInvite(userId) {
  const { data, error } = await supabaseAdmin
    .from('invites')
    .select('code, tier')
    .eq('redeemed_by', userId)
    .limit(1);
  if (error) throw new Error(`Failed to check invite: ${error.message}`);
  return data?.[0] || null;
}

async function getWaitlistEntry(userId) {
  const { data, error } = await supabaseAdmin
    .from('waitlist')
    .select('kind, status, created_at')
    .eq('user_id', userId)
    .eq('kind', 'tmm_plus')
    .maybeSingle();
  if (error) throw new Error(`Failed to load waitlist entry: ${error.message}`);
  return data || null;
}

const router = express.Router();

const adminGuard = (req, res, next) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Server is not configured with a Supabase service key.'
    });
  }
  next();
};

router.get('/api/entitlements', requireAuth, adminGuard, async (req, res, next) => {
  try {
    const resolved = await getEntitlementsForUser(req.userId);
    const [invite, waitlistEntry] = await Promise.all([
      userHasRedeemedInvite(req.userId),
      getWaitlistEntry(req.userId)
    ]);
    return res.json({
      tier: resolved.tier,
      is_admin: resolved.isAdmin,
      entitlements: {
        max_alternatives: resolved.entitlements.maxAlternatives,
        max_horizon_years: resolved.entitlements.maxHorizonYears,
        plaid_enabled: resolved.entitlements.plaidEnabled,
        max_plaid_items: resolved.entitlements.maxPlaidItems,
        extras: resolved.entitlements.extras
      },
      subscription: {
        status: resolved.subscription.status,
        current_period_end: resolved.subscription.currentPeriodEnd,
        grace_expires_at: resolved.subscription.graceExpiresAt,
        has_subscription: resolved.subscription.hasSubscription
      },
      invite: invite ? { redeemed: true, tier: invite.tier } : { redeemed: false, tier: null },
      waitlist: waitlistEntry ? { joined: true, status: waitlistEntry.status } : { joined: false, status: null }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/signup-status', signupStatusRateLimit, adminGuard, async (req, res, next) => {
  try {
    const mode = await computeSignupMode();
    return res.json({ mode });
  } catch (err) {
    next(err);
  }
});

router.post('/api/waitlist', requireAuth, adminGuard, waitlistJoinRateLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.user?.email);
    if (!email) {
      return res.status(400).json({ error: 'Account has no valid email address' });
    }
    const { error } = await supabaseAdmin
      .from('waitlist')
      .upsert(
        { user_id: req.userId, email, kind: 'tmm_plus', status: 'waiting' },
        { onConflict: 'kind,email', ignoreDuplicates: true }
      );
    if (error) throw new Error(`Failed to join waitlist: ${error.message}`);
    return res.json({ ok: true, kind: 'tmm_plus', status: 'waiting' });
  } catch (err) {
    next(err);
  }
});

// Free-overflow waitlist (D1): pre-account, email only, so it cannot require
// auth. Rate-limited; email format validated; duplicates no-op.
router.post('/api/waitlist/free', waitlistJoinRateLimit, adminGuard, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    const { error } = await supabaseAdmin
      .from('waitlist')
      .upsert(
        { user_id: null, email, kind: 'free_signup', status: 'waiting' },
        { onConflict: 'kind,email', ignoreDuplicates: true }
      );
    if (error) throw new Error(`Failed to join waitlist: ${error.message}`);
    return res.json({ ok: true, kind: 'free_signup', status: 'waiting' });
  } catch (err) {
    next(err);
  }
});

router.post('/api/invites/redeem', requireAuth, adminGuard, waitlistJoinRateLimit, async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code || code.length > 64) {
      return res.status(400).json({ error: 'Invite code is required', code: 'INVALID_INVITE' });
    }

    // Atomic single-use redemption: only an unredeemed, unexpired code flips.
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('invites')
      .update({ redeemed_by: req.userId, redeemed_at: nowIso })
      .eq('code', code)
      .is('redeemed_by', null)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .select('code, tier')
      .maybeSingle();
    if (error) throw new Error(`Failed to redeem invite: ${error.message}`);
    if (!data) {
      return res.status(400).json({
        error: 'Invalid or already-used invite code',
        code: 'INVALID_INVITE'
      });
    }

    await supabaseAdmin
      .from('waitlist')
      .update({ status: 'invited' })
      .eq('user_id', req.userId)
      .eq('kind', 'tmm_plus');

    await writeAuditLog({
      userId: req.userId,
      actor: 'user',
      action: 'invite.redeemed',
      resource: data.code,
      metadata: { tier: data.tier }
    });
    return res.json({ ok: true, tier: data.tier });
  } catch (err) {
    next(err);
  }
});

router.post('/api/admin/invites', requireAuth, requireAdmin, adminGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const tier = body.tier === 'tmm_pro' ? 'tmm_pro' : 'tmm_plus';
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 50);
    const expiresInDays = Number(body.expires_in_days);
    const expiresAt = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const rows = Array.from({ length: count }, () => ({
      code: `TMM-${crypto.randomBytes(6).toString('base64url')}`,
      tier,
      issued_by: req.userId,
      expires_at: expiresAt
    }));
    const { data, error } = await supabaseAdmin
      .from('invites')
      .insert(rows)
      .select('code, tier, expires_at');
    if (error) throw new Error(`Failed to create invites: ${error.message}`);

    await writeAuditLog({
      userId: req.userId,
      actor: 'admin',
      action: 'invite.issued',
      metadata: { tier, count }
    });
    return res.json({ ok: true, invites: data || [] });
  } catch (err) {
    next(err);
  }
});

router.get('/api/admin/waitlist', requireAuth, requireAdmin, adminGuard, async (req, res, next) => {
  try {
    const kind = req.query?.kind === 'free_signup' ? 'free_signup' : 'tmm_plus';
    const { data, error } = await supabaseAdmin
      .from('waitlist')
      .select('email, kind, status, created_at')
      .eq('kind', kind)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw new Error(`Failed to list waitlist: ${error.message}`);
    return res.json({ waitlist: data || [] });
  } catch (err) {
    next(err);
  }
});

export default router;
