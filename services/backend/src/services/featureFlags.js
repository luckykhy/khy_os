/**
 * Feature Flags — unified toggle system for optional subsystems.
 *
 * Checks (in priority order):
 *   1. Environment variable: KHY_FEATURE_{FEATURE}=true/false
 *   2. Config file: ~/.khyquant/features.json
 *   3. Built-in defaults
 *
 * Supported features:
 *   buddy, coordinator, assistant, ultraplan, bridge, claudeDelegation
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Default states: all enabled except experimental ones (bridge, claudeDelegation)
const DEFAULTS = {
  buddy: true,
  coordinator: true,
  assistant: true,
  ultraplan: true,
  bridge: false,
  // Auto-delegate suitable subtasks to Claude Code CLI from AgentTool. Off by
  // default (opt-in) so Khy never spawns the heavy `claude -p` process unasked.
  // Explicit `subagent_type:'claude'` requests are NOT gated by this flag.
  claudeDelegation: false,
};

let _configCache = null;
let _configMtime = 0;

/**
 * Load feature config from disk (cached, refreshed on mtime change).
 * @returns {object}
 */
function _loadConfig() {
  try {
    const { getDataHome } = require('../utils/dataHome');
    const cfgPath = path.join(getDataHome(), 'features.json');
    if (!fs.existsSync(cfgPath)) return {};

    const mtime = fs.statSync(cfgPath).mtimeMs;
    if (_configCache && mtime === _configMtime) return _configCache;

    _configCache = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    _configMtime = mtime;
    return _configCache;
  } catch {
    return {};
  }
}

/**
 * Check if a feature is enabled.
 * @param {string} feature - Feature name (buddy/coordinator/assistant/ultraplan/bridge)
 * @returns {boolean}
 */
function isEnabled(feature) {
  const key = feature.toLowerCase();

  // 1. Environment variable override (highest priority)
  const envKey = `KHY_FEATURE_${key.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    return envVal === 'true' || envVal === '1';
  }

  // 2. Config file
  const config = _loadConfig();
  if (config[key] !== undefined) {
    return !!config[key];
  }

  // 3. Built-in default
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : true;
}

/**
 * List all features with their current state.
 * @returns {Array<{name: string, enabled: boolean, source: string}>}
 */
function listFeatures() {
  const config = _loadConfig();
  return Object.keys(DEFAULTS).map(name => {
    const envKey = `KHY_FEATURE_${name.toUpperCase()}`;
    const envVal = process.env[envKey];
    let source = 'default';
    let enabled = DEFAULTS[name];

    if (envVal !== undefined) {
      enabled = envVal === 'true' || envVal === '1';
      source = 'env';
    } else if (config[name] !== undefined) {
      enabled = !!config[name];
      source = 'config';
    }

    return { name, enabled, source };
  });
}

/**
 * Set a feature flag in the config file.
 * @param {string} feature
 * @param {boolean} enabled
 */
function setFeature(feature, enabled) {
  const { getDataHome } = require('../utils/dataHome');
  const cfgPath = path.join(getDataHome(), 'features.json');
  const config = _loadConfig();
  config[feature.toLowerCase()] = enabled;
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
  _configCache = config;
  _configMtime = Date.now();
}

module.exports = { isEnabled, listFeatures, setFeature, DEFAULTS };
