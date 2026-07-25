'use strict';

/**
 * autonomyInspectPlan.test.js — 纯叶子 /autonomy 巡检逻辑单一真源测试(零 IO·确定性·绝不抛)。
 * 覆盖:parseAutonomyArgs 全语法 + 边界 + parseError;tallyRuns/tallyTasks 分桶;
 * build* 渲染器(注入快照·缺面诚实「不可用」·绝不抛);isEnabled 门控梯。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/autonomy/autonomyInspectPlan');

test('parseAutonomyArgs: 空参 → status 概览(deep=false)', () => {
  const p = leaf.parseAutonomyArgs([]);
  assert.strictEqual(p.action, 'status');
  assert.strictEqual(p.deep, false);
  assert.strictEqual(p.valid, true);
  assert.strictEqual(p.parseError, null);
});

test('parseAutonomyArgs: undefined/非数组入参不抛 → status', () => {
  assert.strictEqual(leaf.parseAutonomyArgs(undefined).action, 'status');
  assert.strictEqual(leaf.parseAutonomyArgs(null).action, 'status');
  assert.strictEqual(leaf.parseAutonomyArgs('nope').action, 'status');
});

test('parseAutonomyArgs: status --deep / -d / deep 三写法都置 deep', () => {
  assert.strictEqual(leaf.parseAutonomyArgs(['status', '--deep']).deep, true);
  assert.strictEqual(leaf.parseAutonomyArgs(['status', '-d']).deep, true);
  assert.strictEqual(leaf.parseAutonomyArgs(['status', 'deep']).deep, true);
  assert.strictEqual(leaf.parseAutonomyArgs(['status']).deep, false);
});

test('parseAutonomyArgs: help / -h / --help', () => {
  assert.strictEqual(leaf.parseAutonomyArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseAutonomyArgs(['-h']).action, 'help');
  assert.strictEqual(leaf.parseAutonomyArgs(['--help']).action, 'help');
});

test('parseAutonomyArgs: runs/flows [N] 解析 limit(默认/上限钳制/非法回退)', () => {
  assert.strictEqual(leaf.parseAutonomyArgs(['runs']).limit, leaf._DEFAULT_LIMIT);
  assert.strictEqual(leaf.parseAutonomyArgs(['runs', '5']).limit, 5);
  assert.strictEqual(leaf.parseAutonomyArgs(['flows', '7']).limit, 7);
  assert.strictEqual(leaf.parseAutonomyArgs(['runs', '9999']).limit, leaf._MAX_LIMIT);
  assert.strictEqual(leaf.parseAutonomyArgs(['runs', 'abc']).limit, leaf._DEFAULT_LIMIT);
  assert.strictEqual(leaf.parseAutonomyArgs(['runs', '-3']).limit, leaf._DEFAULT_LIMIT);
});

test('parseAutonomyArgs: flow <id> → flow-view', () => {
  const p = leaf.parseAutonomyArgs(['flow', 'run-123']);
  assert.strictEqual(p.action, 'flow-view');
  assert.strictEqual(p.flowId, 'run-123');
  assert.strictEqual(p.valid, true);
});

test('parseAutonomyArgs: flow cancel/resume <id> → flow-cancel/flow-resume', () => {
  const c = leaf.parseAutonomyArgs(['flow', 'cancel', 'run-9']);
  assert.strictEqual(c.action, 'flow-cancel');
  assert.strictEqual(c.flowId, 'run-9');
  const r = leaf.parseAutonomyArgs(['flow', 'resume', 'run-9']);
  assert.strictEqual(r.action, 'flow-resume');
  assert.strictEqual(r.flowId, 'run-9');
});

test('parseAutonomyArgs: flow 缺 id → valid:false missing_flow_id', () => {
  assert.deepStrictEqual(
    { v: leaf.parseAutonomyArgs(['flow']).valid, e: leaf.parseAutonomyArgs(['flow']).parseError },
    { v: false, e: 'missing_flow_id' },
  );
  const cc = leaf.parseAutonomyArgs(['flow', 'cancel']);
  assert.strictEqual(cc.valid, false);
  assert.strictEqual(cc.parseError, 'missing_flow_id');
});

test('parseAutonomyArgs: 未知子命令 → valid:false unknown_action', () => {
  const p = leaf.parseAutonomyArgs(['frobnicate']);
  assert.strictEqual(p.valid, false);
  assert.strictEqual(p.parseError, 'unknown_action');
});

test('tallyRuns: 按 control 分桶(含 idle 兜底·防呆非数组/脏元素)', () => {
  const t = leaf.tallyRuns([
    { control: 'running' }, { control: 'running' },
    { control: 'paused' }, { control: 'done' },
    { control: 'failed' }, { control: 'cancelled' },
    { control: 'weird' }, null, 'x',
  ]);
  assert.strictEqual(t.total, 7);
  assert.strictEqual(t.running, 2);
  assert.strictEqual(t.paused, 1);
  assert.strictEqual(t.done, 1);
  assert.strictEqual(t.failed, 1);
  assert.strictEqual(t.cancelled, 1);
  assert.strictEqual(t.idle, 1);
  assert.strictEqual(leaf.tallyRuns('nope').total, 0);
});

test('tallyTasks: 按 status 分桶(防呆)', () => {
  const t = leaf.tallyTasks([
    { status: 'ready' }, { status: 'ready' }, { status: 'done' }, {},
  ]);
  assert.strictEqual(t.total, 4);
  assert.strictEqual(t.ready, 2);
  assert.strictEqual(t.done, 1);
  assert.strictEqual(t.unknown, 1);
  assert.strictEqual(leaf.tallyTasks(null).total, 0);
});

test('buildOverview: 缺面诚实渲染「不可用」/「none」,绝不抛', () => {
  const txt = leaf.buildOverview({});
  assert.match(txt, /自治活动总览/);
  assert.match(txt, /编排运行: 不可用/);
  assert.match(txt, /任务板: 不可用/);
  assert.match(txt, /计划任务\(cron\): 不可用/);
  assert.match(txt, /Proactive idle-tick: 不可用/);
  assert.match(txt, /远端会话: none/);
});

test('buildOverview: 有面渲染计数 + 最新行 + 禁用提示', () => {
  const txt = leaf.buildOverview({
    permissionMode: 'plan',
    enabled: false,
    runs: [{ runId: 'r1', control: 'done', progress: { done: 2, total: 2 }, mode: 'seq', label: 'x' }],
    tasks: [{ status: 'ready' }],
    cronJobs: [{ id: 'j1', enabled: true }, { id: 'j2', enabled: false }],
    proactiveActive: true,
    remotedev: { state: 'live' },
  });
  assert.match(txt, /权限模式: plan/);
  assert.match(txt, /编排运行: 共 1/);
  assert.match(txt, /编排已禁用/);
  assert.match(txt, /最新:/);
  assert.match(txt, /任务板: 共 1/);
  assert.match(txt, /计划任务\(cron\): 共 2（启用 1）/);
  assert.match(txt, /Proactive idle-tick: 活跃/);
  assert.match(txt, /远端会话: live/);
});

test('buildDeep: 概览 + 明细分节(空 → （无）)', () => {
  const txt = leaf.buildDeep({});
  assert.match(txt, /── 编排运行明细 ──/);
  assert.match(txt, /── 计划任务\(cron\)明细 ──/);
  assert.match(txt, /── 权限模式 ──/);
  assert.match(txt, /（无）/);
});

test('buildRunsList / buildFlowsList: 空 → （无）;有 → 列表', () => {
  assert.match(leaf.buildRunsList([], 10), /（无）/);
  assert.match(leaf.buildFlowsList(null, 10), /（无）/);
  const runs = [{ runId: 'r1', control: 'running', progress: { done: 1, total: 3 } }];
  assert.match(leaf.buildRunsList(runs, 10), /近期编排运行/);
  assert.match(leaf.buildRunsList(runs, 10), /r1/);
  assert.match(leaf.buildFlowsList(runs, 10), /近期受管 flow/);
});

test('buildFlowView: null → 未找到;有 → 详情 + 步骤', () => {
  assert.match(leaf.buildFlowView(null), /未找到/);
  const txt = leaf.buildFlowView({
    runId: 'r1', mode: 'seq', control: 'running', label: '目标X',
    progress: { done: 1, total: 2, failed: 0 },
    steps: [{ stepId: 's1', status: 'done', role: 'coder', result: 'ok' }, { stepId: 's2', status: 'blocked', error: 'boom' }],
  });
  assert.match(txt, /Flow r1/);
  assert.match(txt, /control=running/);
  assert.match(txt, /目标: 目标X/);
  assert.match(txt, /s1/);
  assert.match(txt, /✗ boom/);
});

test('isEnabled: 默认开;0/false/off/no/空 → 关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({ KHY_AUTONOMY: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_AUTONOMY: v }), false, `KHY_AUTONOMY=${v}`);
  }
});
