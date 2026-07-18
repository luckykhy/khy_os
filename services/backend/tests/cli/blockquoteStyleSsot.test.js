'use strict';

// 对齐 CC「后端逻辑也对齐」:markdown blockquote 正文样式**单一真源**。
// CC `src/utils/markdown.ts` 的 blockquote 渲染刻意把竖条 dim、正文保持
// `chalk.italic(line)` 且**正常亮度**,源码注释逐字:"Keep text italic but at
// normal brightness — chalk.dim is nearly invisible on dark themes."
// khy 历史把正文 `c().dim(body)` 掉=复刻了 CC 注释专门要避免的可读性 bug。
// 本测试锁定收敛后的 `blockquoteStyle` 决策 + renderer 接线:
//   - 门控 KHY_BLOCKQUOTE_STYLE 开 → 正文 italic(\x1b[3m,正常亮度)
//   - 门控关 → 逐字节回退历史 dim(\x1b[2m)
// 零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const {
  blockquoteBodyStyleEnabled,
  blockquoteBodyStyle,
} = require('../../src/cli/blockquoteStyle');

// ── 叶子决策:门控梯 ───────────────────────────────────────────────────────
test('blockquoteBodyStyleEnabled 门控梯:默认开·仅 0/false/off/no 关', () => {
  assert.strictEqual(blockquoteBodyStyleEnabled({}), true);                          // 默认开
  assert.strictEqual(blockquoteBodyStyleEnabled({ KHY_BLOCKQUOTE_STYLE: '1' }), true);
  assert.strictEqual(blockquoteBodyStyleEnabled({ KHY_BLOCKQUOTE_STYLE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No', 'False']) {
    assert.strictEqual(blockquoteBodyStyleEnabled({ KHY_BLOCKQUOTE_STYLE: off }), false, off);
  }
});

test('blockquoteBodyStyle:门控开→"italic"(CC 正常亮度)·关→"dim"(历史回退)', () => {
  assert.strictEqual(blockquoteBodyStyle({}), 'italic');
  assert.strictEqual(blockquoteBodyStyle({ KHY_BLOCKQUOTE_STYLE: '1' }), 'italic');
  assert.strictEqual(blockquoteBodyStyle({ KHY_BLOCKQUOTE_STYLE: 'off' }), 'dim');
  assert.strictEqual(blockquoteBodyStyle({ KHY_BLOCKQUOTE_STYLE: '0' }), 'dim');
});

test('唯一分歧锁定:正文样式名 italic vs dim(竖条始终 dim·不在本刀)', () => {
  assert.notStrictEqual(
    blockquoteBodyStyle({ KHY_BLOCKQUOTE_STYLE: 'on' }),
    blockquoteBodyStyle({ KHY_BLOCKQUOTE_STYLE: 'off' }),
  );
});

// ── 渲染接线:真 ANSI 转义验证(italic=\x1b[3m / dim=\x1b[2m)───────────────
// chalk 需 FORCE_COLOR 才上色;在 require renderer 前设置。
function renderQuote(gateValue) {
  // 隔离 require 缓存,确保 env 在模块初始化前生效不影响别的用例。
  const path = require.resolve('../../src/cli/markdownRenderer');
  delete require.cache[path];
  const prevForce = process.env.FORCE_COLOR;
  const prevGate = process.env.KHY_BLOCKQUOTE_STYLE;
  process.env.FORCE_COLOR = '3';
  if (gateValue == null) delete process.env.KHY_BLOCKQUOTE_STYLE;
  else process.env.KHY_BLOCKQUOTE_STYLE = gateValue;
  try {
    const { renderMarkdownLite } = require(path);
    return renderMarkdownLite('> An important caveat.');
  } finally {
    if (prevForce == null) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce;
    if (prevGate == null) delete process.env.KHY_BLOCKQUOTE_STYLE; else process.env.KHY_BLOCKQUOTE_STYLE = prevGate;
    delete require.cache[path];
  }
}

const ITALIC = '[3m';
const DIM = '[2m';

test('渲染门控开:正文套 italic(\\x1b[3m)·正常亮度·对齐 CC', () => {
  const out = renderQuote('1');
  assert.ok(out.includes('An important caveat.'), 'body present');
  assert.ok(out.includes(ITALIC), 'italic escape present (CC parity)');
});

test('渲染门控关:正文回退 dim(\\x1b[2m)·历史口径', () => {
  const out = renderQuote('off');
  assert.ok(out.includes('An important caveat.'), 'body present');
  assert.ok(out.includes(DIM), 'dim escape present (legacy)');
  // 正文不应被 italic 包裹(竖条另算,但本行只有一个文本段)。
  assert.ok(!out.includes(ITALIC), 'no italic in legacy mode');
});

test('默认门控(无 env)= 开 → italic(对齐 CC)', () => {
  const out = renderQuote(null);
  assert.ok(out.includes(ITALIC), 'default-on italic');
});
