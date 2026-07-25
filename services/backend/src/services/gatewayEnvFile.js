/**
 * gatewayEnvFile — shared .env patcher for gateway / custom-provider config.
 *
 * Single source of truth for the env-map read/merge/persist logic that the CLI
 * (`cli/handlers/gateway.js`) and the runtime admin API (`aiManagementServer.js`
 * via `customProviderRegistrar.js`) both need. Anchored to the same two targets
 * the CLI has always written:
 *   - canonical: services/backend/.env  (or $KHY_ENV_FILE)
 *   - mirror:    services/.env (unless KHY_ENV_SYNC_ROOT=false)
 *
 * Every writer also updates `process.env` in-memory so changes take effect for
 * the running process without a restart.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const resolveEnvPaths = require('../utils/resolveGatewayEnvPaths');

const patchEnvContent = require('../utils/patchEnvContent');

function writeEnvPatch(envMap = {}, unsetKeys = [], options = {}) {
  const resolved = resolveEnvPaths();
  const canonicalPath = options.envPath ? path.resolve(options.envPath) : resolved.canonicalPath;
  const targets = options.envPath ? [canonicalPath] : resolved.targets;

  for (const targetPath of targets) {
    let content = '';
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { /* no .env yet */ }
    const patched = patchEnvContent(content, envMap, unsetKeys);
    fs.writeFileSync(targetPath, patched);
  }

  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = String(value);
  }
  for (const key of unsetKeys) {
    delete process.env[key];
  }
  return canonicalPath;
}

function writeEnvMap(envMap = {}, options = {}) {
  return writeEnvPatch(envMap, [], options);
}

function unsetEnvKeys(keys = [], options = {}) {
  return writeEnvPatch({}, keys, options);
}

function parseJsonObject(raw, fallback = {}) {
  const text = String(raw || '').trim();
  if (!text) return { ...fallback };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    return { ...fallback };
  }
  return { ...fallback };
}

/**
 * Merge entries into a JSON-object env var, persist to .env, and update process.env.
 */
function mergeJsonEnvVar(envKey, newEntries) {
  const existing = parseJsonObject(process.env[envKey], {});
  const merged = { ...existing, ...newEntries };
  const json = JSON.stringify(merged);
  writeEnvMap({ [envKey]: json });
  return merged;
}

/**
 * Remove a key from a JSON-object env var. Unsets the var entirely when empty.
 */
function removeJsonEnvVarKey(envKey, keyToRemove) {
  const existing = parseJsonObject(process.env[envKey], {});
  if (!(keyToRemove in existing)) return existing;
  delete existing[keyToRemove];
  if (Object.keys(existing).length > 0) {
    writeEnvMap({ [envKey]: JSON.stringify(existing) });
  } else {
    unsetEnvKeys([envKey]);
  }
  return existing;
}

module.exports = {
  resolveEnvPaths,
  patchEnvContent,
  writeEnvPatch,
  writeEnvMap,
  unsetEnvKeys,
  parseJsonObject,
  mergeJsonEnvVar,
  removeJsonEnvVarKey,
};
