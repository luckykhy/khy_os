/**
 * _fingerprint.js — Device fingerprint emulation for IDE adapters.
 *
 * Generates plausible device identifiers and request headers that mimic
 * a real Kiro IDE installation. Avoids using actual machine identifiers
 * (hostname, username, MAC address) in outgoing requests.
 *
 * Persists device identity to ~/.khyquant/device_id.json for session
 * continuity, with periodic rotation (default 24h).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sleep = require('../../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

// ── Config ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.khyquant');
const DEVICE_ID_FILE = path.join(DATA_DIR, 'device_id.json');
const ROTATION_HOURS = Math.max(1, parseInt(process.env.KIRO_DEVICE_ROTATION_HOURS || '24', 10) || 24);
const ROTATION_MS = ROTATION_HOURS * 60 * 60 * 1000;
const JITTER_ENABLED = String(process.env.KIRO_JITTER || 'true').toLowerCase() !== 'false';

// ── Device ID — persistent + rotating ───────────────────────────────────
let _cachedDeviceState = null;

function generateDeviceId() {
  const entropy = [
    crypto.randomBytes(16).toString('hex'),
    Date.now().toString(36),
    process.pid.toString(36),
  ].join(':');
  return crypto.createHash('sha256').update(entropy).digest('hex').slice(0, 32);
}

function loadOrCreateDeviceState() {
  if (_cachedDeviceState && (Date.now() - _cachedDeviceState.createdAt) < ROTATION_MS) {
    return _cachedDeviceState;
  }

  // Try loading from disk
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      if (data.deviceId && data.createdAt && (Date.now() - data.createdAt) < ROTATION_MS) {
        _cachedDeviceState = data;
        return data;
      }
    }
  } catch { /* regenerate */ }

  // Generate new device state
  const state = {
    deviceId: generateDeviceId(),
    createdAt: Date.now(),
    sessionSeed: crypto.randomBytes(8).toString('hex'),
  };

  // Persist
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }

  _cachedDeviceState = state;
  return state;
}

// ── Dynamic User-Agent ──────────────────────────────────────────────────
// Simple format matching kiro-proxy: "KiroIDE {version} {machineId}"
// DO NOT use AWS SDK full format — it triggers AWS anti-abuse detection.
const KIRO_VERSION_POOL = [
  '0.10.98', '0.10.101', '0.10.104',
  '0.11.100', '0.11.103', '0.11.107', '0.11.110', '0.11.112',
  '0.12.1', '0.12.3', '0.12.5',
];

let _sessionVersion = null;

function pickSessionVersion() {
  if (_sessionVersion) return _sessionVersion;
  const envVersion = (process.env.KIRO_VERSION || '').trim();
  if (envVersion) {
    _sessionVersion = envVersion;
    return envVersion;
  }
  _sessionVersion = KIRO_VERSION_POOL[Math.floor(Math.random() * KIRO_VERSION_POOL.length)];
  return _sessionVersion;
}

function buildKiroUserAgent() {
  const version = pickSessionVersion();
  const device = loadOrCreateDeviceState();
  const machineTag = device.deviceId.slice(0, 12);
  return `KiroIDE ${version} ${machineTag}`;
}

// ── Session management ──────────────────────────────────────────────────
let _session = null;
const SESSION_MIN_LIFETIME_MS = 1 * 60 * 60 * 1000;  // 1 hour
const SESSION_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;  // 4 hours

function getSession() {
  if (_session && (Date.now() - _session.startedAt) < _session.lifetimeMs) {
    _session.requestCount++;
    return _session;
  }

  const lifetimeMs = SESSION_MIN_LIFETIME_MS +
    Math.floor(Math.random() * (SESSION_MAX_LIFETIME_MS - SESSION_MIN_LIFETIME_MS));

  _session = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    lifetimeMs,
    requestCount: 0,
  };
  // Reset session version so a new one is picked next time
  _sessionVersion = null;
  return _session;
}

// ── Request header enrichment ───────────────────────────────────────────
function buildKiroHeaders(baseHeaders = {}) {
  getSession(); // ensure session is active
  return {
    ...baseHeaders,
    'User-Agent': buildKiroUserAgent(),
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'X-Request-Id': crypto.randomUUID(),
  };
}

// ── Request timing jitter ───────────────────────────────────────────────
// Log-normal distribution: median ~150ms, 95th percentile ~400ms
function jitterDelayMs() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  const logNormal = Math.exp(5.0 + 0.5 * z); // mu=5.0 (~148ms median), sigma=0.5
  return Math.min(500, Math.max(50, Math.round(logNormal)));
}

function applyJitter() {
  if (!JITTER_ENABLED) return Promise.resolve();
  const delayMs = jitterDelayMs();
  return sleep(delayMs);
}

// ── Reset ───────────────────────────────────────────────────────────────
function resetSession() {
  _session = null;
  _sessionVersion = null;
}

function resetAll() {
  _cachedDeviceState = null;
  _session = null;
  _sessionVersion = null;
}

/**
 * Reset device fingerprint to a deterministic identity bound to an email.
 *
 * Mirrors nirvana's approach: HMAC-SHA256(secret, email) → same email always
 * produces the same deviceId, so switching back to a previously-used account
 * restores its fingerprint instead of creating a "new device" signal.
 *
 * When email is null/empty, falls back to a fresh random device identity
 * (same as normal rotation).
 */
function resetForAccount(email) {
  _session = null;
  _sessionVersion = null;

  if (!email || typeof email !== 'string' || !email.trim()) {
    // No email: generate a fresh random identity
    _cachedDeviceState = null;
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const deviceId = crypto
    .createHmac('sha256', 'khy-device-id-v1')
    .update(normalizedEmail)
    .digest('hex')
    .slice(0, 32);

  const state = {
    deviceId,
    createdAt: Date.now(),
    sessionSeed: crypto
      .createHmac('sha256', 'khy-session-seed-v1')
      .update(normalizedEmail)
      .digest('hex')
      .slice(0, 16),
    accountEmail: normalizedEmail,
  };

  // Persist
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }

  _cachedDeviceState = state;
}

module.exports = {
  buildKiroUserAgent,
  buildKiroHeaders,
  applyJitter,
  jitterDelayMs,
  getSession,
  loadOrCreateDeviceState,
  resetSession,
  resetAll,
  resetForAccount,
};
