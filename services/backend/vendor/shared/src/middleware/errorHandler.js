/**
 * Global Express Error Handler (4-param middleware)
 *
 * Access & Routing Layer (接入与路由层) - Step 4 of 5 in the middleware chain.
 * Normalizes all unhandled exceptions into a unified JSON format:
 *   { success: false, message: "...", requestId: "..." }
 * See thesis Chapter 4.2, Table 12.
 * @pattern Chain of Responsibility, Proxy
 */
const logger = require('../utils/logger');

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  const requestId = req.headers['x-request-id'] || req.id;

  logger.error(err.message, {
    status,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id,
    requestId,
    stack: err.stack
  });

  const body = { success: false, message };
  if (requestId) {
    body.requestId = requestId;
  }
  if (process.env.NODE_ENV === 'development') {
    body.stack = err.stack;
  }
  res.status(status).json(body);
}

module.exports = errorHandler;
