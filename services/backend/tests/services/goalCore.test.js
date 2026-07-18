'use strict';

// goalCore.test.js — 纯叶子「持久目标」单一真源测试(node:test)。
const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../../src/services/goalCore');

test('isEnabled: 默认开,仅显式 0/false/off/no 关闭', () => {
  assert.equal(core.isEnabled({}), true);
  assert.equal(core.isEnabled({ KHY_GOAL: 'true' }), true);
  assert.equal(core.isEnabled({ KHY_GOAL: '1' }), true);
  assert.equal(core.isEnabled({ KHY_GOAL: 'off' }), false);
  assert.equal(core.isEnabled({ KHY_GOAL: 'false' }), false);
  assert.equal(core.isEnabled({ KHY_GOAL: '0' }), false);
  assert.equal(core.isEnabled({ KHY_GOAL: 'NO' }), false);
});

test('normalizeGoal: 去空白、折叠多空行、按上限截断', () => {
  assert.equal(core.normalizeGoal('  hello  '), 'hello');
  assert.equal(core.normalizeGoal(''), '');
  assert.equal(core.normalizeGoal(null), '');
  assert.equal(core.normalizeGoal('a\n\n\n\nb'), 'a\n\nb');
  const long = 'x'.repeat(core.GOAL_MAX_LEN + 500);
  assert.ok(core.normalizeGoal(long).length <= core.GOAL_MAX_LEN);
});

test('scopeKeyFor: 同目录恒等、不同目录不同、空→global、尾随斜杠归一', () => {
  const a = core.scopeKeyFor('/home/u/proj');
  const b = core.scopeKeyFor('/home/u/proj');
  const c = core.scopeKeyFor('/home/u/other');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(core.scopeKeyFor(''), core.GLOBAL_SCOPE);
  assert.equal(core.scopeKeyFor(null), core.GLOBAL_SCOPE);
  assert.equal(core.scopeKeyFor('/home/u/proj/'), core.scopeKeyFor('/home/u/proj'));
  assert.match(a, /^[0-9a-f]{8}$/); // FNV-1a 32 位十六进制
});

test('buildGoalRecord: 空文本失败,正常文本组装并绑定作用域', () => {
  assert.equal(core.buildGoalRecord({ text: '   ' }).ok, false);
  const r = core.buildGoalRecord({ text: 'ship 0.1.136', cwd: '/p', createdAt: 'T', id: 'id1' });
  assert.equal(r.ok, true);
  assert.equal(r.goal.text, 'ship 0.1.136');
  assert.equal(r.goal.scope, core.scopeKeyFor('/p'));
  assert.equal(r.goal.id, 'id1');
  assert.equal(r.goal.active, true);
});

test('pickActiveGoal: 优先项目作用域,回退全局,取最新', () => {
  const cwd = '/proj';
  const scope = core.scopeKeyFor(cwd);
  const goals = [
    { active: true, text: 'old proj', scope },
    { active: true, text: 'new proj', scope },
    { active: true, text: 'global one', scope: core.GLOBAL_SCOPE },
    { active: false, text: 'inactive', scope },
  ];
  assert.equal(core.pickActiveGoal(goals, cwd).text, 'new proj');     // 取同项目最新
  assert.equal(core.pickActiveGoal(goals, '/other').text, 'global one'); // 无项目目标→全局
  assert.equal(core.pickActiveGoal([], cwd), null);
  assert.equal(core.pickActiveGoal([{ active: false, text: 'x', scope }], cwd), null);
});

test('buildGoalDirective: 无目标→空;有目标→[SYSTEM:] 含目标文本与清除指引', () => {
  assert.equal(core.buildGoalDirective(null), '');
  assert.equal(core.buildGoalDirective({ text: '' }), '');
  const d = core.buildGoalDirective({ text: '发布 0.1.136' });
  assert.match(d, /^\[SYSTEM:/);
  assert.match(d, /发布 0\.1\.136/);
  assert.match(d, /GoalTool\(action=clear\)/);
  assert.match(d, /\/goal clear/);
});

test('routeGoal: 门控关→空指令(系统提示词字节不变);开+有目标→指令', () => {
  assert.equal(core.routeGoal({ goal: { text: 'g' }, env: { KHY_GOAL: 'off' } }), '');
  assert.equal(core.routeGoal({ goal: null, env: {} }), '');
  assert.match(core.routeGoal({ goal: { text: 'g' }, env: {} }), /\[SYSTEM:/);
});
