'use strict';

// 对齐 CC「后端逻辑也对齐」:diff 的 add/remove 行背景色条**填充到终端整宽**
// **单一真源**。CC `src/components/StructuredDiff/Fallback.tsx` 的 `formatDiff`
// 对每行算 `padding = Math.max(0, width - contentWidth)` 再在 backgroundColor
// 的 <Text> 里追加 `{' '.repeat(padding)}`,使红/绿背景条铺到终端右缘。khy 历史所有
// diff 路径只把背景铺到文本末尾,右侧参差。本测试锁定:
//   - 纯算术叶子 diffFullWidth(门控梯 + diffRowPadCount 防呆 + diffRowPadSpaces)
//   - 经典 ANSI 路径 diffRenderer 接线:门控开 → add/del 行补背景空格到整宽
//     (经 console.log 直出无 ink trim,尾随背景空格存活);门控关 → 字节回退
//   - context(无背景)行不补;`---`/`+++` 头不补
// 诚实边界:Ink TUI 因 ink@6.8.0 output.js trimEnd 裁掉尾随背景空格,整宽色条
//   在 TUI 为 honest-NA(本叶子不接 TUI 路径)。
const test = require('node:test');
const assert = require('node:assert');

const {
  diffFullWidthEnabled,
  diffRowPadCount,
  diffRowPadSpaces,
} = require('../../src/cli/diffFullWidth');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('diffFullWidthEnabled 门控梯:默认开·仅 0/false/off/no 关', () => {
  assert.strictEqual(diffFullWidthEnabled({}), true);
  assert.strictEqual(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: '1' }), true);
  assert.strictEqual(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.strictEqual(diffFullWidthEnabled({ KHY_DIFF_FULL_WIDTH: off }), false, off);
  }
});

// ── 纯算术:diffRowPadCount(对齐 CC Math.max(0, width - contentWidth))────────
test('diffRowPadCount:整宽 - 已用 = 补白数;used>=total → 0', () => {
  assert.strictEqual(diffRowPadCount(7, 80), 73);
  assert.strictEqual(diffRowPadCount(80, 80), 0);
  assert.strictEqual(diffRowPadCount(100, 80), 0); // 绝不返回负数
  assert.strictEqual(diffRowPadCount(0, 80), 80);
});

test('diffRowPadCount 防呆:非有限数 → 0·小数 floor', () => {
  assert.strictEqual(diffRowPadCount(NaN, 80), 0);
  assert.strictEqual(diffRowPadCount(7, Infinity), 0);
  assert.strictEqual(diffRowPadCount('x', 80), 0);
  assert.strictEqual(diffRowPadCount(undefined, 80), 0);
  assert.strictEqual(diffRowPadCount(7.9, 80.2), 73); // floor(80)-floor(7)=73
});

// ── diffRowPadSpaces:门控关 → 空串(字节回退)·门控开 → 空格串 ──────────────
test('diffRowPadSpaces:门控关 → 空串(call-site 接空串=字节回退)', () => {
  assert.strictEqual(diffRowPadSpaces(7, 80, { KHY_DIFF_FULL_WIDTH: 'off' }), '');
  assert.strictEqual(diffRowPadSpaces(7, 80, { KHY_DIFF_FULL_WIDTH: '0' }), '');
});

test('diffRowPadSpaces:门控开 → 正确长度空格串', () => {
  assert.strictEqual(diffRowPadSpaces(7, 80, {}), ' '.repeat(73));
  assert.strictEqual(diffRowPadSpaces(80, 80, {}), '');
});

// ── 集成:经典 diffRenderer 真渲染(FORCE_COLOR=3·固定 columns=80)──────────
function renderStructured(gateValue) {
  const path = require.resolve('../../src/cli/diffRenderer');
  delete require.cache[path];
  const prevForce = process.env.FORCE_COLOR;
  const prevGate = process.env.KHY_DIFF_FULL_WIDTH;
  const prevCols = process.stdout.columns;
  process.env.FORCE_COLOR = '3';
  process.stdout.columns = 80;
  if (gateValue == null) delete process.env.KHY_DIFF_FULL_WIDTH;
  else process.env.KHY_DIFF_FULL_WIDTH = gateValue;
  try {
    return require(path).renderStructuredDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.txt');
  } finally {
    if (prevForce == null) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce;
    if (prevGate == null) delete process.env.KHY_DIFF_FULL_WIDTH; else process.env.KHY_DIFF_FULL_WIDTH = prevGate;
    process.stdout.columns = prevCols;
    delete require.cache[path];
  }
}

