const DEFAULT_TIMEOUT_MS = 30_000;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function securityHeaders(options = {}) {
  const enableHsts = !!options.enableHsts;
  const hstsMaxAgeSeconds = Number.isFinite(Number(options.hstsMaxAgeSeconds))
    ? Number(options.hstsMaxAgeSeconds)
    : 31536000;
  return function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (enableHsts) {
    res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAgeSeconds}; includeSubDomains; preload`);
  }
  next();
  };
}

export function createRequestTimeoutMiddleware(timeoutMs) {
  const safeTimeoutMs = toPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
  return function requestTimeoutMiddleware(req, res, next) {
    res.setTimeout(safeTimeoutMs, () => {
      if (!res.headersSent) {
        res.status(503).json({
          error: 'Request timed out',
          timeout_ms: safeTimeoutMs
        });
      }
    });
    next();
  };
}
