'use strict';

/**
 * _toolHealer — pure leaf: classifies and repairs tool definition errors.
 *
 * Contract: zero IO (no fs, no network, no subprocess, no process.exit),
 * deterministic (same input → same output), never throws. Env-gated default-on
 * (`KHY_TOOL_HEAL`, only 0/false/off/no disables).
 *
 * Design: each error is classified into a HEAL_CLASS. A healer function receives
 * the invalid value + the valid options and returns `{ repaired, value, confidence }`.
 * Unknown/unrepairable values fall back to a safe default with confidence:'fallback'.
 *
 * Heal classes (taxonomy of all tool-definition errors):
 *
 *   E1  static-field-colon          static x: 'v'  →  static x = 'v'         (file-level, see _toolSyntaxHealer)
 *   E2  invalid-category            category = 'protocol'  → fuzzy-match CATEGORIES
 *   E3  invalid-risk                risk = 'mdeium'  → fuzzy-match RISK_LEVELS
 *   E4  invalid-enum                interruptBehavior = 'stop'  → fuzzy-match VALID_INTERRUPT_BEHAVIORS
 *   E5  type-mismatch               shouldDefer = 'true'  → coerce literal to target type
 *   E6  invalid-array               aliases = 'single'  → wrap in ['single']
 *
 * Specification: docs/04_IMPL_实现/[IMPL-RPT-045] 工具注册表自愈层规范.md
 */

const { RISK_LEVELS } = require('../constants/riskOrder');

// ── Valid value registries ────────────────────────────────────────────
// Each registry is a frozen array of valid strings. Healers fuzzy-match against these.

const VALID_CATEGORIES = Object.freeze([
  'data',
  'analysis',
  'execution',
  'filesystem',
  'git',
  'system',
  'optimization',
  'coordinator',
  'mcp',
  'multimodal',
  'storage',
  'ai',
  'training',
  'realtime',
  'custom',
]);

const VALID_RISK_LEVELS = Object.freeze([...RISK_LEVELS]); // ['safe','low','medium','high','critical']

const VALID_INTERRUPT_BEHAVIORS = Object.freeze(['cancel', 'block']);

// ── Fuzzy-match core (shared across E2/E3/E4) ─────────────────────────

/**
 * Levenshtein distance — pure, never throws.
 */
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array(b.length + 1).fill(0).map((_, i) => i);
  let curr = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Find the closest valid option using Levenshtein + prefix match.
 * @param {string} value - The invalid value (already trimmed, lowercased)
 * @param {string[]} validOptions - Array of valid string options
 * @returns {{ match: string, dist: number } | null}
 */
function _closestOption(value, validOptions) {
  if (!value) return null;

  let best = null;
  for (const opt of validOptions) {
    const optLower = opt.toLowerCase();
    const dist = _levenshtein(value, optLower);
    const prefixHit = optLower.startsWith(value) || value.startsWith(optLower);

    if (dist <= 2 || prefixHit) {
      if (!best || dist < best.dist) {
        best = { match: opt, dist };
      }
    }
  }
  return best;
}

// ── Heal class handlers ────────────────────────────────────────────────

/**
 * E2: Repair an invalid category.
 * @param {string} raw - The raw category string from the tool definition
 * @returns {{ repaired: boolean, value: string, confidence: 'exact'|'fuzzy'|'fallback' }}
 */
function healCategory(raw) {
  const value = String(raw || '').trim().toLowerCase();

  if (!value) {
    return { repaired: true, value: 'custom', confidence: 'fallback' };
  }
  if (VALID_CATEGORIES.includes(value)) {
    return { repaired: false, value, confidence: 'exact' };
  }

  const closest = _closestOption(value, VALID_CATEGORIES);
  if (closest) {
    return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  }

  return { repaired: true, value: 'custom', confidence: 'fallback' };
}

/**
 * E3: Repair an invalid risk level.
 * @param {string} raw - The raw risk string
 * @returns {{ repaired: boolean, value: string, confidence: 'exact'|'fuzzy'|'fallback' }}
 */
