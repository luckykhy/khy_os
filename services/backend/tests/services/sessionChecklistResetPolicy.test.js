'use strict';

/**
 * sessionChecklistResetPolicy.test.js — 纯叶子:新会话该清空哪些 legacy 会话清单文件。
 *
 * 锁定 selectResetPaths / isEnabled:
 *   ① 全量注入 dirs → 返回 V1 + 三处兼容 todo_state.json 路径(去重);
 *   ② resume 会话 → [];
 *   ③ 门控关(0/false/off/no) → [];默认 / 未知值 → 开;
 *   ④ 坏输入(缺 paths / paths 非对象 / 非字符串字段) → 保守不抛、按可用字段返回;
 *   ⑤ 路径集镜像写入侧(tmpdir/khy-todos.json、homedir/.khyquant/todo_state.json、
 *      cwd/.khyquant/todo_state.json、compatTmpdir/khyquant/todo_state.json);
 *   ⑥ dedup:tmpdir===compatTmpdir 时不产生重复项。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const policy = require('../../src/services/sessionChecklistResetPolicy');

const PATHS = {
  tmpdir: '/tmp',
  compatTmpdir: '/var/tmp',
  homedir: '/home/u',
  cwd: '/work/proj',
};

test('全量 dirs → V1 + 三处兼容路径(镜像写入/读取侧)', () => {
  const out = policy.selectResetPaths({ resumed: false, paths: PATHS, env: {} });
  assert.ok(out.includes(path.join('/tmp', 'khy-todos.json')), 'V1 tmp todo');
  assert.ok(out.includes(path.join('/home/u', '.khyquant', 'todo_state.json')), 'home 兼容');
  assert.ok(out.includes(path.join('/work/proj', '.khyquant', 'todo_state.json')), 'cwd 兼容');
  assert.ok(out.includes(path.join('/var/tmp', 'khyquant', 'todo_state.json')), 'compatTmp 兼容');
  assert.ok(out.includes(path.join('/tmp', 'khyquant', 'todo_state.json')), 'tmp 读侧兼容');
  // 全部去重、非空。
  assert.strictEqual(out.length, new Set(out).size, '无重复');
  assert.ok(out.every((p) => typeof p === 'string' && p.length > 0));
});

test('resume 会话 → [](豁免,承接上一会话清单)', () => {
  assert.deepStrictEqual(policy.selectResetPaths({ resumed: true, paths: PATHS, env: {} }), []);
});

test('门控关(off/0/false/no) → []', () => {
  for (const v of ['off', '0', 'false', 'no', 'OFF', 'False']) {
    assert.deepStrictEqual(
      policy.selectResetPaths({ resumed: false, paths: PATHS, env: { KHY_SESSION_TODO_RESET: v } }),
      [],
      `KHY_SESSION_TODO_RESET=${v} 应关`,
    );
  }
});

test('门控默认开 / 未知值开', () => {
  assert.strictEqual(policy.isEnabled({}), true, '未设 → 开');
  assert.strictEqual(policy.isEnabled({ KHY_SESSION_TODO_RESET: 'on' }), true);
  assert.strictEqual(policy.isEnabled({ KHY_SESSION_TODO_RESET: '1' }), true);
  assert.strictEqual(policy.isEnabled({ KHY_SESSION_TODO_RESET: 'off' }), false);
});

test('dedup:tmpdir === compatTmpdir 不产生重复项', () => {
  const p = { tmpdir: '/tmp', compatTmpdir: '/tmp', homedir: '/home/u', cwd: '/work' };
  const out = policy.selectResetPaths({ resumed: false, paths: p, env: {} });
  assert.strictEqual(out.length, new Set(out).size, '无重复');
  // /tmp/khyquant/todo_state.json 只出现一次(compatTmpdir 与 tmpdir 读侧折叠)。
  const tmpCompat = out.filter((x) => x === path.join('/tmp', 'khyquant', 'todo_state.json'));
  assert.strictEqual(tmpCompat.length, 1);
});

test('compatTmpdir 缺省 → 回退 tmpdir', () => {
  const p = { tmpdir: '/tmp', homedir: '/home/u', cwd: '/work' }; // 无 compatTmpdir
  const out = policy.selectResetPaths({ resumed: false, paths: p, env: {} });
  assert.ok(out.includes(path.join('/tmp', 'khyquant', 'todo_state.json')), '回退用 tmpdir');
});

test('坏输入不抛:缺 paths / paths 非对象 / 缺字段', () => {
  assert.deepStrictEqual(policy.selectResetPaths({ resumed: false, env: {} }), []); // 无 paths → 全空字段 → []
  assert.deepStrictEqual(policy.selectResetPaths({ resumed: false, paths: null, env: {} }), []);
  // 仅 homedir 字符串,其余非字符串 → 只返回 home 兼容项。
  const out = policy.selectResetPaths({ resumed: false, paths: { homedir: '/h', tmpdir: 42, cwd: null }, env: {} });
  assert.deepStrictEqual(out, [path.join('/h', '.khyquant', 'todo_state.json')]);
});

test('完全空参 → []', () => {
  assert.deepStrictEqual(policy.selectResetPaths(), []);
  assert.deepStrictEqual(policy.selectResetPaths({}), []);
});
