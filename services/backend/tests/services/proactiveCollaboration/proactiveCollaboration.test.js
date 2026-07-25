'use strict';

/**
 * tests/services/proactiveCollaboration/proactiveCollaboration.test.js
 * 主动协同子系统（DESIGN-ARCH-031）。
 *
 * 覆盖：
 *   - opportunityDetector：枚举列表 / 共享动词枚举 / 独立多动词 / 文件目标
 *     / 并行标记 的正向识别，以及简单请求·会话·问句·短消息·并发误词 的负向拒绝。
 *   - delegationPlanner：扇出上限裁剪、角色推断、去重、tool-call 形状。
 *   - 门面 proposeCollaboration：四道防呆（禁用 / agent 工具缺失 / 无机会 / 不可执行）
 *     与 fail-soft（异常吞掉、永不阻断主循环）。
 *
 * 纯逻辑、零 I/O、零模型调用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const collab = require('../../../src/services/proactiveCollaboration');
const detector = require('../../../src/services/proactiveCollaboration/opportunityDetector');
const planner = require('../../../src/services/proactiveCollaboration/delegationPlanner');
const { LIMITS } = require('../../../src/services/proactiveCollaboration/constants');

const { detectCollaborationOpportunity } = detector;
const { planDelegation, inferRole } = planner;
const { proposeCollaboration } = collab;

// ── opportunityDetector：正向识别 ────────────────────────────────────

test('detector: explicit numbered list → 3 deliverables, high confidence', () => {
  const r = detectCollaborationOpportunity('1. 编写后端 API\n2. 实现前端页面\n3. 添加单元测试');
  assert.equal(r.shouldCollaborate, true);
  assert.equal(r.subtasks.length, 3);
  assert.ok(r.confidence >= 0.6, `confidence ${r.confidence} should clear the floor`);
});

test('detector: shared-verb enumeration propagates the verb to each object', () => {
  const r = detectCollaborationOpportunity('实现用户登录、注册和找回密码三个接口');
  assert.equal(r.shouldCollaborate, true);
  assert.ok(r.subtasks.length >= 3);
  // Every object inherits the leading 实现 so each sub-task is self-contained.
  assert.ok(r.subtasks.every(s => /实现/.test(s.task)), JSON.stringify(r.subtasks));
});

test('detector: heterogeneous independent verbs score via verb diversity', () => {
  const r = detectCollaborationOpportunity('调研市场情况、编写分析报告并验证数据准确性');
  assert.equal(r.shouldCollaborate, true);
  assert.equal(r.subtasks.length, 3);
});

test('detector: explicit parallel marker (分别) lifts confidence to ceiling', () => {
  const r = detectCollaborationOpportunity('分别调研 React、Vue 和 Svelte 三个框架的性能');
  assert.equal(r.shouldCollaborate, true);
  assert.equal(r.confidence, 1);
});

test('detector: multiple distinct file targets corroborate decomposition', () => {
  const r = detectCollaborationOpportunity('更新 a.js、b.ts 和 c.py 里的导入路径');
  assert.equal(r.shouldCollaborate, true);
  assert.ok(r.signals.distinctTargets >= 3);
});

// ── opportunityDetector：负向拒绝 ────────────────────────────────────

test('detector: short greeting → no collaboration', () => {
  const r = detectCollaborationOpportunity('你好');
  assert.equal(r.shouldCollaborate, false);
});

test('detector: single-deliverable request → no collaboration', () => {
  const r = detectCollaborationOpportunity('实现登录功能');
  assert.equal(r.shouldCollaborate, false);
});

test('detector: conversational question → no collaboration', () => {
  const r = detectCollaborationOpportunity('帮我看看这个 bug 为什么会发生');
  assert.equal(r.shouldCollaborate, false);
});

test('detector: 并发 must not be mis-split into a fake task list', () => {
  const r = detectCollaborationOpportunity('这个项目并发性能怎么样啊请帮我评估一下');
  assert.equal(r.shouldCollaborate, false);
});

test('detector: bracketed [System …] hints are stripped, not turned into tasks', () => {
  const r = detectCollaborationOpportunity('[System Skill: scaffold a project and initialize modules] 你好吗');
  assert.equal(r.shouldCollaborate, false);
});

test('detector: pure determinism — same input, same output', () => {
  const msg = '实现用户登录、用户注册和找回密码三个接口';
  assert.deepEqual(
    detectCollaborationOpportunity(msg),
    detectCollaborationOpportunity(msg),
  );
});

// ── delegationPlanner ────────────────────────────────────────────────

test('planner: assigns roles by action verb', () => {
  assert.equal(inferRole('编写后端 API'), 'implement');
  assert.equal(inferRole('调研三个框架'), 'explore');
  assert.equal(inferRole('添加单元测试'), 'verify');
  assert.equal(inferRole('分析性能瓶颈'), 'planner');
  assert.equal(inferRole('随便聊聊'), 'general');
});

test('planner: produces a well-formed agent tool-call', () => {
  const opp = { subtasks: [{ task: '实现登录' }, { task: '实现注册' }] };
  const plan = planDelegation(opp, { goal: '实现登录和注册' });
  assert.equal(plan.toolCall.name, 'agent');
  assert.equal(plan.toolCall.params.mode, 'flexible');
  assert.equal(plan.toolCall.params.subtasks.length, 2);
  assert.ok(typeof plan.toolCall.params.prompt === 'string' && plan.toolCall.params.prompt.length > 0);
  assert.ok(plan.toolCall.params.subtasks.every(s => s.task && s.role));
});

test('planner: clamps fan-out to MAX_SUBTASKS and reports the dropped count', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ task: `实现模块${i}` }));
  const plan = planDelegation({ subtasks: many }, {});
  assert.equal(plan.subtaskCount, LIMITS.MAX_SUBTASKS);
  assert.equal(plan.dropped, 9 - LIMITS.MAX_SUBTASKS);
});

test('planner: de-duplicates identical sub-tasks', () => {
  const plan = planDelegation({ subtasks: [{ task: '实现登录' }, { task: '实现登录' }, { task: '实现注册' }] }, {});
  assert.equal(plan.subtaskCount, 2);
});

test('planner: returns null tool-call when too few sub-tasks', () => {
  const plan = planDelegation({ subtasks: [{ task: '实现登录' }] }, {});
  assert.equal(plan.toolCall, null);
});

// ── 门面 proposeCollaboration：四道防呆 + fail-soft ────────────────────

test('facade: ① disabled flag → no-op', () => {
  const r = proposeCollaboration('实现用户登录、用户注册和找回密码三个接口', { enabled: false, agentToolAvailable: true });
  assert.equal(r.inject, false);
  assert.match(r.reason, /disabled/);
});

test('facade: ② agent tool unavailable → no-op', () => {
  const r = proposeCollaboration('实现用户登录、用户注册和找回密码三个接口', { enabled: true, agentToolAvailable: false });
  assert.equal(r.inject, false);
  assert.match(r.reason, /unavailable/);
});

test('facade: ③ no opportunity → no-op with confidence reported', () => {
  const r = proposeCollaboration('帮我看看这个 bug', { enabled: true, agentToolAvailable: true });
  assert.equal(r.inject, false);
  assert.equal(r.toolCall, null);
});

test('facade: happy path → injectable agent tool-call', () => {
  const r = proposeCollaboration('实现用户登录、用户注册和找回密码三个接口', { enabled: true, agentToolAvailable: true });
  assert.equal(r.inject, true);
  assert.equal(r.toolCall.name, 'agent');
  assert.ok(r.subtaskCount >= 2);
  assert.match(r.reason, /delegating/);
});

test('facade: fail-soft — a malformed message never throws', () => {
  assert.doesNotThrow(() => proposeCollaboration(null, { enabled: true, agentToolAvailable: true }));
  assert.doesNotThrow(() => proposeCollaboration(undefined, { enabled: true, agentToolAvailable: true }));
  const r = proposeCollaboration(12345, { enabled: true, agentToolAvailable: true });
  assert.equal(r.inject, false);
});
