/**
 * khy settings — layered resolution (Claude Code aligned).
 *
 * Historically khy read a single user-level file (`~/.khy/settings.json`). To
 * match Claude Code's managed/user/project/local precedence, reads now resolve a
 * deep-merge across an ordered set of layers; WRITES still target the user file
 * only (the layer a single interactive user owns).
 *
 * Precedence — LOWEST to HIGHEST (a later layer overrides an earlier one):
 *   1. user            ~/.khy/settings.json
 *   2. project-shared  <cwd>/.khy/settings.json          (checked-in, team-shared)
 *   3. project-local   <cwd>/.khy/settings.local.json    (gitignored, per-checkout)
 *   4. managed         /etc/khy/managed-settings.json  (POSIX)
 *                      %PROGRAMDATA%\khy\managed-settings.json  (Windows)
 *
 * The managed layer is HIGHEST precedence on purpose: an enterprise policy must
 * not be overridable by user or project files — same contract as Claude Code's
 * managed policy. Env override `KHY_MANAGED_SETTINGS` points the managed layer at
 * an explicit path (used by tests and bespoke deployments).
 *
 * Backward compatibility: with only the user file present, the merged result is
 * byte-for-byte the user file — existing single-file deployments are unaffected.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Resolve the current user's home directory, honoring an explicitly overridden
 * HOME (POSIX) / USERPROFILE (Windows) before falling back to os.homedir(). This
 * keeps the user-layer path correct when the environment redefines home, and
 * makes layered resolution deterministically testable (os.homedir() famously
 * ignores a reassigned process.env.HOME on some platforms).
 */
function _homeDir() {
  const override = process.platform === 'win32'
    ? process.env.USERPROFILE
    : process.env.HOME;
  if (override && String(override).trim()) return String(override);
  return os.homedir();
}

function _userSettingsFile() {
  return path.join(_homeDir(), '.khy', 'settings.json');
}

// Backward-compatible export: the user-layer path computed at load time. Prefer
// _userSettingsFile() internally so a reassigned HOME is always respected.
const KHY_SETTINGS_FILE = _userSettingsFile();

/**
 * Resolve the managed (enterprise policy) settings path for the current platform.
 * `KHY_MANAGED_SETTINGS` overrides everything (absolute path), enabling tests and
 * non-standard deployments.
 */
function _managedSettingsPath() {
  const override = process.env.KHY_MANAGED_SETTINGS;
  if (override && String(override).trim()) return String(override).trim();
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(base, 'khy', 'managed-settings.json');
  }
  return path.join('/etc', 'khy', 'managed-settings.json');
}

/**
 * Ordered layer descriptors, LOWEST precedence first. `cwd` is injectable so the
 * resolution is pure and testable; it defaults to the live working directory.
 */
function _settingsLayers(cwd = process.cwd()) {
  return [
    { name: 'user', file: _userSettingsFile() },
    { name: 'project-shared', file: path.join(cwd, '.khy', 'settings.json') },
    { name: 'project-local', file: path.join(cwd, '.khy', 'settings.local.json') },
    { name: 'managed', file: _managedSettingsPath() },
  ];
}

function _readJsonObject(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function _isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`. Nested plain objects merge recursively;
 * arrays and scalars replace wholesale (an override array is authoritative, not
 * concatenated). Neither input is mutated.
 */
function _deepMerge(base, override) {
  const out = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (_isPlainObject(val) && _isPlainObject(out[key])) {
      out[key] = _deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Resolve the effective settings by deep-merging every existing layer in
 * precedence order. Absent files contribute nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] working directory used for project layers.
 * @returns {object} merged settings (a fresh object).
 */
function resolveKhySettings(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let merged = {};
  for (const layer of _settingsLayers(cwd)) {
    const data = _readJsonObject(layer.file);
    if (data) merged = _deepMerge(merged, data);
  }
  return merged;
}

/**
 * Like resolveKhySettings but also reports, for each TOP-LEVEL key, which layer
 * supplied the winning value — for `/config`-style transparency (the "state
 * transparency" engineering rule). Only existing layers appear in `layers`.
 *
 * @param {object} [opts]
 * @returns {{ value: object, sources: Record<string,string>, layers: Array<{name:string,file:string}> }}
 */
function resolveKhySettingsWithProvenance(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let merged = {};
  const sources = {};
  const layers = [];
  for (const layer of _settingsLayers(cwd)) {
    const data = _readJsonObject(layer.file);
    if (!data) continue;
    layers.push({ name: layer.name, file: layer.file });
    for (const key of Object.keys(data)) sources[key] = layer.name;
    merged = _deepMerge(merged, data);
  }
  return { value: merged, sources, layers };
}

/**
 * Read effective settings (layered merge). Backward-compatible name kept for the
 * many existing callers; they transparently gain project/managed layering.
 */
function _readKhySettings() {
  return resolveKhySettings();
}

/**
 * Persist settings to the USER layer only. Project/managed layers are owned by a
 * repo or an administrator and are never written here.
 */
function _writeKhySettings(nextSettings = {}) {
  try {
    const file = _userSettingsFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(nextSettings, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function _loadBooleanKhySetting(key, fallback = false) {
  const settings = _readKhySettings();
  if (typeof settings[key] === 'boolean') return settings[key];
  return !!fallback;
}

/**
 * Persist a boolean to the USER layer. NOTE: the effective value is still subject
 * to layered precedence on read — a managed/project layer may override what was
 * written here, which is the intended enterprise-policy contract.
 */
function _persistBooleanKhySetting(key, value) {
  const settings = _readJsonObject(_userSettingsFile()) || {};
  settings[key] = !!value;
  return _writeKhySettings(settings);
}

/**
 * Persist a string to the USER layer. Same layered-precedence caveat as
 * _persistBooleanKhySetting: a managed/project layer may still override on read.
 * Passing null/undefined removes the key.
 */
function _persistStringKhySetting(key, value) {
  const settings = _readJsonObject(_userSettingsFile()) || {};
  if (value === null || value === undefined) delete settings[key];
  else settings[key] = String(value);
  return _writeKhySettings(settings);
}

/**
 * Persist a nested object value (e.g. `statusLine: {type,command}`) to the USER
 * layer. Same layered-precedence caveat as the scalar persisters: a
 * managed/project layer may still override on read. Passing null/undefined
 * removes the key — this is how a feature like the status line is "closed".
 */
function _persistObjectKhySetting(key, value) {
  const settings = _readJsonObject(_userSettingsFile()) || {};
  if (value === null || value === undefined) delete settings[key];
  else settings[key] = value;
  return _writeKhySettings(settings);
}

module.exports = {
  KHY_SETTINGS_FILE,
  _readKhySettings,
  _writeKhySettings,
  _loadBooleanKhySetting,
  _persistBooleanKhySetting,
  _persistStringKhySetting,
  _persistObjectKhySetting,
  // Layered-resolution API (Claude Code aligned).
  resolveKhySettings,
  resolveKhySettingsWithProvenance,
  _managedSettingsPath,
  _deepMerge,
};
