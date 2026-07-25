'use strict';

/**
 * taskPanelLines.test.js — 纯叶子格式化/合并(零 IO,确定性)。
 *
 * 验收:状态→图标映射;计划步骤数组→行(空/畸形剔除);与 snapshot 文本合并
 * (计划行在前、去重、皆空→[])。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  panelStatusIcon,
  formatPanelStateLines,
  mergeTaskLines,
  summarizeHiddenTaskLines,
  taskHiddenBreakdownEnabled,
  taskPanelSplitEnabled,
  splitTaskLinesBySource,
  taskPriorityCapEnabled,
  selectTaskLinesByPriority,
} = require('../../../src/cli/tui/ink-components/taskPanelLines');

test('panelStatusIcon: 状态 → ✓/→/✗/○', () => {
  assert.equal(panelStatusIcon('completed'), '✓');
  assert.equal(panelStatusIcon('in_progress'), '→');
  assert.equal(panelStatusIcon('error'), '✗');
  assert.equal(panelStatusIcon('pending'), '○');
});

test('panelStatusIcon: 未知/空 → 保守归 ○', () => {
  assert.equal(panelStatusIcon('weird'), '○');
  assert.equal(panelStatusIcon(''), '○');
  assert.equal(panelStatusIcon(undefined), '○');
  assert.equal(panelStatusIcon(null), '○');
});

test('formatPanelStateLines: 步骤数组 → 带图标行', () => {
  const lines = formatPanelStateLines([
    { description: 'Read config', status: 'completed' },
    { description: 'Patch resolver', status: 'in_progress' },
    { description: 'Run tests', status: 'pending' },
    { description: 'Build wheel', status: 'error' },
  ]);
  assert.deepEqual(lines, [
    '✓ Read config',
    '→ Patch resolver',
    '○ Run tests',
    '✗ Build wheel',
  ]);
});

test('formatPanelStateLines: null/非数组 → []', () => {
  assert.deepEqual(formatPanelStateLines(null), []);
  assert.deepEqual(formatPanelStateLines(undefined), []);
  assert.deepEqual(formatPanelStateLines('nope'), []);
  assert.deepEqual(formatPanelStateLines({}), []);
});

test('formatPanelStateLines: 空描述/空项剔除', () => {
  const lines = formatPanelStateLines([
    null,
    { description: '', status: 'pending' },
    { description: '   ', status: 'pending' },
    { description: 'Real step', status: 'in_progress' },
  ]);
  assert.deepEqual(lines, ['→ Real step']);
});

test('mergeTaskLines: 计划行在前,snapshot 行在后', () => {
  const snap = '○ #1 Model todo — do thing\n→ #2 Another';
  const plan = [
    { description: 'Plan step A', status: 'in_progress' },
    { description: 'Plan step B', status: 'pending' },
  ];
  const merged = mergeTaskLines(snap, plan);
  assert.deepEqual(merged, [
    '→ Plan step A',
    '○ Plan step B',
    '○ #1 Model todo — do thing',
    '→ #2 Another',
  ]);
});

test('mergeTaskLines: 逐行去重(trim 后相同只留一次)', () => {
  const snap = '✓ Shared line';
  const plan = [{ description: 'Shared line', status: 'completed' }];
  // 计划行 "✓ Shared line" 与 snapshot 行 "✓ Shared line" 完全相同 → 只保留一次
  const merged = mergeTaskLines(snap, plan);
  assert.deepEqual(merged, ['✓ Shared line']);
});

test('mergeTaskLines: 两源皆空 → []', () => {
  assert.deepEqual(mergeTaskLines('', null), []);
  assert.deepEqual(mergeTaskLines(null, undefined), []);
  assert.deepEqual(mergeTaskLines('   \n  ', []), []);
});

test('mergeTaskLines: 仅 snapshot(模型 TodoWrite,无计划)', () => {
  const merged = mergeTaskLines('○ #1 Task\n✓ #2 Done', null);
  assert.deepEqual(merged, ['○ #1 Task', '✓ #2 Done']);
});

test('mergeTaskLines: 仅计划(执行中,无模型清单)', () => {
  const merged = mergeTaskLines('', [
    { description: 'Step 1', status: 'completed' },
    { description: 'Step 2', status: 'in_progress' },
  ]);
  assert.deepEqual(merged, ['✓ Step 1', '→ Step 2']);
});

// ── summarizeHiddenTaskLines(刀19:隐藏项按状态分解,对齐 CC hiddenSummary) ──────
const ON = { KHY_TASK_HIDDEN_BREAKDOWN: '1' };
const OFF = { KHY_TASK_HIDDEN_BREAKDOWN: '0' };

test('summarizeHiddenTaskLines: 多状态 → CC 次序 进行中→待办→已完成→错误', () => {
  const hidden = ['○ a', '→ b', '✓ c', '○ d', '→ e', '✗ f'];
  assert.equal(summarizeHiddenTaskLines(hidden, ON), '2 进行中, 2 待办, 1 已完成, 1 错误');
});

test('summarizeHiddenTaskLines: 仅非零项出现', () => {
  assert.equal(summarizeHiddenTaskLines(['○ a', '○ b', '○ c'], ON), '3 待办');
  assert.equal(summarizeHiddenTaskLines(['→ a', '✓ b'], ON), '1 进行中, 1 已完成');
});

test('summarizeHiddenTaskLines: 任一行行首非已知图标 → 空串(回退原始计数,绝不少计)', () => {
  assert.equal(summarizeHiddenTaskLines(['○ a', 'plain text', '→ c'], ON), '');
  assert.equal(summarizeHiddenTaskLines(['- [ ] V1 todo'], ON), '');
});

test('summarizeHiddenTaskLines: 空/非数组 → 空串', () => {
  assert.equal(summarizeHiddenTaskLines([], ON), '');
  assert.equal(summarizeHiddenTaskLines(null, ON), '');
  assert.equal(summarizeHiddenTaskLines(undefined, ON), '');
});

test('summarizeHiddenTaskLines: 门控关 → 空串(调用方逐字节回退原始计数)', () => {
  assert.equal(summarizeHiddenTaskLines(['→ a', '○ b'], OFF), '');
});

test('summarizeHiddenTaskLines: 行首图标前可含空白(trimStart)', () => {
  assert.equal(summarizeHiddenTaskLines(['  → a', '  ○ b'], ON), '1 进行中, 1 待办');
});

test('taskHiddenBreakdownEnabled: 默认开 + falsy 值关', () => {
  assert.equal(taskHiddenBreakdownEnabled({}), true);
  assert.equal(taskHiddenBreakdownEnabled(ON), true);
  assert.equal(taskHiddenBreakdownEnabled(OFF), false);
  assert.equal(taskHiddenBreakdownEnabled({ KHY_TASK_HIDDEN_BREAKDOWN: 'false' }), false);
  assert.equal(taskHiddenBreakdownEnabled({ KHY_TASK_HIDDEN_BREAKDOWN: 'off' }), false);
  assert.equal(taskHiddenBreakdownEnabled({ KHY_TASK_HIDDEN_BREAKDOWN: 'no' }), false);
});

// ── selectTaskLinesByPriority(刀30:截断时按状态生存优先级保活,对齐 CC 截断优先级) ──
test('selectTaskLinesByPriority: 进行中优先于陈旧已完成存活(救回非末尾的 → 行)', () => {
  // cap=2:历史尾切会留末尾两行(✓ d, ✓ e)挤掉非末尾的 → b;优先级保活把 → b 救回。
  const lines = ['✓ a', '→ b', '✓ c', '✓ d', '✓ e'];
  const sel = selectTaskLinesByPriority(lines, 2);
  assert.ok(sel, '可识别图标 → 非 null');
  // 生存:→ b(rank0)必活;另一席从 4 个 completed(rank3)里按尾锚定取下标最大者 = ✓ e。
  assert.deepEqual(sel.kept, ['→ b', '✓ e']);
  assert.deepEqual(sel.hiddenLines, ['✓ a', '✓ c', '✓ d']);
});

test('selectTaskLinesByPriority: 同档内尾锚定(降序原始下标,守 khy 既有哲学)', () => {
  // 全同档(全待办)cap=3 → 保留下标最大的末尾三行,与历史尾切逐字节一致。
  const lines = ['○ 1', '○ 2', '○ 3', '○ 4', '○ 5'];
  const sel = selectTaskLinesByPriority(lines, 3);
  assert.ok(sel);
  assert.deepEqual(sel.kept, ['○ 3', '○ 4', '○ 5']);
  assert.deepEqual(sel.hiddenLines, ['○ 1', '○ 2']);
});

test('selectTaskLinesByPriority: 跨档优先级(进行中/错误 > 待办 > 已完成)', () => {
  // cap=3,7 行混合:rank in_progress(0)/error(1)/pending(2)/completed(3)。
  const lines = ['✓ c1', '○ p1', '→ ip1', '✗ e1', '○ p2', '✓ c2', '→ ip2'];
  const sel = selectTaskLinesByPriority(lines, 3);
  assert.ok(sel);
  // 排序候选:→ ip1(0)、→ ip2(0)、✗ e1(1)取前 3 → 两个进行中 + 一个错误。
  assert.deepEqual(sel.kept, ['→ ip1', '✗ e1', '→ ip2']);
  // 隐藏=其余按原始顺序。
  assert.deepEqual(sel.hiddenLines, ['✓ c1', '○ p1', '○ p2', '✓ c2']);
});

test('selectTaskLinesByPriority: 任一行图标不可识别 → null(回退尾切)', () => {
  assert.equal(selectTaskLinesByPriority(['→ a', 'plain', '○ c'], 1), null);
  assert.equal(selectTaskLinesByPriority(['- [ ] V1 todo', '→ b'], 1), null);
});

test('selectTaskLinesByPriority: 无截断(cap≥行数)或非法 cap → null', () => {
  assert.equal(selectTaskLinesByPriority(['→ a', '○ b'], 2), null);
  assert.equal(selectTaskLinesByPriority(['→ a', '○ b'], 5), null);
  assert.equal(selectTaskLinesByPriority(['→ a'], -1), null);
  assert.equal(selectTaskLinesByPriority(['→ a'], Infinity), null);
  assert.equal(selectTaskLinesByPriority(null, 1), null);
});

test('selectTaskLinesByPriority: 行首图标前可含空白(trimStart)', () => {
  const sel = selectTaskLinesByPriority(['  ✓ a', '  → b'], 1);
  assert.ok(sel);
  assert.deepEqual(sel.kept, ['  → b']);
  assert.deepEqual(sel.hiddenLines, ['  ✓ a']);
});

test('taskPriorityCapEnabled: 默认开 + falsy 值关', () => {
  assert.equal(taskPriorityCapEnabled({}), true);
  assert.equal(taskPriorityCapEnabled({ KHY_TASK_PRIORITY_CAP: '1' }), true);
  assert.equal(taskPriorityCapEnabled({ KHY_TASK_PRIORITY_CAP: '0' }), false);
  assert.equal(taskPriorityCapEnabled({ KHY_TASK_PRIORITY_CAP: 'false' }), false);
  assert.equal(taskPriorityCapEnabled({ KHY_TASK_PRIORITY_CAP: 'off' }), false);
  assert.equal(taskPriorityCapEnabled({ KHY_TASK_PRIORITY_CAP: 'no' }), false);
});

// ── 语义分区(缺口②):本会话清单 vs 跨会话项目任务 ────────────────────────────
// V2 持久化行由 _taskStore.snapshot() 写成 `<icon> #<id> …`;计划/ V1 行是 `<icon> <文本>`。

test('taskPanelSplitEnabled: 默认开 + falsy 值关', () => {
  assert.equal(taskPanelSplitEnabled({}), true);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: '1' }), true);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: 'on' }), true);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: '0' }), false);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: 'false' }), false);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: 'off' }), false);
  assert.equal(taskPanelSplitEnabled({ KHY_TASK_PANEL_SPLIT: 'no' }), false);
});

test('splitTaskLinesBySource: 两源并存 → 拆成本会话清单 + 项目任务', () => {
  const lines = [
    '→ 写代码',            // 计划步骤 → session
    '○ 跑测试',            // 计划步骤 → session
    '✓ #12 重构解析器',    // V2 持久化 → project
    '○ #13 补文档',        // V2 持久化 → project
    '✓ 提交',              // V1 todo → session
  ];
  const groups = splitTaskLinesBySource(lines, {});
  assert.ok(groups, '两源并存应返回分组');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, 'session');
  assert.equal(groups[0].label, '本会话清单');
  assert.deepEqual(groups[0].lines, ['→ 写代码', '○ 跑测试', '✓ 提交']);
  assert.equal(groups[1].key, 'project');
  assert.equal(groups[1].label, '项目任务 · 跨会话');
  assert.deepEqual(groups[1].lines, ['✓ #12 重构解析器', '○ #13 补文档']);
});

test('splitTaskLinesBySource: 仅会话行(无 #id)→ null(单一来源不分区)', () => {
  assert.equal(splitTaskLinesBySource(['→ 写代码', '○ 跑测试'], {}), null);
});

test('splitTaskLinesBySource: 仅项目行 → null(单一来源不分区)', () => {
  assert.equal(splitTaskLinesBySource(['✓ #1 a', '○ #2 b'], {}), null);
});

test('splitTaskLinesBySource: 门控关 → null(逐字节回退扁平)', () => {
  const lines = ['→ 写代码', '✓ #12 重构'];
  assert.equal(splitTaskLinesBySource(lines, { KHY_TASK_PANEL_SPLIT: '0' }), null);
  assert.equal(splitTaskLinesBySource(lines, { KHY_TASK_PANEL_SPLIT: 'off' }), null);
});

test('splitTaskLinesBySource: 空/非数组 → null', () => {
  assert.equal(splitTaskLinesBySource([], {}), null);
  assert.equal(splitTaskLinesBySource(null, {}), null);
  assert.equal(splitTaskLinesBySource(undefined, {}), null);
});

test('splitTaskLinesBySource: 图标前含空白仍能识别 #id 项目行', () => {
  const groups = splitTaskLinesBySource(['  → 计划', '  ✓ #7 项目'], {});
  assert.ok(groups);
  assert.deepEqual(groups[0].lines, ['  → 计划']);
  assert.deepEqual(groups[1].lines, ['  ✓ #7 项目']);
});

test('splitTaskLinesBySource: 不增删行 — 两组行数之和 == 输入行数', () => {
  const lines = ['→ a', '✓ #1 x', '○ b', '○ #2 y', '✗ #3 z', '✓ c'];
  const groups = splitTaskLinesBySource(lines, {});
  const total = groups.reduce((n, g) => n + g.lines.length, 0);
  assert.equal(total, lines.length);
});
