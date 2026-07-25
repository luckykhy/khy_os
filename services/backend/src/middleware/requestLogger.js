/**
 * HTTP Request Logging Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 1 of 5 in the middleware chain.
 * Records every HTTP request with method, path, IP, and response time.
 * See thesis Chapter 4.2, Table 12 (middleware execution order).
 */
const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || req.id;
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      userId: req.user?.id,
      ip: req.ip,
      requestId
    });
  });
  next();
}

module.exports = requestLogger;
