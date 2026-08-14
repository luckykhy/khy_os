'use strict';

/**
 * sourceHealPolicy.test.js — 纯叶子:源码自愈决策大脑。
 *
 * 锁定:
 *   ① 门控 isEnabled 默认开、仅 {0,false,off,no} 关;
 *   ② resolveMaxHeal 默认 200 + KHY_SOURCE_HEAL_MAX 覆盖 + 坏值回落;
 *   ③ planSourceHeal 分类:missing / corrupt / ok / extra;
 *   ④ 路径安全:绝对路径 / 盘符 / `..` 逃逸 → skippedUnsafe(绝不进 plan);
 *   ⑤ 封顶:超过 limit → plan 截断 + capped.dropped;
 *   ⑥ 门控关 → enabled:false 全空计划(字节回退「不自愈」);
 *   ⑦ 多余文件只报告不删;⑧ 坏输入 fail-soft;⑨ 确定性排序。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/services/sourceHealPolicy');

// ── ① 门控 ─────────────────────────────────────────────────────────────────
test('isEnabled: 默认开 + falsy 值关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: '1' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: 'on' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: 'YES' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: '0' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: 'false' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: 'off' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: 'no' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_SOURCE_HEAL: ' OFF ' }), false);
});

// ── ② 上限解析 ───────────────────────────────────────────────────────────────
test('resolveMaxHeal: 默认 200 + 覆盖 + 坏值回落默认', () => {
  assert.strictEqual(leaf.resolveMaxHeal({}), 200);
  assert.strictEqual(leaf.DEFAULT_MAX_HEAL, 200);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '5' }), 5);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '1000' }), 1000);
  // 坏值 → 默认
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '0' }), 200);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '-3' }), 200);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '1.5' }), 200);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: 'abc' }), 200);
  assert.strictEqual(leaf.resolveMaxHeal({ KHY_SOURCE_HEAL_MAX: '' }), 200);
});

// ── ③ 分类:missing / corrupt / ok ────────────────────────────────────────────
test('planSourceHeal: 缺失=补齐 / 哈希不符=修正 / 一致=ok', () => {
  const expected = { 'a.js': 'h1', 'b.js': 'h2', 'c.js': 'h3' };
  const actual = { 'a.js': 'h1', 'b.js': 'DIFFERENT', /* c.js missing */ };
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(r.ok, ['a.js']);
  assert.deepStrictEqual(r.corrupt, ['b.js']);
  assert.deepStrictEqual(r.missing, ['c.js']);
  // plan:先缺失后损坏
  assert.deepStrictEqual(r.plan, [
    { relPath: 'c.js', reason: 'missing' },
    { relPath: 'b.js', reason: 'corrupt' },
  ]);
  assert.strictEqual(r.summary.toHeal, 2);
  assert.strictEqual(r.summary.ok, 1);
});

test('planSourceHeal: 函数名少打一个字母(内容变→哈希变)归为 corrupt', () => {
  // 用户点名场景:源码里函数名 typo → 文件内容变 → sha256 变 → corrupt → 从纯净参照覆盖。
  const expected = { 'services/foo.js': 'sha-of-correct' };
  const actual = { 'services/foo.js': 'sha-of-typo' };
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.deepStrictEqual(r.corrupt, ['services/foo.js']);
  assert.deepStrictEqual(r.plan, [{ relPath: 'services/foo.js', reason: 'corrupt' }]);
});

test('planSourceHeal: 空/缺失哈希(null/undefined/空串)一律视为缺失', () => {
  const expected = { 'a.js': 'h1', 'b.js': 'h2', 'c.js': 'h3' };
  const actual = { 'a.js': null, 'b.js': undefined, 'c.js': '' };
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.deepStrictEqual(r.missing, ['a.js', 'b.js', 'c.js']);
  assert.strictEqual(r.corrupt.length, 0);
});

test('planSourceHeal: 参照哈希缺失但磁盘有内容 → 保守视为需修(corrupt)', () => {
  const expected = { 'a.js': '' }; // 参照哈希异常缺失
  const actual = { 'a.js': 'something' };
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.deepStrictEqual(r.corrupt, ['a.js']);
});

// ── ④ 路径安全 ───────────────────────────────────────────────────────────────
test('_isSafeRelPath: 拒绝绝对路径 / 盘符 / .. 逃逸,接受正常相对路径', () => {
  assert.strictEqual(leaf._isSafeRelPath('services/backend/src/a.js'), true);
  assert.strictEqual(leaf._isSafeRelPath('a.js'), true);
  assert.strictEqual(leaf._isSafeRelPath('/etc/passwd'), false);
  assert.strictEqual(leaf._isSafeRelPath('C:\\Windows\\x'), false);
  assert.strictEqual(leaf._isSafeRelPath('C:/Windows/x'), false);
  assert.strictEqual(leaf._isSafeRelPath('../escape.js'), false);
  assert.strictEqual(leaf._isSafeRelPath('a/../../b.js'), false);
  assert.strictEqual(leaf._isSafeRelPath('..'), false);
  assert.strictEqual(leaf._isSafeRelPath(''), false);
  assert.strictEqual(leaf._isSafeRelPath('   '), false);
  assert.strictEqual(leaf._isSafeRelPath(null), false);
  assert.strictEqual(leaf._isSafeRelPath(42), false);
});

