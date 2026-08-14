/**
 * parameterNormalizationEngine — ladder-style tool-parameter correction for
 * small models (T2/T3), stage 3.3 of the small-model normalization pipeline.
 *
 * A weak model frequently emits *near-miss* tool parameters: quoted numbers
 * ("30" instead of 30), stringified booleans ('true'), a scalar where the
 * schema wants a single-element array (or vice versa), and enum typos
 * ('exicute' for 'execute'). Rejecting those verbatim burns a full model
 * round-trip per mistake. This engine repairs the SAFE subset deterministically
 * and returns a structured Chinese fix hint for everything it refuses to touch,
 * so the loop can feed the hint back to the model for self-correction.
 *
 * Ladder policy (attemptCount starts at 1):
 *   attempt 1  — safe type coercions ONLY:
 *                  numeric string → number, 'true'/'false' → boolean,
 *                  single-element array → scalar (schema expects scalar),
 *                  scalar → single-element array (schema expects array)
 *   attempt ≥2 — additionally: enum fuzzy repair (Levenshtein, mirroring the
 *                _closestEnumOption suggestion logic in tools/_baseTool.js),
 *                applied ONLY when there is a single high-confidence candidate.
 *
 * RED LINE — never auto-rewritten, hint only:
 *   • path-like fields  (name contains path/file/dir/cwd, or schema `format`
 *     hints at a filesystem path)
 *   • command-like fields (name contains command/cmd/script/shell)
 * A silently "repaired" path or command could redirect a write or execute a
 * different program — the model must fix those itself from the hint.
 *
 * Pure leaf: no IO, deterministic, never throws. Only leaf-module requires
 * (_baseTool.validateParams, ccValidationError.levenshteinDistance,
 * constants/smallModelDefaults) — no cycle with toolCalling.js, which loads
 * this module lazily.
 *
 * @module services/parameterNormalizationEngine
 */
'use strict';

// Schema validation single source of truth — the exact validator used by the
// executeTool funnel, so "valid" here means "will pass the funnel check".
const { validateParams } = require('../tools/_baseTool');
// Pure Levenshtein leaf (zero IO, never throws) — same primitive that powers
// the `Did you mean "x"?` suggestions in _baseTool.validateParams().
const { levenshteinDistance } = require('../tools/ccValidationError');

// ── Thresholds (module constants + env override — zero hardcoding at call sites) ──

// Max Levenshtein distance for an enum candidate to count as high-confidence.
// Mirrors the distance bound used by _baseTool._closestEnumOption.
const ENUM_MAX_DISTANCE_DEFAULT = 2;
// The ladder rung at which enum fuzzy repair unlocks (attempt 1 = types only).
const ENUM_MIN_ATTEMPT_DEFAULT = 2;

// RED LINE field-name patterns. Deliberately NOT env-relaxable — the red line
// must hold regardless of environment configuration.
const PATH_FIELD_RE = /(path|file|dir|cwd)/i;
const COMMAND_FIELD_RE = /(command|cmd|script|shell)/i;
// Schema `format` values that hint at a filesystem path.
const PATH_FORMAT_RE = /(path|file|dir|uri)/i;

// Correction rule identifiers (audit vocabulary).
const RULE_TYPE_COERCE = 'type-coerce';
const RULE_ARRAY_UNWRAP = 'array-unwrap';
const RULE_ARRAY_WRAP = 'array-wrap';
const RULE_ENUM_FUZZY = 'enum-fuzzy';

// Strict decimal literal (optionally signed, optional fraction). Anything
// looser (hex, exponent, '1,000') is NOT a safe coercion.
const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

// ── Env helpers (lazy reads — test-friendly, never throw) ───────────────────

/**
 * Parse a positive-integer env var; invalid/missing → fallback.
 * @param {*} raw
 * @param {number} fallback
 * @returns {number}
 */
