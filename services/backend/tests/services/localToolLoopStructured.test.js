'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const loop = require('../../src/services/localToolLoop');

const ON = () => { process.env.KHY_LOCAL_STRUCTURED = '1'; };

// ── renderStructuredSteps ────────────────────────────────────────────────────
test('renderStructuredSteps emits ordered phase-labelled sections', () => {
  ON();
  const steps = [
    { name: 'Read', params: { file_path: 'a.txt' }, phase: 'read', result: { success: true, content: '旧内容' } },
    { name: 'Edit', params: { file_path: 'a.txt' }, phase: 'write', result: { success: true, path: 'a.txt', changed: true } },
    { name: 'Read', params: { file_path: 'a.txt' }, phase: 'verify', result: { success: true, content: '新内容' } },
  ];
  const out = loop.renderStructuredSteps(steps, '把 a.txt 改一下再读回');
  assert.match(out, /# 本地顺序执行结果/);
  assert.match(out, /第 1 步 · 读取 · Read a\.txt/);
  assert.match(out, /第 2 步 · 写入 · Edit a\.txt/);
  assert.match(out, /第 3 步 · 验证 · Read a\.txt/);
  // order preserved: read section before write section before verify section
  assert.ok(out.indexOf('第 1 步') < out.indexOf('第 2 步'));
  assert.ok(out.indexOf('第 2 步') < out.indexOf('第 3 步'));
  // meta footer marks no-model + local
  assert.match(out, /本地 · 无模型/);
  assert.match(out, /先读后写 \/ 先写再读/);
});

test('renderStructuredSteps returns empty when all steps failed/denied', () => {
  ON();
  const steps = [
    { name: 'Edit', params: { file_path: 'x' }, phase: 'write', result: { denied: true, error: '权限不足' } },
  ];
  assert.strictEqual(loop.renderStructuredSteps(steps, 'q'), '');
});

test('renderStructuredSteps returns empty when disabled', () => {
  process.env.KHY_LOCAL_STRUCTURED = '0';
  const steps = [{ name: 'Read', params: { file_path: 'a' }, phase: 'read', result: { success: true, content: 'x' } }];
  assert.strictEqual(loop.renderStructuredSteps(steps, 'q'), '');
  ON();
});

test('write result with no payload digests to a clean effect line, not raw JSON', () => {
  ON();
  const out = loop._digestStructured('Write', { success: true, path: 'out.txt', changed: true }, 'q');
  assert.match(out, /已完成/);
  assert.doesNotMatch(out, /\{"success"/);
});

test('_phaseForTool maps tool families', () => {
  assert.strictEqual(loop._phaseForTool('Read'), 'read');
  assert.strictEqual(loop._phaseForTool('Edit'), 'write');
  assert.strictEqual(loop._phaseForTool('Write'), 'write');
  assert.strictEqual(loop._phaseForTool('Grep'), 'search');
  assert.strictEqual(loop._phaseForTool('WebFetch'), 'fetch');
});

// ── loop integration: deterministic ordered drive ────────────────────────────
test('deterministic loop runs edit-replace in read→write order and renders structured', async () => {
  ON();
  const calls = [];
  const executeTool = async (name, params) => {
    calls.push({ name, params });
    if (name === 'Read' || name === 'readFile') return { success: true, content: 'foo lives here' };
    if (name === 'Edit' || name === 'editFile') return { success: true, path: params.file_path, changed: true };
    return { success: true };
  };
  const toolDefinitions = [
    { name: 'Read', description: 'read', parameters: {} },
    { name: 'Edit', description: 'edit', parameters: {} },
  ];
  // Force write tier on so the ordered plan with a mutation is not dropped.
  const prevWrite = process.env.KHY_LOCAL_WRITE;
  process.env.KHY_LOCAL_WRITE = 'on';
  try {
    const res = await loop.runLocalToolLoop('把 a.txt 里的 foo 改成 bar', {
      executeTool,
      toolDefinitions,
      fileExists: () => true,
      networkUp: false,
    });
    // read must precede edit
    const readIdx = calls.findIndex(c => c.name === 'Read' || c.name === 'readFile');
    const editIdx = calls.findIndex(c => c.name === 'Edit' || c.name === 'editFile');
    assert.ok(readIdx >= 0 && editIdx >= 0, 'both tools ran');
    assert.ok(readIdx < editIdx, '先读后写: read precedes edit');
    assert.strictEqual(res.mode, 'deterministic');
    assert.match(res.finalText, /# 本地顺序执行结果/);
    assert.match(res.finalText, /读取/);
    assert.match(res.finalText, /写入/);
  } finally {
    if (prevWrite === undefined) delete process.env.KHY_LOCAL_WRITE;
    else process.env.KHY_LOCAL_WRITE = prevWrite;
  }
});
