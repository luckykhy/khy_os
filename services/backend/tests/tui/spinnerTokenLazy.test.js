'use strict';

/**
 * spinnerTokenLazy — guard tests for skipping the live spinner's per-frame token
 * estimate while the spinner meta is provably hidden (goal「khy 动画/输入体验卡顿,
 * 无法做真正的软件项目」).
 *
 * _spinnerProgress runs in App's render body (every frame while busy + 1s
 * nowTick) and re-estimates the WHOLE growing streaming.text each call. But those
 * tokens only render once buildSpinnerMeta reveals the meta (spinnerMeta's 30s
 * gate); for the first 30s the meta is '' and tokens are DISCARDED. This leaf's
 * shouldEstimateSpinnerTokens returns false only when the reveal gate positively
 * says hidden — so the skip is byte-safe at the render layer.
 *
 * Invariants:
 *   ① gate KHY_SPINNER_TOKEN_LAZY default ON; 0/false/off/no → OFF (byte-revert)
 *   ② meta hidden (elapsed < 30s, gate on) → skip (false)
 *   ③ meta shown (elapsed > 30s) → estimate (true)
 *   ④ gate off → ALWAYS estimate (true) — byte-revert to today
 *   ⑤ the skip predicate mirrors spinnerMeta.shouldShowTimerAndTokens exactly
 *      (SSOT — same 30s threshold, no divergent gate)
 *   ⑥ LIVE wiring: App._spinnerProgress requires spinnerTokenLazy + guards the
 *      _estimateTok call; flag registered default ON
 *
 * node:test (jest via rtk proxy is unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/cli/tui/ink-components/spinnerTokenLazy');
const spinnerMeta = require('../../src/cli/spinnerMeta');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_SPINNER_TOKEN_LAZY defaults ON, reverts on falsy words', () => {
  assert.strictEqual(leaf.isSpinnerTokenLazyEnabled({}), true);
  assert.strictEqual(leaf.isSpinnerTokenLazyEnabled({ KHY_SPINNER_TOKEN_LAZY: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.isSpinnerTokenLazyEnabled({ KHY_SPINNER_TOKEN_LAZY: off }), false, `'${off}'`);
  }
  assert.strictEqual(leaf.isSpinnerTokenLazyEnabled({ KHY_SPINNER_TOKEN_LAZY: '1' }), true);
});

// ── ② meta hidden (< 30s, gate on) → skip the estimate ────────────────────
test('meta hidden (elapsed < 30s) → shouldEstimate=false (skip)', () => {
  for (const sec of [0, 1, 12, 29, 30]) {
    assert.strictEqual(
      leaf.shouldEstimateSpinnerTokens({ elapsedSec: sec, env: {} }), false,
      `elapsed ${sec}s → meta hidden → skip`);
  }
});

// ── ③ meta shown (> 30s) → estimate ───────────────────────────────────────
test('meta shown (elapsed > 30s) → shouldEstimate=true (estimate)', () => {
  for (const sec of [31, 42, 120]) {
    assert.strictEqual(
      leaf.shouldEstimateSpinnerTokens({ elapsedSec: sec, env: {} }), true,
      `elapsed ${sec}s → meta shown → estimate`);
  }
});

// ── ④ gate off → ALWAYS estimate (byte-revert) ────────────────────────────
test('gate off → always estimate regardless of elapsed (byte-revert)', () => {
  for (const sec of [0, 12, 42]) {
    assert.strictEqual(
      leaf.shouldEstimateSpinnerTokens({ elapsedSec: sec, env: { KHY_SPINNER_TOKEN_LAZY: '0' } }), true,
      `gate off, elapsed ${sec}s → estimate`);
  }
});

// ── ⑤ predicate mirrors spinnerMeta.shouldShowTimerAndTokens (SSOT) ───────
test('skip decision is the exact inverse of spinnerMeta reveal (same SSOT)', () => {
  for (const sec of [0, 5, 15, 29, 30, 31, 60, 300]) {
    const shown = spinnerMeta.shouldShowTimerAndTokens({
      elapsedMs: sec * 1000, gateEnabled: spinnerMeta.isEnabled({}),
    });
    const estimate = leaf.shouldEstimateSpinnerTokens({ elapsedSec: sec, env: {} });
    // gate on → estimate iff meta is shown (never diverges from the SSOT gate).
    assert.strictEqual(estimate, shown, `elapsed ${sec}s: estimate must equal reveal`);
  }
});

// ── ⑥ LIVE wiring guards ──────────────────────────────────────────────────
test('App._spinnerProgress wires spinnerTokenLazy to guard the estimate', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/cli/tui/ink-components/App.js'), 'utf8');
  assert.ok(/require\(['"]\.\/spinnerTokenLazy['"]\)/.test(src),
    'App must require ./spinnerTokenLazy');
  assert.ok(/shouldEstimateSpinnerTokens\(\{\s*elapsedSec,\s*env\s*\}\)/.test(src),
    'App must call shouldEstimateSpinnerTokens keyed on elapsedSec + env');
  assert.ok(/if\s*\(streaming\s*&&\s*_needEstimate\)/.test(src),
    'the _estimateTok call must be guarded by streaming && _needEstimate');
});

test('flagRegistry registers KHY_SPINNER_TOKEN_LAZY default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_SPINNER_TOKEN_LAZY', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_SPINNER_TOKEN_LAZY', { KHY_SPINNER_TOKEN_LAZY: 'off' }), false);
});
