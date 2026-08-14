'use strict';

// 集成验证:经公开 renderMarkdownLite,有序列表标记在门控开时跨 9→10 右对齐
// (对齐 CC ui/OrderedList.tsx),门控关时逐字节回退到旧的无对齐渲染。
const test = require('node:test');
const assert = require('node:assert');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function render(md) {
  const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');
  return stripAnsi(renderMarkdownLite(md));
}

// 1..10 有序列表。
const LIST = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n');

function markerWidths(out) {
  // 取每个「数字.」标记(到点号)的宽度。
  return out.split('\n')
    .map((l) => l.match(/^(\s*\d+\.)/))
    .filter(Boolean)
    .map((m) => m[1].length);
}

test('门控开:1..10 列表所有 marker 同宽(点号对齐),正文起始列一致', () => {
  process.env.KHY_OL_MARKER_ALIGN = '1';
  const out = render(LIST + '\n<!--align-on-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  const widths = markerWidths(out);
  assert.strictEqual(widths.length, 10, '应识别到 10 个有序项:\n' + out);
  assert.ok(widths.every((w) => w === widths[0]), 'marker 宽度应全相等:' + widths.join(','));
  assert.strictEqual(widths[0], 3, '1..10 的 marker 应宽 3(右对齐):' + widths[0]);
  // 正文 "item N" 在每行的列起点一致。
  const cols = out.split('\n')
    .map((l) => l.indexOf('item '))
    .filter((c) => c >= 0);
  assert.ok(cols.length === 10 && cols.every((c) => c === cols[0]), '正文起始列应对齐:' + cols.join(','));
});

test('门控关:回退到无对齐(个位 marker 宽 2,十位宽 3)', () => {
  process.env.KHY_OL_MARKER_ALIGN = 'off';
  const out = render(LIST + '\n<!--align-off-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  const widths = markerWidths(out);
  assert.strictEqual(widths.length, 10);
  assert.strictEqual(widths[0], 2, '个位项 marker 应宽 2(`1.`):' + widths[0]);
  assert.strictEqual(widths[9], 3, '第 10 项 marker 应宽 3(`10.`):' + widths[9]);
  assert.ok(!widths.every((w) => w === widths[0]), '关档下不应全等宽');
});

test('保留源序号(从 5 起,不重编号),且对齐到两位宽', () => {
  process.env.KHY_OL_MARKER_ALIGN = '1';
  const md = ['5. five', '6. six', '10. ten'].join('\n');
  const out = render(md + '\n<!--preserve-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  // 序号保留 5/6/10(不变成 1/2/3),且 marker 同宽。
  assert.ok(/(^|\n)\s*5\./.test(out), '应保留序号 5:\n' + out);
  assert.ok(/(^|\n)\s*6\./.test(out), '应保留序号 6');
  assert.ok(/(^|\n)10\./.test(out), '应保留序号 10');
  const widths = markerWidths(out);
  assert.ok(widths.length === 3 && widths.every((w) => w === 3), 'marker 应对齐到宽 3:' + widths.join(','));
});

test('同宽列表(全个位)门控开/关输出逐字节一致', () => {
  const md = ['1. a', '2. b', '3. c'].join('\n');
  process.env.KHY_OL_MARKER_ALIGN = '1';
  const on = render(md + '\n<!--u-on-->');
  process.env.KHY_OL_MARKER_ALIGN = 'off';
  const off = render(md + '\n<!--u-off-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  const strip = (s) => s.replace(/<!--[\w-]+-->/g, '').trimEnd();
  assert.strictEqual(strip(on), strip(off));
});

// 回归:有序对齐 pass 曾在栅栏代码块「恢复之后」运行,把 ``` fence 里的数字列表行
// (`1.`/`2.`)也 padStart 到与 `10.` 对齐 → 污染了本应逐字节保留的代码内容。
// 修复:对齐在 fence 仍是 \x00CB…\x00 占位符时运行(占位符不匹配 "N." 项正则)。
test('回归:``` 代码块内的数字列表逐字节保留(不被有序对齐污染)', () => {
  const md = ['```', '1. first', '2. second', '10. tenth', '```'].join('\n');
  process.env.KHY_OL_MARKER_ALIGN = '1';
  const on = render(md + '\n<!--fence-on-->');
  process.env.KHY_OL_MARKER_ALIGN = 'off';
  const off = render(md + '\n<!--fence-off-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  const strip = (s) => s.replace(/<!--[\w-]+-->/g, '').trimEnd();
  // 代码块内容是 verbatim 契约:对齐门开/关都不得改动栅栏内的数字列表。
  assert.strictEqual(strip(on), strip(off), '代码块内数字列表不应随对齐门变化:\n' + on);
  // 门开时 `1. first` 不得获得对齐用的前导空格(否则即污染 verbatim 代码)。
  assert.ok(/│ 1\. first/.test(on), '`1. first` 应无对齐前导空格(verbatim):\n' + on);
  assert.ok(!/│ {2}1\. first/.test(on), '`1. first` 不应被填充为 ` 1.`(污染):\n' + on);
});

test('回归:同一文档栅栏外散文列表仍对齐,栅栏内不变', () => {
  process.env.KHY_OL_MARKER_ALIGN = '1';
  const md = ['1. outer', '2. outer', '10. outer', '', '```', '1. inner', '10. inner', '```'].join('\n');
  const out = render(md + '\n<!--mixed-->');
  delete process.env.KHY_OL_MARKER_ALIGN;
  // 散文侧:`1. outer` 被对齐为 ` 1. outer`(宽 3,与 `10.` 齐)。
  assert.ok(/(^|\n)\s+1\. outer/.test(out), '散文数字列表应对齐(前导 pad):\n' + out);
  // 栅栏侧:`1. inner` 在盒内无对齐前导空格。
  assert.ok(/│ 1\. inner/.test(out), '栅栏内 `1. inner` 应 verbatim:\n' + out);
  assert.ok(!/│ {2}1\. inner/.test(out), '栅栏内 `1. inner` 不应被对齐污染:\n' + out);
});

