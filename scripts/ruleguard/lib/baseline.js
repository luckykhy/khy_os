'use strict';

const fs = require('fs');
const path = require('path');

/**
 * baseline.js — ratchet for P2 ("advisory" tier) rule findings.
 *
 * Same semantics as check-repo-layout.js: warnings may exist up to the
 * baseline count; anything above it auto-escalates to blocking. Baselines only
 * ever move down — `--update-baseline` rewrites them to the current observed
 * count, which is always <= the previous value when the codebase is clean.
 *
 * File: scripts/ci/ruleguard-baseline.json
 * Shape: { "_note": ..., "counts": { "<rule-id>": <allowed errors> } }
 */

const BASELINE_REL = path.join('scripts', 'ci', 'ruleguard-baseline.json');
const BASELINE_ENV = 'KHY_RULEGUARD_BASELINE';

function baselinePath(repoRoot) {
  const env = process.env[BASELINE_ENV];
  if (env) return path.resolve(env);
  return path.join(path.resolve(repoRoot), BASELINE_REL);
}

function load(repoRoot) {
  const target = baselinePath(repoRoot);
  if (!fs.existsSync(target)) return { counts: {}, path: target, fresh: true };
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    return { counts: data.counts || {}, path: target, fresh: false };
  } catch (error) {
    return { counts: {}, path: target, fresh: true };
  }
}

/**
 * Classify observed counts against the baseline.
 * Returns { blocking, allowed, over } where `over` maps rule id -> surplus.
 */
function evaluate(observed, baseline) {
  const allowed = {};
  const blocking = {};
  const over = {};

  for (const [ruleId, count] of Object.entries(observed)) {
    const limit = Number.isInteger(baseline.counts[ruleId]) ? baseline.counts[ruleId] : 0;
    if (count > limit) {
      blocking[ruleId] = count;
      over[ruleId] = count - limit;
    } else {
      allowed[ruleId] = count;
    }
  }

  return { allowed, blocking, over };
}

/**
 * Rewrite the baseline to the observed counts. Ratchet: only values at or
 * below the previous limit are written, so an accidental regression can never
 * silently widen the allowance.
 */
function write(repoRoot, observed) {
  const target = baselinePath(repoRoot);
  const current = load(repoRoot);
  const counts = {};

  for (const [ruleId, count] of Object.entries(observed)) {
    const previous = Number.isInteger(current.counts[ruleId]) ? current.counts[ruleId] : count;
    counts[ruleId] = Math.min(previous, count);
  }

  const data = {
    _note: 'ruleguard 基线棘轮：counts 记录每条 P2 规则的允许存量违规数。超量自动升为阻断。'
      + ' 只降不升 —— npm run rules:baseline 把 counts 收紧到当前观测值。'
      + ' 语义与 scripts/ci/repo-layout-baseline.json 一致。',
    _updated: new Date().toISOString().slice(0, 10),
    counts,
  };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  return { path: target, counts };
}

module.exports = { BASELINE_REL, baselinePath, load, evaluate, write };
