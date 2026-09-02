'use strict';

/**
 * doomLoopGuard.test.js — Doom Loop 防护(借鉴 sst/opencode)验收。
 *
 * 覆盖:
 *   1. 1-2 次同 tool+input → continue,不告警
 *   2. 读工具第 5 次同 input → escalate(reason 含"连续 5 次")
 *   3. 写工具第 3 次同 input → escalate
 *   4. 写工具第 5 次同 input → ask_user
 *   5. 不同 input 切换 → 计数立即重置
 *   6. 滑动窗口外的老旧 fingerprint 不影响判定
 *   7. gate KHY_DOOM_LOOP_GUARD=0 关闭
 *   8. fail-soft:坏输入不抛
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const dlg = require('../../src/services/doomLoopGuard');

test('isDoomLoopGuardEnabled 默认开;显式 0/false/off 关', () => {
  assert.equal(dlg.isDoomLoopGuardEnabled({}), true);
  assert.equal(dlg.isDoomLoopGuardEnabled({ KHY_DOOM_LOOP_GUARD: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.equal(dlg.isDoomLoopGuardEnabled({ KHY_DOOM_LOOP_GUARD: v }), false, v);
  }
});

test('读工具:1-2 次同 input → continue', () => {
  const g = dlg.createDoomLoopGuard();
  const r1 = g.assess('read_file', { path: '/a' });
  const r2 = g.assess('read_file', { path: '/a' });
  assert.equal(r1.action, 'continue');
  assert.equal(r2.action, 'continue');
  assert.equal(r1.consecutiveCount, 1);
  assert.equal(r2.consecutiveCount, 2);
});

test('读工具:第 5 次同 input → escalate(默认 read 阈值=5)', () => {
  const g = dlg.createDoomLoopGuard();
  let r;
  for (let i = 0; i < 4; i += 1) {
    r = g.assess('read_file', { path: '/a' });
  }
  // 第 5 次
  r = g.assess('read_file', { path: '/a' });
  assert.equal(r.action, 'escalate');
  assert.equal(r.consecutiveCount, 5);
  assert.match(r.reason, /连续 5 次/);
  assert.match(r.suggest, /最近一次成功返回/);
});

test('写工具:第 3 次同 input → escalate(默认 write 阈值=3)', () => {
  const g = dlg.createDoomLoopGuard();
  g.assess('write_file', { path: '/x', content: 'hi' });
  g.assess('write_file', { path: '/x', content: 'hi' });
  const r = g.assess('write_file', { path: '/x', content: 'hi' });
  assert.equal(r.action, 'escalate');
  assert.equal(r.consecutiveCount, 3);
  assert.match(r.reason, /连续 3 次/);
  assert.match(r.reason, /write_file/);
  assert.match(r.suggest, /基于已有工具结果/);
});

test('写工具:连续 ≥5 次同 input → ask_user', () => {
  const g = dlg.createDoomLoopGuard();
  for (let i = 0; i < 4; i += 1) {
    g.assess('editFile', { path: '/x', oldStr: 'a', newStr: 'b' });
  }
  const r = g.assess('editFile', { path: '/x', oldStr: 'a', newStr: 'b' });
  assert.equal(r.action, 'ask_user');
  assert.equal(r.consecutiveCount, 5);
  // ask_user 文案应显式说明「需人工介入」
  assert.match(r.reason, /人工介入/);
});

test('写工具:连续 4 次同 input → escalate(还没到 ask_user 阈值 5)', () => {
  const g = dlg.createDoomLoopGuard();
  for (let i = 0; i < 3; i += 1) {
    g.assess('write_file', { path: '/y', content: 'q' });
  }
  const r = g.assess('write_file', { path: '/y', content: 'q' });
  assert.equal(r.action, 'escalate');
  assert.equal(r.consecutiveCount, 4);
});

test('不同 input 切换 → 计数立即重置', () => {
  const g = dlg.createDoomLoopGuard();
  g.assess('write_file', { path: '/a', content: 'a' });
  g.assess('write_file', { path: '/a', content: 'a' });
  // 切到不同 content
  const r = g.assess('write_file', { path: '/a', content: 'b' });
  assert.equal(r.action, 'continue');
  assert.equal(r.consecutiveCount, 1);
});

test('不同 tool 切换 → 计数也立即重置(指纹不同)', () => {
  const g = dlg.createDoomLoopGuard();
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  // 切到 grep
  const r = g.assess('grep', { pattern: 'foo' });
  assert.equal(r.action, 'continue');
  assert.equal(r.consecutiveCount, 1);
});

test('滑动窗口:超过 windowSize 的老 fingerprint 不影响当前判定', () => {
  const g = dlg.createDoomLoopGuard({ windowSize: 4 });
  // 早期 4 次同 input(达到窗口上限)
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  g.assess('read_file', { path: '/a' });
  // 不同 input 把前面 4 个挤出去
  g.assess('grep', { pattern: 'x' });
  g.assess('grep', { pattern: 'x' });
  g.assess('grep', { pattern: 'x' });
  g.assess('grep', { pattern: 'x' });
  // 现在的 read_file 是窗口里第 1 次,应该 continue
  const r = g.assess('read_file', { path: '/a' });
  assert.equal(r.action, 'continue');
  assert.equal(r.consecutiveCount, 1);
});

test('env 覆盖:KHY_DOOM_LOOP_THRESHOLD_WRITE=5 + KHY_DOOM_LOOP_ASK_USER_AFTER=7', () => {
  // 提高 escalate 阈值到 5,ask_user 阈值到 7,则第 5 次仍是 escalate,而不是 ask_user
  const g = dlg.createDoomLoopGuard({
    env: { KHY_DOOM_LOOP_THRESHOLD_WRITE: '5', KHY_DOOM_LOOP_ASK_USER_AFTER: '7' },
  });
  for (let i = 0; i < 4; i += 1) {
    g.assess('write_file', { path: '/z', content: 'q' });
  }
  const r = g.assess('write_file', { path: '/z', content: 'q' });
  // 阈值 5,第 5 次才 escalate(没到 ask_user 阈值 7)
  assert.equal(r.action, 'escalate');
  assert.equal(r.consecutiveCount, 5);
});

test('env 覆盖:KHY_DOOM_LOOP_ASK_USER_AFTER=2 + THRESHOLD_WRITE=2', () => {
  // 两个阈值都是 2:第 2 次同时触发 escalate 与 ask_user,ask_user 优先(更强约束)
  const g = dlg.createDoomLoopGuard({
    env: { KHY_DOOM_LOOP_ASK_USER_AFTER: '2', KHY_DOOM_LOOP_THRESHOLD_WRITE: '2' },
  });
  g.assess('write_file', { path: '/w', content: 'q' });
  const r = g.assess('write_file', { path: '/w', content: 'q' });
  assert.equal(r.action, 'ask_user');
  assert.equal(r.consecutiveCount, 2);
});

test('fail-soft:坏 params(循环引用)不抛', () => {
  const g = dlg.createDoomLoopGuard();
  const a = {};
  a.self = a; // 循环引用
  let r;
  try {
    r = g.assess('read_file', a);
  } catch (e) {
    assert.fail(`should not throw: ${e.message}`);
  }
  assert.equal(r.action, 'continue');
});

test('fail-soft:坏 tool 名(非字符串)不抛', () => {
  const g = dlg.createDoomLoopGuard();
  let r;
  try {
    r = g.assess(null, { x: 1 });
  } catch (e) {
    assert.fail(`should not throw: ${e.message}`);
  }
  assert.equal(r.action, 'continue');
});

test('reset() 清空窗口', () => {
  const g = dlg.createDoomLoopGuard();
  for (let i = 0; i < 3; i += 1) {
    g.assess('write_file', { path: '/r', content: 'q' });
  }
  g.reset();
  const r = g.assess('write_file', { path: '/r', content: 'q' });
  assert.equal(r.action, 'continue');
  assert.equal(r.consecutiveCount, 1);
});

test('snapshot() 返回窗口与配置', () => {
  const g = dlg.createDoomLoopGuard();
  g.assess('read_file', { path: '/a' });
  g.assess('grep', { p: 'x' });
  const s = g.snapshot();
  assert.equal(s.windowSize, 8);
  assert.equal(s.readThreshold, 5);
  assert.equal(s.writeThreshold, 3);
  assert.equal(s.askUserAfter, 5);
  assert.equal(s.recent.length, 2);
});

test('大小写不敏感:Read_File 与 read_file 算同工具', () => {
  const g = dlg.createDoomLoopGuard();
  g.assess('Read_File', { path: '/c' });
  g.assess('read_file', { path: '/c' });
  g.assess('READ_FILE', { path: '/c' });
  g.assess('read_file', { path: '/c' });
  g.assess('read_file', { path: '/c' });
  const r = g.assess('read_file', { path: '/c' });
  assert.equal(r.action, 'escalate');
  assert.equal(r.consecutiveCount, 6);
});

test('不同 call 的 same tool 串:write_file 5 次内容不同 → 始终 continue', () => {
  const g = dlg.createDoomLoopGuard();
  for (let i = 0; i < 10; i += 1) {
    const r = g.assess('write_file', { path: '/x', content: `step${i}` });
    assert.equal(r.action, 'continue');
  }
});

test('params 字段顺序不影响 fingerprint', () => {
  // 两次同样的 params,键顺序不同,fingerprint 必须相同
  const a = dlg._callFingerprint('read_file', { path: '/a', line: 1 });
  const b = dlg._callFingerprint('read_file', { line: 1, path: '/a' });
  assert.equal(a, b);
});
