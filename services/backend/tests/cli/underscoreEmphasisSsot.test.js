'use strict';

// 对齐 CC「后端逻辑也对齐」:markdown 行内下划线强调 `_italic_`/`__bold__` **单一真源**。
// CC `src/utils/markdown.ts` 用 marked 词法器按 CommonMark 解析,`em→chalk.italic`/
// `strong→chalk.bold`,**同时识别** `*`/`_` 两套定界符并套 flanking 规则。khy 行内
// 强调链历史**只认星号**,`_x_`/`__x__` 连定界符原样上屏(强调丢失)。本测试锁定
// 收敛后的 `underscoreEmphasis` 叶子(承重=词内守卫防 snake_case 误斜体)+ renderer 接线:
//   - 门控 KHY_UNDERSCORE_EMPHASIS 开 → `_x_`→italic·`__x__`→bold·snake_case 字面
//   - 门控关 → call-site 跳过 → 下划线逐字节回退(原样)
// 零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const {
  underscoreEmphasisEnabled,
  applyUnderscoreEmphasis,
} = require('../../src/cli/underscoreEmphasis');

// 测试用样式器:用可见包裹标记替代 chalk(无需上色即可断言哪段被套样式)。
const TAG = {
  italic: (t) => `<i>${t}</i>`,
  bold: (t) => `<b>${t}</b>`,
  boldItalic: (t) => `<bi>${t}</bi>`,
};

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('underscoreEmphasisEnabled 门控梯:默认开·仅 0/false/off/no 关', () => {
  assert.strictEqual(underscoreEmphasisEnabled({}), true);
  assert.strictEqual(underscoreEmphasisEnabled({ KHY_UNDERSCORE_EMPHASIS: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.strictEqual(underscoreEmphasisEnabled({ KHY_UNDERSCORE_EMPHASIS: off }), false, off);
  }
});

// ── 核心:基本强调 ─────────────────────────────────────────────────────────
test('基本:_italic_ → italic·__bold__ → bold·___bi___ → bold-italic', () => {
  assert.strictEqual(applyUnderscoreEmphasis('a _foo_ b', TAG), 'a <i>foo</i> b');
  assert.strictEqual(applyUnderscoreEmphasis('a __foo__ b', TAG), 'a <b>foo</b> b');
  assert.strictEqual(applyUnderscoreEmphasis('a ___foo___ b', TAG), 'a <bi>foo</bi> b');
});

test('行首/行尾边界:开头与结尾的下划线强调也命中', () => {
  assert.strictEqual(applyUnderscoreEmphasis('_foo_', TAG), '<i>foo</i>');
  assert.strictEqual(applyUnderscoreEmphasis('__foo__', TAG), '<b>foo</b>');
});

// ── 承重:词内守卫(snake_case 必须字面保留)──────────────────────────────────
test('承重守卫:snake_case / 词内下划线**字面保留**(对齐 CommonMark intraword)', () => {
  assert.strictEqual(applyUnderscoreEmphasis('some_function_name', TAG), 'some_function_name');
  assert.strictEqual(applyUnderscoreEmphasis('a foo_bar_baz b', TAG), 'a foo_bar_baz b');
  assert.strictEqual(applyUnderscoreEmphasis('_a_b_', TAG), '_a_b_'); // 词内连缀 → 无匹配
  assert.strictEqual(applyUnderscoreEmphasis('call f(x_, _y)', TAG), 'call f(x_, _y)'); // 不成对/词内
});

test('守卫:定界符内侧须紧贴非空白(`_ foo _` 不命中)', () => {
  assert.strictEqual(applyUnderscoreEmphasis('a _ foo _ b', TAG), 'a _ foo _ b');
});

test('混合:同行 snake_case 与真强调并存,只套真强调', () => {
  assert.strictEqual(
    applyUnderscoreEmphasis('set my_var then _go_ now', TAG),
    'set my_var then <i>go</i> now',
  );
});

// ── 防呆 ──────────────────────────────────────────────────────────────────
test('防呆:非串 / 无下划线 / 非法 styler → 原样返回', () => {
  assert.strictEqual(applyUnderscoreEmphasis('no underscores here', TAG), 'no underscores here');
  assert.strictEqual(applyUnderscoreEmphasis(42, TAG), 42);
  assert.strictEqual(applyUnderscoreEmphasis('_x_', null), '_x_');
  assert.strictEqual(applyUnderscoreEmphasis('_x_', { italic: 1, bold: 2, boldItalic: 3 }), '_x_');
});

// ── 渲染接线:真 ANSI(italic=\x1b[3m / bold=\x1b[1m)+ 门控字节回退 ──────────
function renderLite(text, gateValue) {
  const path = require.resolve('../../src/cli/markdownRenderer');
  delete require.cache[path];
  const prevForce = process.env.FORCE_COLOR;
  const prevGate = process.env.KHY_UNDERSCORE_EMPHASIS;
  process.env.FORCE_COLOR = '3';
  if (gateValue == null) delete process.env.KHY_UNDERSCORE_EMPHASIS;
  else process.env.KHY_UNDERSCORE_EMPHASIS = gateValue;
  try {
    return require(path).renderMarkdownLite(text);
  } finally {
    if (prevForce == null) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce;
    if (prevGate == null) delete process.env.KHY_UNDERSCORE_EMPHASIS; else process.env.KHY_UNDERSCORE_EMPHASIS = prevGate;
    delete require.cache[path];
  }
}

const ITALIC = '[3m';
const BOLD = '[1m';

test('渲染门控开:_emphasized_ 套 italic(\\x1b[3m)·对齐 CC', () => {
  const out = renderLite('This is _emphasized_ text', '1');
  assert.ok(out.includes('emphasized'), 'body present');
  assert.ok(out.includes(ITALIC), 'italic escape present');
});

test('渲染门控开:__strong__ 套 bold(\\x1b[1m)', () => {
  const out = renderLite('This is __strong__ text', '1');
  assert.ok(out.includes(BOLD), 'bold escape present');
});

test('渲染门控开:snake_case 不被斜体(承重守卫·上屏后无 italic 包裹)', () => {
  const out = renderLite('run some_function_name now', '1');
  assert.ok(out.includes('some_function_name'), 'identifier intact');
  assert.ok(!out.includes(ITALIC), 'no italic around snake_case');
});

test('渲染门控关:_emphasized_ 原样不动(下划线逐字节回退·无 italic)', () => {
  const out = renderLite('This is _emphasized_ text', 'off');
  assert.ok(out.includes('_emphasized_'), 'underscores literal in legacy');
  assert.ok(!out.includes(ITALIC), 'no italic in legacy mode');
});

test('渲染默认门控(无 env)= 开 → italic(对齐 CC)', () => {
  const out = renderLite('a _foo_ b', null);
  assert.ok(out.includes(ITALIC), 'default-on italic');
});

test('渲染:星号强调不受影响(*x*→italic·**x**→bold 仍工作)', () => {
  const it = renderLite('a *foo* b', '1');
  const bd = renderLite('a **foo** b', '1');
  assert.ok(it.includes(ITALIC), 'asterisk italic intact');
  assert.ok(bd.includes(BOLD), 'asterisk bold intact');
});
