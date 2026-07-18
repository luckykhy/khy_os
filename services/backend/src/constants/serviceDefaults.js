'use strict';

/**
 * serviceDefaults.js — Single source of truth for external service URLs/ports.
 *
 * Every env-based default lives here so no file needs to independently
 * hardcode "localhost:XXXX" OR a production domain.  Import from this module
 * instead.  Domain migration / self-hosting = one edit here, every consumer
 * follows (see AGENTS.md "Zero Hardcoding").
 */

const fs = require('fs');
const path = require('path');

// ── Cloud (telemetry / profile sync / skill registry) endpoint ──────────────
// The production cloud endpoint. Overridable per-install via env or the user's
// cloud.json (cloudSync.getEndpoint reads config.endpoint first). Every module
// that needs the default MUST import these instead of re-hardcoding the domain.
const CLOUD_DEFAULT_ENDPOINT =
  process.env.KHY_CLOUD_ENDPOINT || 'https://api.khyquant.top';
const CLOUD_FALLBACK_ENDPOINTS = [
  CLOUD_DEFAULT_ENDPOINT,
  // Future domain migrations are appended here (single source of truth).
];
// Default telemetry sink derived from the cloud endpoint (no second literal).
const TELEMETRY_DEFAULT_ENDPOINT =
  process.env.KHY_TELEMETRY_ENDPOINT || `${CLOUD_DEFAULT_ENDPOINT}/telemetry`;
// Bare host used by diagnostics/help text when no host is supplied.
const CLOUD_DEFAULT_HOST = (() => {
  try { return new URL(CLOUD_DEFAULT_ENDPOINT).host.replace(/^api\./, ''); }
  catch { return 'khyquant.top'; }
})();
// Attribution referer sent to OpenRouter-style upstreams (HTTP-Referer header).
const HTTP_REFERER = process.env.KHY_HTTP_REFERER || 'https://khyquant.com';

// ── Local AI backend (daemon) default ───────────────────────────────────────
// The loopback port the daemon listens on when nothing else is discoverable.
// apps/ai-frontend/backendDiscovery.mjs MIRRORS this value (a separate browser
// package that cannot import backend code) — keep the two in lock-step.
const AI_BACKEND_DEFAULT_PORT = parseInt(process.env.KHY_DAEMON_PORT || '9090', 10);
const AI_BACKEND_DEFAULT_URL = `http://localhost:${AI_BACKEND_DEFAULT_PORT}`;

/**
 * Discover the daemon API URL from runtime state.
 * Returns null when no valid runtime or env-derived port is available.
 */
function _discoverAiBackendUrl(env = process.env) {
  const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');
  const files = [
    path.join(getDataHome(), 'ai_manage_runtime.json'),
    path.join(getLegacyDataHome(), 'ai_manage_runtime.json'),
  ];

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const apiPort = parseInt(String(raw?.apiPort ?? ''), 10);
      if (Number.isFinite(apiPort) && apiPort > 0 && apiPort <= 65535) {
        return `http://localhost:${apiPort}`;
      }
    } catch { /* try next */ }
  }

  const envPort = parseInt(String(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT || ''), 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) {
    return `http://localhost:${envPort}`;
  }
  return null;
}

function getAiBackendUrl(env = process.env) {
  return env.AI_BACKEND_URL || _discoverAiBackendUrl(env) || AI_BACKEND_DEFAULT_URL;
}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const INFERENCE_SERVER_PORT = parseInt(process.env.INFERENCE_SERVER_PORT || '8765', 10);
const BACKEND_PORT = parseInt(process.env.PORT || '3000', 10);

// Redis gateway key prefix (shared across all gateway Redis keys)
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'khy:gw:';

const exported = {
  OLLAMA_HOST,
  INFERENCE_SERVER_PORT,
  getAiBackendUrl,
  BACKEND_PORT,
  REDIS_KEY_PREFIX,
  // Cloud endpoint single source of truth
  CLOUD_DEFAULT_ENDPOINT,
  CLOUD_FALLBACK_ENDPOINTS,
  TELEMETRY_DEFAULT_ENDPOINT,
  CLOUD_DEFAULT_HOST,
  HTTP_REFERER,
  // Local AI backend default
  AI_BACKEND_DEFAULT_PORT,
  AI_BACKEND_DEFAULT_URL,
};

Object.defineProperty(exported, 'AI_BACKEND_URL', {
  enumerable: true,
  get() {
    return getAiBackendUrl();
  },
});

module.exports = exported;
