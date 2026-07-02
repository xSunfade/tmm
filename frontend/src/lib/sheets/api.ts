import { getSupabaseClient } from '../supabaseClient';

const GET_SESSION_TIMEOUT_MS = 2500;
const SHEETS_REQUEST_TIMEOUT_MS = 30000;
let cachedAccessTokenForSheets: string | null = null;

function getApiBaseUrl(): string {
  const base = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return base ? base.replace(/\/$/, '') : '';
}

function parseApiError(response: Response, rawText: string): string {
  if (response.status === 401) {
    return 'Please sign in again to continue.';
  }
  try {
    const parsed = JSON.parse(rawText) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? (rawText || 'Request failed');
  } catch {
    return rawText || 'Request failed';
  }
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Sheets request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function authorizedFetch(path: string, options: RequestInit = {}, sessionToken?: string | null) {
  const isSheetsCall = path.includes('/api/google/sheets/');
  let token: string | null | undefined = sessionToken;
  if (token === undefined) {
    const supabase = getSupabaseClient();
    const timeout = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getSession timeout')), GET_SESSION_TIMEOUT_MS));
    try {
      const { data } = await Promise.race([supabase.auth.getSession(), timeout()]);
      token = data.session?.access_token;
      cachedAccessTokenForSheets = token ?? null;
    } catch {
      token = cachedAccessTokenForSheets ?? undefined;
    }
  }
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('Content-Type', 'application/json');
  const url = `${getApiBaseUrl()}${path}`;
  let response: Response;
  try {
    response = isSheetsCall
      ? await fetchWithTimeout(url, { ...options, headers }, SHEETS_REQUEST_TIMEOUT_MS)
      : await fetch(url, { ...options, headers });
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) {
      throw error;
    }
    throw new Error(
      'Backend API is unreachable. Start it with: cd backend && npm start (or npm run dev:backend from repo root).'
    );
  }
  if (!response.ok) {
    const rawText = await response.text();
    if ((response.status === 500 || response.status === 502 || response.status === 503) && !rawText.trim()) {
      throw new Error(
        'Backend API is unavailable (proxy could not reach localhost:3000). Start the backend server and retry.'
      );
    }
    throw new Error(parseApiError(response, rawText));
  }
  return response.json();
}

/** True if the error message indicates Google OAuth token is expired, revoked, or invalid. */
export function isGoogleTokenError(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  return (
    lower.includes('invalid_grant') ||
    lower.includes('token has been expired') ||
    lower.includes('token has been revoked') ||
    lower.includes('google token refresh failed') ||
    lower.includes('google not connected')
  );
}

export async function getGoogleAuthUrl() {
  const data = await authorizedFetch('/api/google/oauth/authorize', { method: 'POST' });
  return data.url as string;
}

export async function getGoogleTokenStatus() {
  return authorizedFetch('/api/google/tokens', { method: 'GET' });
}

export async function getTokenForPicker(): Promise<string> {
  const supabase = getSupabaseClient();
  if (cachedAccessTokenForSheets) {
    try {
      const fast = await authorizedFetch('/api/google/token-for-picker', { method: 'GET' }, cachedAccessTokenForSheets);
      return fast.accessToken as string;
    } catch {
      // fallback to full flow below
    }
  }
  const timeout = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getSession timeout')), GET_SESSION_TIMEOUT_MS));
  let data: { session: { access_token?: string } | null } = { session: null };
  try {
    const result = await Promise.race([supabase.auth.getSession(), timeout()]);
    data = result.data;
    cachedAccessTokenForSheets = data.session?.access_token ?? null;
  } catch (error) {
    if (cachedAccessTokenForSheets) {
      data = { session: { access_token: cachedAccessTokenForSheets } };
    } else {
      throw new Error('Session wake timed out. Please refresh and try again.');
    }
  }
  if (!data.session?.access_token) {
    throw new Error('Please sign in to TMM to use the file picker.');
  }
  const result = await authorizedFetch('/api/google/token-for-picker', { method: 'GET' }, data.session.access_token);
  return result.accessToken as string;
}

export async function disconnectGoogle() {
  return authorizedFetch('/api/google/tokens', { method: 'DELETE' });
}

export async function createSpreadsheet(title: string, sheets: string[]) {
  return authorizedFetch('/api/google/sheets/create', {
    method: 'POST',
    body: JSON.stringify({ title, sheets })
  });
}

export async function writeSheet(spreadsheetId: string, range: string, values: unknown[][], sessionToken?: string | null) {
  return authorizedFetch('/api/google/sheets/write', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, range, values, valueInputOption: 'USER_ENTERED' })
  }, sessionToken);
}

export async function readSheet(spreadsheetId: string, range: string, sessionToken?: string | null) {
  return authorizedFetch('/api/google/sheets/read', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, range })
  }, sessionToken);
}

export async function getSpreadsheetMetadata(spreadsheetId: string): Promise<{ title: string }> {
  return authorizedFetch(
    `/api/google/sheets/metadata?spreadsheetId=${encodeURIComponent(spreadsheetId)}`,
    { method: 'GET' }
  ) as Promise<{ title: string }>;
}

export async function clearSheetRange(spreadsheetId: string, range: string, sessionToken?: string | null): Promise<{ ok: boolean }> {
  return authorizedFetch('/api/google/sheets/clear', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, range })
  }, sessionToken) as Promise<{ ok: boolean }>;
}

export async function ensureSpreadsheetTabs(
  spreadsheetId: string,
  sheetNames: string[],
  sessionToken?: string | null
): Promise<{ created: string[] }> {
  return authorizedFetch('/api/google/sheets/ensureTabs', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, sheetNames })
  }, sessionToken) as Promise<{ created: string[] }>;
}

export type DeleteRowsOperation = {
  type: 'deleteRows';
  sheetName: string;
  rowIndices: number[];
};

export async function batchUpdateSheets(
  spreadsheetId: string,
  operations: DeleteRowsOperation[],
  sessionToken?: string | null
): Promise<{ ok: boolean }> {
  return authorizedFetch('/api/google/sheets/batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, operations })
  }, sessionToken) as Promise<{ ok: boolean }>;
}

export async function appendSheet(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  valueInputOption: 'USER_ENTERED' | 'RAW' = 'USER_ENTERED',
  sessionToken?: string | null
): Promise<{ updates?: { updatedCells?: number } }> {
  return authorizedFetch('/api/google/sheets/append', {
    method: 'POST',
    body: JSON.stringify({ spreadsheetId, range, values, valueInputOption })
  }, sessionToken) as Promise<{ updates?: { updatedCells?: number } }>;
}

/** Get session token once for reuse across a burst of Sheets API calls (avoids getSession() hang). */
export async function getSheetsSessionToken(): Promise<string | null> {
  const supabase = getSupabaseClient();
  const timeout = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getSession timeout')), GET_SESSION_TIMEOUT_MS));
  try {
    const { data } = await Promise.race([supabase.auth.getSession(), timeout()]);
    const token = data.session?.access_token ?? null;
    cachedAccessTokenForSheets = token;
    return token;
  } catch {
    return cachedAccessTokenForSheets;
  }
}
