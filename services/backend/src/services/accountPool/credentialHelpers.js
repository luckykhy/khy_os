/**
 * Credential & token value helpers for the Account Pool service.
 *
 * Extracted verbatim from src/services/accountPool.js as part of the
 * behavior-preserving god-file split. These are pure value transforms
 * (token masking/hashing, JSON/URI parsing, placeholder filtering, shape
 * checks) with no dependency on the pool's mutable runtime state — they
 * belong in one importable, directly-tested module. accountPool.js imports
 * them back under their original names so every call site stays byte-identical.
 */
'use strict';

const crypto = require('crypto');

/** Provider name aliases collapsed onto their canonical pool type. */
const PROVIDER_ALIASES = Object.freeze({
  'anti-gravity': 'trae',
  anti_gravity: 'trae',
  antigravity: 'trae',
  nirvana: 'trae',
});

// ── Placeholder / fake credential filter ────────────────────────
// Reject values that are clearly field descriptions, schema placeholders,
// or example data rather than real credentials.

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'test.com', 'test.org',
  'localhost', 'placeholder.com', 'sample.com', 'foo.com', 'bar.com',
]);

const PLACEHOLDER_PATTERNS = [
  /\[object\s+Object\]/i,     // serialization artifact
  /^(user|username|email|test|admin|placeholder|dummy|sample|demo)$/i,
  /^(ユーザー|用户|帐号|账号|メール|邮箱|密码|パスワード)/,  // CJK field names
  /(任意|可选|必填|オプション|必須|选填)/,  // CJK "optional"/"required" markers
  /^(WebDAV|OAuth|Account|Token|Login|Trae|Password|Credential)\b/i,  // field description prefixes
  /^(your[_\s]|my[_\s]|enter[_\s]|input[_\s]|fill[_\s])/i,  // prompt text
  /^https?:\/\//,  // URL leaked into email/label field
];

/** Normalize a pool type string and collapse known aliases onto canonical names. */
function normalizePoolType(poolType) {
  const raw = String(poolType || '').trim().toLowerCase();
  return PROVIDER_ALIASES[raw] || raw;
}

/** Parse JSON, returning `fallback` for non-strings or parse errors. */
function safeJsonParse(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Mask a token for display: short tokens keep a 3-char head, longer ones head…tail. */
function maskToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return '***';
  if (raw.length <= 10) return `${raw.slice(0, 3)}***`;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

/** SHA-256 hex digest of a token (trimmed), or null for empty input. */
function tokenHash(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Normalize an arbitrary date/timestamp value to an ISO string, or null if invalid. */
function formatIso(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

/** Coerce any value to a trimmed token string. */
function normalizeTokenValue(value) {
  return String(value || '').trim();
}

/** True when an email is empty, too short, on a placeholder domain, or matches a placeholder pattern. */
function _isPlaceholderEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || trimmed.length < 3) return true;
  // Check domain
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx > 0) {
    const domain = trimmed.slice(atIdx + 1);
    if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return true;
  }
  // Check patterns
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/**
 * True when a string is a structurally valid email address: a non-empty local
 * part, a single '@', and a dotted domain, with no embedded whitespace — and it
 * is not a known placeholder. Account monitoring uses this to only count
 * credentials that carry a real `user@domain` identity (per product rule:
 * a monitored account must be addressable by an @-email to be counted).
 */
function isValidEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // exactly one '@', non-empty local part, dotted domain, no whitespace
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  // reject placeholder domains (example.com, …) and field-name placeholders
  if (_isPlaceholderEmail(trimmed)) return false;
  return true;
}

/** True when a value is empty, too short, or matches a placeholder pattern. */
function _isPlaceholderValue(value) {
  if (!value || typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2) return true;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

/** Strict token shape: ≥16 chars, no whitespace, only token-safe characters. */
function hasTokenShape(value) {
  const token = normalizeTokenValue(value);
  if (!token) return false;
  if (token.length < 16) return false;
  if (/\s/.test(token)) return false;
  return /^[A-Za-z0-9._\-+/=~:]+$/.test(token);
}

/** Loose token shape: ≥16 chars with no whitespace (charset unrestricted). */
function hasLooseTokenShape(value) {
  const token = normalizeTokenValue(value);
  if (!token) return false;
  if (token.length < 16) return false;
  return !/\s/.test(token);
}

/** Return an object as-is, parse a JSON-object/array string, else null. */
function coerceObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']')))) return null;
  return safeJsonParse(raw, null);
}

/** Percent-decode a value when it looks URI-encoded; return it unchanged otherwise. */
function decodeMaybeURIComponent(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Parse a callback payload (object, JSON string, or query string) into a plain object. */
function parseCallbackPayload(value) {
  if (!value) return {};
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  const raw = value.trim();
  if (!raw) return {};

  const obj = coerceObject(raw);
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;

  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  if (!query.includes('=')) return {};

  try {
    const params = new URLSearchParams(query);
    const out = {};
    for (const [k, v] of params.entries()) {
      if (!k) continue;
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Return the first non-empty value (strings trimmed), or null. */
function firstNonEmpty(values = []) {
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : v;
    if (s !== null && s !== undefined && String(s).trim() !== '') return s;
  }
  return null;
}

/** Parse a boolean-ish string; unrecognized values return `fallback`. */
function parseBoolean(value, fallback = true) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
  return fallback;
}

/** Dedupe a list of path strings (trimmed), preserving first-seen order. */
function dedupePaths(paths = []) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const key = String(p || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

module.exports = {
  PROVIDER_ALIASES,
  PLACEHOLDER_EMAIL_DOMAINS,
  PLACEHOLDER_PATTERNS,
  normalizePoolType,
  safeJsonParse,
  maskToken,
  tokenHash,
  formatIso,
  normalizeTokenValue,
  _isPlaceholderEmail,
  _isPlaceholderValue,
  isValidEmail,
  hasTokenShape,
  hasLooseTokenShape,
  coerceObject,
  decodeMaybeURIComponent,
  parseCallbackPayload,
  firstNonEmpty,
  parseBoolean,
  dedupePaths,
};
