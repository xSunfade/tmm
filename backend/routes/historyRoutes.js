// Net-worth history endpoints (points, TMM per-alt points, reconciliation,
// manual archive). Moved verbatim from server.js (Phase 2.9 router split).

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery, schemas } from '../middleware/validation.js';
import { supabaseAdmin } from '../supabaseClient.js';
import {
  getCoverageForUser,
  getHistoryPoints,
  getHistoryTimezoneForUser,
  getReconciliationOverrides,
  mergePointsWithCheckpoints,
  stableAsOfDate,
  upsertReconciliationOverride
} from '../models/history.js';
import { incrementUsageCounter } from '../models/usageCounter.js';
import { getValidationResponse } from '../lib/validationMode.js';
import {
  buildForensics,
  createArchiveSnapshotForUser,
  deriveCoverageFromPoints,
  deriveNetWorthPointsFromSnapshots
} from '../lib/historyService.js';
import { dateToIsoDate, parseAltNamesFromValue, parseIsoTimestamp } from '../lib/serverUtils.js';

const HISTORY_TMM_WRITE_USER_HOURLY_MAX = Math.max(1, Number(process.env.HISTORY_TMM_WRITE_USER_HOURLY_MAX || 12));
const HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX = Math.max(1, Number(process.env.HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX || 10000));
const HISTORY_TMM_WRITE_GLOBAL_USER_ID = String(process.env.HISTORY_TMM_WRITE_GLOBAL_USER_ID || '').trim();

const router = express.Router();