function healRisk(raw) {
  const value = String(raw || '').trim().toLowerCase();

  if (!value) {
    return { repaired: true, value: 'medium', confidence: 'fallback' };
  }
  if (VALID_RISK_LEVELS.includes(value)) {
    return { repaired: false, value, confidence: 'exact' };
  }

  const closest = _closestOption(value, VALID_RISK_LEVELS);
  if (closest) {
    return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  }

  return { repaired: true, value: 'medium', confidence: 'fallback' };
}

/**
 * E4: Repair an invalid enum value (generic — works for any enum registry).
 * @param {string} raw - The raw enum value
 * @param {string[]} validOptions - The valid enum members
 * @param {string} fallback - The safe fallback value
 * @returns {{ repaired: boolean, value: string, confidence: 'exact'|'fuzzy'|'fallback' }}
 */
function healEnum(raw, validOptions, fallback) {
  const value = String(raw || '').trim().toLowerCase();

  if (!value) {
    return { repaired: true, value: fallback, confidence: 'fallback' };
  }
  if (validOptions.includes(value)) {
    return { repaired: false, value, confidence: 'exact' };
  }

  const closest = _closestOption(value, validOptions);
  if (closest) {
    return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  }

  return { repaired: true, value: fallback, confidence: 'fallback' };
}

/**
 * E5: Coerce a literal value to the expected type.
 * Handles the common case where a boolean/string/number is wrapped in quotes
 * or a string is used where a boolean is expected.
 * @param {*} value - The raw value
 * @param {string} targetType - 'boolean' | 'string' | 'number' | 'array'
 * @returns {{ repaired: boolean, value: * }}
 */
function healType(value, targetType) {
  if (value === null || value === undefined) {
    return { repaired: false, value };
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType === targetType) {
    return { repaired: false, value };
  }

  // String → boolean
  if (targetType === 'boolean' && actualType === 'string') {
    const lowered = value.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) {
      return { repaired: true, value: true };
    }
    if (['false', '0', 'no', 'off'].includes(lowered)) {
      return { repaired: true, value: false };
    }
  }

  // String → number
  if (targetType === 'number' && actualType === 'string') {
    const num = Number(value);
    if (!Number.isNaN(num)) {
      return { repaired: true, value: num };
    }
  }

  // Boolean → string
  if (targetType === 'string' && actualType === 'boolean') {
    return { repaired: true, value: String(value) };
  }

  // Number → string
  if (targetType === 'string' && actualType === 'number') {
    return { repaired: true, value: String(value) };
  }

  // Cannot safely coerce — return as-is
  return { repaired: false, value };
}

// ── Gating ────────────────────────────────────────────────────────────

