'use strict';

/**
 * skillStateService.js — per-skill enable/disable persistence (A2).
 *
 * DesireCore separates "installed" from "authorized". A skill can be present on
 * disk yet disabled: a disabled skill is hidden from the model-facing catalog
 * and refuses execution from any caller. This ledger is the single source of
 * truth for that on/off bit; skill discovery itself is unchanged.
 *
 * Data file: <dataHome>/skills/state.json
 *   { version: 1, skills: { "<name>": { enabled: bool, updatedAt: ISO } } }
 *
 * Design notes:
 *   - Fail-open: an unknown skill (no ledger entry) is ENABLED by default, so
 *     freshly installed skills work without an explicit enable, and a missing
 *     or corrupt ledger never silently disables everything.
 *   - Read-modify-write on a small JSON file (mirrors skillCuratorService).
 *   - Uses getDataDir for the directory, then joins the file name — never pass
 *     the file name to getDataDir (that would create a directory).
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../utils/dataHome');

const STATE_VERSION = 1;

function _stateFile() {
  return path.join(getDataDir('skills'), 'state.json');
}

function _load() {
  try {
    const file = _stateFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.skills && typeof data.skills === 'object') {
        return data;
      }
    }
  } catch { /* corrupt — start fresh */ }
  return { version: STATE_VERSION, skills: {} };
}

function _save(data) {
  const file = _stateFile();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Whether a skill is enabled. Unknown skills default to enabled (fail-open).
 * @param {string} name
 * @returns {boolean}
 */
function isEnabled(name) {
  if (!name) return true;
  const data = _load();
  const entry = data.skills[name];
  if (!entry || typeof entry.enabled !== 'boolean') return true;
  return entry.enabled;
}

/**
 * Set a skill's enabled flag and persist.
 * @param {string} name
 * @param {boolean} enabled
 * @returns {{ name: string, enabled: boolean, updatedAt: string }}
 */
function setEnabled(name, enabled) {
  if (!name) throw new Error('skillStateService.setEnabled requires a skill name');
  const data = _load();
  const entry = {
    enabled: !!enabled,
    updatedAt: new Date().toISOString(),
  };
  data.skills[name] = entry;
  data.version = STATE_VERSION;
  _save(data);
  return { name, ...entry };
}

/**
 * List all explicit state entries.
 * @returns {{ name: string, enabled: boolean, updatedAt: string }[]}
 */
function list() {
  const data = _load();
  return Object.entries(data.skills).map(([name, e]) => ({
    name,
    enabled: e && typeof e.enabled === 'boolean' ? e.enabled : true,
    updatedAt: e && e.updatedAt ? e.updatedAt : null,
  }));
}

module.exports = {
  isEnabled,
  setEnabled,
  list,
  _stateFile, // exposed for tests
};
