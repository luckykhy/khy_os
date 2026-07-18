'use strict';

/**
 * inlineOptionParse.test.js — `--key=value` 内联选项解析(修「router 丢掉等号选项的值」)。
 *
 * 现场:router.parseInput 只认空格分隔 `--key value`,对 `--out=x` 落 options['out=x']=true,
 * 真正的值 x 被丢。本套件锁死叶子语义 + router E2E 接线:
 *   - 开门(default)→ `--out=x` → options.out === 'x'(且不吞下一个 token);
 *   - 关门(0/false/off/no)→ 逐字节回退:options['out=x'] === true;
 *   - 只按第一个等号切;`--=x` 畸形回退;真正的空格分隔 `--out x` 与布尔 `--verbose` 不受影响。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, parseInlineOption } = require('../../src/cli/inlineOptionParse');
const { parseInput } = require('../../src/cli/router');

test('gate default-on / off (0/false/off/no)', () => {
  assert.strictEqual(isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_INLINE_OPTION_PARSE: v }), false, v);
  }
});

test('leaf: splits on the FIRST equals only (default-on)', () => {
  assert.deepStrictEqual(parseInlineOption('out=report.md', {}), {
    inline: true, key: 'out', value: 'report.md',
  });
  // 值里再含等号 → 全部归 value。
  assert.deepStrictEqual(parseInlineOption('filter=a=b', {}), {
    inline: true, key: 'filter', value: 'a=b',
  });
  // 空值形式 `--out=` → value 为空串。
  assert.deepStrictEqual(parseInlineOption('out=', {}), { inline: true, key: 'out', value: '' });
});

test('leaf: no-equals / degenerate `=x` / gate-off → inline:false with raw key', () => {
  assert.deepStrictEqual(parseInlineOption('verbose', {}), { inline: false, key: 'verbose' });
  // 等号在位置 0(`--=x`)→ 交回历史分支。
  assert.deepStrictEqual(parseInlineOption('=x', {}), { inline: false, key: '=x' });
  // 关门 → 即便有等号也不切。
  assert.deepStrictEqual(parseInlineOption('out=x', { KHY_INLINE_OPTION_PARSE: '0' }), {
    inline: false, key: 'out=x',
  });
});

test('leaf never throws on junk input', () => {
  assert.doesNotThrow(() => parseInlineOption(null, {}));
  assert.doesNotThrow(() => parseInlineOption(undefined, null));
});

test('E2E router.parseInput: `--out=x` captures the value (default-on)', () => {
  delete process.env.KHY_INLINE_OPTION_PARSE;
  const parsed = parseInput('/export --out=report.md --scope=user');
  assert.strictEqual(parsed.options.out, 'report.md');
  assert.strictEqual(parsed.options.scope, 'user');
  // 畸形的等号键不应再出现。
  assert.strictEqual(parsed.options['out=report.md'], undefined);
});

test('E2E router.parseInput: gate-off byte-reverts to legacy malformed key', () => {
  process.env.KHY_INLINE_OPTION_PARSE = '0';
  try {
    const parsed = parseInput('/export --out=report.md');
    assert.strictEqual(parsed.options['out=report.md'], true);
    assert.strictEqual(parsed.options.out, undefined);
  } finally {
    delete process.env.KHY_INLINE_OPTION_PARSE;
  }
});

test('E2E router.parseInput: space form and boolean flags unaffected (default-on)', () => {
  delete process.env.KHY_INLINE_OPTION_PARSE;
  const parsed = parseInput('/export --out report.md --verbose');
  assert.strictEqual(parsed.options.out, 'report.md'); // 空格分隔仍工作
  assert.strictEqual(parsed.options.verbose, true); // 布尔标志仍工作
});

test('LIVE wiring: router requires the inline-option leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cli/router.js'),
    'utf8',
  );
  assert.ok(/require\('\.\/inlineOptionParse'\)/.test(src), 'router should require the leaf');
});
