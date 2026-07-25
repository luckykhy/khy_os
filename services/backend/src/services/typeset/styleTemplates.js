'use strict';

/**
 * styleTemplates.js — loader & resolver for document style templates.
 *
 * Style templates are pure DATA (JSON under src/templates/docstyles/). They are
 * the ONLY place visual formatting is decided — page size, margins, line spacing,
 * indents, per-level fonts/sizes/bold/alignment, and the pagination policy
 * (auto-page-break-before-H1). The model never touches any of this; it only emits
 * the semantic AST (see contentSchema.js), and the renderer (docTypeset.py) reads
 * the resolved template to apply formatting deterministically.
 *
 * Resolution:
 *   resolveTemplate(nameOrPathOrObject, overrides)
 *     - a built-in name  ("gbt7714" | "ieee" | "default")
 *     - an absolute path to a user JSON template
 *     - an inline template object
 *   then deep-merges `overrides` on top, so a user can tweak any single key
 *   (e.g. {paragraph:{lineSpacing:2}}) without restating the whole baseline.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '../../templates/docstyles');
const DEFAULT_TEMPLATE = 'default';

let _cache = null;

/** Lazily load and cache the built-in templates keyed by name. */
function _loadBuiltins() {
  if (_cache) return _cache;
  const out = {};
  let files = [];
  try { files = fs.readdirSync(TEMPLATE_DIR); } catch { files = []; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, f), 'utf-8'));
      const name = json.name || path.basename(f, '.json');
      out[name] = json;
    } catch { /* skip malformed template file */ }
  }
  _cache = out;
  return out;
}

/** List built-in template names + labels for help / discovery. */
function listTemplates() {
  const b = _loadBuiltins();
  return Object.keys(b).map((name) => ({ name, label: b[name].label || name, description: b[name].description || '' }));
}

/** Deep-merge plain objects (arrays and scalars replace; objects merge). */
function _deepMerge(base, over) {
  if (over == null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object') {
    return over;
  }
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = k in base ? _deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

/**
 * Resolve a template spec into a full template object, with overrides applied.
 * @param {string|object} [spec] built-in name, absolute JSON path, or inline object
 * @param {object} [overrides] partial template to deep-merge on top
 * @returns {{template: object|null, error?: string, source?: string}}
 */
function resolveTemplate(spec, overrides) {
  const builtins = _loadBuiltins();
  let base = null;
  let source = null;

  if (spec == null || spec === '') {
    base = builtins[DEFAULT_TEMPLATE];
    source = `builtin:${DEFAULT_TEMPLATE}`;
  } else if (typeof spec === 'object') {
    base = spec;
    source = 'inline';
  } else if (typeof spec === 'string') {
    if (builtins[spec]) {
      base = builtins[spec];
      source = `builtin:${spec}`;
    } else if (path.isAbsolute(spec) || spec.includes('/') || spec.includes('\\')) {
      try {
        base = JSON.parse(fs.readFileSync(spec, 'utf-8'));
        source = `file:${spec}`;
      } catch (e) {
        return { template: null, error: `Could not load template file "${spec}": ${e.message}` };
      }
    } else {
      return {
        template: null,
        error: `Unknown style template "${spec}". Built-ins: ${Object.keys(builtins).join(', ')}. ` +
               `Or pass an absolute path to a JSON template.`,
      };
    }
  } else {
    return { template: null, error: `Invalid template spec type: ${typeof spec}` };
  }

  // Always layer the requested template over the default so partial user/file
  // templates still inherit a complete baseline (every font key present, etc.).
  const merged = source === `builtin:${DEFAULT_TEMPLATE}`
    ? base
    : _deepMerge(builtins[DEFAULT_TEMPLATE] || {}, base);
  const finalTemplate = overrides ? _deepMerge(merged, overrides) : merged;
  return { template: finalTemplate, source };
}

module.exports = {
  TEMPLATE_DIR,
  DEFAULT_TEMPLATE,
  listTemplates,
  resolveTemplate,
  _deepMerge,
};
