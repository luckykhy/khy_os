'use strict';

/**
 * _toolSyntaxHealer — pure leaf: detects and repairs common syntax errors in
 * tool definition files, so that a single typo doesn't brick an entire tool.
 *
 * Contract: zero IO beyond reading/writing the single target file, deterministic,
 * idempotent (running twice = no-op on the second run), env-gated default-on
 * (KHY_TOOL_SYNTAX_HEAL, only 0/false/off/no disables), fail-soft never throws.
 *
 * Design: regex-based line-scan transformations. Each pattern is self-describing
 * (`name` field) so the repair log can report *what* was fixed. Patterns are
 * anchored to class-body context (leading `static`) to minimize false positives.
 *
 * Currently healed:
 *   static <prop>: '<string>'  →  static <prop> = '<string>'
 *   static <prop>: "<string>"  →  static <prop> = "<string>"
 *   static <prop>: `<template>`  →  static <prop> = `<template>`
 *   static <prop>: <number>    →  static <prop> = <number>
 *   static <prop>: true|false|null  →  static <prop> = true|false|null
 *   static <prop>: <identifier>  →  static <prop> = <identifier>
 *
 * Specification: docs/04_IMPL_实现/[IMPL-RPT-045] 工具注册表自愈层规范.md
 */

const fs = require('fs');

// ── Heal patterns ─────────────────────────────────────────────────────
// Each: { name, regex, replacement } — regex must have ^ anchor per-line (gm).
// The regex captures `static <prop>` in group 1 and the value expression in group 2.
const HEAL_PATTERNS = [
  {
    name: 'static-field-colon-instead-of-equals',
    // Matches: static <prop>: <string|number|boolean|null|template|identifier>
    // Does NOT match: static <prop>: { ... } or static <prop>: [ ... ] (object/array literals,
    // which are rarer and riskier to auto-fix without understanding the full structure).
    regex: /^(\s*)(static\s+\w+)\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|\d+\.?\d*|true|false|null|[a-zA-Z_$]\w*)(.*)$/gm,
    replacement: '$1$2 = $3$4',
  },
];

// ── Gating ────────────────────────────────────────────────────────────

function _isEnabled() {
  const v = String(process.env.KHY_TOOL_SYNTAX_HEAL || '')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// ── Pure transform (no IO) — primary surface for unit testing ─────────

/**
 * Apply all heal patterns to a source string.
 * @param {string} source - File content to heal
 * @returns {{ source: string, changes: Array<{ line: number, pattern: string, before: string, after: string }> }}
 */
function healSource(source) {
  const changes = [];
  let result = source;

  for (const pattern of HEAL_PATTERNS) {
    // Create a fresh regex instance to avoid lastIndex state issues across calls
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    result = result.replace(regex, (...args) => {
      // regex replace args: [fullMatch, group1, group2, group3, ..., offset, string]
      const fullMatch = args[0];
      const offset = args[args.length - 2];
      const original = args[args.length - 1];

      // Compute line number from offset
      const lineNum = original.slice(0, offset).split('\n').length;

      // Apply replacement using the pattern's replacement string
      const after = fullMatch.replace(
        new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '')),
        pattern.replacement
      );

      changes.push({
        line: lineNum,
        pattern: pattern.name,
        before: fullMatch,
        after,
      });

      return after;
    });
  }

  return { source: result, changes };
}

// ── File IO wrapper ───────────────────────────────────────────────────

/**
 * Read a file, apply heal patterns, write back if changed.
 * @param {string} filePath - Absolute path to the file to heal
 * @returns {{ healed: boolean, changes: Array, error?: string }}
 *   healed=true means the file was modified. changes is empty when no change.
 *   error captures read/write failures (fail-soft, never throws).
 */
function healFile(filePath) {
  if (!_isEnabled()) {
    return { healed: false, changes: [] };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { healed: false, changes: [], error: `read failed: ${err.message}` };
  }

  const { source: healed, changes } = healSource(raw);

  if (changes.length === 0) {
    return { healed: false, changes: [] };
  }

  try {
    fs.writeFileSync(filePath, healed, 'utf-8');
  } catch (err) {
    return { healed: false, changes, error: `write failed: ${err.message}` };
  }

  return { healed: true, changes };
}

// ── Exports ───────────────────────────────────────────────────────────

module.exports = {
  healSource,
  healFile,
  HEAL_PATTERNS,
  _isEnabled,
};