function _intEnv(raw, fallback) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Max Levenshtein distance for enum fuzzy repair.
 * Env: KHY_PARAM_COERCE_ENUM_MAX_DISTANCE — non-negative integer.
 * @param {object} [env]
 * @returns {number}
 */
function getEnumMaxDistance(env = process.env) {
  return _intEnv(env && env.KHY_PARAM_COERCE_ENUM_MAX_DISTANCE, ENUM_MAX_DISTANCE_DEFAULT);
}

/**
 * First ladder attempt at which enum fuzzy repair is allowed.
 * Env: KHY_PARAM_COERCE_ENUM_MIN_ATTEMPT — positive integer.
 * @param {object} [env]
 * @returns {number}
 */
function getEnumMinAttempt(env = process.env) {
  const n = _intEnv(env && env.KHY_PARAM_COERCE_ENUM_MIN_ATTEMPT, ENUM_MIN_ATTEMPT_DEFAULT);
  return n > 0 ? n : ENUM_MIN_ATTEMPT_DEFAULT;
}

// ── Schema / field classification ───────────────────────────────────────────

/**
 * Resolve the flat validation schema from a tool-ish input. Accepts:
 *   • defineTool() products / registry tools  → tool.inputSchema
 *   • builtin descriptors                     → tool.parameters
 *   • a bare flat schema map itself           → the object as-is
 * @param {object} tool
 * @returns {object|null}
 */
function _resolveSchema(tool) {
  if (!tool || typeof tool !== 'object') {
    return null;
  }
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    return tool.inputSchema;
  }
  if (tool.parameters && typeof tool.parameters === 'object') {
    return tool.parameters;
  }
  // Bare schema map (no tool identity markers) — treat the object itself as schema.
  if (!tool.name && !tool.execute && !tool.handler) {
    return tool;
  }
  return null;
}

/**
 * RED LINE check: is this field path-like or command-like? Protected fields
 * are NEVER auto-rewritten — only mentioned in the fix hint.
 * @param {string} field
 * @param {object} [rule] - Schema rule (checked for a path-hinting `format`)
 * @returns {boolean}
 */
function isProtectedField(field, rule) {
  const name = String(field || '');
  if (PATH_FIELD_RE.test(name) || COMMAND_FIELD_RE.test(name)) {
    return true;
  }
  if (rule && typeof rule.format === 'string' && PATH_FORMAT_RE.test(rule.format)) {
    return true;
  }
  return false;
}

// ── Coercion primitives (pure, never throw) ─────────────────────────────────

/**
 * Attempt a SAFE scalar type coercion for one value against one rule.
 * @param {object} rule - Schema rule with `type`
 * @param {*} value
 * @returns {{ changed: boolean, value: *, rule?: string }}
 */
function _coerceScalar(rule, value) {
  const expected = rule && rule.type;
  if (!expected) {
    return { changed: false, value };
  }

  // Numeric string → number ("123" → 123, "-4.5" → -4.5).
  if (expected === 'number' && typeof value === 'string') {
    const trimmed = value.trim();
    if (NUMERIC_STRING_RE.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        return { changed: true, value: n, rule: RULE_TYPE_COERCE };
      }
    }
    return { changed: false, value };
  }

  // 'true'/'false' string → boolean (case-insensitive).
  if (expected === 'boolean' && typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') {
      return { changed: true, value: true, rule: RULE_TYPE_COERCE };
    }
    if (lower === 'false') {
      return { changed: true, value: false, rule: RULE_TYPE_COERCE };
    }
    return { changed: false, value };
  }

  return { changed: false, value };
}

/**
 * Fuzzy-repair an enum near-miss: returns the corrected option ONLY when there
 * is a single high-confidence candidate (exact case-insensitive match, or
 * exactly ONE option within the distance threshold). Ambiguity → null.
 * Mirrors _baseTool._closestEnumOption but with a stricter uniqueness gate,
 * because here we REWRITE the value instead of merely suggesting it.
 * @param {*} value
 * @param {Array} options
 * @param {number} maxDistance
 * @returns {string|null}
 */
