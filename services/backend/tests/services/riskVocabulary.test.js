'use strict';

/**
 * riskVocabulary.test.js — 风险词汇单一真源与各消费者的防漂移断言。
 *
 * riskOrder.js 是五级风险词汇(safe/low/medium/high/critical)的唯一真源。历史上这份词汇被
 * 多处重复声明,极易漂移。这些测试把「各处词汇必须与真源一致」固化为回归:
 *   - RISK_LEVELS 数组 与 RISK_ORDER 键、序数严格对应。
 *   - _baseTool.RISK_LEVELS 直接复用真源(同一引用)。
 *   - toolCalling.RISK_LEVELS 对象的键集 === 真源。
 *   - execApproval.RISK 的取值是真源的子集(命令无 safe 层,自 low 起,有意为之)。
 */

const { RISK_ORDER, RISK_LEVELS } = require('../../src/constants/riskOrder');

describe('风险词汇单一真源 riskOrder.js', () => {
  test('RISK_LEVELS 与 RISK_ORDER 键一致且严格升序', () => {
    expect(RISK_LEVELS).toEqual(['safe', 'low', 'medium', 'high', 'critical']);
    // RISK_LEVELS[ordinal] === tier name
    RISK_LEVELS.forEach((tier, i) => expect(RISK_ORDER[tier]).toBe(i));
    expect(Object.keys(RISK_ORDER).sort()).toEqual([...RISK_LEVELS].sort());
  });

  test('两者均冻结(不可变真源)', () => {
    expect(Object.isFrozen(RISK_LEVELS)).toBe(true);
    expect(Object.isFrozen(RISK_ORDER)).toBe(true);
  });
});

describe('各消费者防漂移', () => {
  test('_baseTool.RISK_LEVELS 复用真源(同一引用)', () => {
    const baseTool = require('../../src/tools/_baseTool');
    expect(baseTool.RISK_LEVELS).toBe(RISK_LEVELS);
  });

  test('toolCalling.RISK_LEVELS 键集 === 真源', () => {
    const toolCalling = require('../../src/services/toolCalling');
    expect(Object.keys(toolCalling.RISK_LEVELS).sort()).toEqual([...RISK_LEVELS].sort());
  });

  test('execApproval.RISK 取值是真源子集(命令无 safe 层)', () => {
    const execApproval = require('../../src/services/execApproval');
    const values = Object.values(execApproval.RISK);
    // 每个取值都在真源内。
    values.forEach((v) => expect(RISK_LEVELS).toContain(v));
    // 命令天然有副作用 → 不含 safe 层(有意,非遗漏)。
    expect(values).not.toContain('safe');
    expect(values.sort()).toEqual(['critical', 'high', 'low', 'medium']);
  });
});
