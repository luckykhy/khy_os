'use strict';

/**
 * [DESIGN-ARCH-135] §8 回归 —— 工具循环的压缩阈值必须与底栏倒计时**同源**。
 *
 * 修复前同一个「该压缩了」在一轮里有三个不同数值：底栏 78.3k（budget × 0.75）、
 * 经典 REPL 73.3k（budget × 0.7）、Ink TUI 89.6k（window × 0.7，因 TUI 不传预算）。
 * 用户看到的是底栏那个，行为走的是另一个 —— TUI 下就是「底栏说该压了，却迟迟不压」。
 *
 * 本文件钉住收敛后的规则：
 *   - 有预算 → 与 `autoCompactTriggerTokens(budget)` **逐值相等**（同一表达式，不可能漂移）；
 *   - 无预算 → `floor(window × 0.7)`，与改动前逐字节相同（可回滚性）。
 *
 * 用 node:test 写：jest.config.js:57 会按 `require('node:test')` 识别并把本文件**排除**出
 * jest 套件，所以两种 runner 下都不会互相踩。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  autoCompactTriggerTokens,
  toolLoopCompactTriggerTokens,
  TOOL_LOOP_COMPACT_RATIO,
} = require('../../src/services/contextRouter');

// 2026-09-23 实测的真实场景（截图：128k 窗 / 65.3k 占用 / 底栏 @78.3k）。
// budget = 128000 - 4096(reserve, medium) - 19200(safety 12%+3%) = 104704
const WINDOW_128K = 128000;
const BUDGET_MEDIUM = 104704;

test('#135-11 有预算 → 与底栏 autoCompactAt 逐值相等（防漂移核心）', () => {
  assert.strictEqual(
    toolLoopCompactTriggerTokens(WINDOW_128K, BUDGET_MEDIUM),
    autoCompactTriggerTokens(BUDGET_MEDIUM)
  );
});

test('#135-12 无预算 → 回退 window × 0.7（逐字节等价改动前）', () => {
  assert.strictEqual(TOOL_LOOP_COMPACT_RATIO, 0.7);
  assert.strictEqual(
    toolLoopCompactTriggerTokens(WINDOW_128K, undefined),
    Math.floor(WINDOW_128K * 0.7)
  );
  assert.strictEqual(toolLoopCompactTriggerTokens(WINDOW_128K, 0), 89600);
  assert.strictEqual(toolLoopCompactTriggerTokens(WINDOW_128K, null), 89600);
});

test('#135-13 钉住「修复前差多少」—— 两侧不再同源即红', () => {
  const fixed = toolLoopCompactTriggerTokens(WINDOW_128K, BUDGET_MEDIUM);
  const legacy = Math.floor(WINDOW_128K * TOOL_LOOP_COMPACT_RATIO);

  assert.strictEqual(fixed, 78528, '修复后：与底栏 @78.5k 同源');
  assert.strictEqual(legacy, 89600, '修复前：TUI 实际在 89.6k 才压');
  assert.ok(
    legacy - fixed >= 10000,
    `修复前实际比底栏承诺晚 ${legacy - fixed} tokens —— 正是「该压却没压」的量`
  );
});

test('#135-14 非法入参 → 0（调用方据此不压缩，不误判为「立即压缩」）', () => {
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, 'abc', {}]) {
    assert.strictEqual(toolLoopCompactTriggerTokens(bad, bad), 0, `bad=${String(bad)}`);
  }
});

test('#135-15 预算优先：两者都给时以预算为准', () => {
  const withBudget = toolLoopCompactTriggerTokens(WINDOW_128K, BUDGET_MEDIUM);
  const withoutBudget = toolLoopCompactTriggerTokens(WINDOW_128K);
  assert.notStrictEqual(withBudget, withoutBudget);
  assert.strictEqual(withBudget, autoCompactTriggerTokens(BUDGET_MEDIUM));
});

test('#135-16 预算非法但窗口合法 → 仍走回退（不返 0）', () => {
  for (const badBudget of [undefined, null, 0, -5, NaN, 'x']) {
    assert.strictEqual(
      toolLoopCompactTriggerTokens(WINDOW_128K, badBudget),
      89600,
      `badBudget=${String(badBudget)}`
    );
  }
});

test('#135-17 单调性：预算越大触发点越晚', () => {
  assert.ok(
    toolLoopCompactTriggerTokens(WINDOW_128K, 50000) <
      toolLoopCompactTriggerTokens(WINDOW_128K, 200000)
  );
});
