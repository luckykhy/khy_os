'use strict';

// 集成验证:经公开 renderMarkdownLite,markdown 表格的超宽单元格在门控开时
// 「换行不截断」(对齐 CC MarkdownTable),门控关时逐字节回退到旧的截断行为。
// 不渲染 ink,纯 CJS markdownRenderer。
const test = require('node:test');
const assert = require('node:assert');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 强制窄终端,逼一列收窄到内容之下 → 触发换行/截断分歧。
function withColumns(cols, fn) {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  try { return fn(); } finally {
    if (desc) Object.defineProperty(process.stdout, 'columns', desc);
    else delete process.stdout.columns;
  }
}

function render(md) {
  // 每个用例用不同表格文本,规避 renderMarkdownLite 的按文本 LRU 缓存跨门控串味。
  // 本文件专测**盒线表格**路径(单元格换行 vs 截断);无边框纯文本表格是新默认,单独在
  // plainProcessTable.test.js 覆盖 —— 这里显式关 KHY_PLAIN_PROCESS_TABLE 逼盒线路径。
  const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');
  const prev = process.env.KHY_PLAIN_PROCESS_TABLE;
  process.env.KHY_PLAIN_PROCESS_TABLE = 'off';
  try {
    return stripAnsi(renderMarkdownLite(md));
  } finally {
    if (prev === undefined) delete process.env.KHY_PLAIN_PROCESS_TABLE;
    else process.env.KHY_PLAIN_PROCESS_TABLE = prev;
  }
}

test('门控开:超宽单元格换行,所有词完整保留,绝不出现 "..." 截断标记', () => {
  process.env.KHY_TABLE_CELL_WRAP = '1';
  const md = [
    '| Feature | Notes |',
    '| --- | --- |',
    '| Alpha | wrapcase one verylongunbreakabletokenword two three four five six |',
  ].join('\n');
  const out = withColumns(36, () => render(md));
  assert.ok(!out.includes('...'), '换行模式不应截断(无 ...):\n' + out);
  // 长单元格的每个词都应出现在输出里(可能分布在多个物理行)。
  for (const w of ['wrapcase', 'one', 'two', 'three', 'four', 'five', 'six']) {
    assert.ok(out.includes(w), `词 "${w}" 丢失:\n` + out);
  }
  // 超过列宽的单 token 被硬切 → 该 token 不应原样整体出现(被拆开)。
  assert.ok(!out.includes('verylongunbreakabletokenword'),
    '超宽 token 应被硬切而非整体保留:\n' + out);
});

test('门控关:回退到旧截断行为(出现 "..." 且尾部内容丢失)', () => {
  process.env.KHY_TABLE_CELL_WRAP = 'off';
  const md = [
    '| Feature | Notes |',
    '| --- | --- |',
    '| Beta | truncwords this tail content gets dropped sentinelXYZ |',
  ].join('\n');
  const out = withColumns(36, () => render(md));
  assert.ok(out.includes('...'), '截断模式应出现 ...:\n' + out);
  assert.ok(!out.includes('sentinelXYZ'), '截断模式应丢掉尾部内容:\n' + out);
  delete process.env.KHY_TABLE_CELL_WRAP;
});

test('无溢出的表格:门控开与关输出逐字节一致(公共路径等价)', () => {
  const md = [
    '| K | V |',
    '| --- | --- |',
    '| **a** | one |',
    '| b | two |',
  ].join('\n');
  process.env.KHY_TABLE_CELL_WRAP = '1';
  const on = withColumns(80, () => render(md + '\n<!--on-->'));
  process.env.KHY_TABLE_CELL_WRAP = 'off';
  const off = withColumns(80, () => render(md + '\n<!--off-->'));
  delete process.env.KHY_TABLE_CELL_WRAP;
  // 去掉各自的注释行后比较表格主体。
  const strip = (s) => s.replace(/<!--\w+-->/g, '').trimEnd();
  assert.strictEqual(strip(on), strip(off));
});

test('门控开:行内格式仍生效且单元格能装下时不换行(常见路径不退化)', () => {
  process.env.KHY_TABLE_CELL_WRAP = '1';
  const md = [
    '| Name | Qty |',
    '| --- | --- |',
    '| widget | 7 |',
  ].join('\n');
  const out = withColumns(80, () => render(md));
  delete process.env.KHY_TABLE_CELL_WRAP;
  // 单行表体(头 + 分隔 + 1 数据行 + 上下边框 = 5 行,无额外换行行)。
  const bodyLines = out.split('\n').filter((l) => l.includes('│'));
  assert.strictEqual(bodyLines.length, 2, '应为表头+1数据行(无换行膨胀):\n' + out);
  assert.ok(out.includes('widget') && out.includes('7'));
});
