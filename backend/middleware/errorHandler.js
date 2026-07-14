// Central Express error handler. Moved verbatim from server.js (Phase 2.9
// router split).

import config from '../config.js';
import { getPlaidErrorCode, getPlaidErrorRequestId } from '../lib/plaidErrorUtils.js';

export const errorHandler = (err, req, res, next) => {
  const requestId = req.requestId || 'unknown';

  // Log error with correlation ID (verbosity depends on environment)
  const errorLog = {
    type: 'error',
    requestId,
    method: req.method,
    path: req.path,
    error: err.message,
    timestamp: new Date().toISOString()
  };

  if (config.logging.verbose) {
    errorLog.stack = err.stack;
    errorLog.fullError = err.toString();
  }

  if (err.response) {
    // Plaid API error metadata (safe identifiers for support/debugging)
    errorLog.plaidRequestId = getPlaidErrorRequestId(err);
    errorLog.plaidErrorCode = getPlaidErrorCode(err);
    errorLog.plaidErrorType = err?.response?.data?.error_type || null;
    errorLog.plaidHttpStatus = err?.response?.status || null;
  }

  console.error(JSON.stringify(errorLog));

  if (err.response) {
    // Plaid API error
    const status = err.response.status || 500;
    const errorMessage = err.response.data?.error_message || 'Plaid API error';

    return res.status(status).json({
      error: errorMessage,
      request_id: getPlaidErrorRequestId(err),
      error_code: getPlaidErrorCode(err),
      ...(config.logging.verbose && { details: err.response.data })
    });
  }

  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS policy violation',
      message: 'Origin not allowed'
    });
  }

  if (err.status && Number.isInteger(Number(err.status))) {
    return res.status(Number(err.status)).json({
      error: err.message || 'Request failed',
      code: err.code || null
    });
  }

  // Generic error
  res.status(500).json({
    error: config.isProduction ? 'Internal server error' : err.message
  });
};
