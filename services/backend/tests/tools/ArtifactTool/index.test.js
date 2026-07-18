'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离数据家:在 require 任何东西前钉到临时目录(getDataHome 读 KHY_DATA_HOME 并缓存)。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-artifact-test-'));
process.env.KHY_DATA_HOME = TMP;
delete process.env.KHY_PROJECT_DATA_HOME;

const ArtifactTool = require('../../../src/tools/ArtifactTool');

function makeTool() { return new ArtifactTool(); }

test('static 元数据', () => {
  assert.strictEqual(ArtifactTool.toolName, 'Artifact');
  assert.strictEqual(ArtifactTool.risk, 'safe');
});

test('isReadOnly: create 非只读、list/read 只读', () => {
  const t = makeTool();
  assert.strictEqual(t.isReadOnly({ action: 'create' }), false);
  assert.strictEqual(t.isReadOnly({}), false); // 默认 create
  assert.strictEqual(t.isReadOnly({ action: 'list' }), true);
  assert.strictEqual(t.isReadOnly({ action: 'read' }), true);
});

test('isDestructive 恒假', () => {
  assert.strictEqual(makeTool().isDestructive({ action: 'create' }), false);
});

test('execute create → 写本地文件并返回本地 path(非云 URL)', async () => {
  const t = makeTool();
  const r = await t.execute({ action: 'create', name: 'hello.md', content: '# hi\n' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.name, 'hello.md');
  assert.ok(path.isAbsolute(r.path), 'path 应为本地绝对路径');
  assert.ok(r.path.startsWith(TMP), 'path 应落在隔离数据家内');
  assert.ok(!/^https?:\/\//.test(r.path), 'path 绝不是 URL');
  assert.strictEqual(fs.readFileSync(r.path, 'utf-8'), '# hi\n');
});

test('execute create 缺 content → 校验失败、不写', async () => {
  const t = makeTool();
  const r = await t.execute({ action: 'create' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /content/);
});

test('execute create 目录穿越名 → 落到安全名,不逃逸数据家', async () => {
  const t = makeTool();
  const r = await t.execute({ action: 'create', name: '../../etc/passwd', content: 'x' });
  assert.strictEqual(r.success, true);
  assert.ok(!r.path.includes('..'));
  assert.ok(r.path.startsWith(TMP), '绝不逃逸数据家');
  assert.strictEqual(path.basename(r.path), 'passwd.txt');
});

test('execute list → 列出已写工件', async () => {
  const t = makeTool();
  await t.execute({ action: 'create', name: 'a.txt', content: 'aa' });
  const r = await t.execute({ action: 'list' });
  assert.strictEqual(r.success, true);
  assert.ok(r.count >= 1);
  assert.ok(r.artifacts.some((e) => e.name === 'a.txt'));
});

test('execute read → 读回内容', async () => {
  const t = makeTool();
  await t.execute({ action: 'create', name: 'rd.txt', content: 'roundtrip' });
  const r = await t.execute({ action: 'read', name: 'rd.txt' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.content, 'roundtrip');
});

test('execute read 不存在 → 诚实错误', async () => {
  const t = makeTool();
  const r = await t.execute({ action: 'read', name: 'nope.txt' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /未找到工件/);
});

test('门控关 → 不写文件、返回禁用提示', async () => {
  const prev = process.env.KHY_ARTIFACT_TOOL;
  process.env.KHY_ARTIFACT_TOOL = '0';
  try {
    const t = makeTool();
    const r = await t.execute({ action: 'create', name: 'gated.txt', content: 'x' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /KHY_ARTIFACT_TOOL/);
    assert.ok(!fs.existsSync(path.join(TMP, 'artifacts', 'gated.txt')), '门控关绝不写文件');
  } finally {
    if (prev === undefined) delete process.env.KHY_ARTIFACT_TOOL;
    else process.env.KHY_ARTIFACT_TOOL = prev;
  }
});

test('getActivityDescription 委托叶子', () => {
  assert.match(makeTool().getActivityDescription({ action: 'list' }), /列出/);
});
