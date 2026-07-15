// Privacy consent, account deletion (D12/D17), and account-level MFA factor
// management. Moved verbatim from server.js (Phase 2.9 router split).

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, schemas } from '../middleware/validation.js';
import { supabaseAdmin } from '../supabaseClient.js';
import { plaidClient } from '../plaidClient.js';
import { getToken, removeToken, listItemIdsForUser } from '../tokenStore.js';
import {
  createDeletionRequest,
  CURRENT_PRIVACY_POLICY_VERSION,
  failDeletionRequest,
  getLatestConsent,
  PLAID_CONSENT_TYPE,
  recordPrivacyConsent,
  completeDeletionRequest
} from '../models/privacy.js';
import { writeAuditLog } from '../lib/auditLog.js';

/** Decode the (already validated by requireAuth) JWT's claims for AAL checks. */
function getJwtClaims(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function bestEffortDeleteByUser(table, userId) {
  try {
    const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
    if (error && !String(error.message || '').toLowerCase().includes('does not exist')) {
      throw error;
    }
  } catch (err) {
    const message = err?.message || '';
    if (!String(message).toLowerCase().includes('does not exist')) {
      throw err;
    }
  }
}

const router = express.Router();

router.get('/api/privacy/consent-status', requireAuth, async (req, res, next) => {
  try {
    const latest = await getLatestConsent(req.userId, PLAID_CONSENT_TYPE);
    const hasAcceptedOlderVersion =
      !!latest &&
      latest.accepted === true &&
      latest.policy_version !== CURRENT_PRIVACY_POLICY_VERSION;
    const accepted =
      !!latest &&
      latest.accepted === true &&
      latest.policy_version === CURRENT_PRIVACY_POLICY_VERSION;
    res.json({
      consent_type: PLAID_CONSENT_TYPE,
      policy_version: CURRENT_PRIVACY_POLICY_VERSION,
      accepted,
      requires_reconsent: hasAcceptedOlderVersion,
      latest
    });
  } catch (err) {
    next(err);
  }
});

router.post('/api/privacy/consent', requireAuth, validateBody(schemas.privacyConsentBody), async (req, res, next) => {
  try {
    const consent = await recordPrivacyConsent({
      userId: req.userId,
      consentType: req.body.consent_type,
      policyVersion: req.body.policy_version,
      accepted: req.body.accepted,
      metadata: { source: 'frontend' }
    });
    res.json({ ok: true, consent });
  } catch (err) {
    next(err);
  }
});

router.post('/api/privacy/delete-account', requireAuth, validateBody(schemas.deleteAccountBody), async (req, res, next) => {
  const userId = req.userId;
  const confirmText = String(req.body.confirm_text || '').trim().toUpperCase();
  if (confirmText !== 'DELETE MY DATA') {
    return res.status(400).json({ error: "confirm_text must be exactly 'DELETE MY DATA'" });
  }

  let deletionRequest = null;
  try {
    deletionRequest = await createDeletionRequest(userId, {
      reason: req.body.reason || null,
      requested_via: 'api'
    });

    const itemIds = await listItemIdsForUser(userId);
    for (const itemId of itemIds) {
      try {
        const accessToken = await getToken(itemId, userId);
        await plaidClient.itemRemove({ access_token: accessToken });
      } catch (err) {
        console.warn(`[privacy] Plaid item/remove failed for ${itemId}:`, err?.message || err);
      }
      try {
        await removeToken(itemId, userId);
      } catch (err) {
        console.warn(`[privacy] removeToken failed for ${itemId}:`, err?.message || err);
      }
    }

    await Promise.all([
      bestEffortDeleteByUser('privacy_consents', userId),
      bestEffortDeleteByUser('plaid_webhook_events', userId),
      bestEffortDeleteByUser('plaid_item_status', userId),
      bestEffortDeleteByUser('plaid_sync_runs', userId),
      bestEffortDeleteByUser('plaid_sync_jobs', userId),
      bestEffortDeleteByUser('plaid_connection_events', userId),
      bestEffortDeleteByUser('plaid_link_intents', userId),
      bestEffortDeleteByUser('usage_counters', userId),
      bestEffortDeleteByUser('history_reconciliation_overrides', userId),
      bestEffortDeleteByUser('net_worth_points', userId),
      bestEffortDeleteByUser('net_worth_points_alt', userId),
      bestEffortDeleteByUser('account_balance_snapshots', userId),
      bestEffortDeleteByUser('transactions', userId),
      bestEffortDeleteByUser('accounts', userId),
      bestEffortDeleteByUser('plaid_tokens', userId),
      bestEffortDeleteByUser('google_sheets_tokens', userId),
      bestEffortDeleteByUser('user_onboarding', userId),
      bestEffortDeleteByUser('plans', userId),
      bestEffortDeleteByUser('plan_revisions', userId),
      // Phase 4 tables (D24: immediate deletion; FK cascade is the backstop).
      bestEffortDeleteByUser('waitlist', userId),
      bestEffortDeleteByUser('oauth_states', userId),
      bestEffortDeleteByUser('audit_log', userId),
      bestEffortDeleteByUser('profiles', userId)
    ]);

    // Legacy table from early schema migration (best effort).
    try {
      await supabaseAdmin.from('users').delete().eq('id', userId);
    } catch (_) {
      // Ignore missing legacy table.
    }

    if (deletionRequest?.id) {
      await completeDeletionRequest(deletionRequest.id);
    }
    // Final auth user deletion (cascades remaining auth-scoped rows).
    await supabaseAdmin.auth.admin.deleteUser(userId);

    // Compliance trace (user_id null so it survives the cascade; the id
    // string in resource is required to evidence D24 processing).
    await writeAuditLog({
      userId: null,
      actor: 'user',
      action: 'privacy.account_deleted',
      resource: userId,
      metadata: {}
    });

    res.json({ ok: true, deleted: true });
  } catch (err) {
    if (deletionRequest?.id) {
      try {
        await failDeletionRequest(deletionRequest.id, err?.message || 'unknown deletion error');
      } catch (statusErr) {
        console.error('[privacy] Failed to set deletion request failure status:', statusErr?.message || statusErr);
      }
    }
    next(err);
  }
});

router.post(
  '/api/auth/mfa/remove-factor',
  requireAuth,
  validateBody(schemas.mfaRemoveFactorBody),
  async (req, res, next) => {
    try {
      if (!supabaseAdmin) {
        return res.status(503).json({
          error: 'Service unavailable',
          message: 'MFA management is not available'
        });
      }
      const userId = req.userId;
      const factorId = req.body.factor_id;

      // Phase 4.11 / D23: removing a VERIFIED factor is a credential change
      // and requires a step-up (AAL2) session — otherwise a stolen aal1
      // session could strip the account's MFA. Unverified (half-enrolled)
      // factors can be cleaned up at aal1.
      const { data: factorsData, error: factorsError } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId });
      if (factorsError) {
        return res.status(500).json({
          error: 'Failed to check MFA factors',
          message: factorsError.message
        });
      }
      const factors = factorsData?.factors || [];
      const target = factors.find((f) => f.id === factorId) || null;
      if (target && target.status === 'verified') {
        const claims = getJwtClaims(req);
        if (claims?.aal !== 'aal2') {
          return res.status(403).json({
            error: 'Step-up verification required',
            message: 'Verify with your authenticator before removing it.',
            code: 'STEP_UP_REQUIRED'
          });
        }
      }

      const { data, error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: factorId,
        userId
      });
      if (error) {
        return res.status(400).json({
          error: 'Failed to remove MFA factor',
          message: error.message
        });
      }
      await writeAuditLog({
        userId,
        actor: 'user',
        action: 'auth.mfa_factor_removed',
        resource: factorId,
        metadata: { was_verified: target?.status === 'verified' }
      });
      res.json({ ok: true, removed: data?.id ?? factorId });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
