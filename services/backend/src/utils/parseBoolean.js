'use strict';

/**
 * parseBoolean.js — single source of truth for coercing a loosely-typed value
 * (env var, CLI flag, config field) into a boolean with a fallback default.
 *
 * Replaces the per-module boolean parsers (modelRouter / proxyServer /
 * cli/handlers/proxy / observability metrics+otel / aiManagementServer) that
 * each re-declared the same truthy/falsy token sets. Centralizing means the
 * accepted tokens change in one place only.
 *
 * Two token tiers, both sourced here:
 *   - base:     1/true/yes/on  ↔  0/false/no/off
 *   - extended: base + single-letter y ↔ n   (default)
 * Pass { extended: false } for parsers that intentionally reject y/n.
 *
 * Accepts boolean passthrough; treats null/undefined/'' as "unset" → fallback.
 * Token matching is case-insensitive and trimmed.
 *
 * @param {*} raw - Value to coerce (boolean, string, or nullish).
 * @param {boolean} [fallback=false] - Returned when raw is unset or unrecognized.
 * @param {{extended?: boolean}} [opts] - extended=false drops the y/n shorthand.
 * @returns {boolean}
 */
const BASE_TRUTHY = ['1', 'true', 'yes', 'on'];
const BASE_FALSY = ['0', 'false', 'no', 'off'];
const TRUTHY = Object.freeze([...BASE_TRUTHY, 'y']);
const FALSY = Object.freeze([...BASE_FALSY, 'n']);
const FROZEN_BASE_TRUTHY = Object.freeze([...BASE_TRUTHY]);
const FROZEN_BASE_FALSY = Object.freeze([...BASE_FALSY]);

function parseBoolean(raw, fallback = false, opts = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  const extended = opts.extended !== false;
  const truthy = extended ? TRUTHY : BASE_TRUTHY;
  const falsy = extended ? FALSY : BASE_FALSY;
  if (truthy.includes(normalized)) return true;
  if (falsy.includes(normalized)) return false;
  return fallback;
}

module.exports = parseBoolean;
module.exports.TRUTHY = TRUTHY;
module.exports.FALSY = FALSY;
module.exports.BASE_TRUTHY = FROZEN_BASE_TRUTHY;
module.exports.BASE_FALSY = FROZEN_BASE_FALSY;
