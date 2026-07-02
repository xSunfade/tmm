// Correlation ID Middleware
// Ensures request IDs are propagated through the request lifecycle

/**
 * Correlation ID middleware
 * Extracts or generates request ID and attaches to request object
 */
export function correlationMiddleware(req, res, next) {
  // Use existing request ID from header or generate new one
  const requestId = req.headers['x-request-id'] || 
    `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  next();
}
