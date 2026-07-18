'use strict';

/**
 * truncateDisplayWidthBudget.test.js — 按显示宽度截断的省略号预算(修「截断溢出列宽」)。
 *
 * 现场:toolDisplay._truncateDisplayWidth 把内容填到恰好 limit 列再接 `...` → 总宽 limit+3,
 * 溢出调用方列预算。本套件锁死:
 *   - 开门(default)→ 截断后总显示宽度 ≤ limit,且以 `...` 结尾;整串 ≤ limit 时原样(不加省略号);
 *   - 关门(0/false/off/no)→ 逐字节回退历史行为(填满 limit 再溢出接 `...`,总宽 = limit+3);
 *   - CJK 宽字符按 2 列计;极端窄列(limit<3)不硬塞会越界的省略号。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  truncateWidth,
  ELLIPSIS_WIDTH,
} = require('../../src/cli/truncateDisplayWidthBudget');

// 测试用显示宽度:ASCII/半角=1,CJK 及全角=2(与 formatters.displayWidth 同族的够用近似)。
function widthOf(ch) {
  const cp = ch.codePointAt(0);
  // 常见 CJK / 全角区段按 2 列;其余按 1。
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function totalWidth(s) {
  let w = 0;
  for (const ch of Array.from(s)) w += widthOf(ch);
  return w;
}

test('gate default-on / off (0/false/off/no)', () => {
  assert.strictEqual(isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_TRUNCATE_WIDTH_BUDGET: v }), false, v);
  }
});

test('BUG FIX (default-on): truncated width never exceeds the limit, ends with ...', () => {
  const src = 'the quick brown fox jumps over the lazy dog';
  const limit = 20;
  const out = truncateWidth(src, limit, widthOf, {});
  assert.ok(out.endsWith('...'), `expected trailing ellipsis, got ${JSON.stringify(out)}`);
  assert.ok(totalWidth(out) <= limit, `width ${totalWidth(out)} must be <= ${limit}`);
  // 内容部分正好填到 limit-3。
  assert.strictEqual(totalWidth(out.slice(0, -ELLIPSIS_WIDTH)), limit - ELLIPSIS_WIDTH);
});

test('legacy (gate off) DID overflow by ellipsis width — pins the bug it fixes', () => {
  const off = { KHY_TRUNCATE_WIDTH_BUDGET: '0' };
  const src = 'the quick brown fox jumps over the lazy dog';
  const limit = 20;
  const out = truncateWidth(src, limit, widthOf, off);
  assert.ok(out.endsWith('...'));
  // 历史:内容填满 limit,再接 3 列省略号 → 总宽 limit+3。
  assert.strictEqual(totalWidth(out), limit + ELLIPSIS_WIDTH);
  assert.strictEqual(totalWidth(out.slice(0, -ELLIPSIS_WIDTH)), limit);
});

test('exact fit / shorter → returned as-is, no ellipsis (both branches)', () => {
  for (const env of [{}, { KHY_TRUNCATE_WIDTH_BUDGET: '0' }]) {
    assert.strictEqual(truncateWidth('hello', 5, widthOf, env), 'hello', JSON.stringify(env));
    assert.strictEqual(truncateWidth('hi', 10, widthOf, env), 'hi', JSON.stringify(env));
  }
});

test('CJK full-width chars counted as 2 columns (default-on)', () => {
  // 每个汉字 2 列。limit=10 → 预算 7 列 → 放得下 3 个汉字(6 列)+ `...`(3 列)= 9 ≤ 10。
  const out = truncateWidth('你好世界朋友', 10, widthOf, {});
  assert.ok(out.endsWith('...'));
  assert.ok(totalWidth(out) <= 10, `width ${totalWidth(out)} must be <= 10`);
  assert.strictEqual(out, '你好世...');
});

test('degenerate narrow limits never overflow (default-on)', () => {
  // limit=3 → 预算 0,一个字符都放不进 → 省略号自身正好 3 列 ≤ 3。
  assert.strictEqual(truncateWidth('abcdef', 3, widthOf, {}), '...');
  // limit<3 → 宁可返回空串也不硬塞越界省略号。
  assert.strictEqual(truncateWidth('abcdef', 2, widthOf, {}), '');
  assert.strictEqual(truncateWidth('abcdef', 1, widthOf, {}), '');
});

test('never throws on junk widthOf / input', () => {
  assert.doesNotThrow(() => truncateWidth('abc', 5, null, {}));
  assert.doesNotThrow(() => truncateWidth(null, 5, widthOf, {}));
  assert.doesNotThrow(() => truncateWidth('abc', 5, () => { throw new Error('boom'); }, {}));
});

test('LIVE wiring: toolDisplay._truncateDisplayWidth routes through the leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cli/toolDisplay.js'),
    'utf8',
  );
  assert.ok(
    /require\('\.\/truncateDisplayWidthBudget'\)/.test(src),
    'toolDisplay should require the budget leaf',
  );
});
