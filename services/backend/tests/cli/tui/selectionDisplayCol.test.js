'use strict';

/**
 * selectionDisplayCol.test.js — 鼠标「显示列」↔ 选区「字符下标」的换算回归（问题 #10）。
 *
 * 实测症状：在中文转录上按住拖动，反色跑不到指针底下、复制出的文本比选中的多出
 * 一截，用户报「复制选中不能单点拖动」。
 *
 * 根因：SGR 鼠标序列上报的是**终端单元格列**（CJK 字占 2 列），而 `selection.js`
 * 的 `col` 与 `extractText` / `Viewport.sliceLineForSelection` 一律按**字符串下标**
 * 工作。中文行上两个口径差近一倍 —— 指针停在第 20 列，选区却从第 20 个字符
 * （≈第 40 列）开始。
 *
 * 本套件先钉住纯函数 `charColForDisplay` 的语义（宽字符两半归到该字符起始、
 * ASCII 恒等、越界 clamp），再用它复现「按下点→松手点」的端到端取词。
 *
 * 运行：node --test tests/cli/tui/selectionDisplayCol.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  charColForDisplay,
  beginSelection,
  extendSelection,
  endSelection,
  extractText,
  selectionRangeFor,
} = require('../../../src/cli/tui/selection');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

// 与真实转录同形：两格缩进 + 项目符号 + 中文 + ASCII 混排。
const LINE = '  · 央视网新闻频道 (https://news.cctv.cn/) 抓取结果为空，无法获取具体新闻内容';

/** 取显示列区间 `[a,b)` 的原文（换算的独立参照实现）。 */
function colsBetween(str, a, b) {
  let out = '';
  let w = 0;
  for (const ch of str) {
    if (w >= a && w < b) out += ch;
    w += visWidth(ch);
    if (w >= b) break;
  }
  return out;
}

test('DC-01 换算函数存在且是纯函数（不改入参、不抛）', () => {
  assert.equal(typeof charColForDisplay, 'function');
  assert.equal(charColForDisplay(undefined, 5), 0);
  assert.equal(charColForDisplay('', 5), 0);
  assert.equal(charColForDisplay(LINE, NaN), 0);
  assert.equal(charColForDisplay(LINE, -3), 0);
});

test('DC-02 纯 ASCII 行：显示列 == 字符下标（恒等，零回归）', () => {
  const ascii = 'hello world, plain ascii';
  for (let c = 0; c <= ascii.length + 5; c++) {
    assert.equal(charColForDisplay(ascii, c), Math.min(c, ascii.length));
  }
});

test('DC-03 中文行：落在宽字符两半之间时归到该字符起始列', () => {
  const s = '中文测试';
  assert.equal(charColForDisplay(s, 0), 0);
  assert.equal(charColForDisplay(s, 1), 0); // 「中」的第 2 格 → 仍指向「中」
  assert.equal(charColForDisplay(s, 2), 1);
  assert.equal(charColForDisplay(s, 3), 1);
  assert.equal(charColForDisplay(s, 4), 2);
});

test('DC-04 越界 clamp 到行尾（指针拖过行末不会越界取词）', () => {
  assert.equal(charColForDisplay(LINE, 4000), LINE.length);
  assert.equal(charColForDisplay('中文', 99), 2);
});

test('DC-05 换算后的两端取词 == 指针底下的那段（#10 的核心断言）', () => {
  const from = 4;  // 指针按在「·」之后
  const to = 20;   // 指针拖到「频道」与「(」 之间
  const expected = colsBetween(LINE, from, to);
  assert.ok(expected.length > 0, '夹具本身要能取到东西');
  assert.notEqual(expected, LINE.slice(from, to), '旧口径（按字符下标）必须是错的');

  const sel = endSelection(extendSelection(beginSelection(null, 0, charColForDisplay(LINE, from)),
    0, charColForDisplay(LINE, to)));
  assert.equal(extractText([LINE], sel), expected);
});

test('DC-06 反色区间与取词同源：换算后高亮段 == 指针底下的段', () => {
  const from = 4;
  const to = 20;
  const sel = endSelection(extendSelection(beginSelection(null, 0, charColForDisplay(LINE, from)),
    0, charColForDisplay(LINE, to)));
  const seg = selectionRangeFor([LINE], sel, 0);
  assert.ok(seg, '命中本行');
  assert.equal(LINE.slice(seg.from, seg.to), colsBetween(LINE, from, to));
});

test('DC-07 跨行选区：每行按**各自**的换算（中文首行 + ASCII 末行）', () => {
  const a = '中文测试内容宽度为二';
  const b = 'abcdef';
  const sel = {
    anchor: { line: 0, col: charColForDisplay(a, 4) },
    head: { line: 1, col: charColForDisplay(b, 3) },
    dragging: false,
  };
  // 跨行语义：首行从按下点取到**行尾**，末行从 0 取到松手点。
  // 首行按显示列 4 换算 → 字符 2（「测」），而不是字符 4（「内」）。
  assert.equal(extractText([a, b], sel), a.slice(2) + '\n' + b.slice(0, 3));
  assert.equal(charColForDisplay(a, 4), 2);
  assert.equal(charColForDisplay(b, 3), 3, '纯 ASCII 行恒等');
});
