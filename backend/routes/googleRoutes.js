// Google OAuth (Sheets consent flow, separate from sign-in per D21) and the
// Google Sheets proxy endpoints. Moved verbatim from server.js (Phase 2.9
// router split).

import express from 'express';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  storeGoogleTokens,
  getGoogleTokens,
  removeGoogleTokens
} from '../storage/googleTokens.js';
import { createOAuthState, consumeOAuthState } from '../lib/oauthState.js';
import { writeAuditLog } from '../lib/auditLog.js';

function getGoogleConfigOrThrow() {
  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    throw new Error('Google OAuth configuration missing');
  }
  return config.google;
}

function buildGoogleAuthUrl(state) {
  const google = getGoogleConfigOrThrow();
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: google.scopes,
    // SEC-3: signed, single-use, TTL-bound, user-bound nonce — never a user id.
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const google = getGoogleConfigOrThrow();
  const body = new URLSearchParams({
    code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: google.redirectUri,
    grant_type: 'authorization_code'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }
  const tokenResponse = await response.json();
  return tokenResponse;
}

async function refreshAccessToken(refreshToken) {
  const google = getGoogleConfigOrThrow();
  const body = new URLSearchParams({
    client_id: google.clientId,
    client_secret: google.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token refresh failed: ${error}`);
  }
  return response.json();
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function getValidGoogleTokens(userId) {
  const tokens = await getGoogleTokens(userId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  const now = Date.now();
  if (expiresAt > now + 60000) {
    return tokens;
  }
  if (!tokens.refresh_token) {
    return tokens;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const nextTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  };
  await storeGoogleTokens(userId, nextTokens);
  return nextTokens;
}

const GOOGLE_SHEETS_FETCH_TIMEOUT_MS = 25000;
// Google Sheets allows 60 write requests/min/user. On 429/503 the request was NOT
// processed, so retrying with backoff is safe (no risk of duplicate appends) and lets
// large syncs succeed as the per-minute quota refills.
// Worst-case cumulative backoff = 1000+2000+4000+8000 = 15s (plus small jitter). Kept below
// the frontend Sheets request timeout so a backing-off retry can finish instead of being aborted.
const GOOGLE_SHEETS_MAX_RETRIES = 4;
const GOOGLE_SHEETS_RETRY_BASE_MS = 1000;
const GOOGLE_SHEETS_RETRY_MAX_MS = 8000;
const GOOGLE_SHEETS_RETRYABLE_STATUS = new Set([429, 503]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds, or null. */
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function googleSheetsFetch(url, options = {}) {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(GOOGLE_SHEETS_FETCH_TIMEOUT_MS)
    });
    if (!GOOGLE_SHEETS_RETRYABLE_STATUS.has(response.status) || attempt >= GOOGLE_SHEETS_MAX_RETRIES) {
      return response;
    }
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const backoffMs = Math.min(
      GOOGLE_SHEETS_RETRY_MAX_MS,
      GOOGLE_SHEETS_RETRY_BASE_MS * 2 ** attempt
    );
    const jitterMs = Math.floor(Math.random() * 250);
    const waitMs = (retryAfterMs != null ? retryAfterMs : backoffMs) + jitterMs;
    // Drain the body so the underlying connection can be reused.
    try {
      await response.arrayBuffer();
    } catch {
      // Ignore drain failures; we are discarding this response anyway.
    }
    console.warn(JSON.stringify({
      type: 'google_sheets_retry',
      status: response.status,
      attempt: attempt + 1,
      waitMs
    }));
    await sleep(waitMs);
    attempt += 1;
  }
}

const router = express.Router();

// Google OAuth - get authorization URL
router.post('/api/google/oauth/authorize', requireAuth, async (req, res, next) => {
  try {
    const state = await createOAuthState(req.userId, { purpose: 'google_sheets' });
    const url = buildGoogleAuthUrl(state);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// Google OAuth callback. Unauthenticated by nature (browser redirect from
// Google); the state nonce is the authentication — it must resolve to the
// exact user who initiated the flow (SEC-3), exactly once.
router.get('/api/google/oauth/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing OAuth code or state' });
    }

    const consumed = await consumeOAuthState(String(state), { purpose: 'google_sheets' });
    if (!consumed.ok) {
      console.warn(JSON.stringify({
        type: 'oauth_state_rejected',
        requestId: req.requestId || 'unknown',
        reason: consumed.reason,
        timestamp: new Date().toISOString()
      }));
      // Generic error to the caller; detail stays in logs.
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }
    const userId = consumed.userId;

    const tokenResponse = await exchangeCodeForTokens(code);
    const profile = await fetchGoogleProfile(tokenResponse.access_token);
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
    await storeGoogleTokens(userId, {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_at: expiresAt,
      google_user_id: profile?.id || null,
      google_user_email: profile?.email || null
    });
    await writeAuditLog({
      userId,
      actor: 'user',
      action: 'google.sheets_connected',
      metadata: {}
    });
    const base = config.google.frontendRedirect || '/';
    const sep = base.includes('?') ? '&' : '?';
    const redirect = `${base}${sep}sheets=connected`;
    res.redirect(redirect);
  } catch (err) {
    next(err);
  }
});

// Google Picker - get access token for Drive Picker (requires auth + connected)
router.get('/api/google/token-for-picker', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    res.json({ accessToken: tokens.access_token });
  } catch (err) {
    next(err);
  }
});

// Google tokens status — validate/refresh so UI shows correct state on load (no false CONNECTED when token expired/revoked)
router.get('/api/google/tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (tokens) {
      return res.json({
        connected: true,
        expiresAt: tokens.expires_at || null,
        email: tokens.google_user_email || null
      });
    }
    return res.json({ connected: false, expiresAt: null, email: null });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || msg.includes('Token has been revoked') || msg.includes('Google token refresh failed')) {
      await removeGoogleTokens(req.userId).catch(() => {});
      return res.json({ connected: false, expiresAt: null, email: null });
    }
    next(err);
  }
});

// Google disconnect
router.delete('/api/google/tokens', requireAuth, async (req, res, next) => {
  try {
    await removeGoogleTokens(req.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - create spreadsheet
router.post('/api/google/sheets/create', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const title = req.body?.title || 'The Money Machine Plan';
    const sheets = Array.isArray(req.body?.sheets)
      ? req.body.sheets
      : ['Settings', 'Alternatives', 'Augments', 'Checkpoints', 'TMM_META'];
    const response = await googleSheetsFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: { title },
        sheets: sheets.map((name) => ({ properties: { title: name } }))
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets create failed: ${error}`);
    }
    const data = await response.json();
    res.json({ spreadsheetId: data.spreadsheetId, spreadsheetUrl: data.spreadsheetUrl });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - read
router.post('/api/google/sheets/read', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range } = req.body;
    if (!spreadsheetId || !range) {
      return res.status(400).json({ error: 'spreadsheetId and range are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const response = await googleSheetsFetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets read failed: ${error}`);
    }
    const data = await response.json();
    res.json({ values: data.values || [] });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - spreadsheet metadata (e.g. title for import toast)
router.get('/api/google/sheets/metadata', requireAuth, async (req, res, next) => {
  try {
    const spreadsheetId = req.query.spreadsheetId;
    if (!spreadsheetId || typeof spreadsheetId !== 'string') {
      return res.status(400).json({ error: 'spreadsheetId query is required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title`;
    const response = await googleSheetsFetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets metadata failed: ${error}`);
    }
    const data = await response.json();
    const title = data.properties?.title || 'Spreadsheet';
    res.json({ title });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - write
router.post('/api/google/sheets/write', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body;
    if (!spreadsheetId || !range || !values) {
      return res.status(400).json({ error: 'spreadsheetId, range, values are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption || 'USER_ENTERED'}`;
    const response = await googleSheetsFetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets write failed: ${error}`);
    }
    const data = await response.json();
    res.json({ updatedCells: data.updatedCells });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - append
router.post('/api/google/sheets/append', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body;
    if (!spreadsheetId || !range || !values) {
      return res.status(400).json({ error: 'spreadsheetId, range, values are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption || 'USER_ENTERED'}`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets append failed: ${error}`);
    }
    const data = await response.json();
    res.json({ updates: data.updates });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - clear range (fixed tables / full-replace only; never use for entity-row deletion)
router.post('/api/google/sheets/clear', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range } = req.body;
    if (!spreadsheetId || !range) {
      return res.status(400).json({ error: 'spreadsheetId and range are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets clear failed: ${error}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - values batchUpdate (multiple ranges written in ONE write request).
// Used to collapse per-row entity updates into a single quota-costing call.
router.post('/api/google/sheets/valuesBatchUpdate', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, data, valueInputOption } = req.body;
    if (!spreadsheetId || !Array.isArray(data)) {
      return res.status(400).json({ error: 'spreadsheetId and data array are required' });
    }
    if (data.length === 0) {
      return res.json({ totalUpdatedCells: 0 });
    }
    for (const entry of data) {
      if (!entry || typeof entry.range !== 'string' || !Array.isArray(entry.values)) {
        return res.status(400).json({ error: 'Each data entry requires a string range and values array' });
      }
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        valueInputOption: valueInputOption || 'USER_ENTERED',
        data: data.map((entry) => ({ range: entry.range, values: entry.values }))
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets valuesBatchUpdate failed: ${error}`);
    }
    const result = await response.json();
    res.json({ totalUpdatedCells: result.totalUpdatedCells ?? 0 });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - create missing tabs by title (for older spreadsheets connected via picker)
router.post('/api/google/sheets/ensureTabs', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, sheetNames } = req.body;
    if (!spreadsheetId || !Array.isArray(sheetNames)) {
      return res.status(400).json({ error: 'spreadsheetId and sheetNames array are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(title)`;
    const metaRes = await googleSheetsFetch(metaUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Sheets metadata failed: ${err}`);
    }
    const meta = await metaRes.json();
    const existing = new Set(
      (meta.sheets || [])
        .map((s) => s.properties?.title)
        .filter((title) => typeof title === 'string')
    );

    const toCreate = [...new Set(sheetNames.map((name) => String(name).trim()).filter(Boolean))]
      .filter((name) => !existing.has(name));

    if (toCreate.length === 0) {
      return res.json({ ok: true, created: [] });
    }

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const batchRes = await googleSheetsFetch(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } }))
      })
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      throw new Error(`Sheets ensureTabs failed: ${err}`);
    }
    res.json({ ok: true, created: toCreate });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - batchUpdate (delete rows via DeleteDimension; rowIndices 1-based, applied descending)
router.post('/api/google/sheets/batchUpdate', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, operations } = req.body;
    if (!spreadsheetId || !Array.isArray(operations)) {
      return res.status(400).json({ error: 'spreadsheetId and operations array are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
    const metaRes = await googleSheetsFetch(metaUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Sheets metadata failed: ${err}`);
    }
    const meta = await metaRes.json();
    const nameToId = {};
    for (const s of meta.sheets || []) {
      const title = s.properties?.title;
      if (title != null) nameToId[title] = s.properties.sheetId;
    }

    const requests = [];
    for (const op of operations) {
      if (op.type !== 'deleteRows' || !op.sheetName || !Array.isArray(op.rowIndices)) continue;
      const sheetId = nameToId[op.sheetName];
      if (!(op.sheetName in nameToId)) {
        return res.status(400).json({ error: `Sheet not found: ${op.sheetName}` });
      }
      const sorted = [...op.rowIndices].filter((r) => Number.isInteger(r) && r >= 2).sort((a, b) => b - a);
      for (const oneBasedRow of sorted) {
        const startIndex = oneBasedRow - 1;
        const endIndex = oneBasedRow;
        requests.push({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex, endIndex }
          }
        });
      }
    }

    if (requests.length === 0) {
      return res.json({ ok: true });
    }
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const batchRes = await googleSheetsFetch(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests })
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      throw new Error(`Sheets batchUpdate failed: ${err}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
