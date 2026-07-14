// Plaid error/response metadata helpers shared by routes, the sync service,
// and the error handler. Moved verbatim from server.js (Phase 2.9 router split).

export function getPlaidErrorCode(err) {
  return err?.response?.data?.error_code || null;
}

export function getPlaidResponseRequestId(response) {
  const id = response?.data?.request_id || response?.data?.requestId || null;
  return id ? String(id) : null;
}

export function getPlaidErrorRequestId(err) {
  const id =
    err?.response?.data?.request_id ||
    err?.response?.data?.requestId ||
    err?.response?.headers?.['plaid-request-id'] ||
    err?.response?.headers?.['x-request-id'] ||
    null;
  return id ? String(id) : null;
}

export function isPlaidFailureForBreaker(err) {
  const code = getPlaidErrorCode(err);
  return [
    'RATE_LIMIT_EXCEEDED',
    'INSTITUTION_DOWN',
    'PRODUCTS_NOT_SUPPORTED',
    'INTERNAL_SERVER_ERROR',
    'API_ERROR'
  ].includes(String(code || ''));
}
