// Backend base-URL trust boundary (Phase 4.13 — SEC-6).
//
// plaidConfig.backendApiUrl lives inside the plan DOCUMENT, which can arrive
// from an XLSX/Sheets import. Untrusted, it would redirect authenticated
// requests (Bearer tokens included) to an attacker-chosen host. Every code
// path that derives an API base from the plan must go through this allowlist:
//
//   * '' (relative)                      -> same-origin via proxy (always safe)
//   * same origin as the app             -> safe
//   * http://localhost:* / 127.0.0.1:*   -> local dev backend
//   * VITE_BACKEND_API_ORIGIN (if set)   -> the deployed API origin
//
// Anything else falls back to '' (same-origin relative paths) with a console
// warning — requests still work through the standard proxy, tokens never
// leave the expected origin.

const warned = new Set<string>();

function configuredBackendOrigin(): string | null {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_API_ORIGIN;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function resolveBackendBaseUrl(raw: string | null | undefined): string {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }

  const isLocalhost =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  const isSameOrigin = typeof window !== 'undefined' && url.origin === window.location.origin;
  const isConfigured = url.origin === configuredBackendOrigin();

  if (isLocalhost || isSameOrigin || isConfigured) {
    return url.origin;
  }

  if (!warned.has(url.origin)) {
    warned.add(url.origin);
    console.warn(
      `[security] Ignoring untrusted backendApiUrl origin "${url.origin}" from the plan document; using same-origin API paths instead (SEC-6).`
    );
  }
  return '';
}
