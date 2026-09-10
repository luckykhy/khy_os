'use strict';

/**
 * commandManifest.js — Command manifest schema & validation.
 *
 * Single source of truth for the self-registration command convention.
 * Each handler in `handlers/` MAY export a manifest under the key
 * MANIFEST_EXPORT_KEY to opt into auto-discovery. The auto-registry
 * (commandAutoRegistry.js) scans, validates, and dispatches these.
 *
 * Manifest shape:
 *   {
 *     name: 'health',              // canonical command name (required)
 *     aliases: ['jk', '健康'],      // optional aliases (pinyin, Chinese)
 *     description: '…',             // one-line help text
 *     usage: 'health [--json]',     // usage line
 *     subCommands: [],              // optional sub-command list
 *     category: 'system',           // display category
 *     async handler(parsed, ctx) {} // dispatch function (required)
 *   }
 *
 * @module cli/commandManifest
 */

const path = require('path');

// The export key handlers use to expose their manifest.
const MANIFEST_EXPORT_KEY = '__khyCommandManifest';

// Also accept this camelCase key for ergonomics.
const MANIFEST_EXPORT_KEY_ALT = 'commandManifest';

const DEFAULT_CATEGORY = 'extension';

// Where handlers live (relative to this file's directory).
const HANDLERS_DIR = path.join(__dirname, 'handlers');

// Valid categories (loose — only used for help grouping).
const CATEGORIES = new Set([
  'system',
  'data',
  'trading',
  'ai',
  'dev',
  'workflow',
  'extension',
]);

/**
 * Validate a command manifest.
 * @param {unknown} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be a non-null object'] };
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    errors.push('missing required field: name (non-empty string)');
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    errors.push(`invalid name "${manifest.name}": must be kebab-case (a-z, 0-9, hyphens; first char alphanumeric)`);
  }

  if (typeof manifest.handler !== 'function') {
    errors.push('missing required field: handler (function)');
  }

  if (manifest.aliases !== undefined) {
    if (!Array.isArray(manifest.aliases)) {
      errors.push('aliases must be an array of strings');
    } else {
      for (const a of manifest.aliases) {
        if (typeof a !== 'string' || !a.trim()) {
          errors.push(`invalid alias: ${JSON.stringify(a)}`);
        }
      }
    }
  }

  if (manifest.subCommands !== undefined) {
    if (!Array.isArray(manifest.subCommands)) {
      errors.push('subCommands must be an array of strings');
    } else {
      for (const s of manifest.subCommands) {
        if (typeof s !== 'string') {
          errors.push(`invalid subCommand: ${JSON.stringify(s)}`);
        }
      }
    }
  }

  if (manifest.category !== undefined && !CATEGORIES.has(manifest.category)) {
    errors.push(`unknown category "${manifest.category}": expected one of ${[...CATEGORIES].join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract a manifest from a handler module's exports.
 * Checks both MANIFEST_EXPORT_KEY and MANIFEST_EXPORT_KEY_ALT.
 * @param {object} mod — the required module
 * @returns {{ manifest: object|null, key: string|null }}
 */
function extractManifest(mod) {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    return { manifest: null, key: null };
  }
  if (mod[MANIFEST_EXPORT_KEY] && typeof mod[MANIFEST_EXPORT_KEY] === 'object') {
    return { manifest: mod[MANIFEST_EXPORT_KEY], key: MANIFEST_EXPORT_KEY };
  }
  if (mod[MANIFEST_EXPORT_KEY_ALT] && typeof mod[MANIFEST_EXPORT_KEY_ALT] === 'object') {
    return { manifest: mod[MANIFEST_EXPORT_KEY_ALT], key: MANIFEST_EXPORT_KEY_ALT };
  }
  return { manifest: null, key: null };
}

module.exports = {
  MANIFEST_EXPORT_KEY,
  MANIFEST_EXPORT_KEY_ALT,
  DEFAULT_CATEGORY,
  HANDLERS_DIR,
  CATEGORIES,
  validateManifest,
  extractManifest,
};
