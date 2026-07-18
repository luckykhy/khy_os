'use strict';

/**
 * Key Health Probe — periodic health checking for API key pool entries.
 *
 * Probes each configured provider key with a lightweight request (GET /models)
 * and feeds results back to apiKeyPool via markSuccess/markFailure.
 *
 * @module keyHealthProbe
 */

const pool = require('./apiKeyPool');

// ── Constants ──

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PROBE_TIMEOUT_MS = 8_000;

// Known provider → lightweight health endpoint mapping
const _HEALTH_ENDPOINTS = {
  openai:     '/v1/models',
  deepseek:   '/v1/models',
  qwen:       '/v1/models',
  glm:        '/v1/models',
  doubao:     '/v1/models',
  anthropic:  '/v1/models',
  trae:       '/v1/models',
  relay:      '/v1/models',
  codex:      '/v1/models',
  wenxin:     '/v1/models',
  ollama:     '/api/tags',
};

// ── State ──

let _timer = null;
let _running = false;

// ── Public API ──

/**
 * Start periodic health probing.
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=300000] - Probe interval in ms
 */
function start(opts = {}) {
  if (_timer) return; // already running

  const interval = opts.intervalMs || DEFAULT_INTERVAL_MS;
  _timer = setInterval(() => {
    probeAll().catch(() => {});
  }, interval);

  // Don't block process exit
  if (_timer.unref) _timer.unref();
  _running = true;
}

/**
 * Stop periodic health probing.
 */
function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
}

/**
 * Check if the probe is currently running.
 * @returns {boolean}
 */
function isRunning() {
  return _running;
}

/**
 * Probe all keys across all providers.
 * @returns {Promise<Array<{ keyId, provider, healthy, latencyMs, error? }>>}
 */
async function probeAll() {
  pool.init();

  const providers = pool.getProviders();

  // Probe independent keys concurrently rather than serially ([MGMT-RPT-020] REQ-2026-009).
  const tasks = [];
  for (const provider of providers) {
    const keys = pool.listAvailableKeys(provider);
    for (const keyEntry of keys) {
      tasks.push(probeKey(provider, keyEntry));
    }
  }

  return Promise.all(tasks);
}

/**
 * Probe a single key's health.
 * @param {string} provider
 * @param {object} keyEntry - From pool.listAvailableKeys() or { keyId|id, key, endpoint }
 * @returns {Promise<{ keyId, provider, healthy, latencyMs, statusCode?, error? }>}
 */
async function probeKey(provider, keyEntry) {
  const resolvedKeyId = keyEntry.keyId || keyEntry.id || null;
  const result = {
    keyId: resolvedKeyId,
    provider,
    healthy: false,
    latencyMs: 0,
    statusCode: null,
    error: null,
  };

  const endpoint = (keyEntry.endpoint || '').replace(/\/+$/, '');
  const healthPath = _HEALTH_ENDPOINTS[provider] || '/v1/models';
  const url = `${endpoint}${healthPath}`;

  if (!endpoint) {
    result.error = 'No endpoint configured';
    _reportResult(result);
    return result;
  }

  const t0 = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const headers = {};
    if (keyEntry.key) {
      headers['Authorization'] = `Bearer ${keyEntry.key}`;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    result.latencyMs = Date.now() - t0;
    result.statusCode = res.status;

    if (res.ok) {
      result.healthy = true;
    } else {
      result.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    result.latencyMs = Date.now() - t0;
    result.error = err.name === 'AbortError' ? 'Timeout' : (err.message || 'Unknown error');
  }

  _reportResult(result);
  return result;
}

// ── Internal ──

/**
 * Report probe result to the apiKeyPool.
 */
function _reportResult(result) {
  try {
    if (result.healthy) {
      pool.markSuccess(result.keyId);
    } else {
      pool.markFailure(result.keyId, result.statusCode || 0, result.error || 'Health probe failed');
    }
  } catch { /* pool operation failure is non-fatal */ }
}

/** @internal Reset for testing */
function _resetForTest() {
  stop();
}

module.exports = {
  start,
  stop,
  isRunning,
  probeAll,
  probeKey,
  _resetForTest,
};
