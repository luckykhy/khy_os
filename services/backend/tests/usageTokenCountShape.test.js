'use strict';

/**
 * usageTokenCountShape.test.js — 纯叶子契约 + formatTokenCount 越界修正接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、shapeTokenCount 边界修正
 * (999500→"1.0m"·9999→"10k"·常规档不变)、门关返 null(逐字节回退)、fail-soft;
 * formatTokenCount 门开修正 / 门关落回 legacy("1000k"/"10.0k")。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/usageTokenCountShape'));

test('usageTokenPromotionEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.usageTokenPromotionEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.usageTokenPromotionEnabled({ KHY_USAGE_TOKEN_PROMOTION: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.usageTokenPromotionEnabled({ KHY_USAGE_TOKEN_PROMOTION: 'nope' }), true); // 非 CANON → 开
});

test('shapeTokenCount: fixes 999500..999999 → "1.0m" (was "1000k")', () => {
  for (const v of [999500, 999750, 999999]) {
    assert.strictEqual(leaf.shapeTokenCount(v, {}), '1.0m', `v=${v}`);
  }
});

test('shapeTokenCount: fixes toFixed→"10.0" case → "10k" (was "10.0k")', () => {
  assert.strictEqual(leaf.shapeTokenCount(9999, {}), '10k');
  assert.strictEqual(leaf.shapeTokenCount(9995, {}), '10k'); // 9.995 → toFixed "10.0"
});

test('shapeTokenCount: regular bands unchanged (strict superset)', () => {
  assert.strictEqual(leaf.shapeTokenCount(999, {}), '999');
  assert.strictEqual(leaf.shapeTokenCount(1000, {}), '1.0k');
  assert.strictEqual(leaf.shapeTokenCount(1200, {}), '1.2k');
  assert.strictEqual(leaf.shapeTokenCount(9949, {}), '9.9k');
  assert.strictEqual(leaf.shapeTokenCount(10000, {}), '10k');
  assert.strictEqual(leaf.shapeTokenCount(42000, {}), '42k');
  assert.strictEqual(leaf.shapeTokenCount(999499, {}), '999k');
  assert.strictEqual(leaf.shapeTokenCount(1000000, {}), '1.0m');
  assert.strictEqual(leaf.shapeTokenCount(2500000, {}), '2.5m');
});

test('shapeTokenCount: null/non-finite → "0" (matches legacy sentinel)', () => {
  assert.strictEqual(leaf.shapeTokenCount(null, {}), '0');
  assert.strictEqual(leaf.shapeTokenCount(undefined, {}), '0');
  assert.strictEqual(leaf.shapeTokenCount(Infinity, {}), '0');
  assert.strictEqual(leaf.shapeTokenCount(NaN, {}), '0');
});

test('shapeTokenCount: gate OFF → null (caller reverts to legacy)', () => {
  assert.strictEqual(leaf.shapeTokenCount(999500, { KHY_USAGE_TOKEN_PROMOTION: '0' }), null);
  assert.strictEqual(leaf.shapeTokenCount(9999, { KHY_USAGE_TOKEN_PROMOTION: 'off' }), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.shapeTokenCount(1000, undefined));
  assert.doesNotThrow(() => leaf.usageTokenPromotionEnabled(null));
});

// ── formatTokenCount 接线(整模块加载,真跑门开修正 / 门关回退)─────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('formatTokenCount: gate ON → boundary fixed', () => {
  withEnv({ KHY_USAGE_TOKEN_PROMOTION: undefined }, () => {
    delete require.cache[require.resolve('../src/services/usageFormatter')];
    delete require.cache[require.resolve('../src/services/usageTokenCountShape')];
    const { formatTokenCount } = require('../src/services/usageFormatter');
    assert.strictEqual(formatTokenCount(999500), '1.0m');
    assert.strictEqual(formatTokenCount(9999), '10k');
    assert.strictEqual(formatTokenCount(42000), '42k'); // regression
  });
});

test('formatTokenCount: gate OFF → byte-revert to legacy ("1000k"/"10.0k")', () => {
  withEnv({ KHY_USAGE_TOKEN_PROMOTION: '0' }, () => {
    delete require.cache[require.resolve('../src/services/usageFormatter')];
    delete require.cache[require.resolve('../src/services/usageTokenCountShape')];
    const { formatTokenCount } = require('../src/services/usageFormatter');
    assert.strictEqual(formatTokenCount(999500), '1000k');
    assert.strictEqual(formatTokenCount(9999), '10.0k');
    assert.strictEqual(formatTokenCount(42000), '42k');
  });
});
