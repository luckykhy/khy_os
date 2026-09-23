'use strict';

/**
 * zenGatekeeper — OpenCode Zen free-tier request gate (pure leaf).
 *
 * The free endpoint does NOT use a registered API key. Access is fingerprinted
 * by client headers the official OpenCode CLI sends (see its session/llm.ts):
 *   - User-Agent: opencode/<channel>/<version>/<client>   (SSOT: serviceDefaults)
 *   - x-opencode-session: stable per-session id (ses_…, generated locally)
 *   - x-opencode-request: per-request id (msg_…)
 *   - x-opencode-client:  "cli" (env OPENCODE_CLIENT override)
 *   - x-session-id:       UUID alias for gatekeepers that read the short name
 *   - Authorization:      empty / "public" bearer (no account key)
 *
 * Session/request ids are LOCAL ONLY — each machine generates its own; nothing
 * to sync across hosts. Stable within one khy process so sticky routing works.
 *
 * Zero IO, deterministic, never throws. Endpoint SSOT: constants/serviceDefaults.
 */

const crypto = require('crypto');
const {
  ZEN_BASE_URL,
  OPENCODE_USER_AGENT,
} = require('../constants/serviceDefaults');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function _base62(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62[bytes[i] % BASE62.length];
  }
  return out;
}

function newSessionId() {
  return `ses_${_base62(26)}`;
}

function newRequestId() {
  return `msg_${_base62(26)}`;
}

function newUuid() {
  return crypto.randomUUID();
}

// ── Process-stable identity (local generation only; no cross-machine sync) ──
let _sessionId = null;
let _projectUuid = null;

function getSessionId() {
  if (!_sessionId) {
    _sessionId = process.env.KHY_ZEN_SESSION_ID || newSessionId();
  }
  return _sessionId;
}

function getProjectUuid() {
  if (!_projectUuid) {
    _projectUuid = process.env.KHY_ZEN_PROJECT_ID || newUuid();
  }
  return _projectUuid;
}

/** Reset process-stable ids (tests only). */
function _reset() {
  _sessionId = null;
  _projectUuid = null;
}

function getClient() {
  return String(process.env.OPENCODE_CLIENT || 'cli').trim() || 'cli';
}

/**
 * True when `url` points at the Zen free gateway (SSOT endpoint match).
 * Trailing slashes and an optional /v1 suffix on either side are tolerated.
 */
function isZenEndpoint(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return false;
  }
  try {
    const a = new URL(raw);
    const b = new URL(ZEN_BASE_URL);
    const strip = (u) => `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/**
 * Build the free-tier gate headers for one request.
 * @param {object} [opts]
 * @param {string} [opts.sessionId]  override sticky session (default: process-stable)
 * @param {string} [opts.requestId]  override per-request id (default: fresh)
 * @param {string} [opts.bearer]     Authorization bearer value ('' or 'public')
 * @returns {Record<string,string>}
 */
function buildZenHeaders(opts = {}) {
  const sessionId = String(opts.sessionId || getSessionId());
  const requestId = String(opts.requestId || newRequestId());
  const bearer = opts.bearer !== undefined ? String(opts.bearer) : 'public';
  const ua = String(process.env.KHY_OPENCODE_USER_AGENT || OPENCODE_USER_AGENT);
  return {
    'User-Agent': ua,
    'x-opencode-session': sessionId,
    'x-opencode-request': requestId,
    'x-opencode-client': getClient(),
    'x-opencode-project': getProjectUuid(),
    'x-session-id': sessionId,
    Authorization: bearer ? `Bearer ${bearer}` : 'Bearer ',
  };
}

/**
 * Whether a chat request body must force stream:true (Zen gate).
 * @param {string} baseUrl
 * @returns {boolean}
 */
function requiresStream(baseUrl) {
  return isZenEndpoint(baseUrl);
}

module.exports = {
  ZEN_BASE_URL,
  OPENCODE_USER_AGENT,
  isZenEndpoint,
  requiresStream,
  buildZenHeaders,
  getSessionId,
  getProjectUuid,
  getClient,
  newSessionId,
  newRequestId,
  newUuid,
  _reset,
};
