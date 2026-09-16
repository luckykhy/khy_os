'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ledger.js — append-only violation ledger at .khy/ruleguard/violations.jsonl.
 *
 * The ledger is the evidence source for "how do we know compliance is real":
 * it turns per-run stdout into queryable history. Only violations are
 * recorded (passes are not), so volume stays bounded.
 */

const LEDGER_DIR = path.join('.khy', 'ruleguard');
const LEDGER_FILE = 'violations.jsonl';
const SPLIT_BYTES = 1024 * 1024;

/** Resolve the ledger path, honoring KHY_RULEGUARD_LEDGER for fixtures/tests. */
function ledgerPath(repoRoot) {
  const env = process.env.KHY_RULEGUARD_LEDGER;
  if (env) return path.resolve(env);
  return path.join(path.resolve(repoRoot), LEDGER_DIR, LEDGER_FILE);
}

/** Commit sha for ledger provenance; empty string when not in a git tree. */
function gitHead(repoRoot) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return '';
  }
}

/**
 * Append finding records. Each record is one JSON line. Suppressed findings
 * are written with suppressed=true plus the reason, never dropped.
 * Returns the path written to.
 */
function append(repoRoot, records, extra = {}) {
  if (!Array.isArray(records) || !records.length) return null;

  const target = ledgerPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Rotate when the file grows past the split threshold.
  let suffix = '';
  try {
    if (fs.existsSync(target) && fs.statSync(target).size > SPLIT_BYTES) {
      suffix = `-${new Date().toISOString().slice(0, 10)}`;
    }
  } catch (error) {
    suffix = '';
  }

  const lines = records.map((record) => JSON.stringify({
    ts: extra.ts || new Date().toISOString(),
    gate: extra.gate || 'local',
    mode: extra.mode || 'run',
    commit: extra.commit || gitHead(repoRoot),
    checker: record.checker || '',
    finding: record.finding || '',
    rule: record.rule || '',
    priority: record.priority || '',
    strength: record.strength || '',
    file: record.file || '',
    line: record.line || 0,
    message: record.message || '',
    suppressed: Boolean(record.suppressed),
    suppressionReason: record.suppressionReason || '',
  })).join('\n') + '\n';

  fs.appendFileSync(suffix ? target.replace(LEDGER_FILE, `${LEDGER_FILE.replace(/\.jsonl$/, '')}${suffix}.jsonl`) : target, lines);
  return suffix ? target.replace(LEDGER_FILE, `${LEDGER_FILE.replace(/\.jsonl$/, '')}${suffix}.jsonl`) : target;
}

/** Read back the ledger as an array (newest last). Corrupt lines are skipped. */
function readAll(repoRoot) {
  const target = ledgerPath(repoRoot);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

/** Count active suppressions by rule id (for the coverage report). */
function activeSuppressions(repoRoot) {
  const byRule = {};
  for (const record of readAll(repoRoot)) {
    if (!record.suppressed) continue;
    byRule[record.rule] = (byRule[record.rule] || 0) + 1;
  }
  return byRule;
}

module.exports = { LEDGER_DIR, ledgerPath, append, readAll, activeSuppressions };
