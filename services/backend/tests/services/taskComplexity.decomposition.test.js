'use strict';

/**
 * Tests for complex-task decomposition integration in the natural tool loop
 * (cli/aiChatCore.js) — "学会拆解任务步骤".
 *
 * The natural tool loop previously only injected a static "decompose" hint
 * for large tasks and relied on the model's goodwill. Now it:
 *   1. Injects the structured planning instruction (taskComplexity
 *      injectPlanningPrompt) so the model emits an <execution_plan> block
 *      (numbered steps + tool hints + parallel groups) before acting;
 *   2. Parses that plan (parseExecutionPlan) and tracks step progress via
 *      matchToolCallToStep, so tool calls stay aligned to the plan and the
 *      UI reports "步骤 X/Y".
 *
 * These tests cover the pure leaf pieces that make up that integration.
 */
const test = require('node:test');
const assert = require('node:assert');

const tc = require('../../src/services/taskComplexity');

test('injectPlanningPrompt adds execution-plan instructions for complex tasks', () => {
  const msg = '请实现用户登录功能：1) 创建数据库表 2) 编写注册接口 3) 编写登录接口';
  const injected = tc.injectPlanningPrompt(msg, { autoDecompose: true });
  assert.ok(injected.includes('<execution_plan>'), 'must instruct an execution plan block');
  assert.ok(injected.includes(msg), 'must keep the original message');
  assert.ok(injected.includes('subtasks'), 'auto-decompose must hint at subtasks');
  assert.ok(injected.includes('segments') || injected.includes('分段'),
    'auto-decompose must instruct segmented delivery of very long output');
});

test('injectPlanningPrompt without autoDecompose does not add segment/subtask hints', () => {
  const msg = '请实现用户登录功能：1) 创建数据库表 2) 编写注册接口 3) 编写登录接口';
  const injected = tc.injectPlanningPrompt(msg, { autoDecompose: false });
  assert.ok(injected.includes('<execution_plan>'), 'must still instruct a plan block');
  assert.ok(!injected.includes('subtasks'), 'no auto-decompose → no subtask hint');
  assert.ok(!(injected.includes('segments') || injected.includes('分段')),
    'no auto-decompose → no segment hint');
});

test('injectPlanningPrompt multiOption instructs the model to present strategies first', () => {
  const msg = '请重构数据层：1) 拆分数据访问 2) 引入仓库模式 3) 迁移调用方';
  const injected = tc.injectPlanningPrompt(msg, { multiOption: true });
  assert.ok(injected.includes('<execution_plan>'), 'must still instruct a plan block');
  assert.ok(injected.includes('AskUserQuestion'), 'must route the choice through AskUserQuestion');
  assert.ok(injected.includes('执行方案') || injected.includes('Approach'),
    'must name the strategy-choice question');
  assert.ok(injected.includes(msg), 'must keep the original message');
});

test('injectPlanningPrompt multiOption without the gate keeps legacy behavior', () => {
  const msg = '请重构数据层：1) 拆分数据访问 2) 引入仓库模式 3) 迁移调用方';
  const injected = tc.injectPlanningPrompt(msg, { multiOption: false, autoDecompose: false });
  assert.ok(!injected.includes('AskUserQuestion'), 'gate off → no multi-option hint');
  assert.ok(injected.includes('<execution_plan>'), 'plan block remains');
});

test('parseExecutionPlan extracts numbered steps with tool hints', () => {
  const reply = '计划如下：\n<execution_plan>\n1. [read] 查看现有表结构\n2. [shell_command] 创建 users 表\n3. [write] 编写注册接口\n</execution_plan>\n开始执行';
  const plan = tc.parseExecutionPlan(reply);
  assert.ok(plan, 'plan must parse');
  assert.strictEqual(plan.steps.length, 3);
  assert.strictEqual(plan.steps[0].toolHint, 'read');
  assert.strictEqual(plan.steps[1].description, '创建 users 表');
  assert.strictEqual(plan.steps[0].status, 'pending');
});

test('parseExecutionPlan returns null for replies without a plan block', () => {
  assert.strictEqual(tc.parseExecutionPlan('直接回答，没有计划'), null);
  assert.strictEqual(tc.parseExecutionPlan(''), null);
  assert.strictEqual(tc.parseExecutionPlan(null), null);
});

test('matchToolCallToStep advances sequentially across plan steps', () => {
  const reply = '<execution_plan>\n1. [read] 查看表结构\n2. [shell_command] 创建表\n3. [runTests] 运行测试\n</execution_plan>';
  const plan = tc.parseExecutionPlan(reply);
  assert.ok(plan);

  // Sequential advancement: Read → step 0, then shell_command → step 1.
  let step = 0;
  const s1 = tc.matchToolCallToStep('Read', { file_path: 'schema.sql' }, plan, step);
  assert.strictEqual(s1, 0);
  plan.steps[s1].status = 'completed';
  step = s1 + 1;
  const s2 = tc.matchToolCallToStep('shell_command', { command: 'sqlite3 init' }, plan, step);
  assert.strictEqual(s2, 1);
  assert.ok(String(plan.steps[s2].description).includes('创建表'));
});

test('matchToolCallToStep handles completed steps and sequential default', () => {
  const reply = '<execution_plan>\n1. [read] 查看表结构\n2. [write] 写接口\n3. [runTests] 跑测试\n</execution_plan>';
  const plan = tc.parseExecutionPlan(reply);
  plan.steps[0].status = 'completed';
  // Sequential advancement: a tool call while step 2 is pending advances to
  // the current (pending) step by default — matching the loop's "advance one
  // step per tool call" contract.
  const s = tc.matchToolCallToStep('runTests', {}, plan, 1);
  assert.strictEqual(s, 1, 'sequential default advances to the current pending step');
  // A tool hint match on a later step is found by lookahead when the current
  // step is already completed.
  plan.steps[1].status = 'completed';
  const s3 = tc.matchToolCallToStep('runTests', {}, plan, 2);
  assert.strictEqual(s3, 2, 'lookahead finds the matching step after completed ones');
});
