'use strict';

const fs = require('fs');
const path = require('path');

/**
 * suppression.js — `khy-allow-<RULE-ID>: <reason>` inline suppression.
 *
 * Generalizes the repo's existing `khy-allow-unbounded-loop: <reason>`
 * convention (RUNTIME-003 exemption) from one hardcoded id to a registry-id
 * parameter. Suppression is line-scoped, must carry a reason, and is never
 * silent: suppressed findings still land in the ledger with the reason.
 *
 * Syntax (line comment or block comment opener on the offending line):
 *   // khy-allow-RUNTIME-001: 端点探测夹具，域名仅作 .endsWith 比较
 *   /* khy-allow-SECURITY-001: 示例代码，非生产密钥 *\/
 *   # khy-allow-PROCESS-002: release 分支豁免
 */

const SUPPRESSION_PATTERN = /khy-allow-([A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})\s*:\s*([^\n*\/]*)/g;

/**
 * Extract suppressions keyed by rule id -> array of { line, reason }.
 * Only lines whose comment carries a non-empty reason are recorded; an empty
 * reason means the suppression is invalid and must not take effect.
 */
function readSuppressions(absFile) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch (error) {
    return { suppressions: map, invalid: [] };
  }

  const lines = text.split(/\r?\n/);
  const invalid = [];

  lines.forEach((line, index) => {
    SUPPRESSION_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(SUPPRESSION_PATTERN)) {
      const ruleId = match[1];
      const reason = match[2].trim();
      if (!reason) {
        invalid.push({ file: absFile, line: index + 1, ruleId, reason: '' });
        continue;
      }
      if (!map.has(ruleId)) map.set(ruleId, []);
      map.get(ruleId).push({ line: index + 1, reason });
    }
  });

  return { suppressions: map, invalid };
}

/**
 * Is (ruleId, file, line) suppressed? A suppression line applies to the
 * finding on that same line, or to the next non-blank line when the comment
 * sits directly above it — the two idioms both appear in this repo.
 */
function isSuppressed(absFile, ruleId, line) {
  const { suppressions } = readSuppressions(absFile);
  const entries = suppressions.get(ruleId);
  if (!entries) return null;
  return entries.find((entry) => entry.line === line || entry.line + 1 === line) || null;
}

module.exports = { SUPPRESSION_PATTERN, readSuppressions, isSuppressed };