// Read historical net-worth points (Plaid live/archive + optional checkpoint merge).
router.get('/api/history/net-worth', requireAuth, validateQuery(schemas.historyNetWorthQuery), async (req, res, next) => {
  try {
    const validation = await getValidationResponse('GET', '/api/history/net-worth', req);
    if (validation) {
      if (String(req.query.forensics || '').toLowerCase() === 'true') {
        return res.json({ ...validation, forensics: buildForensics(validation.points) });
      }
      return res.json(validation);
    }
    const userId = req.userId;
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;

    let points = await getHistoryPoints(userId, startDate, endDate);
    if (!points.length) {
      points = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
    }

    const tokenCoverage = await getCoverageForUser(userId);
    const fallbackCoverage = deriveCoverageFromPoints(points);
    const coverage = {
      earliest: tokenCoverage.earliest || fallbackCoverage.earliest || null,
      latest: tokenCoverage.latest || fallbackCoverage.latest || null
    };
    const overrides = await getReconciliationOverrides(userId, startDate, endDate);
    const merged = mergePointsWithCheckpoints({
      points,
      checkpoints: [],
      coverage,
      overrides
    });

    const payload = {
      points: merged,
      coverage,
      as_of_rule: 'end_of_day_utc'
    };
    if (String(req.query.forensics || '').toLowerCase() === 'true') {
      payload.forensics = buildForensics(merged);
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Option B from plan: frontend sends checkpoints so backend can reconcile/merge.
router.post('/api/history/net-worth', requireAuth, validateBody(schemas.historyNetWorthBody), async (req, res, next) => {
  try {
    const validation = await getValidationResponse('POST', '/api/history/net-worth', req);
    if (validation) {
      if (String(req.query.forensics || '').toLowerCase() === 'true' || req.body?.forensics === true) {
        return res.json({ ...validation, forensics: buildForensics(validation.points) });
      }
      return res.json(validation);
    }
    const userId = req.userId;
    const body = req.body || {};
    const startDate = body.start_date || null;
    const endDate = body.end_date || null;
    const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
    const threshold = Number.isFinite(Number(body.threshold))
      ? Number(body.threshold)
      : 250;

    let points = await getHistoryPoints(userId, startDate, endDate);
    if (!points.length) {
      points = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
    }
    const tokenCoverage = await getCoverageForUser(userId);
    const fallbackCoverage = deriveCoverageFromPoints(points);
    const coverage = {
      earliest: tokenCoverage.earliest || fallbackCoverage.earliest || null,
      latest: tokenCoverage.latest || fallbackCoverage.latest || null
    };
    const overrides = await getReconciliationOverrides(userId, startDate, endDate);
    const merged = mergePointsWithCheckpoints({
      points,
      checkpoints,
      threshold,
      coverage,
      overrides
    });

    const payload = {
      points: merged,
      coverage,
      threshold,
      as_of_rule: 'end_of_day_utc'
    };
    if (String(req.query.forensics || '').toLowerCase() === 'true' || req.body?.forensics === true) {
      payload.forensics = buildForensics(merged);
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Read TMM-total net worth points per alternative (manual + connected, per alt/day).
router.get('/api/history/net-worth/tmm', requireAuth, validateQuery(schemas.historyNetWorthTmmQuery), async (req, res, next) => {
  try {
    const userId = req.userId;
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;
    const altNames = parseAltNamesFromValue(req.query.alt_names);

    let query = supabaseAdmin
      .from('net_worth_points_alt')
      .select('alt,point_date,net_worth,source,confidence')
      .eq('user_id', userId)
      .order('point_date', { ascending: true });
    if (startDate) query = query.gte('point_date', startDate);
    if (endDate) query = query.lte('point_date', endDate);
    if (altNames.length) query = query.in('alt', altNames);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load TMM net worth history points: ${error.message}`);
    }

    const tokenCoverage = await getCoverageForUser(userId);
    const points = (data || []).map((row) => ({
      alt: row.alt,
      date: row.point_date,
      value: Number(row.net_worth || 0),
      source: row.source || 'tmm_total',
      confidence: row.confidence || 'high',
      reconciled: false,
      needsReview: false
    }));

    // Backward compatibility: if per-alt points do not exist yet, fan out legacy points.
    if (!points.length && altNames.length) {
      let legacyPoints = await getHistoryPoints(userId, startDate, endDate);
      if (!legacyPoints.length) {
        legacyPoints = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
      }
      const fallback = altNames.flatMap((alt) =>
        (legacyPoints || []).map((p) => ({
          alt,
          date: p.point_date,
          value: Number(p.net_worth || 0),
          source: p.source || 'plaid_archived',
          confidence: p.confidence || 'high',
          reconciled: !!p.reconciled,
          needsReview: false
        }))
      );
      return res.json({
        points: fallback,
        coverage: tokenCoverage,
        as_of_rule: 'end_of_day_utc'
      });
    }

    return res.json({
      points,
      coverage: tokenCoverage,
      as_of_rule: 'end_of_day_utc'
    });
  } catch (err) {
    next(err);
  }
});

// Upsert TMM-total net worth points per alternative for today's history point.
router.post('/api/history/net-worth/tmm', requireAuth, validateBody(schemas.historyNetWorthTmmUpsertBody), async (req, res, next) => {
  try {
    const userId = req.userId;
    const body = req.body || {};
    const inputPoints = Array.isArray(body.points) ? body.points : [];
    if (!inputPoints.length) {
      return res.status(400).json({ error: 'points is required' });
    }

    const userQuota = await incrementUsageCounter({
      metric: 'history_tmm_write_user_hourly',
      userId,
      itemId: null,
      windowSeconds: 3600,
      max: HISTORY_TMM_WRITE_USER_HOURLY_MAX
    });
    if (!userQuota.allowed) {
      return res.status(429).json({
        error: 'Hourly TMM history write quota exceeded',
        count: userQuota.count,
        bucket_start: userQuota.bucket_start
      });
    }

    if (HISTORY_TMM_WRITE_GLOBAL_USER_ID) {
      const globalQuota = await incrementUsageCounter({
        metric: 'history_tmm_write_global_hourly',
        userId: HISTORY_TMM_WRITE_GLOBAL_USER_ID,
        itemId: null,
        windowSeconds: 3600,
        max: HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX
      });
      if (!globalQuota.allowed) {
        return res.status(429).json({
          error: 'Global TMM history write quota exceeded',
          count: globalQuota.count,
          bucket_start: globalQuota.bucket_start
        });
      }
    }

    const timezone = await getHistoryTimezoneForUser(userId);
    const requestedAsOf = body.as_of ? parseIsoTimestamp(body.as_of) : null;
    const asOf = stableAsOfDate({ now: requestedAsOf || new Date(), timezone });
    const pointDate = dateToIsoDate(asOf);

    const byAlt = new Map();
    for (const point of inputPoints) {
      const alt = String(point.alt || '').trim();
      if (!alt) continue;
      byAlt.set(alt, Number(point.net_worth || 0));
    }
    if (!byAlt.size) {
      return res.status(400).json({ error: 'At least one valid alt point is required' });
    }

    const rows = Array.from(byAlt.entries()).map(([alt, netWorth]) => ({
      user_id: userId,
      alt,
      point_date: pointDate,
      net_worth: netWorth,
      source: 'tmm_total',
      confidence: 'high',
      metadata: {
        trigger: 'sync_completion',
        as_of: asOf.toISOString()
      }
    }));

    const { data, error } = await supabaseAdmin
      .from('net_worth_points_alt')
      .upsert(rows, { onConflict: 'user_id,alt,point_date', ignoreDuplicates: false })
      .select('alt,point_date,net_worth');
    if (error) {
      throw new Error(`Failed to upsert TMM net worth history points: ${error.message}`);
    }

    res.json({
      ok: true,
      point_date: pointDate,
      upserted_count: rows.length,
      points: data || []
    });
  } catch (err) {
    next(err);
  }
});

// Reconciliation choice endpoint.
router.post(
  '/api/history/reconciliation',
  requireAuth,
  validateBody(schemas.historyReconciliationBody),
  async (req, res, next) => {
  try {
    const validation = await getValidationResponse('POST', '/api/history/reconciliation', req);
    if (validation) return res.json(validation);
    const userId = req.userId;
    const {
      point_date,
      chosen_source,
      checkpoint_value,
      plaid_value,
      reason
    } = req.body || {};
    if (!point_date || !chosen_source) {
      return res.status(400).json({ error: 'point_date and chosen_source are required' });
    }
    if (!['checkpoint', 'plaid'].includes(chosen_source)) {
      return res.status(400).json({ error: "chosen_source must be 'checkpoint' or 'plaid'" });
    }

    const override = await upsertReconciliationOverride({
      userId,
      pointDate: String(point_date).slice(0, 10),
      chosenSource: chosen_source,
      checkpointValue: checkpoint_value,
      plaidValue: plaid_value,
      reason: reason || null
    });

    const valueToUse = chosen_source === 'checkpoint'
      ? Number(checkpoint_value || 0)
      : Number(plaid_value || 0);
    const sourceToUse = chosen_source === 'checkpoint'
      ? 'checkpoint_user'
      : 'plaid_live';
    await supabaseAdmin
      .from('net_worth_points')
      .upsert({
        user_id: userId,
        point_date: String(point_date).slice(0, 10),
        net_worth: valueToUse,
        source: sourceToUse,
        confidence: 'high',
        reconciled: true,
        override_id: override.id
      }, { onConflict: 'user_id,point_date', ignoreDuplicates: false });

    res.json({ ok: true, override });
  } catch (err) {
    next(err);
  }
});

// Manual archive trigger (useful for tier transitions/admin workflows).
router.post('/api/history/archive', requireAuth, validateBody(schemas.historyArchiveBody), async (req, res, next) => {
  try {
    const userId = req.userId;
    const { use_month_end } = req.body || {};
    const snapshot = await createArchiveSnapshotForUser(userId, {
      useMonthEnd: !!use_month_end,
      pointSource: 'plaid_archived',
      metadata: { trigger: 'manual_archive' },
      forceArchive: true
    });
    res.json({ ok: true, snapshot });
  } catch (err) {
    next(err);
  }
});

export default router;
