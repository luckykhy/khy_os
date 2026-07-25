'use strict';

/**
 * gitignoreReviewStore.test.js — .gitignore 写入「待审核队列」的确定性测试。
 *
 * 锁定:① enqueue → list → approve(真写 .gitignore 且移除 pending)→ discard 全链;
 * ② 非法 pattern 拒绝入队;③ 去重(同一组 pattern 已 pending → skip);④ 门控关 enqueue no-op;
 * ⑤ IO fail-soft(坏 id / 空输入不抛)。
 *
 * 隔离:临时 data home(队列落 pending.json)+ 临时 cwd(approve 写 .gitignore 落 cwd)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gi-review-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_GITIGNORE_REVIEW = 'true';
process.env.KHY_GITIGNORE_ADVISOR = 'true';

const dataHome = require('../../src/utils/dataHome');
dataHome._resetStorageCaches();

const store = require('../../src/services/gitignoreReviewStore');

const origCwd = process.cwd();
const workCwd = path.join(TMP, 'work');
fs.mkdirSync(workCwd, { recursive: true });

test.before(() => { process.chdir(workCwd); });
test.after(() => {
  process.chdir(origCwd);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function fresh() { store.clear(); }

test('enqueue → list:候选进队列', () => {
  fresh();
  const r = store.enqueue({ patterns: ['secret.env', 'big.bin'], reason: 'precommit', source: 'auto' });
  assert.strictEqual(r.success, true, r.error || '');
  assert.ok(r.id);
  const list = store.list();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].patterns, ['secret.env', 'big.bin']);
  assert.strictEqual(store.count(), 1);
});

test('去重:同一组 pattern 已 pending → skip', () => {
  fresh();
  store.enqueue({ patterns: ['a', 'b'] });
  const r2 = store.enqueue({ patterns: ['b', 'a'] }); // 顺序无关
  assert.strictEqual(r2.success, true);
  assert.strictEqual(r2.skipped, true);
  assert.strictEqual(store.list().length, 1);
});

test('approve:真写 .gitignore 且从 pending 移除', () => {
  fresh();
  const r = store.enqueue({ patterns: ['secret.env'], reason: 'precommit' });
  const ap = store.approve(r.id, { cwd: workCwd });
  assert.strictEqual(ap.success, true, ap.error || '');
  assert.ok(ap.file && ap.file.endsWith('.gitignore'), `应写 .gitignore,实际 ${ap.file}`);
  const content = fs.readFileSync(ap.file, 'utf-8');
  assert.ok(content.includes('secret.env'));
  assert.strictEqual(store.list().length, 0); // pending 已移除
});

test('discard:丢弃不写文件', () => {
  fresh();
  const r = store.enqueue({ patterns: ['x.log'] });
  const d = store.discard(r.id);
  assert.strictEqual(d.success, true);
  assert.strictEqual(store.list().length, 0);
});

test('非法 pattern 拒绝入队', () => {
  fresh();
  assert.strictEqual(store.enqueue({ patterns: ['/'] }).success, false);
  assert.strictEqual(store.enqueue({ patterns: ['a\nb'] }).success, false);
  assert.strictEqual(store.enqueue({ patterns: [] }).success, false);
  assert.strictEqual(store.list().length, 0);
});

test('门控关 → enqueue no-op(disabled)', () => {
  fresh();
  const saved = process.env.KHY_GITIGNORE_REVIEW;
  process.env.KHY_GITIGNORE_REVIEW = 'off';
  try {
    const r = store.enqueue({ patterns: ['y.tmp'] });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /disabled/);
  } finally {
    process.env.KHY_GITIGNORE_REVIEW = saved;
  }
});

test('fail-soft:坏 id / 空输入绝不抛', () => {
  fresh();
  assert.strictEqual(store.approve('').success, false);
  assert.strictEqual(store.approve('nonexistent').success, false);
  assert.strictEqual(store.discard('nope').success, false);
  assert.strictEqual(store.enqueue({}).success, false);
});
