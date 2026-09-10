'use strict';
/**
 * usageTokenCountShape.test.js — 纯叶子契约 + formatTokenCount 越界修正接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、shapeTokenCount 边界修正
 * (999500→"1.0m"·9999→"10k"·常规档不变)、门关返 null(逐字节回退)、fail-soft;
 * formatTokenCount 门开修正 / 门关落回 legacy("1000k"/"10.0k")。
 */
const path = require('node:path');
const leaf = require(path.join(__dirname, '../src/services/usageTokenCountShape'));
test('shapeTokenCount: fixes 999500..999999 → "1.0m" (was "1000k")', () => {
  for (const v of [999500, 999750, 999999]) {
    expect(leaf.shapeTokenCount(v, {})).toBe('1.0m');
  }
});
test('shapeTokenCount: fixes toFixed→"10.0" case → "10k" (was "10.0k")', () => {
  expect(leaf.shapeTokenCount(9999, {})).toBe('10k');
  expect(leaf.shapeTokenCount(9995, {})).toBe('10k'); // 9.995 → toFixed "10.0"
});
test('shapeTokenCount: null/non-finite → "0" (matches legacy sentinel)', () => {
  expect(leaf.shapeTokenCount(null, {})).toBe('0');
  expect(leaf.shapeTokenCount(undefined, {})).toBe('0');
  expect(leaf.shapeTokenCount(Infinity, {})).toBe('0');
  expect(leaf.shapeTokenCount(NaN, {})).toBe('0');
});
// ── formatTokenCount 接线(整模块加载,真跑门开修正 / 门关回退)─────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}
test('formatTokenCount: gate OFF → byte-revert to legacy ("1000k"/"10.0k")', () => {
  withEnv({ KHY_USAGE_TOKEN_PROMOTION: '0' }, () => {
    delete require.cache[require.resolve('../src/services/usageFormatter')];
    delete require.cache[require.resolve('../src/services/usageTokenCountShape')];
    const { formatTokenCount } = require('../src/services/usageFormatter');
    expect(formatTokenCount(999500)).toBe('1000k');
    expect(formatTokenCount(9999)).toBe('10.0k');
    expect(formatTokenCount(42000)).toBe('42k');
  });
});

describe('Usage Token Count Shape', () => {
  test('usageTokenPromotionEnabled: default ON; CANON off-words disable', () => {
      expect(leaf.usageTokenPromotionEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(leaf.usageTokenPromotionEnabled({ KHY_USAGE_TOKEN_PROMOTION: off })).toBe(false, `off=${off}`);
      }
      expect(leaf.usageTokenPromotionEnabled({ KHY_USAGE_TOKEN_PROMOTION: 'nope' })).toBe(true); // 非 CANON → 开
  });

  test('shapeTokenCount: regular bands unchanged (strict superset)', () => {
      expect(leaf.shapeTokenCount(999, {})).toBe('999');
      expect(leaf.shapeTokenCount(1000, {})).toBe('1.0k');
      expect(leaf.shapeTokenCount(1200, {})).toBe('1.2k');
      expect(leaf.shapeTokenCount(9949, {})).toBe('9.9k');
      expect(leaf.shapeTokenCount(10000, {})).toBe('10k');
      expect(leaf.shapeTokenCount(42000, {})).toBe('42k');
      expect(leaf.shapeTokenCount(999499, {})).toBe('999k');
      expect(leaf.shapeTokenCount(1000000, {})).toBe('1.0m');
      expect(leaf.shapeTokenCount(2500000, {})).toBe('2.5m');
  });

  test('shapeTokenCount: gate OFF → null (caller reverts to legacy)', () => {
      expect(leaf.shapeTokenCount(999500, { KHY_USAGE_TOKEN_PROMOTION: '0' })).toBe(null);
      expect(leaf.shapeTokenCount(9999, { KHY_USAGE_TOKEN_PROMOTION: 'off' })).toBe(null);
  });

  test('fail-soft: never throws on bad env', () => {
      expect(() => leaf.shapeTokenCount(1000, undefined).not.toThrow());
      expect(() => leaf.usageTokenPromotionEnabled(null).not.toThrow());
  });

  test('formatTokenCount: gate ON → boundary fixed', () => {
      withEnv({ KHY_USAGE_TOKEN_PROMOTION: undefined }, () => {
        delete require.cache[require.resolve('../src/services/usageFormatter')];
        delete require.cache[require.resolve('../src/services/usageTokenCountShape')];
        const { formatTokenCount } = require('../src/services/usageFormatter');
        expect(formatTokenCount(999500)).toBe('1.0m');
        expect(formatTokenCount(9999)).toBe('10k');
        expect(formatTokenCount(42000)).toBe('42k'); // regression
      });
  });

});
