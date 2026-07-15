// Server-side plan persistence handlers (Phase 2.2, ADR-1 / D14).
//
// The plan is a versioned jsonb document, one row per user in `plans`, with a
// rolling revision history in `plan_revisions` (newest REVISION_KEEP pruned on
// insert). Handlers are factories with injected deps so they unit-test without
// a live Supabase (same pattern as plaidItemHandlers.js).

export const PLAN_SIZE_WARN_BYTES = 1 * 1024 * 1024; // warn at 1 MB (D14)
export const PLAN_SIZE_MAX_BYTES = 5 * 1024 * 1024; // reject above 5 MB (D14)
export const PLAN_REVISION_KEEP = 20; // rolling revisions per user (D14)

// 2.0 stays accepted so pre-v3 clients/offline caches can still save (D14).
export const SUPPORTED_PLAN_SCHEMA_VERSIONS = new Set(['2.0', '3.0']);

const REVISION_REASONS = new Set(['save', 'pre_import', 'pre_migration', 'manual']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Insert a revision row, then prune to the newest `keep` revisions for the user.
 * Prune failures are non-fatal (the retention sweep is a backstop).
 */
export async function insertPlanRevision(supabaseAdmin, {
  userId,
  plan,
  schemaVersion,
  sizeBytes,
  reason,
  clientSavedAt,
  keep = PLAN_REVISION_KEEP,
  logger = console
}) {
  const { error: insertError } = await supabaseAdmin
    .from('plan_revisions')
    .insert({
      user_id: userId,
      plan,
      schema_version: schemaVersion,
      size_bytes: sizeBytes,
      reason,
      client_saved_at: clientSavedAt ?? null
    });
  if (insertError) {
    throw new Error(`Failed to insert plan revision: ${insertError.message}`);
  }

  const { data: staleRows, error: staleError } = await supabaseAdmin
    .from('plan_revisions')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(keep, keep + 100);
  if (staleError) {
    logger.warn?.('[plan] Failed to look up stale revisions for pruning', staleError.message);
    return;
  }
  const staleIds = (staleRows || []).map((row) => row.id);
  if (staleIds.length === 0) return;
  const { error: deleteError } = await supabaseAdmin
    .from('plan_revisions')
    .delete()
    .in('id', staleIds);
  if (deleteError) {
    logger.warn?.('[plan] Failed to prune stale plan revisions', deleteError.message);
  }
}

export function createGetPlanHandler({ supabaseAdmin }) {
  return async function getPlanHandler(req, res, next) {
    try {
      const { data, error } = await supabaseAdmin
        .from('plans')
        .select('plan, schema_version, size_bytes, client_saved_at, updated_at')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (error) {
        return res.status(500).json({ error: 'Failed to load plan', message: error.message });
      }
      if (!data) {
        return res.status(200).json({ plan: null });
      }
      return res.status(200).json({
        plan: data.plan,
        schema_version: data.schema_version,
        size_bytes: data.size_bytes,
        client_saved_at: data.client_saved_at,
        updated_at: data.updated_at
      });
    } catch (err) {
      next(err);
    }
  };
}

export function createPutPlanHandler({
  supabaseAdmin,
  warnBytes = PLAN_SIZE_WARN_BYTES,
  maxBytes = PLAN_SIZE_MAX_BYTES,
  revisionKeep = PLAN_REVISION_KEEP,
  logger = console
}) {
  return async function putPlanHandler(req, res, next) {
    try {
      const body = req.body || {};
      const plan = body.plan;
      const schemaVersion = typeof body.schema_version === 'string' ? body.schema_version.trim() : '';
      const clientSavedAt = typeof body.client_saved_at === 'string' ? body.client_saved_at : null;
      const baseClientSavedAt =
        typeof body.base_client_saved_at === 'string' ? body.base_client_saved_at : null;
      const reason = REVISION_REASONS.has(body.reason) ? body.reason : 'save';

      if (!isPlainObject(plan)) {
        return res.status(400).json({
          error: 'Invalid plan',
          message: 'Body must include a `plan` object.',
          code: 'invalid_plan'
        });
      }
      if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.has(schemaVersion)) {
        return res.status(400).json({
          error: 'Unsupported schema version',
          message: `schema_version must be one of: ${[...SUPPORTED_PLAN_SCHEMA_VERSIONS].join(', ')}`,
          code: 'unsupported_schema_version'
        });
      }

      const sizeBytes = Buffer.byteLength(JSON.stringify(plan), 'utf8');
      if (sizeBytes > maxBytes) {
        return res.status(413).json({
          error: 'Plan too large',
          message: `Plan is ${sizeBytes} bytes; the maximum is ${maxBytes} bytes.`,
          code: 'plan_too_large',
          size_bytes: sizeBytes,
          max_bytes: maxBytes
        });
      }

      const { data: existing, error: readError } = await supabaseAdmin
        .from('plans')
        .select('client_saved_at, updated_at')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (readError) {
        return res.status(500).json({ error: 'Failed to load plan', message: readError.message });
      }

      // Conflict detection (D14): when the client tells us which server state
      // its edit was based on, reject the write if the server has moved on
      // (another device saved in between). The client then prompts the user.
      if (existing && baseClientSavedAt !== null) {
        const serverSavedAt = existing.client_saved_at || null;
        if (serverSavedAt && serverSavedAt !== baseClientSavedAt) {
          return res.status(409).json({
            error: 'Plan conflict',
            message: 'The server has a newer plan than the one this edit was based on.',
            code: 'plan_conflict',
            server_client_saved_at: serverSavedAt,
            server_updated_at: existing.updated_at
          });
        }
      }

      const { data: saved, error: upsertError } = await supabaseAdmin
        .from('plans')
        .upsert(
          {
            user_id: req.userId,
            plan,
            schema_version: schemaVersion,
            size_bytes: sizeBytes,
            client_saved_at: clientSavedAt
          },
          { onConflict: 'user_id' }
        )
        .select('client_saved_at, updated_at')
        .single();
      if (upsertError) {
        return res.status(500).json({ error: 'Failed to save plan', message: upsertError.message });
      }

      await insertPlanRevision(supabaseAdmin, {
        userId: req.userId,
        plan,
        schemaVersion,
        sizeBytes,
        reason,
        clientSavedAt,
        keep: revisionKeep,
        logger
      });

      return res.status(200).json({
        ok: true,
        size_bytes: sizeBytes,
        size_warning: sizeBytes >= warnBytes,
        client_saved_at: saved?.client_saved_at ?? clientSavedAt,
        updated_at: saved?.updated_at ?? null
      });
    } catch (err) {
      next(err);
    }
  };
}

