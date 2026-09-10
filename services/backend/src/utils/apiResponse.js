'use strict';

/**
 * apiResponse.js — Unified API response helpers (backend SSOT).
 *
 * Single source of truth for all HTTP API response shapes in khy-os backend.
 * Every route handler should use these helpers instead of inline res.json().
 *
 * Success envelope:
 *   { success: true, data, metadata: { requestId, timestamp }, message? }
 *
 * Pagination envelope:
 *   { success: true, data: [], pagination: { page, pageSize, total, totalPages }, metadata }
 *
 * Error envelope (delegates to errorEnvelope.js classifyKhyError):
 *   { success: false, error: { code, message, hint, category, severity, ... }, metadata }
 *
 * @see [DESIGN-API-001] API 设计规范
 * @see @khy/shared/src/errorEnvelope.js (error classification SSOT)
 */

const { classifyKhyError, ensureKhyError, CODES, getSubCategory } = require('@khy/shared/errorEnvelope');

// ─── Request ID extraction ────────────────────────────────────────────────
// Extract requestId from common sources. Returns undefined if not found —
// the metadata injection will still add a timestamp.

function _extractRequestId(req) {
  if (!req) return undefined;
  // Explicit client-provided ID takes priority
  const headerId = req.headers && (req.headers['x-request-id'] || req.headers['X-Request-ID']);
  if (headerId) return String(headerId);
  // Server-generated (requestLogger may attach one)
  if (req.requestId) return String(req.requestId);
  return undefined;
}

// ─── Timestamp ─────────────────────────────────────────────────────────────

function _timestamp() {
  return new Date().toISOString();
}

// ─── Metadata builder ──────────────────────────────────────────────────────

function _metadata(req) {
  const md = { timestamp: _timestamp() };
  const requestId = _extractRequestId(req);
  if (requestId) md.requestId = requestId;
  return md;
}

// ─── Success responses ─────────────────────────────────────────────────────

/**
 * Standard success response.
 * @param {import('express').Response} res
 * @param {*} [data=null]   - Response payload
 * @param {object} [opts]
 * @param {string} [opts.message]    - Optional human-readable message
 * @param {string} [opts.requestId]  - Override requestId (else auto-extracted)
 */
function success(res, data = null, opts = {}) {
  const body = { success: true, data };
  if (opts.message) body.message = opts.message;
  body.metadata = _metadata(res.req);
  if (opts.requestId) body.metadata.requestId = String(opts.requestId);
  return res.json(body);
}

/**
 * Resource created (201).
 * @param {import('express').Response} res
 * @param {*} [data=null]
 * @param {object} [opts]
 * @param {string} [opts.message='创建成功']
 * @param {string} [opts.requestId]
 */
function created(res, data = null, opts = {}) {
  const body = { success: true, data };
  body.message = opts.message || '创建成功';
  body.metadata = _metadata(res.req);
  if (opts.requestId) body.metadata.requestId = String(opts.requestId);
  return res.status(201).json(body);
}

/**
 * Paginated list response.
 * @param {import('express').Response} res
 * @param {Array} rows      - Data items for current page
 * @param {object} pagination - { page, pageSize, total, totalPages }
 * @param {object} [opts]
 * @param {string} [opts.requestId]
 */
function page(res, rows, pagination, opts = {}) {
  const body = {
    success: true,
    data: rows || [],
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
  };
  body.metadata = _metadata(res.req);
  if (opts.requestId) body.metadata.requestId = String(opts.requestId);
  return res.json(body);
}

/**
 * No content (204).
 * @param {import('express').Response} res
 */
function noContent(res) {
  return res.status(204).send();
}

// ─── Error responses ───────────────────────────────────────────────────────

/**
 * Build a KhyError-shaped Error from a known code + message.
 * Uses the CODES table for category/severity/hint lookup.
 * @param {string} code
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.hint]
 * @returns {Error & KhyErrorShape}
 */
function _buildFromCode(code, message, opts = {}) {
  const sub = getSubCategory(code);
  const spec = CODES[code] || CODES.UNKNOWN;
  const err = new Error(message);
  err.code = sub ? sub.code : code;
  err.hint = opts.hint || spec.hint;
  err.category = sub ? sub.category : spec.category;
  err.severity = sub ? sub.severity : spec.severity;
  err.recoverable = !!spec.recoverable;
  err.retryable = !!spec.retryable;
  err.actionable = true;
  err.isKhyError = true;
  return err;
}

/**
 * Structured error response using KhyError classification.
 * Delegates to errorEnvelope.js for consistent code/category/severity mapping.
 *
 * @param {import('express').Response} res
 * @param {Error|string} err - Error object or message string
 * @param {object} [opts]
 * @param {number} [opts.status]    - HTTP status override (else inferred from error)
 * @param {string} [opts.requestId]
 * @param {boolean} [opts.includeCause] - Include cause chain (dev mode only)
 */
function error(res, err, opts = {}) {
  // Already a KhyError → use as-is; otherwise classify
  const khyErr = (err && err.isKhyError === true && typeof err.code === 'string')
    ? err
    : classifyKhyError(err);
  const status = opts.status || khyErr.statusCode || khyErr.status || _statusFromCategory(khyErr.category);

  const errorObj = {
    code: khyErr.code || 'UNKNOWN',
    message: khyErr.message || String(err),
    hint: khyErr.hint || undefined,
    category: khyErr.category || 'unknown',
    severity: khyErr.severity || 'error',
    recoverable: !!khyErr.recoverable,
    retryable: !!khyErr.retryable,
  };
  // Drop undefined hint for cleaner JSON
  if (errorObj.hint === undefined) delete errorObj.hint;

  const body = { success: false, error: errorObj };
  body.metadata = _metadata(res.req);
  if (opts.requestId) body.metadata.requestId = String(opts.requestId);
  if (opts.includeCause && khyErr.cause) {
    body.error.cause = { message: String(khyErr.cause.message || khyErr.cause) };
  }
  return res.status(status).json(body);
}

/**
 * Quick error with explicit code + message (no Error object needed).
 * @param {import('express').Response} res
 * @param {string} code     - KhyError code (e.g. 'INVALID_ARGUMENT')
 * @param {string} message  - Human-readable message
 * @param {object} [opts]
 * @param {number} [opts.status]
 * @param {string} [opts.hint]
 */
function fail(res, code, message, opts = {}) {
  const khyErr = _buildFromCode(code, message, opts);
  return error(res, khyErr, opts);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _statusFromCategory(category) {
  switch (category) {
    case 'auth': return 401;
    case 'user': return 400;
    case 'network': return 502;
    case 'upstream': return 502;
    case 'resource': return 500;
    case 'internal': return 500;
    case 'config': return 500;
    case 'io': return 500;
    default: return 500;
  }
}

// ─── Express middleware ────────────────────────────────────────────────────
/**
 * Middleware: auto-injects metadata into any JSON response that has a
 * `success` property. Non-envelope responses (e.g. raw data from legacy
 * routes) are passed through unchanged.
 *
 * Mounted AFTER route registration so it wraps res.json before the final
 * send. This ensures even routes that don't use the helper functions get
 * consistent metadata.
 */
function envelopeMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    // Only wrap envelope-shaped responses
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof payload.success === 'boolean' &&
      !payload.metadata  // don't double-wrap
    ) {
      payload.metadata = _metadata(req);
    }
    return originalJson(payload);
  };

  next();
}

module.exports = {
  // Success helpers
  success,
  created,
  page,
  noContent,
  // Error helpers
  error,
  fail,
  // Middleware
  envelopeMiddleware,
};
