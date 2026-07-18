'use strict';

// goalHandler.test.js — `khy goal …` handler 分派回归(node:test)。
//
// 核心修复(goal 2026-07-03「/goal 对齐 CC」):`/goal <freeform 文本>` 直接设定并返回
// { code, aiForward }(设定即开跑);`/goal`(无参)→ 只读状态;白名单动词(show/clear/list/…)
// 行为不变。门控 KHY_GOAL_AUTODRIVE 关 → 设定但只返回 0(不 aiForward)。
//
// 必须在 require 任何模块前把 KHYOS_HOME 指向临时目录(dataHome 缓存 base home)。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goalh-'));
process.env.KHYOS_HOME = TMP;

const { handleGoal } = require('../../../src/cli/handlers/goal');
const store = require('../../../src/services/goalStore');

// handler 直接 print 到 stdout;测试只关心返回值与副作用(store 落盘),不断言输出文本。
const CWD = process.cwd();

beforeEach(() => {
  store.clearGoal({ all: true });
  delete process.env.KHY_GOAL_AUTODRIVE;
  delete process.env.KHY_GOAL;
});

test('/goal <freeform>(subCommand=null + args 非空)→ 设定 + 返回 { aiForward }', () => {
  const res = handleGoal(null, ['把技巧', '制作完', '确保可用'], {});
  assert.equal(typeof res, 'object');
  assert.equal(res.code, 0);
  assert.equal(typeof res.aiForward, 'string');
  assert.match(res.aiForward, /把技巧 制作完 确保可用/);
  // 真落盘了活动目标
  const g = store.getActiveGoal(CWD);
  assert.ok(g, '应已设定活动目标');
  assert.equal(g.text, '把技巧 制作完 确保可用');
});

test('门控 KHY_GOAL_AUTODRIVE=off → 设定但返回 0(不 aiForward,逐字节回退)', () => {
  process.env.KHY_GOAL_AUTODRIVE = 'off';
  const res = handleGoal(null, ['写个 X 并确保可用'], {});
  assert.equal(res, 0);
  assert.ok(store.getActiveGoal(CWD), '仍应设定活动目标');
  assert.equal(store.getActiveGoal(CWD).text, '写个 X 并确保可用');
});

test('/goal(无参:subCommand=null + args 空)→ 只读状态(不设定,返回 0)', () => {
  const res = handleGoal(null, [], {});
  assert.equal(res, 0);
  assert.equal(store.getActiveGoal(CWD), null, '无参不应设定任何目标');
});

test('显式 show/status(有尾参也只读,不误设)', () => {
  assert.equal(handleGoal('show', ['忽略', '的', '尾参'], {}), 0);
  assert.equal(handleGoal('status', [], {}), 0);
  assert.equal(store.getActiveGoal(CWD), null);
});

test('白名单动词 set/clear/list 回归不变', () => {
  // set → 也走设定即开跑(门控默认开)返回 { aiForward }
  const setRes = handleGoal('set', ['目标一'], {});
  assert.equal(typeof setRes, 'object');
  assert.match(setRes.aiForward, /目标一/);
  assert.equal(store.getActiveGoal(CWD).text, '目标一');
  // list → 返回 0
  assert.equal(handleGoal('list', [], {}), 0);
  // clear → 返回 0 且清除
  assert.equal(handleGoal('clear', [], {}), 0);
  assert.equal(store.getActiveGoal(CWD), null);
});

test('未知非空子命令(如整串目标)→ 当作 set <整串>', () => {
  const res = handleGoal('把今天发布完', [], {});
  assert.equal(typeof res, 'object');
  assert.match(res.aiForward, /把今天发布完/);
  assert.equal(store.getActiveGoal(CWD).text, '把今天发布完');
});
