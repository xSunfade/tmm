import { getSupabaseClient } from '../supabaseClient';

const GET_SESSION_TIMEOUT_MS = 2500;
/** When we have a cached token, use a short timeout so we fall back to cache quickly instead of waiting 5s. */
const GET_SESSION_FAST_TIMEOUT_MS = 400;

let cachedAccessToken: string | null = null;

async function getSessionWithRetry(useFastTimeout: boolean): Promise<{ data: { session: { access_token?: string } | null } }> {
  const supabase = getSupabaseClient();
  const getSession = () => supabase.auth.getSession();
  const timeoutMs = useFastTimeout ? GET_SESSION_FAST_TIMEOUT_MS : GET_SESSION_TIMEOUT_MS;
  const timeout = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('getSession timeout')), timeoutMs));
  try {
    return await Promise.race([getSession(), timeout()]);
  } catch {
    if (useFastTimeout) throw new Error('getSession timeout');
    return Promise.race([getSession(), timeout()]);
  }
}

async function resolveAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string | undefined> {
  if (options.forceRefresh) cachedAccessToken = null;
  const haveCache = cachedAccessToken != null;
  try {
    const { data } = await getSessionWithRetry(haveCache);
    const token = data.session?.access_token;
    if (token) cachedAccessToken = token;
    else cachedAccessToken = null;
    return token ?? undefined;
  } catch {
    return cachedAccessToken ?? undefined;
  }
}

async function buildAuthHeaders(options: RequestInit = {}, token?: string | null) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function authFetchOnce(path: string, options: RequestInit = {}, token?: string | null) {
  const headers = await buildAuthHeaders(options, token);
  try {
    return await fetch(path, { ...options, headers });
  } catch {
    throw new Error(
      'Backend API is unreachable. Start it with: cd backend && npm start (or npm run dev:backend from repo root).'
    );
  }
}

export async function authFetch(path: string, options: RequestInit = {}) {
  let token = await resolveAccessToken();
  let response = await authFetchOnce(path, options, token);
  if (response.status === 401) {
    token = await resolveAccessToken({ forceRefresh: true });
    response = await authFetchOnce(path, options, token);
  }
  if (!response.ok) {
    const error = await response.text();
    if ((response.status === 500 || response.status === 502 || response.status === 503) && !error.trim()) {
      throw new Error(
        'Backend API is unavailable (proxy could not reach localhost:3000). Start the backend server and retry.'
      );
    }
    throw new Error(error || 'Request failed');
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  return response.json();
}
