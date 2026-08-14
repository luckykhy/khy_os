'use strict';

/**
 * workflowCliHandler.test.js — handlers/workflow.handleWorkflow 端到端(注入 deps)。
 *
 * 用真实的 @khy/shared/workflow/cozeImport + nodeCatalog + Engine A executor
 * (复用既有生产组件,验证 CLI 桥而非重造),仅注入临时 storeDir 与 chat 桩 primitives,
 * 不触真实 LLM / 网络。覆盖 import → list → show → validate → run(--json)→ rm 全生命周期
 * 与未知工作流 fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { handleWorkflow } = require('../src/cli/handlers/workflow');

// 一个最小 Coze 导出文档(Entry/LLM/Exit + 一个被丢弃的 Comment)。
function cozeDoc() {
  return {
    nodes: [
      { id: '1', type: '1', data: { nodeMeta: { title: '开始' }, outputs: [{ name: 'topic' }] } },
      {
        id: '2', type: '3',
        data: {
          nodeMeta: { title: '写作' },
          inputs: { inputParameters: [{ name: 'q', input: { value: { type: 'ref', content: { name: 'topic' } } } }] },
          outputs: [{ name: 'draft' }],
        },
      },
      {
        id: '3', type: '2',
        data: { inputs: { inputParameters: [{ name: 'result', input: { value: { type: 'ref', content: { name: 'draft' } } } }] } },
      },
      { id: '9', type: '31', data: { nodeMeta: { title: '备注' } } },
    ],
    edges: [
      { sourceNodeID: '1', sourcePortID: '', targetNodeID: '2' },
      { sourceNodeID: '2', sourcePortID: '', targetNodeID: '3' },
    ],
  };
}

// 捕获 process.stdout.write(--json 路径用)。
function captureStdout(fn) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = orig; })
    .then(() => buf);
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcli-test-'));
  const storeDir = path.join(tmp, 'store');
  fs.mkdirSync(storeDir);
  const srcFile = path.join(tmp, 'export.json');
  fs.writeFileSync(srcFile, JSON.stringify(cozeDoc()));
  const primitives = { async chat(p) { return 'DRAFT<' + p + '>'; } };
  const deps = { storeDir, primitives };
  return { tmp, storeDir, srcFile, deps, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('import: 写出 canonical 图 + report(--json)', async () => {
  const s = setup();
  try {
    const out = await captureStdout(() => handleWorkflow('import', [s.srcFile], { name: '诗歌', json: true }, s.deps));
    const j = JSON.parse(out);
    assert.equal(j.ok, true);
    assert.equal(j.slug, '诗歌');
    assert.ok(fs.existsSync(j.file));
    const saved = JSON.parse(fs.readFileSync(j.file, 'utf8'));
    assert.equal(saved.nodes.length, 3); // Comment 被丢弃
    assert.equal(saved.connections.length, 2);
    assert.equal(saved._meta.source, 'coze');
  } finally { s.cleanup(); }
});

test('list: 列出已保存(--json)', async () => {
  const s = setup();
  try {
    await handleWorkflow('import', [s.srcFile], { name: '诗歌' }, s.deps);
    const out = await captureStdout(() => handleWorkflow('list', [], { json: true }, s.deps));
    const j = JSON.parse(out);
    assert.equal(j.items.length, 1);
    assert.equal(j.items[0].slug, '诗歌');
    assert.equal(j.items[0].nodeCount, 3);
  } finally { s.cleanup(); }
});

test('show --json / --mermaid', async () => {
  const s = setup();
  try {
    await handleWorkflow('import', [s.srcFile], { name: '诗歌' }, s.deps);
    const j = JSON.parse(await captureStdout(() => handleWorkflow('show', ['诗歌'], { json: true }, s.deps)));
    assert.equal(j.name, '诗歌');
    const mm = await captureStdout(() => handleWorkflow('show', ['诗歌'], { mermaid: true }, s.deps));
    assert.match(mm, /^flowchart TD/);
  } finally { s.cleanup(); }
});

test('validate: 导入图 strict 通过(--json)', async () => {
  const s = setup();
  try {
    await handleWorkflow('import', [s.srcFile], { name: '诗歌' }, s.deps);
    const j = JSON.parse(await captureStdout(() => handleWorkflow('validate', ['诗歌'], { json: true }, s.deps)));
    assert.equal(j.ok, true);
  } finally { s.cleanup(); }
});

test('run: 用注入 primitives 跑通,vars 含 LLM 产出(--json)', async () => {
  const s = setup();
  try {
    await handleWorkflow('import', [s.srcFile], { name: '诗歌' }, s.deps);
    const j = JSON.parse(await captureStdout(() => handleWorkflow('run', ['诗歌', 'topic=秋天'], { json: true }, s.deps)));
    assert.equal(j.status, 'completed');
    assert.equal(j.vars.topic, '秋天');
    assert.match(j.vars.draft, /^DRAFT</);
  } finally { s.cleanup(); }
});

test('rm: 删除后 list 为空', async () => {
  const s = setup();
  try {
    await handleWorkflow('import', [s.srcFile], { name: '诗歌' }, s.deps);
    await handleWorkflow('rm', ['诗歌'], {}, s.deps);
    const j = JSON.parse(await captureStdout(() => handleWorkflow('list', [], { json: true }, s.deps)));
    assert.equal(j.items.length, 0);
  } finally { s.cleanup(); }
});

test('未知工作流 / 缺文件 → fail-soft 返回 true 不抛', async () => {
  const s = setup();
  try {
    assert.equal(await handleWorkflow('show', ['不存在'], {}, s.deps), true);
    assert.equal(await handleWorkflow('run', ['不存在'], {}, s.deps), true);
    assert.equal(await handleWorkflow('validate', ['不存在'], {}, s.deps), true);
    assert.equal(await handleWorkflow('rm', ['不存在'], {}, s.deps), true);
    assert.equal(await handleWorkflow('import', ['/no/such/file.json'], {}, s.deps), true);
  } finally { s.cleanup(); }
});

test('help / 未知子命令 → true', async () => {
  assert.equal(await handleWorkflow('help', [], {}), true);
  assert.equal(await handleWorkflow('frobnicate', [], {}, { storeDir: os.tmpdir() }), true);
});