function _uniqueEnumCandidate(value, options, maxDistance) {
  if (typeof value !== 'string' || !value || !Array.isArray(options)) {
    return null;
  }
  const lower = value.toLowerCase();
  // Exact case-insensitive match wins outright (pure casing mistake).
  for (const opt of options) {
    if (typeof opt === 'string' && opt.toLowerCase() === lower) {
      return opt;
    }
  }
  const hits = [];
  for (const opt of options) {
    if (typeof opt !== 'string' || !opt) {
      continue;
    }
    const dist = levenshteinDistance(lower, opt.toLowerCase());
    if (dist <= maxDistance) {
      hits.push(opt);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// ── Fix-hint builder (Chinese, model-facing) ────────────────────────────────

/**
 * Compact JSON preview of a value for hint messages (≤60 chars, never throws).
 * @param {*} value
 * @returns {string}
 */
function _preview(value) {
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    s = undefined;
  }
  if (s === undefined) {
    s = String(value);
  }
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/**
 * Build a structured Chinese fix hint from a failed validation, listing the
 * expected type / enum values / example per offending field, plus a red-line
 * note for protected fields. Returned to the model for self-correction.
 * @param {object} schema - Flat schema map
 * @param {object} params - The (possibly partially corrected) params
 * @param {object} validation - validateParams() result (invalid)
 * @returns {string}
 */
function buildFixHint(schema, params, validation) {
  const lines = ['参数校验未通过，请按以下要求修正后重新调用：'];
  const seen = new Set();
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];
  for (const issue of issues) {
    const key = issue && issue.param;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const rule = (schema && schema[key]) || {};
    const parts = [];
    if (issue.kind === 'missing') {
      parts.push(`缺少必填参数，期望类型 ${rule.type || 'string'}`);
    } else if (issue.kind === 'type') {
      parts.push(
        `期望类型 ${issue.expected}，实际收到 ${issue.received}（当前值: ${_preview(params[key])}）`
      );
    } else {
      parts.push(issue.message || `取值不符合约束（当前值: ${_preview(params[key])}）`);
    }
    if (rule.enum && Array.isArray(rule.enum)) {
      parts.push(`可选枚举值: ${rule.enum.join(' | ')}`);
    }
    if (rule.example !== undefined) {
      parts.push(`示例: ${_preview(rule.example)}`);
    }
    if (isProtectedField(key, rule)) {
      parts.push('（路径/命令类参数不会被自动纠正，请自行提供准确值）');
    }
    lines.push(`- ${key}: ${parts.join('；')}`);
  }
  // Validation failed but no classified issue (defensive) — generic fallback line.
  if (lines.length === 1) {
    const errs = (validation && validation.errors) || [];
    lines.push(`- 错误详情: ${errs.join('; ') || '参数不符合工具 schema'}`);
  }
  return lines.join('\n');
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Normalize near-miss parameters against a tool schema with the ladder policy,
 * then re-validate. Never throws; never mutates the input `params`.
 *
 * @param {object} tool - Tool definition ({ inputSchema } | { parameters }) or a bare flat schema map
 * @param {object} params - Raw parameters from the model
 * @param {object} [opts]
 * @param {string} [opts.modelTier] - 'T0'..'T3' (informational; ladder depth is driven by attemptCount)
 * @param {number} [opts.attemptCount=1] - Ladder rung, starts at 1
 * @param {object} [opts.env] - Env override for thresholds (defaults to process.env)
 * @returns {{ valid: boolean, params: object, corrections: Array<{field:string,from:*,to:*,rule:string}>, severity: ('ok'|'corrected'|'warning'|'error'), hint: (string|null) }}
 */
function normalizeAndValidate(tool, params, opts = {}) {
  const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  try {
    const env = (opts && opts.env) || process.env;
    const attemptCount = Number.isFinite(Number(opts && opts.attemptCount))
      ? Math.max(1, Math.floor(Number(opts.attemptCount)))
      : 1;
    const schema = _resolveSchema(tool);

    // No schema → nothing to validate against; pass through untouched.
    if (!schema) {
      return { valid: true, params: safeParams, corrections: [], severity: 'ok', hint: null };
    }

    // Fast path: already valid → zero rewrites.
    const initial = validateParams(schema, safeParams);
    if (initial.valid) {
      return { valid: true, params: safeParams, corrections: [], severity: 'ok', hint: null };
    }

    const corrections = [];
    const out = { ...safeParams };
    const enumUnlocked = attemptCount >= getEnumMinAttempt(env);
    const enumMaxDist = getEnumMaxDistance(env);

    for (const [key, rule] of Object.entries(schema)) {
      if (!rule || typeof rule !== 'object') {
        continue;
      }
      let value = out[key];
      if (value === undefined || value === null) {
        continue;
      }

      // RED LINE: path/command-like fields are hint-only, never rewritten.
      if (isProtectedField(key, rule)) {
        continue;
      }

      const original = value;
      let appliedRule = null;

      // Single-element array → scalar (schema expects a non-array scalar).
      if (rule.type && rule.type !== 'array' && Array.isArray(value) && value.length === 1) {
        value = value[0];
        appliedRule = RULE_ARRAY_UNWRAP;
      }

      // Safe scalar coercions (number-string, boolean-string). May follow an
      // unwrap in the same pass (e.g. ["30"] → "30" → 30).
      const coerced = _coerceScalar(rule, value);
      if (coerced.changed) {
        value = coerced.value;
        appliedRule = appliedRule || coerced.rule;
      }

      // Scalar → single-element array (schema expects an array).
      if (rule.type === 'array' && !Array.isArray(value) && typeof value !== 'object') {
        value = [value];
        appliedRule = RULE_ARRAY_WRAP;
      }

      // Enum fuzzy repair — attempt ≥2 only, single high-confidence candidate only.
      if (
        enumUnlocked &&
        appliedRule === null &&
        rule.enum &&
        Array.isArray(rule.enum) &&
        typeof value === 'string' &&
        !rule.enum.includes(value)
      ) {
        const candidate = _uniqueEnumCandidate(value, rule.enum, enumMaxDist);
        if (candidate !== null && candidate !== value) {
          value = candidate;
          appliedRule = RULE_ENUM_FUZZY;
        }
      }

      if (appliedRule !== null && value !== original) {
        out[key] = value;
        corrections.push({ field: key, from: original, to: value, rule: appliedRule });
      }
    }

    // Re-validate the corrected shape against the same authoritative validator.
    const revalidation = corrections.length > 0 ? validateParams(schema, out) : initial;
    if (revalidation.valid) {
      return {
        valid: true,
        params: out,
        corrections,
        severity: corrections.length > 0 ? 'corrected' : 'ok',
        hint: null,
      };
    }

    // Still invalid → structured Chinese hint for model self-correction.
    return {
      valid: false,
      params: out,
      corrections,
      severity: corrections.length > 0 ? 'warning' : 'error',
      hint: buildFixHint(schema, out, revalidation),
    };
  } catch {
    // Fail-soft: an internal engine fault must never mask the original
    // validation failure — report invalid with no corrections, no hint.
    return { valid: false, params: safeParams, corrections: [], severity: 'error', hint: null };
  }
}

module.exports = {
  normalizeAndValidate,
  buildFixHint,
  isProtectedField,
  // Threshold getters (env-overridable — zero hardcoding at call sites)
  getEnumMaxDistance,
  getEnumMinAttempt,
  // Built-in defaults (read-only reference)
  ENUM_MAX_DISTANCE_DEFAULT,
  ENUM_MIN_ATTEMPT_DEFAULT,
};
