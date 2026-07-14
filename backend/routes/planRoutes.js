// Plan persistence (Phase 2.2, ADR-1 / D14): Supabase is the authoritative
// source of truth for the plan document. Auth-only (all tiers persist plans).
// Handlers live in lib/planHandlers.js; supabaseAdmin (service role) is used,
// with strict RLS protecting the anon/browser path. Moved verbatim from
// server.js (Phase 2.9 router split).

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../supabaseClient.js';
import {
  createGetPlanHandler,
  createPutPlanHandler,
  createListPlanRevisionsHandler,
  createGetPlanRevisionHandler
} from '../lib/planHandlers.js';

const planRouteGuard = (req, res, next) => {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Plan persistence unavailable',
      message: 'Server is not configured with a Supabase service key.'
    });
  }
  next();
};

const router = express.Router();

router.get('/api/plan', requireAuth, planRouteGuard, createGetPlanHandler({ supabaseAdmin }));
router.put('/api/plan', requireAuth, planRouteGuard, createPutPlanHandler({ supabaseAdmin }));
router.get('/api/plan/revisions', requireAuth, planRouteGuard, createListPlanRevisionsHandler({ supabaseAdmin }));
router.get('/api/plan/revisions/:revisionId', requireAuth, planRouteGuard, createGetPlanRevisionHandler({ supabaseAdmin }));

export default router;
