'use strict';

/**
 * toollist handler — /toollist prints/filters the tool catalog (node:test).
 * Asserts keyword filter, --json branch, gate-off warn, and return true.
 * console.log is captured; the catalog service is exercised through DI-free
 * real registry only in the smoke path — filtering is unit-tested on a literal.
 */
const test = require('node:test');
const assert = require('node:assert');

const { handleToolList, _filterToolCatalog } = require('../../../src/cli/handlers/toollist');

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return fn(lines); } finally { console.log = orig; }
}

const CATALOG = {
  categories: [
    { key: 'filesystem', label: '文件读写', order: 1, tools: [
      { name: 'Read', desc: 'Read a file.', readOnly: true, risk: 'safe', aliases: [] },
      { name: 'Edit', desc: 'Edit a file.', readOnly: false, risk: 'medium', aliases: ['StrReplace'] },
    ] },
    { key: 'execution', label: '执行与 Shell', order: 2, tools: [
      { name: 'Bash', desc: 'Run a shell command.', readOnly: false, risk: 'high', aliases: [] },
    ] },
  ],
  total: 3,
  generatedBy: 'toolRegistry',
};

test('_filterToolCatalog: 按名过滤', () => {
  const out = _filterToolCatalog(CATALOG, 'bash');
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].tools[0].name, 'Bash');
});

test('_filterToolCatalog: 按别名过滤', () => {
  const out = _filterToolCatalog(CATALOG, 'strreplace');
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].tools[0].name, 'Edit');
});

test('_filterToolCatalog: 空关键字 → 原样', () => {
  assert.strictEqual(_filterToolCatalog(CATALOG, ''), CATALOG);
});

test('--json 输出可解析且含 categories', async () => {
  const prev = process.env.KHY_TOOL_CATALOG;
  delete process.env.KHY_TOOL_CATALOG;
  await captureLog(async (lines) => {
    const rv = await handleToolList('', [], { json: true });
    assert.strictEqual(rv, true);
    const parsed = JSON.parse(lines.join('\n'));
    assert.ok(Array.isArray(parsed.categories));
    assert.strictEqual(typeof parsed.total, 'number');
    assert.ok(parsed.total > 0, 'real registry has tools');
  });
  if (prev === undefined) delete process.env.KHY_TOOL_CATALOG; else process.env.KHY_TOOL_CATALOG = prev;
});

test('gate off → warn + return true, 不打印目录', async () => {
  const prev = process.env.KHY_TOOL_CATALOG;
  process.env.KHY_TOOL_CATALOG = 'off';
  const rv = await handleToolList('', [], {});
  assert.strictEqual(rv, true);
  if (prev === undefined) delete process.env.KHY_TOOL_CATALOG; else process.env.KHY_TOOL_CATALOG = prev;
});

test('人类输出含标题与分类', async () => {
  const prev = process.env.KHY_TOOL_CATALOG;
  delete process.env.KHY_TOOL_CATALOG;
  await captureLog(async (lines) => {
    const rv = await handleToolList('', [], {});
    assert.strictEqual(rv, true);
    const text = lines.join('\n');
    assert.ok(text.includes('khy 工具清单'), 'has title');
  });
  if (prev === undefined) delete process.env.KHY_TOOL_CATALOG; else process.env.KHY_TOOL_CATALOG = prev;
});
