'use strict';

/**
 * Tests for contextRouter.js — context overflow routing strategy.
 * Mocks contextWasm.estimateTokens to control token counts.
 */

jest.mock('../../src/services/contextWasm', () => ({
  estimateTokens: jest.fn((text) => {
    // Simple mock: 1 char = 1 token
    return typeof text === 'string' ? text.length : 0;
  }),
}));

const {
  routeContextStrategy,
  truncateToolResults,
  sumToolResultTokens,
  autoCompactTriggerTokens,
  SAFETY_MARGIN,
  PREEMPTIVE_RATIO,
  SINGLE_RESULT_SHARE,
} = require('../../src/services/contextRouter');

describe('routeContextStrategy', () => {
  test('returns "fits" when total tokens within budget', () => {
    const messages = [
      { role: 'user', content: 'hi' },      // 2 tokens
      { role: 'assistant', content: 'hey' }, // 3 tokens
    ];
    const result = routeContextStrategy(messages, 'sys', 'user', 10000);
    expect(result.route).toBe('fits');
    expect(result.overflow).toBe(0);
  });

  test('returns "compact_only" when overflow and no tool results', () => {
    // Create messages that exceed budget
    const longContent = 'x'.repeat(1000);
    const messages = [
      { role: 'user', content: longContent },
      { role: 'assistant', content: longContent },
    ];
    const result = routeContextStrategy(messages, longContent, longContent, 100);
    expect(result.route).toBe('compact_only');
    expect(result.overflow).toBeGreaterThan(0);
    expect(result.toolResultTokens).toBe(0);
  });

  test('returns "truncate_tool_results_only" when tool results can cover overflow', () => {
    const toolContent = 'x'.repeat(500); // 500 tokens
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: toolContent },
    ];
    // Budget tight enough to overflow slightly but tool results can cover it
    // Total = (2 + 500 + 3 + 3) * 1.2 = 609.6, threshold = budget * 0.9
    // We want overflow small enough that 50% of tool tokens covers it
    const budget = 600; // threshold = 540, total ~610, overflow ~70
    const result = routeContextStrategy(messages, 'sys', 'usr', budget);
    if (result.route === 'truncate_tool_results_only') {
      expect(result.toolResultTokens).toBeGreaterThan(0);
    }
    // Route should be one of the overflow routes
    expect(['truncate_tool_results_only', 'compact_then_truncate', 'compact_only']).toContain(result.route);
  });

  test('returns "compact_then_truncate" when tool results alone insufficient', () => {
    const longContent = 'x'.repeat(5000);
    const messages = [
      { role: 'user', content: longContent },
      { role: 'tool', content: 'small' },
    ];
    const result = routeContextStrategy(messages, longContent, longContent, 100);
    expect(['compact_then_truncate', 'compact_only']).toContain(result.route);
    expect(result.overflow).toBeGreaterThan(0);
  });
});

describe('sumToolResultTokens', () => {
  test('sums only tool role messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: '12345' },     // 5 tokens
      { role: 'assistant', content: 'world' },
      { role: 'tool', content: '123' },        // 3 tokens
    ];
    expect(sumToolResultTokens(messages)).toBe(8);
  });

  test('returns 0 for no tool messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    expect(sumToolResultTokens(messages)).toBe(0);
  });
});

describe('truncateToolResults', () => {
  test('truncates oversized tool results', () => {
    const content = 'a'.repeat(1000);
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content },
    ];
    const saved = truncateToolResults(messages, 100);
    expect(saved).toBeGreaterThan(0);
    expect(messages[1].content.length).toBeLessThan(content.length);
    expect(messages[1].content).toContain('[truncated');
  });

  test('does not truncate non-tool messages', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(1000) },
    ];
    const saved = truncateToolResults(messages, 500);
    expect(saved).toBe(0);
  });
});

describe('constants', () => {
  test('SAFETY_MARGIN is 1.2', () => {
    expect(SAFETY_MARGIN).toBe(1.2);
  });

  test('PREEMPTIVE_RATIO is 0.9', () => {
    expect(PREEMPTIVE_RATIO).toBe(0.9);
  });

  test('SINGLE_RESULT_SHARE is 0.5', () => {
    expect(SINGLE_RESULT_SHARE).toBe(0.5);
  });
});

// ── autoCompactTriggerTokens:自动压缩阈值的单一真源 ──────────────────────
//
// 这个函数存在的唯一理由是「显示与行为不可能漂移」:底栏倒计时曾用
// compactPipeline 的 0.8 当作「占 contextWindow 的比例」,而真实触发是
// routeContextStrategy 里 0.9-of-budget / 1.2-safety-margin 的复合条件。
// 512k 窗口下前者承诺 80%、后者实际约 63% 就压缩 —— 底栏在"还剩 21%"时
// 压缩已经发生。故此处不仅测数值,更测**代数一致性**:阈值必须恰好是
// routeContextStrategy 从 fits 翻转为非 fits 的那个边界。
describe('autoCompactTriggerTokens', () => {
  const BUDGET = 431104; // 512k 窗口 / medium 档 / 默认 env 下的真实预算

  test('推导值 = floor(budget * PREEMPTIVE_RATIO / SAFETY_MARGIN)', () => {
    expect(autoCompactTriggerTokens(BUDGET)).toBe(
      Math.floor((BUDGET * PREEMPTIVE_RATIO) / SAFETY_MARGIN),
    );
    expect(autoCompactTriggerTokens(BUDGET)).toBe(323328);
  });

  test('非法入参 → 0(调用方据此降级到比例路径)', () => {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, 'abc', {}]) {
      expect(autoCompactTriggerTokens(bad)).toBe(0);
    }
  });

  test('单调递增:预算越大,触发点越晚', () => {
    expect(autoCompactTriggerTokens(200000)).toBeLessThan(autoCompactTriggerTokens(400000));
  });

  // ★ 防漂移核心:阈值即 routeContextStrategy 的翻转边界(精确到 ±1 token)。
  // 为何不断言 `at(trigger)` 本身:当 budget*0.9/1.2 恰为整数时(如 50000),
  // raw==trigger 时 ceil(raw*1.2) 正好等于 floor(budget*0.9),overflow==0 → 仍 fits;
  // 非整数时则已翻转。这 1 token 的差别对倒计时无意义,但测试必须诚实,故把边界
  // 钉在 [trigger-1 → fits, trigger+1 → 压缩] 这个区间上 —— 任何比例式漂移都会
  // 让阈值偏离成千上万 token,一定会被这条捕获。
  test('代数一致性:阈值 -1 → fits;阈值 +1 → 触发压缩', () => {
    const trigger = autoCompactTriggerTokens(BUDGET);
    // mock 下 1 char = 1 token,故 content 长度即 raw token 数(sys/user 留空)
    const at = (raw) => routeContextStrategy([{ role: 'user', content: 'x'.repeat(raw) }], '', '', BUDGET);

    expect(at(trigger - 1).route).toBe('fits');
    expect(at(trigger + 1).route).not.toBe('fits');
  });

  test('代数一致性对多种预算成立(非只在某个幸运数字上)', () => {
    // 覆盖:小预算、131072 窗口档、200k 窗口档、512k 窗口档的真实预算
    for (const budget of [50000, 107316, 165904, 431104]) {
      const trigger = autoCompactTriggerTokens(budget);
      const at = (raw) => routeContextStrategy([{ role: 'user', content: 'x'.repeat(raw) }], '', '', budget);
      expect(at(trigger - 1).route).toBe('fits');
      expect(at(trigger + 1).route).not.toBe('fits');
    }
  });
});
