const buckets = new Map();

function nowMs() {
  return Date.now();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Lightweight in-memory rate limiter.
 * Best used as a baseline abuse guard; move to Redis for multi-instance production.
 */
export function createRateLimiter({
  id,
  windowMs,
  max,
  keyFn,
  skip
}) {
  const safeId = String(id || 'global');
  const safeWindowMs = toPositiveInt(windowMs, 60_000);
  const safeMax = toPositiveInt(max, 60);

  return function rateLimitMiddleware(req, res, next) {
    if (skip && skip(req)) return next();

    const keyPart = keyFn ? keyFn(req) : getClientIp(req);
    const key = `${safeId}:${String(keyPart || 'unknown')}`;
    const ts = nowMs();
    const bucket = buckets.get(key);

    if (!bucket || ts - bucket.windowStart >= safeWindowMs) {
      buckets.set(key, { windowStart: ts, count: 1 });
      return next();
    }

    if (bucket.count >= safeMax) {
      const retryAfterSeconds = Math.max(1, Math.ceil((safeWindowMs - (ts - bucket.windowStart)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limiter: safeId,
        retry_after_seconds: retryAfterSeconds
      });
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    return next();
  };
}

// Periodic memory cleanup for expired buckets.
setInterval(() => {
  const ts = nowMs();
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket?.windowStart || ts - bucket.windowStart > 15 * 60_000) {
      buckets.delete(key);
    }
  }
}, 5 * 60_000);
