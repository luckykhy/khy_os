'use strict';

const { timingSafeEqual } = require('crypto');
const { Router } = require('express');
const { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } = require('prom-client');

const _parseBoolean = require('../utils/parseBoolean');
function parseBool(value, fallback = false) {
  return _parseBoolean(value, fallback, { extended: false });
}

function normalizePath(rawPath) {
  const input = String(rawPath || '/');
  const path = input.split('?')[0] || '/';
  if (path === '/' || path === '/health' || path === '/api/health') return path;

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  if (segments[0] === 'api') {
    if (segments.length === 1) return '/api';
    return `/api/${segments[1]}/#path`;
  }
  return `/${segments[0]}/#path`;
}

function extractBearerToken(authHeader) {
  const raw = String(authHeader || '');
  const match = raw.match(/^bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function secureTokenEqual(expected, actual) {
  const expectedBuf = Buffer.from(String(expected), 'utf8');
  const actualBuf = Buffer.from(String(actual), 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function createMetrics(options = {}) {
  const logger = options.logger || console;
  const serviceName = String(options.serviceName || 'khy-os-backend');

  const enabled = parseBool(process.env.KHY_METRICS_ENABLED, true);
  const metricsPath = String(process.env.KHY_METRICS_PATH || '/metrics').trim() || '/metrics';
  const metricsPrefix = String(process.env.KHY_METRICS_PREFIX || 'khy_').trim() || 'khy_';
  const secret = String(process.env.METRICS_SECRET || '').trim();
  const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

  let authMode = 'none';
  if (secret) {
    authMode = 'bearer';
  } else if (isProduction) {
    authMode = 'deny';
  }

  if (!enabled) {
    return {
      enabled,
      path: metricsPath,
      authMode,
      metricsMiddleware: (_req, _res, next) => next(),
      metricsRouter: Router(),
    };
  }

  if (authMode === 'deny') {
    logger.warn('[metrics] METRICS_SECRET is missing in production; /metrics will return 401.');
  }

  const register = new Registry();
  register.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register, prefix: metricsPrefix });

  const httpRequestsTotal = new Counter({
    name: `${metricsPrefix}http_requests_total`,
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status_code'],
    registers: [register],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: `${metricsPrefix}http_request_duration_seconds`,
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path', 'status_code'],
    buckets: [0.01, 0.03, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [register],
  });

  const httpRequestsInFlight = new Gauge({
    name: `${metricsPrefix}http_requests_in_flight`,
    help: 'Current in-flight HTTP requests',
    registers: [register],
  });

  const metricsMiddleware = (req, res, next) => {
    const path = String(req.path || req.originalUrl || '/');
    const normalizedMetricsPath = metricsPath.split('?')[0];
    if (path === normalizedMetricsPath || path.startsWith(`${normalizedMetricsPath}/`)) {
      return next();
    }

    httpRequestsInFlight.inc();
    const stopTimer = httpRequestDurationSeconds.startTimer();
    res.on('finish', () => {
      const labels = {
        method: req.method,
        path: normalizePath(req.path || req.originalUrl || '/'),
        status_code: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      stopTimer(labels);
      httpRequestsInFlight.dec();
    });
    res.on('close', () => {
      // Ensure gauge does not leak if connection closes before finish.
      if (res.writableEnded !== true) {
        httpRequestsInFlight.dec();
      }
    });

    return next();
  };

  const metricsRouter = Router();
  metricsRouter.get('/', async (req, res) => {
    if (authMode === 'deny') {
      res.status(401).end();
      return;
    }

    if (authMode === 'bearer') {
      const token = extractBearerToken(req.headers.authorization);
      if (!token || !secureTokenEqual(secret, token)) {
        res.set('WWW-Authenticate', 'Bearer');
        res.status(401).end();
        return;
      }
    }

    try {
      const payload = await register.metrics();
      res.set('Content-Type', register.contentType);
      res.end(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[metrics] Failed to collect metrics', { message });
      res.status(500).end();
    }
  });

  return {
    enabled,
    path: metricsPath,
    authMode,
    metricsMiddleware,
    metricsRouter,
  };
}

module.exports = {
  createMetrics,
  normalizePath,
};

