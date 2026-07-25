'use strict';

// goalStore.test.js — 持久目标薄 IO 层往返测试(node:test)。
// 必须在 require 任何模块前把 KHYOS_HOME 指向临时目录(dataHome 会缓存 base home)。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goal-'));
process.env.KHYOS_HOME = TMP;

const { test } = require('node:test');
const assert = require('node:assert');

const store = require('../../src/services/goalStore');

const CWD_A = '/tmp/projA';
const CWD_B = '/tmp/projB';

test('空存档:无活动目标、空指令', () => {
  assert.equal(store.getActiveGoal(CWD_A), null);
  assert.equal(store.getActiveGoalDirective({ cwd: CWD_A }), '');
});

test('setGoal + getActiveGoal:项目作用域往返,落盘 ~/.khyos/goals/goals.json', () => {
  const r = store.setGoal('发布 0.1.136', { cwd: CWD_A });
  assert.equal(r.ok, true);
  const g = store.getActiveGoal(CWD_A);
  assert.equal(g.text, '发布 0.1.136');
  // 落盘核实
  const file = path.join(TMP, 'goals', 'goals.json');
  assert.ok(fs.existsSync(file));
  const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(Array.isArray(disk.goals) && disk.goals.length >= 1);
});

test('作用域隔离:另一项目看不到 A 的目标', () => {
  assert.equal(store.getActiveGoal(CWD_B), null);
});

test('setGoal 覆盖:同项目再设,旧目标退役、新目标活动', () => {
  store.setGoal('第二个目标', { cwd: CWD_A });
  assert.equal(store.getActiveGoal(CWD_A).text, '第二个目标');
  const active = store.listGoals().filter((x) => x.active && x.cwd === '/tmp/projA');
  assert.equal(active.length, 1); // 同项目只剩一个活动
});

test('getActiveGoalDirective:有目标→[SYSTEM:];门控关→空', () => {
  assert.match(store.getActiveGoalDirective({ cwd: CWD_A }), /\[SYSTEM:/);
  assert.equal(store.getActiveGoalDirective({ cwd: CWD_A, env: { KHY_GOAL: 'off' } }), '');
});

test('clearGoal:清当前项目活动目标', () => {
  const r = store.clearGoal({ cwd: CWD_A });
  assert.equal(r.ok, true);
  assert.ok(r.cleared >= 1);
  assert.equal(store.getActiveGoal(CWD_A), null);
});

test('global 目标:无项目目标时作为回退', () => {
  store.setGoal('全局目标', { global: true });
  // CWD_B 没有项目目标 → 回退到全局
  assert.equal(store.getActiveGoal(CWD_B).text, '全局目标');
  store.clearGoal({ all: true });
  assert.equal(store.getActiveGoal(CWD_B), null);
});

test('损坏 JSON:fail-soft 视为空存档,不抛', () => {
  const file = path.join(TMP, 'goals', 'goals.json');
  fs.writeFileSync(file, '{ not valid json', 'utf-8');
  assert.doesNotThrow(() => store.listGoals());
  assert.equal(store.getActiveGoal(CWD_A), null);
});
