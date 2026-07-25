'use strict';

const fs = require('fs');
const path = require('path');
const { getDataHome, getLegacyDataHome } = require('./dataHome');

function toPort(raw, fallback = null) {
  const value = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return fallback;
  return value;
}

function toBool(raw, fallback = false) {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function normalizeHost(raw) {
  const host = String(raw || '').trim() || '127.0.0.1';
  if (['0.0.0.0', '::', '[::]', '*'].includes(host)) return '127.0.0.1';
  return host;
}

function isLoopbackBaseUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    const host = String(parsed.hostname || '').trim().toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '0.0.0.0'
      || host === '[::]';
  } catch {
    return false;
  }
}

function readProxyRuntime() {
  const files = [
    path.join(getDataHome(), 'proxy_server_runtime.json'),
    path.join(getLegacyDataHome(), 'proxy_server_runtime.json'),
  ];

  for (const filePath of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const legacyPort = toPort(raw?.port);
      let httpPort = toPort(raw?.httpPort);
      const httpsPort = toPort(raw?.httpsPort);
      const httpsEnabled = raw?.httpsEnabled === true || httpsPort !== null;
      const httpsOnly = raw?.httpsOnly === true || (httpPort === null && httpsPort !== null);

      if (httpPort === null && !httpsOnly) {
        httpPort = legacyPort;
      }
      if (httpPort === null && httpsPort === null) {
        continue;
      }

      return {
        host: normalizeHost(raw?.host),
        httpPort,
        httpsPort,
        httpsEnabled,
        httpsOnly,
      };
    } catch { /* try next file */ }
  }

  return null;
}

function buildBaseFromRuntime(runtime) {
  if (!runtime) return '';
  const host = runtime.host || '127.0.0.1';
  if (runtime.httpsPort !== null && runtime.httpsPort !== undefined && runtime.httpsEnabled) {
    return `https://${host}:${runtime.httpsPort}`;
  }
  if (runtime.httpPort !== null && runtime.httpPort !== undefined) {
    return `http://${host}:${runtime.httpPort}`;
  }
  if (runtime.httpsPort !== null && runtime.httpsPort !== undefined) {
    return `https://${host}:${runtime.httpsPort}`;
  }
  return '';
}

function buildBaseFromProxyEnv(env = process.env) {
  const host = normalizeHost(env.PROXY_HOST);
  const httpPort = toPort(env.PROXY_PORT, 9100) || 9100;
  const httpsEnabled = toBool(env.PROXY_ENABLE_HTTPS, false);
  const httpsOnly = toBool(env.PROXY_HTTPS_ONLY, false);
  const httpsFallback = httpsOnly ? httpPort : Math.min(httpPort + 1, 65535);
  const httpsPort = toPort(env.PROXY_HTTPS_PORT, httpsFallback);

  if (httpsEnabled && httpsPort && httpsOnly) {
    return `https://${host}:${httpsPort}`;
  }
  if (!httpsOnly && httpPort) {
    return `http://${host}:${httpPort}`;
  }
  if (httpsEnabled && httpsPort) {
    return `https://${host}:${httpsPort}`;
  }
  return `http://${host}:${httpPort}`;
}

function resolveLocalProxyBaseUrl(processEnv = process.env) {
  const runtimeBase = buildBaseFromRuntime(readProxyRuntime());
  if (runtimeBase) {
    return runtimeBase;
  }
  return buildBaseFromProxyEnv(processEnv);
}

function resolveLocalProxyOpenAiBaseUrl(processEnv = process.env) {
  return `${resolveLocalProxyBaseUrl(processEnv).replace(/\/+$/, '')}/v1`;
}

function pickConfiguredBaseUrl(processEnv = process.env, settingsEnv = {}) {
  const processBase = String(processEnv.ANTHROPIC_BASE_URL || '').trim();
  if (processBase) return processBase;
  const settingsBase = String(settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  if (settingsBase) return settingsBase;
  return '';
}

function resolveAnthropicBaseUrl(options = {}) {
  const processEnv = options.processEnv || process.env;
  const settingsEnv = options.settingsEnv || {};
  const runtimeBase = buildBaseFromRuntime(readProxyRuntime());
  const configuredBase = pickConfiguredBaseUrl(processEnv, settingsEnv);

  if (configuredBase) {
    if (!runtimeBase || !isLoopbackBaseUrl(configuredBase)) {
      return configuredBase;
    }
    return runtimeBase;
  }

  if (runtimeBase) {
    return runtimeBase;
  }

  return buildBaseFromProxyEnv(processEnv);
}

module.exports = {
  resolveLocalProxyBaseUrl,
  resolveLocalProxyOpenAiBaseUrl,
  resolveAnthropicBaseUrl,
};
