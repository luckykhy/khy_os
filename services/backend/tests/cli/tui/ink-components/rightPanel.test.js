'use strict';

// RightPanel.computeContentLines 契约测试 — BUG-104。
// 该函数文档承诺「Never throws」，但进度条此前内联
// '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10))，
// 而 pct 取自外部数据（plan.progress / context.contextPct）。当 pct>100（上下文
// 溢出可合法超过 100）或 <0/NaN 时，repeat() 收到负数 → RangeError，破坏整块面板。
// 修复 = 抽 miniBar(pct) 钳制到 [0,100] 并容错非有限值。纯函数，直接调用无需渲染。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { computeContentLines } = require(
  path.join(__dirname, '../../../../src/cli/tui/ink-components/RightPanel')
);

test('BUG-104: plan.progress > 100 不崩溃且条钳制满格', () => {
  let lines;
  assert.doesNotThrow(() => {
    lines = computeContentLines('tasks', { plan: { progress: 120, steps: [{ description: 'a', status: 'pending' }] } });
  });
  const bar = lines.find((l) => typeof l.text === 'string' && l.text.includes('%'));
  assert.ok(bar.text.startsWith('██████████'), 'pct>100 应钳制为满格，实测: ' + JSON.stringify(bar.text));
});

test('BUG-104: context.contextPct 为负/NaN 不崩溃', () => {
  assert.doesNotThrow(() => computeContentLines('context', { context: { contextPct: -5 } }));
  assert.doesNotThrow(() => computeContentLines('context', { context: { contextPct: NaN } }));
  const neg = computeContentLines('context', { context: { contextPct: -5 } });
  const bar = neg.find((l) => typeof l.text === 'string' && l.text.includes('上下文'));
  assert.ok(bar.text.includes('░░░░░░░░░░'), '负 pct 应钳制为空格，实测: ' + JSON.stringify(bar.text));
});

test('BUG-104: 正常中间值 45% 条渲染（round(4.5)=5 满 5 空）', () => {
  const lines = computeContentLines('context', { context: { contextPct: 45 } });
  const bar = lines.find((l) => typeof l.text === 'string' && l.text.includes('上下文'));
  assert.ok(bar.text.includes('█████░░░░░'), '45→Math.round(4.5)=5 满,实测: ' + JSON.stringify(bar.text));
});
