'use strict';

/**
 * starEmphasisFlanking.test.js — 行内斜体星号侧接守卫(修「斜体正则吞正文星号」)。
 *
 * 现场:markdownRenderer 历史正则 /(?<!\*)\*([^*\n]+)\*(?!\*)/g 忽略 CommonMark 侧接,
 * 一行正文里成对、两侧带空格的星号(算式 `a * b * c`)被误当斜体定界:渲染吃成斜体、
 * 剥星路径把字面星号删掉。本套件锁死:
 *   - 开门(default)→ 带空白侧接的假定界不再命中;真斜体 `*italic*`、词内 `a*b*c` 仍命中;
 *   - 关门(KHY_STAR_EMPHASIS_FLANKING=0)→ 逐字节回退历史正则(仍命中假定界,记录 legacy)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  starEmphasisEnabled,
  italicStarRegex,
  RE_FLANKING,
  RE_LEGACY,
} = require('../../src/cli/starEmphasisFlanking');

// helper:用当前正则做「剥星」变换(等价 markdownRenderer 表格宽度计算的 .replace(re,'$1'))。
function strip(text, env) {
  return String(text).replace(italicStarRegex(env), '$1');
}

test('gate default-on → returns the flanking-aware regex', () => {
  assert.strictEqual(starEmphasisEnabled({}), true);
  assert.strictEqual(italicStarRegex({}), RE_FLANKING);
});

test('gate off (0/false/off/no) → byte-reverts to the legacy regex', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(starEmphasisEnabled({ KHY_STAR_EMPHASIS_FLANKING: v }), false, v);
    assert.strictEqual(italicStarRegex({ KHY_STAR_EMPHASIS_FLANKING: v }), RE_LEGACY, v);
  }
});

test('BUG FIX: spaced asterisks in prose are no longer eaten (default-on)', () => {
  // 算式:两侧带空格的星号不构成 emphasis → 字面星号必须保留。
  assert.strictEqual(strip('area = a * b * c', {}), 'area = a * b * c');
  assert.strictEqual(strip('see * footnote * here', {}), 'see * footnote * here');
  // 乘法链:三个 factor 两个星号都不该被剥。
  assert.strictEqual(strip('x * y * z * w', {}), 'x * y * z * w');
});

test('legacy behaviour (gate off) DID corrupt the same prose — pins the bug it fixes', () => {
  const off = { KHY_STAR_EMPHASIS_FLANKING: '0' };
  // 历史正则把 `* b *` 当斜体定界并剥掉字面星号 → 内容失真(这正是被修复的行为)。
  assert.strictEqual(strip('area = a * b * c', off), 'area = a  b  c');
});

test('real italic still renders under the flanking regex (no over-correction)', () => {
  assert.strictEqual(strip('*italic*', {}), 'italic');
  assert.strictEqual(strip('an *emphasized* word', {}), 'an emphasized word');
  // 内文含空格但两端非空白 → 合法斜体,仍命中。
  assert.strictEqual(strip('*two words*', {}), 'two words');
});

test('intraword asterisks still emphasise (CommonMark allows them; no word-boundary guard)', () => {
  // 词内星号:`foo*bar*baz` → CommonMark 视 bar 为斜体。剥星后 foo bar baz 连写。
  assert.strictEqual(strip('foo*bar*baz', {}), 'foobarbaz');
});

test('adjacent-asterisk guard preserved: bold delimiters are not treated as italic', () => {
  // `**x**` 的相邻星号(实际由上游 bold 规则先处理)在斜体正则里不该命中。
  assert.strictEqual(strip('**x**', {}), '**x**');
});

test('never throws on junk env / input', () => {
  assert.doesNotThrow(() => italicStarRegex(null));
  assert.doesNotThrow(() => italicStarRegex(undefined));
  assert.doesNotThrow(() => strip('', {}));
});

test('LIVE wiring: markdownRenderer routes its 5 italic sites through the leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cli/markdownRenderer.js'),
    'utf8',
  );
  // 5 处 call-site 都改为经 italicStarRegex(process.env),历史字面正则应已清零。
  const wired = (src.match(/italicStarRegex\(process\.env\)/g) || []).length;
  assert.strictEqual(wired, 5, `expected 5 wired sites, found ${wired}`);
  assert.ok(!/\(\?<!\\\*\)\\\*\(\[\^\*\\n\]\+\)/.test(src), 'legacy literal regex should be gone');
});
