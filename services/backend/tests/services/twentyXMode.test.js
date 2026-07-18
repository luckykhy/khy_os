'use strict';

/**
 * twentyXMode 纯叶子单测 —— 20 倍模式(max-throughput 开关)。
 *
 * 覆盖:
 *   · isTwentyXEnabled:opt-in 默认关;'true'/'1' → 开;其它/缺失 → 关;
 *   · resolveTwentyXEffort:开 → 'max';关 → 原样(逐字节回退,任意基线档);
 *   · scaleIterations:开 → 顶到 100 但不低于 base、不超 100;关 → 原样;
 *   · scaleFanout:开 → 抬 maxChildren/maxTotalAgents,但显式 opts 优先、绝不降;
 *     关 → 同引用返回(逐字节回退);
 *   · describeTwentyXState:始终返回对象,enabled 随门控;
 *   · 绝不抛:坏 env / 坏输入 → 安全默认。
 *
 * node:test。运行:`node --test tests/services/twentyXMode.test.js`。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const x = require('../../src/services/twentyXMode');

const ON = { KHY_20X_MODE: 'true' };
const ON1 = { KHY_20X_MODE: '1' };
const OFF = {}; // 缺失 = opt-in 默认关

describe('isTwentyXEnabled — opt-in 默认关', () => {
  test("缺失 → 关", () => {
    assert.strictEqual(x.isTwentyXEnabled(OFF), false);
  });
  test("'true' / '1' → 开", () => {
    assert.strictEqual(x.isTwentyXEnabled(ON), true);
    assert.strictEqual(x.isTwentyXEnabled(ON1), true);
  });
  test("其它值(on/yes/随便)→ 关(opt-in 严格)", () => {
    assert.strictEqual(x.isTwentyXEnabled({ KHY_20X_MODE: 'on' }), false);
    assert.strictEqual(x.isTwentyXEnabled({ KHY_20X_MODE: 'yes' }), false);
    assert.strictEqual(x.isTwentyXEnabled({ KHY_20X_MODE: 'false' }), false);
  });
  test('坏 env → 安全默认关,绝不抛', () => {
    assert.doesNotThrow(() => x.isTwentyXEnabled(null));
    assert.doesNotThrow(() => x.isTwentyXEnabled(undefined));
  });
});

describe('resolveTwentyXEffort — 开顶格 / 关回退', () => {
  test('开 → max(无论基线)', () => {
    for (const base of ['low', 'medium', 'high', 'max']) {
      assert.strictEqual(x.resolveTwentyXEffort(base, ON), 'max');
    }
  });
  test('关 → 原样返回(逐字节回退)', () => {
    for (const base of ['low', 'medium', 'high', 'max', 'weird']) {
      assert.strictEqual(x.resolveTwentyXEffort(base, OFF), base);
    }
  });
});

describe('scaleIterations — 开顶到 100 / 关回退', () => {
  test('开 → max(base, 100),封顶 100', () => {
    assert.strictEqual(x.scaleIterations(20, ON), 100);
    assert.strictEqual(x.scaleIterations(100, ON), 100);
    assert.strictEqual(x.scaleIterations(200, ON), 100); // 绝不超 100
  });
  test('关 → 原样(逐字节回退)', () => {
    assert.strictEqual(x.scaleIterations(20, OFF), 20);
    assert.strictEqual(x.scaleIterations(7, OFF), 7);
  });
  test('坏输入 → 安全默认,不抛', () => {
    assert.doesNotThrow(() => x.scaleIterations(NaN, ON));
    assert.doesNotThrow(() => x.scaleIterations(undefined, OFF));
  });
});

describe('scaleFanout — 开放大 / 显式优先 / 关同引用', () => {
  test('开 + 无显式 opts → maxChildren/maxTotalAgents 抬到目标', () => {
    const cfg = { maxChildren: 10, maxTotalAgents: 50, maxDepth: 3 };
    const out = x.scaleFanout(cfg, {}, ON);
    assert.strictEqual(out.maxChildren, 20);
    assert.strictEqual(out.maxTotalAgents, 100);
    assert.strictEqual(out.maxDepth, 3, '无关键保留');
  });
  test('开 + 显式 opts 设了值 → 不覆盖(调用方优先)', () => {
    const cfg = { maxChildren: 5, maxTotalAgents: 200 };
    const out = x.scaleFanout(cfg, { maxChildren: 5, maxTotalAgents: 200 }, ON);
    assert.strictEqual(out.maxChildren, 5, '显式 maxChildren 不被抬');
    assert.strictEqual(out.maxTotalAgents, 200, '显式 maxTotalAgents 不被抬');
  });
  test('开 → 绝不降(现值高于目标则保留)', () => {
    const cfg = { maxChildren: 30, maxTotalAgents: 500 };
    const out = x.scaleFanout(cfg, {}, ON);
    assert.strictEqual(out.maxChildren, 30);
    assert.strictEqual(out.maxTotalAgents, 500);
  });
  test('关 → 原 config 同引用返回(逐字节回退)', () => {
    const cfg = { maxChildren: 10, maxTotalAgents: 50 };
    assert.strictEqual(x.scaleFanout(cfg, {}, OFF), cfg);
  });
  test('坏输入 → 原样返回,不抛', () => {
    assert.strictEqual(x.scaleFanout(null, {}, ON), null);
    assert.doesNotThrow(() => x.scaleFanout(undefined, undefined, ON));
  });
});

describe('resolveThinkingBudget — 开放大 / 关回退', () => {
  test('开 → max(base, 32768)', () => {
    assert.strictEqual(x.resolveThinkingBudget(10000, ON), 32768);
    assert.strictEqual(x.resolveThinkingBudget(40000, ON), 40000);
  });
  test('关 → 原样', () => {
    assert.strictEqual(x.resolveThinkingBudget(10000, OFF), 10000);
  });
});

describe('describeTwentyXState — 状态自述', () => {
  test('开 → enabled:true + 满负荷文案', () => {
    const s = x.describeTwentyXState(ON);
    assert.strictEqual(s.enabled, true);
    assert.match(s.label, /开/);
    assert.strictEqual(s.effort, 'max');
    assert.strictEqual(s.maxChildren, 20);
    assert.strictEqual(s.maxIterations, 100);
  });
  test('关 → enabled:false + 引导文案', () => {
    const s = x.describeTwentyXState(OFF);
    assert.strictEqual(s.enabled, false);
    assert.match(s.label, /关/);
    assert.match(s.hint, /\/20x on/);
  });
  test('坏 env → 不抛', () => {
    assert.doesNotThrow(() => x.describeTwentyXState(null));
  });
});