function isEnabled() {
  const v = String(process.env.KHY_TOOL_HEAL || '')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// ── Unified entry point ────────────────────────────────────────────────

/**
 * Heal a single field by class.
 * @param {string} healClass - 'category' | 'risk' | 'enum' | 'type'
 * @param {*} value - The raw value from the tool definition
 * @param {object} [options] - Extra context (validOptions, targetType, fallback)
 * @returns {{ repaired: boolean, value: *, confidence?: string }}
 */
function heal(healClass, value, options = {}) {
  if (!isEnabled()) {
    return { repaired: false, value };
  }

  switch (healClass) {
    case 'category':
      return healCategory(value);
    case 'risk':
      return healRisk(value);
    case 'enum':
      return healEnum(value, options.validOptions || [], options.fallback || '');
    case 'type':
      return healType(value, options.targetType);
    default:
      return { repaired: false, value };
  }
}

// ── Learned Patterns (修复学习) ───────────────────────────────────────
// 手动修复后注册模式，下次同类错误自动修复。
// Key: `${healClass}:${invalidValue}` → Value: correctValue

const _learnedPatterns = new Map();

/**
 * Register a learned pattern from a manual fix.
 * @param {string} healClass - 'category' | 'risk' | 'enum' | 'type'
 * @param {string} invalidValue - The invalid value encountered
 * @param {string} correctValue - The correct value after fix
 * @param {string} [context] - Optional context key (e.g., field name for enum)
 */
function learnPattern(healClass, invalidValue, correctValue, context) {
  const key = context ? `${healClass}:${context}:${invalidValue}` : `${healClass}:${invalidValue}`;
  _learnedPatterns.set(key, correctValue);
}

/**
 * Get a learned pattern for an invalid value.
 * @param {string} healClass - 'category' | 'risk' | 'enum' | 'type'
 * @param {string} invalidValue - The invalid value encountered
 * @param {string} [context] - Optional context key
 * @returns {string|undefined} The learned correct value, or undefined
 */
function getLearnedPattern(healClass, invalidValue, context) {
  const key = context ? `${healClass}:${context}:${invalidValue}` : `${healClass}:${invalidValue}`;
  return _learnedPatterns.get(key);
}

/**
 * Check if a learned pattern exists.
 * @param {string} healClass - 'category' | 'risk' | 'enum' | 'type'
 * @param {string} invalidValue - The invalid value encountered
 * @param {string} [context] - Optional context key
 * @returns {boolean}
 */
function hasLearnedPattern(healClass, invalidValue, context) {
  const key = context ? `${healClass}:${context}:${invalidValue}` : `${healClass}:${invalidValue}`;
  return _learnedPatterns.has(key);
}

/**
 * Get all learned patterns (for auditing/persistence).
 * @returns {Array<{ key: string, value: string }>}
 */
function getAllLearnedPatterns() {
  return [..._learnedPatterns.entries()].map(([key, value]) => ({ key, value }));
}

/**
 * Clear all learned patterns.
 */
function clearLearnedPatterns() {
  _learnedPatterns.clear();
}

// ── Enhanced heal functions with learning ─────────────────────────────

/**
 * Enhanced healCategory with learning support.
 */
function healCategoryWithLearning(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return { repaired: true, value: 'custom', confidence: 'fallback' };
  if (VALID_CATEGORIES.includes(value)) return { repaired: false, value, confidence: 'exact' };
  
  // Check learned patterns first (exact match)
  const learned = getLearnedPattern('category', value);
  if (learned) return { repaired: true, value: learned, confidence: 'learned' };
  
  // Fall back to fuzzy match
  const closest = _closestOption(value, VALID_CATEGORIES);
  if (closest) return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  
  return { repaired: true, value: 'custom', confidence: 'fallback' };
}

/**
 * Enhanced healRisk with learning support.
 */
function healRiskWithLearning(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return { repaired: true, value: 'medium', confidence: 'fallback' };
  if (VALID_RISK_LEVELS.includes(value)) return { repaired: false, value, confidence: 'exact' };
  
  const learned = getLearnedPattern('risk', value);
  if (learned) return { repaired: true, value: learned, confidence: 'learned' };
  
  const closest = _closestOption(value, VALID_RISK_LEVELS);
  if (closest) return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  
  return { repaired: true, value: 'medium', confidence: 'fallback' };
}

/**
 * Enhanced healEnum with learning support.
 */
function healEnumWithLearning(raw, validOptions, fallback, context) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return { repaired: true, value: fallback, confidence: 'fallback' };
  if (validOptions.includes(value)) return { repaired: false, value, confidence: 'exact' };
  
  const learned = getLearnedPattern('enum', value, context);
  if (learned && validOptions.includes(learned)) {
    return { repaired: true, value: learned, confidence: 'learned' };
  }
  
  const closest = _closestOption(value, validOptions);
  if (closest) return { repaired: true, value: closest.match, confidence: 'fuzzy' };
  
  return { repaired: true, value: fallback, confidence: 'fallback' };
}

// ── Exports ───────────────────────────────────────────────────────────

module.exports = {
  heal,
  healCategory,
  healRisk,
  healEnum,
  healType,
  healCategoryWithLearning,
  healRiskWithLearning,
  healEnumWithLearning,
  learnPattern,
  getLearnedPattern,
  hasLearnedPattern,
  getAllLearnedPatterns,
  clearLearnedPatterns,
  isEnabled,
  VALID_CATEGORIES,
  VALID_RISK_LEVELS,
  VALID_INTERRUPT_BEHAVIORS,
  _levenshtein,
  _closestOption,
};
