'use strict';

/**
 * Tests for gateway/_envParse.js — env 数值解析纯函数原子层(Batch 2)。
 * 契约锚定被收敛副本(aiGateway.js / relayApiAdapter.js 的 _parseMs)的逐字节语义。
 */

const { _parseMs } = require('../../src/services/gateway/_envParse');

describe('_parseMs — 合法输入', () => {
  test('解析普通毫秒字符串', () => {
    expect(_parseMs('20000', 5000)).toBe(20000);
  });

  test('解析数字输入', () => {
    expect(_parseMs(1500, 100)).toBe(1500);
  });

  test('min 抬底：低于 min 的合法值被抬到 min', () => {
    expect(_parseMs('1000', 20000, 5000)).toBe(5000);
  });

  test('无上限钳制：超大值原样通过', () => {
    expect(_parseMs('99999999', 100)).toBe(99999999);
  });

  test('parseInt 前缀解析："1500ms" → 1500（与原副本一致）', () => {
    expect(_parseMs('1500ms', 100)).toBe(1500);
  });

  test('小数被 parseInt 截断', () => {
    expect(_parseMs('1500.9', 100)).toBe(1500);
  });
});

describe('_parseMs — 回退路径', () => {
  test('null/undefined → 用 fallback 参与解析（?? 语义）', () => {
    expect(_parseMs(null, 8000)).toBe(8000);
    expect(_parseMs(undefined, 8000)).toBe(8000);
  });

  test('空串 → NaN → fallback', () => {
    expect(_parseMs('', 12000)).toBe(12000);
  });

  test('非数字串 → fallback', () => {
    expect(_parseMs('abc', 300)).toBe(300);
  });

  test('0 视为非法（<=0）→ fallback', () => {
    expect(_parseMs('0', 700)).toBe(700);
    expect(_parseMs(0, 700)).toBe(700);
  });

  test('负数视为非法（<=0）→ fallback', () => {
    expect(_parseMs('-5', 900)).toBe(900);
    expect(_parseMs(-5, 900)).toBe(900);
  });

  test('fallback 不经过 min 抬底（原副本行为：直接 return fallback）', () => {
    // 非法输入时 fallback 原样返回，即使 fallback < min
    expect(_parseMs('bad', 100, 5000)).toBe(100);
  });

  test('null + 非法 fallback（fallback 自身进 parseInt）：NaN fallback 原样返回', () => {
    expect(Number.isNaN(_parseMs(null, NaN))).toBe(true);
  });

  test('对象输入 → String() → NaN → fallback', () => {
    expect(_parseMs({}, 42)).toBe(42);
  });

  test('布尔输入 → NaN → fallback', () => {
    expect(_parseMs(true, 42)).toBe(42);
  });
});

describe('_parseMs — 默认参数', () => {
  test('min 缺省为 0：正值不受影响', () => {
    expect(_parseMs('1', 100)).toBe(1);
  });
});
