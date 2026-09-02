'use strict';

/**
 * turnPhaseTracker.js 契约测试 —— 一次 AI 回合的阶段划分单一真源。
 *
 * 用户可读阶段链：等待输入 → 推理 → 判断是否完成 → 执行工具 → 处理工具结果
 *   →（未完成回到推理 | 校验 → 已完成）。
 *
 * 关键契约：
 *   1. toolLoopPhases 状态 → 中文标签映射逐一验证；
 *   2. 主回边（process_results --send--> send_to_ai）计「回到推理」次数；
 *   3. snapshot() pure & total：无变化返回同一引用（React 跳过重渲染的栅栏）；
 *   4. trail 封顶不增长；
 *   5. shell 侧（replPhases / TUI status）映射覆盖「等待输入/已接收输入」。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  TURN_PHASES,
  createTurnPhaseTracker,
  _internals,
} = require('../../src/services/stateMachine/turnPhaseTracker');

test('阶段枚举覆盖用户命名的全部截断点', () => {
  const codes = Object.values(TURN_PHASES).map((p) => p.code);
  for (const expected of [
    'waiting_input', 'input_received', 'reasoning', 'tool_executing',
    'tool_result', 'completion_check', 'finalizing', 'done', 'interrupted',
  ]) {
    assert.ok(codes.includes(expected), `缺阶段 ${expected}`);
  }
  // 每个阶段都必须有非空中文标签 —— 给用户看的绝不能是 snake_case。
  for (const p of Object.values(TURN_PHASES)) {
    assert.ok(typeof p.label === 'string' && p.label.length > 0, `${p.code} 缺中文标签`);
    assert.ok(!/[a-z_]{3,}/.test(p.label), `${p.code} 的标签疑似机器码: ${p.label}`);
  }
});

test('loop 状态映射：推理/判断/执行/结果/完成/中断', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ from: 'init', to: 'send_to_ai', event: 'send', iteration: 1, at: 1000 });
  assert.strictEqual(t.snapshot().phase, 'reasoning');
  assert.strictEqual(t.snapshot().label, '推理中');

  t.onLoopEvent({ from: 'send_to_ai', to: 'parse_ai_output', event: 'ai_replied', at: 1100 });
  assert.strictEqual(t.snapshot().phase, 'completion_check');
  assert.strictEqual(t.snapshot().label, '判断是否完成');

  t.onLoopEvent({ from: 'parse_ai_output', to: 'execute_tools', event: 'tools_found', at: 1200 });
  assert.strictEqual(t.snapshot().phase, 'tool_executing');

  t.onLoopEvent({ from: 'execute_tools', to: 'process_results', event: 'tools_done', at: 1300 });
  assert.strictEqual(t.snapshot().phase, 'tool_result');

  t.onLoopEvent({ from: 'process_results', to: 'send_to_ai', event: 'send', at: 1400 });
  assert.strictEqual(t.snapshot().phase, 'reasoning');
  assert.strictEqual(t.snapshot().loopBacks, 1, '主回边必须计一次「回到推理」');

  t.onLoopEvent({ from: 'parse_ai_output', to: 'final_response', event: 'finish', at: 1500 });
  assert.strictEqual(t.snapshot().phase, 'done');
  assert.strictEqual(t.snapshot().label, '已完成');
});

test('interrupted / 错误 / 恢复 映射', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ to: 'error_handling', event: 'error', at: 1 });
  assert.strictEqual(t.snapshot().phase, 'handling_error');
  t.onLoopEvent({ to: 'transient_recovery', event: 'retry', at: 2 });
  assert.strictEqual(t.snapshot().phase, 'recovering');
  t.onLoopEvent({ to: 'interrupted', event: 'interrupt', at: 3 });
  assert.strictEqual(t.snapshot().phase, 'interrupted');
});

test('非回边的 send 不计「回到推理」', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ from: 'init', to: 'send_to_ai', event: 'send', at: 1 });
  t.onLoopEvent({ from: 'transient_recovery', to: 'send_to_ai', event: 'send', at: 2 });
  t.onLoopEvent({ from: 'verify_gate', to: 'send_to_ai', event: 'send', at: 3 });
  assert.strictEqual(t.snapshot().loopBacks, 0, '只有 process_results 的回边才算回到推理');
});

test('工具计数与轮次', () => {
  const t = createTurnPhaseTracker({ maxIterations: 8 });
  t.noteIteration(2, 8);
  t.noteToolStart();
  t.noteToolStart();
  t.noteToolResult();
  const snap = t.snapshot();
  assert.strictEqual(snap.iteration, 2);
  assert.strictEqual(snap.maxIterations, 8);
  assert.strictEqual(snap.toolCalls, 2);
  assert.strictEqual(snap.toolResults, 1);
});

test('snapshot 是 pure & total：无变化返回同一引用', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ to: 'send_to_ai', event: 'send', at: 1 });
  const a = t.snapshot();
  const b = t.snapshot();
  assert.strictEqual(a, b, '同一引用是 React/Ink 跳过重渲染的栅栏');
  t.noteToolStart();
  const c = t.snapshot();
  assert.notStrictEqual(c, b, '变化后必须换新引用');
  assert.strictEqual(c.toolCalls, 1);
});

test('trail 封顶不无限增长', () => {
  const t = createTurnPhaseTracker();
  // 超过 TRAIL_CAP 的转移次数
  for (let i = 0; i < 40; i++) {
    t.onLoopEvent({ to: i % 2 === 0 ? 'send_to_ai' : 'execute_tools', event: 'x', at: i });
  }
  assert.ok(t.snapshot().trail.length <= 14, `trail 应封顶: ${t.snapshot().trail.length}`);
});

test('shell 映射：等待输入 / 已接收输入 / TUI status', () => {
  const t = createTurnPhaseTracker();
  t.noteShellPhase('ready');
  assert.strictEqual(t.snapshot().phase, 'waiting_input');
  t.noteShellPhase('input_active');
  assert.strictEqual(t.snapshot().phase, 'input_received');
  t.noteShellPhase('thinking');
  assert.strictEqual(t.snapshot().phase, 'reasoning');
  t.noteShellPhase('tool');
  assert.strictEqual(t.snapshot().phase, 'tool_executing');
  t.noteShellPhase('done');
  assert.strictEqual(t.snapshot().phase, 'done');
  // 未知值忽略，不改变当前阶段
  t.noteShellPhase('not-a-state');
  assert.strictEqual(t.snapshot().phase, 'done');
});

test('reset 回到等待输入并清零计数', () => {
  const t = createTurnPhaseTracker({ maxIterations: 5 });
  t.onLoopEvent({ to: 'send_to_ai', event: 'send', iteration: 3, at: 1 });
  t.noteToolStart();
  t.reset();
  const snap = t.snapshot();
  assert.strictEqual(snap.phase, 'waiting_input');
  assert.strictEqual(snap.iteration, 0);
  assert.strictEqual(snap.toolCalls, 0);
  assert.strictEqual(snap.loopBacks, 0);
  assert.strictEqual(snap.maxIterations, 5, 'reset 保留 maxIterations');
});

test('formatLine 产出「动作+进度」人话行', () => {
  const t = createTurnPhaseTracker({ maxIterations: 8 });
  t.noteIteration(2, 8);
  t.onLoopEvent({ to: 'execute_tools', event: 'tools_found', at: 1 });
  t.noteToolStart();
  t.noteToolStart();
  t.onLoopEvent({ to: 'process_results', event: 'tools_done', at: 2 });
  t.onLoopEvent({ from: 'process_results', to: 'send_to_ai', event: 'send', at: 3 });
  const line = t.formatLine();
  assert.ok(line.includes('第 2/8 轮'), line);
  assert.ok(line.includes('推理中'), line);
  assert.ok(line.includes('已执行 2 个工具'), line);
  assert.ok(line.includes('1 次回到推理'), line);
});

test('映射表与真源逐字对齐（防漂移）', () => {
  // MIRRORS toolLoopPhases.js:TOOL_LOOP_PHASES —— 表里每个状态都必须有映射
  const { TOOL_LOOP_PHASES } = require('../../src/services/stateMachine/toolLoopPhases');
  for (const state of Object.values(TOOL_LOOP_PHASES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(_internals._LOOP_STATE_MAP, state),
      `toolLoopPhases 新增状态 ${state} 未映射到 turnPhaseTracker`
    );
  }
});

test('分叉：进入等待选择，清除后恢复分叉前阶段', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ to: 'execute_tools', event: 'tools_found', at: 1 });
  assert.strictEqual(t.snapshot().phase, 'tool_executing');
  t.onLoopEvent({ kind: 'fork', fork: 'ask_user', at: 2 });
  const forkSnap = t.snapshot();
  assert.strictEqual(forkSnap.phase, 'awaiting_choice');
  assert.strictEqual(forkSnap.label, '等待选择');
  // trail 记录分叉来源
  const lastEntry = forkSnap.trail[forkSnap.trail.length - 1];
  assert.strictEqual(lastEntry.via, 'fork:ask_user');
  t.onLoopEvent({ kind: 'fork_clear', at: 3 });
  assert.strictEqual(t.snapshot().phase, 'tool_executing', 'fork_clear 恢复到分叉前阶段');
});

test('分叉：permission 子类（shell 审批）同样走等待选择', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ to: 'execute_tools', event: 'tools_found', at: 1 });
  t.onLoopEvent({ kind: 'fork', fork: 'permission', at: 2 });
  assert.strictEqual(t.snapshot().phase, 'awaiting_choice');
  assert.strictEqual(t.snapshot().trail.at(-1).via, 'fork:permission');
  t.onLoopEvent({ kind: 'fork_clear', at: 3 });
  assert.strictEqual(t.snapshot().phase, 'tool_executing');
});

test('连续分叉不覆盖 _phaseBeforeFork（恢复到最早的分叉前阶段）', () => {
  const t = createTurnPhaseTracker();
  t.onLoopEvent({ to: 'execute_tools', event: 'tools_found', at: 1 });
  t.onLoopEvent({ kind: 'fork', fork: 'permission', at: 2 });
  // fork_clear 丢失的极端情况：连续第二个 fork 不应把 awaiting_choice 记为恢复点
  t.onLoopEvent({ kind: 'fork', fork: 'ask_user', at: 3 });
  t.onLoopEvent({ kind: 'fork_clear', at: 4 });
  assert.strictEqual(t.snapshot().phase, 'tool_executing');
});

test('错误回跳：error → 处理错误，retry → 异常恢复 + 计数，恢复后回推理', () => {
  const t = createTurnPhaseTracker({ maxIterations: 8 });
  t.noteIteration(1, 8);
  t.onLoopEvent({ to: 'execute_tools', event: 'tools_found', at: 1 });
  t.onLoopEvent({ from: 'execute_tools', to: 'transient_recovery', event: 'retry', at: 2 });
  assert.strictEqual(t.snapshot().phase, 'recovering');
  assert.strictEqual(t.snapshot().retries, 1);
  // trail 应可见回跳边：via='retry'
  const recoverEntry = t.snapshot().trail.at(-1);
  assert.strictEqual(recoverEntry.via, 'retry');
  t.onLoopEvent({ from: 'transient_recovery', to: 'send_to_ai', event: 'send', at: 3 });
  assert.strictEqual(t.snapshot().phase, 'reasoning', '恢复后回到推理');
  assert.strictEqual(t.snapshot().retries, 1, 'send 不重复计重试');
  // 再来一次 error → 处理错误（不计数，retry 才计）
  t.onLoopEvent({ to: 'error_handling', event: 'error', at: 4 });
  assert.strictEqual(t.snapshot().phase, 'handling_error');
  assert.strictEqual(t.snapshot().retries, 1);
  t.onLoopEvent({ from: 'error_handling', to: 'send_to_ai', event: 'send', at: 5 });
  t.onLoopEvent({ to: 'transient_recovery', event: 'retry', at: 6 });
  assert.strictEqual(t.snapshot().retries, 2);
  const line = t.formatLine();
  assert.ok(line.includes('重试 2 次'), line);
});

test('视觉代理：vision → 视觉模型识图中，vision-done → 回到推理', () => {
  const t = createTurnPhaseTracker();
  t.noteShellPhase('thinking');
  assert.strictEqual(t.snapshot().phase, 'reasoning');
  t.noteShellPhase('vision');
  assert.strictEqual(t.snapshot().phase, 'vision_delegating');
  assert.strictEqual(t.snapshot().label, '视觉模型识图中');
  t.noteShellPhase('vision-done');
  assert.strictEqual(t.snapshot().phase, 'reasoning', '识图结果回注 → 当前模型继续推理');
});

test('视觉代理：finish 后快照仍是已完成（vision 不悬挂）', () => {
  const t = createTurnPhaseTracker();
  t.noteShellPhase('vision');
  t.noteShellPhase('vision-done');
  t.onLoopEvent({ to: 'final_response', event: 'finish', at: 1 });
  assert.strictEqual(t.snapshot().phase, 'done');
});