test('planSourceHeal: 不安全路径进 skippedUnsafe,绝不进 plan', () => {
  const expected = {
    'ok.js': 'h1',
    '../evil.js': 'h2',
    '/abs/evil.js': 'h3',
    'C:\\evil.js': 'h4',
  };
  const actual = {}; // 全缺失
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.deepStrictEqual(r.missing, ['ok.js']);
  assert.deepStrictEqual(r.skippedUnsafe, ['../evil.js', '/abs/evil.js', 'C:\\evil.js'].sort());
  assert.deepStrictEqual(r.plan, [{ relPath: 'ok.js', reason: 'missing' }]);
});

// ── ⑤ 封顶 ───────────────────────────────────────────────────────────────────
test('planSourceHeal: 超过 limit → plan 截断 + capped.dropped', () => {
  const expected = {};
  for (let i = 0; i < 10; i++) expected[`f${i}.js`] = `h${i}`;
  const actual = {}; // 全缺失
  const r = leaf.planSourceHeal(expected, actual, { env: { KHY_SOURCE_HEAL_MAX: '3' } });
  assert.strictEqual(r.plan.length, 3);
  assert.strictEqual(r.capped.applied, true);
  assert.strictEqual(r.capped.dropped, 7);
  assert.strictEqual(r.capped.limit, 3);
  // summary.toHeal 反映全部需修(未被封顶掩盖)
  assert.strictEqual(r.summary.toHeal, 10);
});

test('planSourceHeal: 未超顶 → capped.applied=false', () => {
  const expected = { 'a.js': 'h1', 'b.js': 'h2' };
  const actual = {};
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.strictEqual(r.capped.applied, false);
  assert.strictEqual(r.capped.dropped, 0);
  assert.strictEqual(r.capped.limit, 200);
});

// ── ⑥ 门控关 → 全空(字节回退) ───────────────────────────────────────────────
test('planSourceHeal: 门控关 → enabled:false 全空计划(不自愈)', () => {
  const expected = { 'a.js': 'h1', 'b.js': 'h2' };
  const actual = { 'a.js': 'DIFF' }; // 有损坏 + 缺失
  const r = leaf.planSourceHeal(expected, actual, { env: { KHY_SOURCE_HEAL: 'off' } });
  assert.strictEqual(r.enabled, false);
  assert.deepStrictEqual(r.plan, []);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.corrupt, []);
  assert.deepStrictEqual(r.ok, []);
  assert.strictEqual(r.summary.toHeal, 0);
});

// ── ⑦ 多余文件只报告不删 ──────────────────────────────────────────────────────
test('planSourceHeal: 磁盘多余文件 → extra(只报告,不进 plan)', () => {
  const expected = { 'a.js': 'h1' };
  const actual = { 'a.js': 'h1', 'user_plugin.js': 'hx', 'notes.md': 'hy' };
  const r = leaf.planSourceHeal(expected, actual, { env: {} });
  assert.deepStrictEqual(r.ok, ['a.js']);
  assert.deepStrictEqual(r.extra, ['notes.md', 'user_plugin.js']);
  assert.deepStrictEqual(r.plan, []); // 绝不删除多余文件
  assert.strictEqual(r.summary.extra, 2);
});

// ── ⑧ 坏输入 fail-soft ────────────────────────────────────────────────────────
test('planSourceHeal: 坏输入(null/非对象)→ 安全空计划,绝不抛', () => {
  for (const bad of [null, undefined, 42, 'str', []]) {
    const r = leaf.planSourceHeal(bad, bad, { env: {} });
    assert.strictEqual(r.enabled, true);
    assert.deepStrictEqual(r.plan, []);
    assert.strictEqual(r.summary.expected, Array.isArray(bad) ? 0 : 0);
  }
});

test('planSourceHeal: expected 空 → 无事可做', () => {
  const r = leaf.planSourceHeal({}, { 'x.js': 'h' }, { env: {} });
  assert.deepStrictEqual(r.plan, []);
  assert.deepStrictEqual(r.extra, ['x.js']);
});

// ── ⑨ 确定性排序 ─────────────────────────────────────────────────────────────
test('planSourceHeal: 输出稳定排序(与输入顺序无关)', () => {
  const e1 = { 'z.js': 'h', 'a.js': 'h', 'm.js': 'h' };
  const e2 = { 'a.js': 'h', 'm.js': 'h', 'z.js': 'h' };
  const r1 = leaf.planSourceHeal(e1, {}, { env: {} });
  const r2 = leaf.planSourceHeal(e2, {}, { env: {} });
  assert.deepStrictEqual(r1.missing, ['a.js', 'm.js', 'z.js']);
  assert.deepStrictEqual(r1.plan, r2.plan);
});
