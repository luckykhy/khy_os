'use strict';

/**
 * toolCatalog/toolCatalog — pure grouping of the tool registry into a browsable
 * catalog (node:test). Asserts grouping/ordering, gate-off empty, name dedup,
 * summary derivation, and fail-soft on bad input. Registry injected (zero IO).
 */
const test = require('node:test');
const assert = require('node:assert');

const tc = require('../../src/services/toolCatalog/toolCatalog');

/** Build a fake registry Map<name, toolDef> from plain objects. */
function fakeRegistry(tools) {
  const m = new Map();
  for (const t of tools) if (t && t.name) m.set(t.name, t);
  return () => m;
}

/** Registry that returns a raw array (buildToolCatalog also accepts arrays). */
function fakeArrayRegistry(tools) {
  return () => tools;
}

const TOOLS = [
  { name: 'Read', category: 'filesystem', description: 'Read a file.\nMore detail.', risk: 'safe', isReadOnly: () => true, aliases: [] },
  { name: 'Edit', category: 'filesystem', description: 'Edit a file.', risk: 'medium', isReadOnly: () => false, aliases: ['StrReplace'] },
  { name: 'Bash', category: 'execution', description: 'Run a shell command.', risk: 'high', isReadOnly: () => false, aliases: [] },
  { name: 'KhySelf', category: 'system', description: 'Self-awareness.', risk: 'safe', isReadOnly: () => true, aliases: ['khy_self'] },
];

test('gate off → 空目录', () => {
  const out = tc.buildToolCatalog({ getAll: fakeRegistry(TOOLS) }, { KHY_TOOL_CATALOG: 'off' });
  assert.deepStrictEqual(out, { categories: [], total: 0, generatedBy: 'toolRegistry' });
});

test('gate 默认开 → 分组 + 总数', () => {
  const out = tc.buildToolCatalog({ getAll: fakeRegistry(TOOLS) }, {});
  assert.strictEqual(out.total, 4);
  // filesystem(order1) 在 execution(order2) 前,execution 在 system(order6) 前
  const keys = out.categories.map((c) => c.key);
  assert.deepStrictEqual(keys, ['filesystem', 'execution', 'system']);
  const fs = out.categories.find((c) => c.key === 'filesystem');
  assert.strictEqual(fs.label, '文件读写');
  // 组内按 name 字母序: Edit < Read
  assert.deepStrictEqual(fs.tools.map((t) => t.name), ['Edit', 'Read']);
});

test('工具条目字段: readOnly / risk / aliases / desc 摘要', () => {
  const out = tc.buildToolCatalog({ getAll: fakeRegistry(TOOLS) }, {});
  const read = out.categories.find((c) => c.key === 'filesystem').tools.find((t) => t.name === 'Read');
  assert.strictEqual(read.readOnly, true);
  assert.strictEqual(read.risk, 'safe');
  assert.strictEqual(read.desc, 'Read a file.'); // 只取首个非空行
  const edit = out.categories.find((c) => c.key === 'filesystem').tools.find((t) => t.name === 'Edit');
  assert.deepStrictEqual(edit.aliases, ['StrReplace']);
});

test('同名去重(保留首个)', () => {
  const dup = [
    { name: 'Read', category: 'filesystem', description: 'first', isReadOnly: () => true },
    { name: 'Read', category: 'filesystem', description: 'second', isReadOnly: () => true },
  ];
  const out = tc.buildToolCatalog({ getAll: fakeArrayRegistry(dup) }, {});
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].tools[0].desc, 'first');
});

test('未知 category → 兜底「其他」', () => {
  const out = tc.buildToolCatalog({ getAll: fakeRegistry([{ name: 'X', category: 'wat', isReadOnly: () => false }]) }, {});
  assert.strictEqual(out.categories[0].key, 'wat');
  assert.strictEqual(out.categories[0].label, '其他');
});

test('_summarize: 首行截断 ~120', () => {
  assert.strictEqual(tc._summarize('  \n\n line one \n line two'), 'line one');
  const long = 'a'.repeat(200);
  assert.ok(tc._summarize(long).length <= 118);
  assert.ok(tc._summarize(long).endsWith('…'));
  assert.strictEqual(tc._summarize(null), '');
});

test('fail-soft: getAll 抛 → 空目录', () => {
  const out = tc.buildToolCatalog({ getAll: () => { throw new Error('boom'); } }, {});
  assert.deepStrictEqual(out, { categories: [], total: 0, generatedBy: 'toolRegistry' });
});

test('fail-soft: 坏工具条目被跳过', () => {
  const out = tc.buildToolCatalog({ getAll: fakeArrayRegistry([null, { noName: true }, { name: 'Ok', category: 'system', isReadOnly: () => false }]) }, {});
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.categories[0].tools[0].name, 'Ok');
});

test('toolCatalogEnabled: 关闭词表', () => {
  assert.strictEqual(tc.toolCatalogEnabled({}), true);
  assert.strictEqual(tc.toolCatalogEnabled({ KHY_TOOL_CATALOG: '0' }), false);
  assert.strictEqual(tc.toolCatalogEnabled({ KHY_TOOL_CATALOG: 'off' }), false);
  assert.strictEqual(tc.toolCatalogEnabled({ KHY_TOOL_CATALOG: 'on' }), true);
});
