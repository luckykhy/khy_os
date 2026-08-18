/**
 * Rate Limiting Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 3 of 5 in the middleware chain.
 * Controls per-IP request frequency (default 100 req/min for API,
 * stricter limits for auth and AI endpoints).
 * See thesis Chapter 4.2, Table 12.
 * @pattern Proxy
 */
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

function isLoopback(ip) {
  if (!ip) return false;
  return ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1';
}

function shouldSkipRateLimit(req) {
  const ip = getClientIp(req);
  // Only skip rate limiting for true loopback addresses.
  // Private/Docker IPs still get (relaxed) rate limits to
  // prevent abuse from within the same network.
  return isLoopback(ip);
}

function createLimiter(options) {
  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    skip: shouldSkipRateLimit,
    handler: (req, res) => {
      const ip = getClientIp(req);
      logger.warn('Rate limit exceeded', {
        ip,
        path: req.originalUrl,
        method: req.method,
      });
      res.status(429).json({
        success: false,
        message: '请求过于频繁，请稍后重试'
      });
    }
  });
}

// General API rate limiter: 600 requests/minute
const apiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_API_MAX || '600', 10)
});

// Auth endpoints: 30 attempts per 15 minutes
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '30', 10)
});

// AI/ML endpoints: 120 requests per minute
const aiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AI_MAX || '120', 10)
});

module.exports = { apiLimiter, authLimiter, aiLimiter };
