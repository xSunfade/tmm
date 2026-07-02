// Request Logging Middleware
// Provides structured logging with correlation IDs

/**
 * Generate a unique request ID
 * @returns {string} Request ID
 */
function generateRequestId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Request logging middleware
 * Logs all requests with correlation IDs, method, path, latency, and status
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || generateRequestId();
  
  // Attach request ID to request object for use in handlers
  req.requestId = requestId;
  
  // Log request
  console.log(JSON.stringify({
    type: 'request',
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    timestamp: new Date().toISOString()
  }));
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      type: 'response',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      timestamp: new Date().toISOString()
    }));
  });
  
  // Set request ID in response header
  res.setHeader('X-Request-ID', requestId);
  
  next();
}