test('集成门控开:add/del 行补到整宽 80·context 行不补', () => {
  const out = renderStructured('1');
  const lines = out.split('\n');
  const add = lines.find((l) => / \+ /.test(strip(l)));
  const del = lines.find((l) => / - /.test(strip(l)));
  const ctx = lines.find((l) => /  1   a/.test(strip(l)));
  assert.strictEqual(strip(add).length, 80, 'add 行整宽');
  assert.strictEqual(strip(del).length, 80, 'del 行整宽');
  assert.ok(strip(ctx).length < 80, 'context(无背景)行不补');
});

test('集成门控开:尾随空格落在背景色跨度内(reset 在空格之后)', () => {
  const out = renderStructured('1');
  const add = out.split('\n').find((l) => / \+ /.test(strip(l)));
  // 末尾应是 「空格… → 前景 reset[39m → 背景 reset[49m」,即背景覆盖补白空格。
  assert.match(add, / {3,}\x1b\[39m\x1b\[49m$/, '背景色覆盖尾随补白空格');
});

test('集成门控关:逐字节回退(add/del 行不补·短于 80)', () => {
  const out = renderStructured('off');
  const lines = out.split('\n');
  const add = lines.find((l) => / \+ /.test(strip(l)));
  const del = lines.find((l) => / - /.test(strip(l)));
  assert.ok(strip(add).length < 80, 'add 行不补=参差(legacy)');
  assert.ok(strip(del).length < 80, 'del 行不补=参差(legacy)');
  assert.ok(!/ {3,}\x1b\[49m$/.test(add), '无尾随背景补白');
});

test('集成默认门控(无 env)= 开 → 整宽(对齐 CC)', () => {
  const out = renderStructured(null);
  const add = out.split('\n').find((l) => / \+ /.test(strip(l)));
  assert.strictEqual(strip(add).length, 80, 'default-on 整宽');
});

// ── 集成:renderDiff(/diff 命令路径)同样整宽,头部不动 ──────────────────────
function renderUnified(gateValue, cols = 80) {
  const path = require.resolve('../../src/cli/diffRenderer');
  delete require.cache[path];
  const prevForce = process.env.FORCE_COLOR;
  const prevGate = process.env.KHY_DIFF_FULL_WIDTH;
  const prevCols = process.stdout.columns;
  process.env.FORCE_COLOR = '3';
  process.stdout.columns = cols;
  if (gateValue == null) delete process.env.KHY_DIFF_FULL_WIDTH;
  else process.env.KHY_DIFF_FULL_WIDTH = gateValue;
  try {
    return require(path).renderDiff('--- a\n+++ b\n-foo bar baz\n+foo qux baz\n');
  } finally {
    if (prevForce == null) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce;
    if (prevGate == null) delete process.env.KHY_DIFF_FULL_WIDTH; else process.env.KHY_DIFF_FULL_WIDTH = prevGate;
    process.stdout.columns = prevCols;
    delete require.cache[path];
  }
}

test('集成 renderDiff 门控开:+/- 行整宽·`---`/`+++` 头不补', () => {
  const out = renderUnified('1');
  const lines = out.split('\n');
  const plus = lines.find((l) => /^\+foo/.test(strip(l)));
  const minus = lines.find((l) => /^-foo/.test(strip(l)));
  const head = lines.find((l) => /^\+\+\+ b/.test(strip(l)));
  assert.strictEqual(strip(plus).length, 80, '+ 行整宽');
  assert.strictEqual(strip(minus).length, 80, '- 行整宽');
  assert.strictEqual(strip(head).length, 5, '+++ 头不补(非色条)');
});

test('集成 renderDiff 跟随终端宽度(cols=120 → 整宽 120)', () => {
  const out = renderUnified('1', 120);
  const plus = out.split('\n').find((l) => /^\+foo/.test(strip(l)));
  assert.strictEqual(strip(plus).length, 120, '跟随 process.stdout.columns');
});
