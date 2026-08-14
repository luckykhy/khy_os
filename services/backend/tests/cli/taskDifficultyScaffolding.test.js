'use strict';

/**
 * taskDifficultyScaffolding.test.js — 锁定「裸问候被能力硬约束误拦」的根因修复。
 *
 * 历史 bug(截图:windows 上 glm-4.7-flash 输入「你好」被硬拦「推理能力不足 需要 4/5
 * 当前 3/5」):harness 在把用户消息交给模型前会前置注入 planning / key-findings 的
 * `[System: …]` 前言,其中 key-findings 含「定位到 bug 的根本原因」等词。
 * `_assessTaskDifficulty` 对整段(含前言)做子串匹配,`/…原因…/` 命中 → reasoning 需求
 * 抬到 4;glm-4.7-flash 子串匹配 MODEL_CAPABILITIES['glm-4'](reasoning cap 3),
 * 4 > 3 → `checkModelCapability` 报「推理能力不足」→ `_resolveHardTaskGuard` 硬拦。
 * 于是「你好」这种零推理需求的输入也被当成强推理任务拦下。
 *
 * 修:难度评分唯一真源 `_assessTaskDifficulty` 入口先 `_stripHarnessScaffolding`,
 * 按空行(`\n\n`)分段剥掉开头的 `[System:…]` 前言(planning 内部含 `[read]` 方括号,
 * 故按空行而非方括号匹配),并清掉残留 `<finding>` / `<execution_plan>`,再评分。
 * 纯评分口径修正,不改真正发给模型的原文。
 */

const test = require('node:test');
const assert = require('node:assert');

const ai = require('../../src/cli/ai');
const { _stripHarnessScaffolding, _assessTaskDifficulty } = ai.__test__;

// key-findings 前言(keyFindings.js buildKeyFindingsInstruction),以 `${inst}\n\n${message}` 前置。
const KF_PREAMBLE = [
  '[System: 执行过程中遇到关键发现请主动汇报，单独成行用以下标记（仅在真正命中时使用，不要为凑数而写）:',
  '- 定位到 bug 的根本原因 → <finding type="root_cause">...</finding>',
  '- 找到关键文件/入口 → <finding type="key_file">...</finding>',
  '这些标记会被单独提取展示，正文无需重复其内容。]',
].join('\n');

// planning 前言(toolUseLoop _injectPlanningPrompt),内部含 `[read]` 方括号。
const PLAN_PREAMBLE =
  '[System: This task has multiple steps. First outline a short plan, e.g. ' +
  '"2. [read] Read config ← parallel_group: A". Do NOT just silently chain tool calls.]';

test('_stripHarnessScaffolding drops leading [System:…] preambles, keeps user text', () => {
  assert.strictEqual(_stripHarnessScaffolding(KF_PREAMBLE + '\n\n你好'), '你好');
  assert.strictEqual(
    _stripHarnessScaffolding(PLAN_PREAMBLE + '\n\n' + KF_PREAMBLE + '\n\n你好'),
    '你好',
    'planning 内部的 [read] 方括号不应导致提前截断',
  );
});

test('_stripHarnessScaffolding is a no-op on genuine user messages', () => {
  assert.strictEqual(_stripHarnessScaffolding('你好'), '你好');
  assert.strictEqual(_stripHarnessScaffolding('帮我分析这个崩溃的原因'), '帮我分析这个崩溃的原因');
  assert.strictEqual(_stripHarnessScaffolding(''), '');
  assert.strictEqual(_stripHarnessScaffolding(null), '');
});

test('bare greeting scores no capability requirement even with injected preambles', () => {
  const bare = _assessTaskDifficulty('你好');
  assert.strictEqual(bare.reasoning, 1);
  assert.strictEqual(bare.code, 1);

  // 关键回归:注入前言后仍必须是 1,而非旧行为的 4。
  const withKf = _assessTaskDifficulty(KF_PREAMBLE + '\n\n你好');
  assert.strictEqual(withKf.reasoning, 1, 'key-findings 前言的「根本原因」不应抬高 reasoning');
  assert.strictEqual(withKf.code, 1);

  const withBoth = _assessTaskDifficulty(PLAN_PREAMBLE + '\n\n' + KF_PREAMBLE + '\n\n你好');
  assert.strictEqual(withBoth.reasoning, 1);
  assert.strictEqual(withBoth.code, 1);
  assert.strictEqual(withBoth.contextNeeded, 0, '前言不应把 contextNeeded 撑大');
});

test('genuine hard tasks still score their real requirement (no over-strip)', () => {
  const codeTask = _assessTaskDifficulty('帮我修复登录 bug');
  assert.strictEqual(codeTask.code, 4, '真实修复任务应保留 code=4');

  const reasonTask = _assessTaskDifficulty('分析一下这个崩溃的原因');
  assert.strictEqual(reasonTask.reasoning, 4, '真实分析原因任务应保留 reasoning=4');

  // 前言 + 真实推理任务:前言剥掉后,真实任务本身仍触发 reasoning=4。
  const wrapped = _assessTaskDifficulty(KF_PREAMBLE + '\n\n分析一下这个崩溃的原因');
  assert.strictEqual(wrapped.reasoning, 4);
});
