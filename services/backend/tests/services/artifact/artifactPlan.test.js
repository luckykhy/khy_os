'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/artifact/artifactPlan');

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
});
test('isEnabled: 关值', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_ARTIFACT_TOOL: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值开', () => {
  assert.strictEqual(leaf.isEnabled({ KHY_ARTIFACT_TOOL: 'on' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_ARTIFACT_TOOL: 'true' }), true);
});

// ── validateInput ────────────────────────────────────────────────────────
test('validateInput: 默认 action=create', () => {
  const v = leaf.validateInput({ content: 'x' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.action, 'create');
});
test('validateInput: create 需非空 content', () => {
  assert.strictEqual(leaf.validateInput({ action: 'create' }).ok, false);
  assert.strictEqual(leaf.validateInput({ action: 'create', content: '' }).ok, false);
});
test('validateInput: read 需 name', () => {
  assert.strictEqual(leaf.validateInput({ action: 'read' }).ok, false);
  assert.strictEqual(leaf.validateInput({ action: 'read', name: 'a.txt' }).ok, true);
});
test('validateInput: list 无需参数', () => {
  assert.strictEqual(leaf.validateInput({ action: 'list' }).ok, true);
});
test('validateInput: 未知 action 拒', () => {
  const v = leaf.validateInput({ action: 'delete' });
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /未知 action/);
});
test('validateInput: 大小写/空白归一', () => {
  assert.strictEqual(leaf.validateInput({ action: '  LIST  ' }).action, 'list');
});
test('validateInput: 防呆非对象', () => {
  assert.strictEqual(leaf.validateInput(null).action, 'create');
  assert.strictEqual(leaf.validateInput(null).ok, false); // create 缺 content
});

// ── deriveSafeName(目录穿越防护) ─────────────────────────────────────────
test('deriveSafeName: 正常名保留', () => {
  assert.strictEqual(leaf.deriveSafeName({ name: 'report.md' }), 'report.md');
});
test('deriveSafeName: 剥目录成分', () => {
  assert.strictEqual(leaf.deriveSafeName({ name: 'foo/bar/baz.js' }), 'baz.js');
  assert.strictEqual(leaf.deriveSafeName({ name: 'a\\b\\c.txt' }), 'c.txt');
});
test('deriveSafeName: 目录穿越 ../ 被清除', () => {
  const n = leaf.deriveSafeName({ name: '../../etc/passwd' });
  assert.ok(!n.includes('..'), `不得含 ..: ${n}`);
  assert.ok(!n.includes('/'), `不得含 /: ${n}`);
  assert.strictEqual(n, 'passwd.txt');
});
test('deriveSafeName: 纯 .. 落到 fallback', () => {
  const n = leaf.deriveSafeName({ name: '..', fallbackStem: 'art-1' });
  assert.match(n, /^art-1\.txt$/);
});
test('deriveSafeName: 非白名单字符 → 下划线', () => {
  assert.strictEqual(leaf.deriveSafeName({ name: 'a b@c.txt' }), 'a_b_c.txt');
});
test('deriveSafeName: 缺 name 用 fallbackStem + kind 扩展', () => {
  assert.strictEqual(leaf.deriveSafeName({ fallbackStem: 'art-9', kind: 'py' }), 'art-9.py');
});
test('deriveSafeName: 缺 name 缺 fallback → artifact + 扩展', () => {
  assert.strictEqual(leaf.deriveSafeName({ kind: 'json' }), 'artifact.json');
});
test('deriveSafeName: 无扩展名按 kind 补', () => {
  assert.strictEqual(leaf.deriveSafeName({ name: 'notes', kind: 'md' }), 'notes.md');
});
test('deriveSafeName: 超长截断到 128', () => {
  const long = 'a'.repeat(300);
  const n = leaf.deriveSafeName({ name: long });
  assert.ok(n.length <= 128 + 4, `应被截断: ${n.length}`);
});

// ── 结果构造 ──────────────────────────────────────────────────────────────
test('buildCreateResult: 含本地 path + 非云端说明', () => {
  const r = leaf.buildCreateResult({ name: 'a.txt', path: '/tmp/x/a.txt', bytes: 5 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.action, 'create');
  assert.strictEqual(r.path, '/tmp/x/a.txt');
  assert.strictEqual(r.bytes, 5);
  assert.match(r.note, /非云端分享链接/);
});
test('buildListResult: 计数 + 脱字段', () => {
  const r = leaf.buildListResult([{ name: 'a.txt', bytes: 3 }, { name: 'b.js', bytes: 9 }]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.artifacts[1].name, 'b.js');
});
test('buildListResult: 防呆非数组 → 空', () => {
  assert.strictEqual(leaf.buildListResult(null).count, 0);
});
test('buildReadResult: 含 content', () => {
  const r = leaf.buildReadResult({ name: 'a.txt', path: '/tmp/a.txt', content: 'hi' });
  assert.strictEqual(r.content, 'hi');
});
test('buildErrorResult: success=false', () => {
  const r = leaf.buildErrorResult('boom');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'boom');
});

// ── describeActivity ──────────────────────────────────────────────────────
test('describeActivity: 三动作', () => {
  assert.match(leaf.describeActivity({ action: 'list' }), /列出/);
  assert.match(leaf.describeActivity({ action: 'read', name: 'a' }), /读取工件:a/);
  assert.match(leaf.describeActivity({ action: 'create', name: 'b' }), /保存本地工件:b/);
});
