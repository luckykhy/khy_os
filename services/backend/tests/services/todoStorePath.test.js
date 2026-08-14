'use strict';

/**
 * todoStorePath.test.js — 纯叶子:V1 TodoWrite 清单的会话作用域路径解析 + 陈旧孤儿判定。
 *
 * 锁定:
 *   ① 门控 todoSessionScopeEnabled 默认开、仅 {0,false,off,no} 关;
 *   ② resolveTodoFilePath:门控开+合法 sessionId → khy-todos-<sid>.json;
 *      门控关 / 无 sessionId / 坏输入 → 历史全局 khy-todos.json(字节回退);
 *   ③ _sanitizeSessionId:白名单 [A-Za-z0-9._-]、其余折 '_'、截断 128、空/非法 → '';
 *   ④ selectStaleTodoFiles:仅门控开清理、按 mtime 年龄、近期文件保留、keepPath 保留、
 *      mtime 缺失保守保留、门控关 / 坏输入 → [];
 *   ⑤ resolveOrphanRetentionDays:默认 7、正整数覆盖、非法回退。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const leaf = require('../../src/services/todoStorePath');

const DAY = 86400000;

// ── ① 门控 ─────────────────────────────────────────────────────────────────
test('todoSessionScopeEnabled: 默认开 + falsy 值关', () => {
  assert.strictEqual(leaf.todoSessionScopeEnabled({}), true);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: '1' }), true);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: 'on' }), true);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: '0' }), false);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: 'false' }), false);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: 'off' }), false);
  assert.strictEqual(leaf.todoSessionScopeEnabled({ KHY_TODO_SESSION_SCOPED: 'no' }), false);
});

// ── ② resolveTodoFilePath ────────────────────────────────────────────────────
test('resolveTodoFilePath: 门控开 + 合法 sessionId → 会话分文件', () => {
  const p = leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: 'abc-123', env: {} });
  assert.strictEqual(p, path.join('/tmp', 'khy-todos-abc-123.json'));
});

test('resolveTodoFilePath: 门控关 → 历史全局路径(字节回退)', () => {
  const p = leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: 'abc-123', env: { KHY_TODO_SESSION_SCOPED: '0' } });
  assert.strictEqual(p, path.join('/tmp', 'khy-todos.json'));
});

test('resolveTodoFilePath: 无 sessionId / 空 → 历史全局路径', () => {
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: '/tmp', env: {} }), path.join('/tmp', 'khy-todos.json'));
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: '', env: {} }), path.join('/tmp', 'khy-todos.json'));
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: '   ', env: {} }), path.join('/tmp', 'khy-todos.json'));
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: null, env: {} }), path.join('/tmp', 'khy-todos.json'));
});

test('resolveTodoFilePath: 全局回退目标 == 历史写死路径(逐字节不变)', () => {
  // 历史:path.join(os.tmpdir(), 'khy-todos.json')。门控关 / 无 session 必须回到它。
  const os = require('os');
  const legacy = path.join(os.tmpdir(), 'khy-todos.json');
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: os.tmpdir(), env: { KHY_TODO_SESSION_SCOPED: '0' } }), legacy);
  assert.strictEqual(leaf.resolveTodoFilePath({ tmpdir: os.tmpdir(), sessionId: null, env: {} }), legacy);
});

// ── ③ _sanitizeSessionId ─────────────────────────────────────────────────────
test('_sanitizeSessionId: 白名单保留、非法折 _、防路径穿越', () => {
  assert.strictEqual(leaf._sanitizeSessionId('abc-123_x.y'), 'abc-123_x.y');
  assert.strictEqual(leaf._sanitizeSessionId('a/b\\c'), 'a_b_c');
  assert.strictEqual(leaf._sanitizeSessionId('../../etc/passwd'), '.._.._etc_passwd');
  assert.strictEqual(leaf._sanitizeSessionId('  '), '');
  assert.strictEqual(leaf._sanitizeSessionId(null), '');
  assert.strictEqual(leaf._sanitizeSessionId(undefined), '');
});

test('_sanitizeSessionId: 截断 128 防超长文件名', () => {
  const long = 'x'.repeat(300);
  assert.strictEqual(leaf._sanitizeSessionId(long).length, 128);
});

test('resolveTodoFilePath: 非法 sessionId 被 sanitize 后仍分文件(不穿越)', () => {
  const p = leaf.resolveTodoFilePath({ tmpdir: '/tmp', sessionId: 'a/b', env: {} });
  assert.strictEqual(p, path.join('/tmp', 'khy-todos-a_b.json'));
  // 断言:结果目录仍是 /tmp(路径穿越被防住)。
  assert.strictEqual(path.dirname(p), '/tmp');
});

// ── ④ selectStaleTodoFiles ───────────────────────────────────────────────────
test('selectStaleTodoFiles: 陈旧(mtime 早于保留期)入选、近期保留', () => {
  const now = 1000 * DAY;
  const entries = [
    { path: '/tmp/khy-todos-old.json', mtimeMs: now - 8 * DAY },   // 8 天前 → 陈旧
    { path: '/tmp/khy-todos-new.json', mtimeMs: now - 1 * DAY },   // 1 天前 → 保留(可能活会话)
    { path: '/tmp/khy-todos-edge.json', mtimeMs: now - 7 * DAY },  // 恰 7 天 → 入选(>=)
  ];
  const stale = leaf.selectStaleTodoFiles({ entries, now, env: {} });
  assert.deepStrictEqual(stale.sort(), ['/tmp/khy-todos-edge.json', '/tmp/khy-todos-old.json']);
});

test('selectStaleTodoFiles: keepPath(当前会话文件)始终保留', () => {
  const now = 1000 * DAY;
  const keep = '/tmp/khy-todos-current.json';
  const entries = [
    { path: keep, mtimeMs: now - 30 * DAY },                       // 很旧但当前会话 → 保留
    { path: '/tmp/khy-todos-dead.json', mtimeMs: now - 30 * DAY }, // 陈旧 → 清
  ];
  const stale = leaf.selectStaleTodoFiles({ entries, now, keepPath: keep, env: {} });
  assert.deepStrictEqual(stale, ['/tmp/khy-todos-dead.json']);
});

test('selectStaleTodoFiles: mtime 缺失 / 非有限 → 保守保留', () => {
  const now = 1000 * DAY;
  const entries = [
    { path: '/tmp/a.json' },                                  // 无 mtime
    { path: '/tmp/b.json', mtimeMs: NaN },
    { path: '/tmp/c.json', mtimeMs: now - 100 * DAY },        // 真陈旧
  ];
  const stale = leaf.selectStaleTodoFiles({ entries, now, env: {} });
  assert.deepStrictEqual(stale, ['/tmp/c.json']);
});

test('selectStaleTodoFiles: 门控关 → []（不清理）', () => {
  const now = 1000 * DAY;
  const entries = [{ path: '/tmp/old.json', mtimeMs: now - 999 * DAY }];
  assert.deepStrictEqual(leaf.selectStaleTodoFiles({ entries, now, env: { KHY_TODO_SESSION_SCOPED: '0' } }), []);
});

test('selectStaleTodoFiles: 坏输入 → []', () => {
  assert.deepStrictEqual(leaf.selectStaleTodoFiles({ entries: null, now: 1, env: {} }), []);
  assert.deepStrictEqual(leaf.selectStaleTodoFiles({ entries: [{ path: '/x', mtimeMs: 0 }], now: NaN, env: {} }), []);
  assert.deepStrictEqual(leaf.selectStaleTodoFiles({}), []);
});

test('selectStaleTodoFiles: 自定义保留期 KHY_TODO_ORPHAN_DAYS', () => {
  const now = 1000 * DAY;
  const entries = [
    { path: '/tmp/a.json', mtimeMs: now - 2 * DAY },  // 2 天
    { path: '/tmp/b.json', mtimeMs: now - 4 * DAY },  // 4 天
  ];
  // 保留期设 3 天 → 4 天的入选、2 天的保留。
  const stale = leaf.selectStaleTodoFiles({ entries, now, env: { KHY_TODO_ORPHAN_DAYS: '3' } });
  assert.deepStrictEqual(stale, ['/tmp/b.json']);
});

// ── ⑤ resolveOrphanRetentionDays ─────────────────────────────────────────────
test('resolveOrphanRetentionDays: 默认 7 + 正整数覆盖 + 非法回退', () => {
  assert.strictEqual(leaf.resolveOrphanRetentionDays({}), 7);
  assert.strictEqual(leaf.resolveOrphanRetentionDays({ KHY_TODO_ORPHAN_DAYS: '14' }), 14);
  assert.strictEqual(leaf.resolveOrphanRetentionDays({ KHY_TODO_ORPHAN_DAYS: '0' }), 7);   // 非正 → 默认
  assert.strictEqual(leaf.resolveOrphanRetentionDays({ KHY_TODO_ORPHAN_DAYS: '-3' }), 7);
  assert.strictEqual(leaf.resolveOrphanRetentionDays({ KHY_TODO_ORPHAN_DAYS: 'abc' }), 7);
  assert.strictEqual(leaf.resolveOrphanRetentionDays({ KHY_TODO_ORPHAN_DAYS: '2.5' }), 7); // 非整数 → 默认
});

// ── SCOPED_FILE_RE:识别会话分文件、不误伤 legacy ──────────────────────────────
test('SCOPED_FILE_RE: 匹配 khy-todos-<sid>.json,不匹配 legacy khy-todos.json', () => {
  assert.ok(leaf.SCOPED_FILE_RE.test('khy-todos-abc.json'));
  assert.ok(leaf.SCOPED_FILE_RE.test('khy-todos-2026-07-02T00-00.json'));
  assert.ok(!leaf.SCOPED_FILE_RE.test('khy-todos.json'));       // legacy 全局:无 '-' 不误删
  assert.ok(!leaf.SCOPED_FILE_RE.test('other.json'));
  assert.ok(!leaf.SCOPED_FILE_RE.test('khy-todos-abc.txt'));
});
