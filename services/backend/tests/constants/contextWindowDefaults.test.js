'use strict';

/**
 * contextWindowDefaults.test.js — 纯常量叶契约单测(node:test,零 IO)。
 *
 * 锁定:
 *   - 未知模型回退窗口 = 128000(保守:宁可写小不可写大 —— 写小只多压缩一次,
 *     写大则运行时 400/413 不可恢复);
 *   - 大窗口家族默认 = 200000;上游谎报天花板 = 1048576(现实最大真实窗口 GPT-4.1 1047576);
 *   - resolveFallbackWindow 只读注入 env.KHY_CONTEXT_WINDOW,无效/非正 → 回退默认;
 *   - 零依赖、绝不抛(本模块是显示分母与压缩预算的共同真源,散落硬编码曾让两者对
 *     同一个未知模型给出不同的数)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/constants/contextWindowDefaults');

describe('常量值', () => {
  test('未知模型回退 = 128000', () => {
    assert.strictEqual(leaf.UNKNOWN_MODEL_CONTEXT_WINDOW, 128000);
  });

  test('大窗口家族默认 = 200000', () => {
    assert.strictEqual(leaf.LARGE_FAMILY_CONTEXT_WINDOW, 200000);
  });

  test('谎报天花板 = 1048576 且 > 现实最大真实窗口(GPT-4.1 1047576)', () => {
    assert.strictEqual(leaf.MAX_PLAUSIBLE_CONTEXT_WINDOW, 1048576);
    assert.ok(leaf.MAX_PLAUSIBLE_CONTEXT_WINDOW >= 1047576);
  });

  test('保守性:未知回退 < 大窗口默认 < 天花板', () => {
    assert.ok(leaf.UNKNOWN_MODEL_CONTEXT_WINDOW < leaf.LARGE_FAMILY_CONTEXT_WINDOW);
    assert.ok(leaf.LARGE_FAMILY_CONTEXT_WINDOW < leaf.MAX_PLAUSIBLE_CONTEXT_WINDOW);
  });
});

describe('resolveFallbackWindow', () => {
  test('有效正整数 → 原样采纳', () => {
    assert.strictEqual(leaf.resolveFallbackWindow({ KHY_CONTEXT_WINDOW: '512000' }), 512000);
  });

  test('小数 → 向下取整', () => {
    assert.strictEqual(leaf.resolveFallbackWindow({ KHY_CONTEXT_WINDOW: '200000.9' }), 200000);
  });

  test("'0' / 负数 / 非数字 / 空串 → 回退默认", () => {
    for (const bad of ['0', '-1', 'abc', '', '   ']) {
      assert.strictEqual(
        leaf.resolveFallbackWindow({ KHY_CONTEXT_WINDOW: bad }),
        leaf.UNKNOWN_MODEL_CONTEXT_WINDOW,
        `应回退默认: ${JSON.stringify(bad)}`,
      );
    }
  });

  test('缺字段 / 空 env / 无参 → 回退默认,绝不抛', () => {
    assert.strictEqual(leaf.resolveFallbackWindow({}), leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
    assert.strictEqual(leaf.resolveFallbackWindow(), leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
    assert.strictEqual(leaf.resolveFallbackWindow(null), leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
    assert.strictEqual(leaf.resolveFallbackWindow(undefined), leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
  });

  test('绝不读 process.env(只认注入)', () => {
    const saved = process.env.KHY_CONTEXT_WINDOW;
    process.env.KHY_CONTEXT_WINDOW = '999999';
    try {
      assert.strictEqual(leaf.resolveFallbackWindow({}), leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
    } finally {
      if (saved === undefined) delete process.env.KHY_CONTEXT_WINDOW;
      else process.env.KHY_CONTEXT_WINDOW = saved;
    }
  });
});

describe('消费方口径一致性(防漂移)', () => {
  test('ctxWindowStats 的 env-fallback 上限 === UNKNOWN_MODEL_CONTEXT_WINDOW', () => {
    const { computeContextStats } = require('../../src/services/context/ctxWindowStats');
    const stats = computeContextStats({ used: 0, limit: 0 }, {});
    assert.strictEqual(stats.limitSource, 'env-fallback');
    assert.strictEqual(stats.limit, leaf.UNKNOWN_MODEL_CONTEXT_WINDOW);
  });
});