export function createListPlanRevisionsHandler({ supabaseAdmin }) {
  return async function listPlanRevisionsHandler(req, res, next) {
    try {
      const { data, error } = await supabaseAdmin
        .from('plan_revisions')
        .select('id, schema_version, size_bytes, reason, client_saved_at, created_at')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(PLAN_REVISION_KEEP);
      if (error) {
        return res.status(500).json({ error: 'Failed to list revisions', message: error.message });
      }
      return res.status(200).json({ revisions: data || [] });
    } catch (err) {
      next(err);
    }
  };
}

export function createGetPlanRevisionHandler({ supabaseAdmin }) {
  return async function getPlanRevisionHandler(req, res, next) {
    try {
      const revisionId = String(req.params.revisionId || '').trim();
      if (!revisionId) {
        return res.status(400).json({ error: 'Missing revision id' });
      }
      const { data, error } = await supabaseAdmin
        .from('plan_revisions')
        .select('id, plan, schema_version, size_bytes, reason, client_saved_at, created_at')
        .eq('user_id', req.userId)
        .eq('id', revisionId)
        .maybeSingle();
      if (error) {
        return res.status(500).json({ error: 'Failed to load revision', message: error.message });
      }
      if (!data) {
        return res.status(404).json({ error: 'Revision not found' });
      }
      return res.status(200).json({ revision: data });
    } catch (err) {
      next(err);
    }
  };
}
