'use strict';

/**
 * contextWarningThreshold.test.js — 纯叶子契约 + calculateTokenWarningState 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、guardBandThreshold(大窗口→threshold-buffer·
 * 小窗口→threshold·关门/非数→null)、fail-soft;接线活验:门开小窗口不再从 token 0 误报、大窗口
 * 逐字节等价、门关回退 legacy(小窗口重新从 0 误报)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/contextWarningThreshold'));

test('contextWarningThresholdGuardEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.contextWarningThresholdGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.contextWarningThresholdGuardEnabled({ KHY_CONTEXT_WARNING_THRESHOLD_GUARD: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.contextWarningThresholdGuardEnabled({ KHY_CONTEXT_WARNING_THRESHOLD_GUARD: 'yes' }), true);
});

test('guardBandThreshold: ON → threshold-buffer when large, threshold when small', () => {
  const buffer = 20000;
  // large window: threshold 160000 (0.8*200k) > buffer → legacy value
  assert.strictEqual(leaf.guardBandThreshold(160000, buffer, {}), 140000);
  // small window: threshold 12800 (0.8*16k) <= buffer → threshold itself (no underflow to negative)
  assert.strictEqual(leaf.guardBandThreshold(12800, buffer, {}), 12800);
  // exactly at buffer boundary → threshold (not 0)
  assert.strictEqual(leaf.guardBandThreshold(20000, buffer, {}), 20000);
  // just above → threshold - buffer
  assert.strictEqual(leaf.guardBandThreshold(20001, buffer, {}), 1);
});

test('guardBandThreshold: OFF → null; non-finite → null', () => {
  assert.strictEqual(leaf.guardBandThreshold(12800, 20000, { KHY_CONTEXT_WARNING_THRESHOLD_GUARD: '0' }), null);
  assert.strictEqual(leaf.guardBandThreshold(NaN, 20000, {}), null);
  assert.strictEqual(leaf.guardBandThreshold(12800, 'x', {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.guardBandThreshold(1, 2, undefined));
  assert.doesNotThrow(() => leaf.contextWarningThresholdGuardEnabled(null));
});

// ── calculateTokenWarningState 接线(真跑)────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshCW() {
  delete require.cache[require.resolve('../src/cli/contextWarning')];
  delete require.cache[require.resolve('../src/services/contextWarningThreshold')];
  return require('../src/cli/contextWarning');
}

test('wiring ON: small 16k window no longer nags at token 0; fires near real threshold', () => {
  withEnv({ KHY_CONTEXT_WARNING_THRESHOLD_GUARD: undefined }, () => {
    const cw = freshCW();
    const at0 = cw.calculateTokenWarningState({ tokenUsage: 0, contextWindow: 16000, autoCompactEnabled: true });
    assert.strictEqual(at0.isAboveWarningThreshold, false, 'must NOT warn at token 0 on small window');
    assert.strictEqual(cw.buildContextWarning({ tokenUsage: 0, contextWindow: 16000, autoCompactEnabled: true }).show, false);
    // once usage reaches the real auto-compact threshold (0.8*16000=12800) → warns
    const atThresh = cw.calculateTokenWarningState({ tokenUsage: 12800, contextWindow: 16000, autoCompactEnabled: true });
    assert.strictEqual(atThresh.isAboveWarningThreshold, true);
    // large 200k window unchanged: warns only in-band, not at token 0
    const big0 = cw.calculateTokenWarningState({ tokenUsage: 0, contextWindow: 200000, autoCompactEnabled: true });
    assert.strictEqual(big0.isAboveWarningThreshold, false);
    const bigBand = cw.calculateTokenWarningState({ tokenUsage: 150000, contextWindow: 200000, autoCompactEnabled: true });
    assert.strictEqual(bigBand.isAboveWarningThreshold, true); // 160000-20000=140000 ≤ 150000
  });
});

test('wiring OFF: byte-revert → small window nags at token 0 again', () => {
  withEnv({ KHY_CONTEXT_WARNING_THRESHOLD_GUARD: '0' }, () => {
    const cw = freshCW();
    const at0 = cw.calculateTokenWarningState({ tokenUsage: 0, contextWindow: 16000, autoCompactEnabled: true });
    assert.strictEqual(at0.isAboveWarningThreshold, true, 'legacy underflow bug returns');
    assert.strictEqual(cw.buildContextWarning({ tokenUsage: 0, contextWindow: 16000, autoCompactEnabled: true }).show, true);
    // large window identical under both gates (byte-revert baseline)
    const bigBand = cw.calculateTokenWarningState({ tokenUsage: 150000, contextWindow: 200000, autoCompactEnabled: true });
    assert.strictEqual(bigBand.isAboveWarningThreshold, true);
  });
});
