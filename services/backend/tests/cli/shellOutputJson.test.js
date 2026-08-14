'use strict';

// 验证 shellOutputJson 纯叶子:命令输出里的 JSON 行美化,忠实对齐 CC OutputLine
// 的 tryFormatJson / tryJsonFormatContent(含精度守卫 + MAX_JSON_FORMAT_LENGTH +
// 门控逐字节回退)。
const test = require('node:test');
const assert = require('node:assert');
const {
  formatShellOutputJson,
  tryFormatJsonLine,
  MAX_JSON_FORMAT_LENGTH,
} = require('../../src/cli/shellOutputJson');

const ON = {};
const OFF = { KHY_SHELL_OUTPUT_JSON: '0' };

test('压扁的 JSON 对象 → 2 空格缩进美化(CC parity)', () => {
  assert.strictEqual(
    formatShellOutputJson('{"a":1,"b":[2,3]}', ON),
    '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}'
  );
});

test('压扁的 JSON 数组 → 美化', () => {
  assert.strictEqual(formatShellOutputJson('[1,2,3]', ON), '[\n  1,\n  2,\n  3\n]');
});

test('非 JSON 普通文本行 → 原样不动', () => {
  assert.strictEqual(formatShellOutputJson('命令输出 5 行', ON), '命令输出 5 行');
  assert.strictEqual(formatShellOutputJson('Read 50 lines', ON), 'Read 50 lines');
});

test('多行混合:JSON 行被美化,普通行保持原样', () => {
  const input = 'starting...\n{"ok":true}\ndone';
  assert.strictEqual(
    formatShellOutputJson(input, ON),
    'starting...\n{\n  "ok": true\n}\ndone'
  );
});

test('大整数 round-trip 丢精度 → 原样保留(精度守卫)', () => {
  // 9999999999999999999 超过 Number.MAX_SAFE_INTEGER,parse/stringify 会改写它
  const line = '{"id":9999999999999999999}';
  assert.strictEqual(formatShellOutputJson(line, ON), line);
});

test('1.0 → round-trip 变 1(信息损失)→ 原样保留', () => {
  assert.strictEqual(tryFormatJsonLine('{"x":1.0}'), '{"x":1.0}');
});

test('转义斜杠 \\/ 归一化后仍判等 → 美化', () => {
  assert.strictEqual(
    tryFormatJsonLine('{"u":"a\\/b"}'),
    '{\n  "u": "a/b"\n}'
  );
});

test('原始量(数字/true/null)行:round-trip 等 → 原样(stringify 不变形)', () => {
  assert.strictEqual(tryFormatJsonLine('42'), '42');
  assert.strictEqual(tryFormatJsonLine('true'), 'true');
  assert.strictEqual(tryFormatJsonLine('null'), 'null');
});

test('整段超过 MAX_JSON_FORMAT_LENGTH → 整段原样跳过', () => {
  const big = '{"a":1}' + '\n' + 'x'.repeat(MAX_JSON_FORMAT_LENGTH);
  assert.ok(big.length > MAX_JSON_FORMAT_LENGTH);
  assert.strictEqual(formatShellOutputJson(big, ON), big);
});

test('门控关 KHY_SHELL_OUTPUT_JSON=0 → 逐字节原样回退', () => {
  assert.strictEqual(formatShellOutputJson('{"a":1,"b":[2,3]}', OFF), '{"a":1,"b":[2,3]}');
});

test('门控关 false/off/no 同回退', () => {
  for (const v of ['false', 'off', 'no', 'FALSE', 'Off']) {
    assert.strictEqual(
      formatShellOutputJson('{"a":1}', { KHY_SHELL_OUTPUT_JSON: v }),
      '{"a":1}'
    );
  }
});

test('空串/非字符串 → 原样返回,绝不抛', () => {
  assert.strictEqual(formatShellOutputJson('', ON), '');
  assert.strictEqual(formatShellOutputJson(null, ON), null);
  assert.strictEqual(formatShellOutputJson(undefined, ON), undefined);
  assert.strictEqual(formatShellOutputJson(42, ON), 42);
});

test('tryFormatJsonLine 对非 JSON 绝不抛 → 原样', () => {
  assert.strictEqual(tryFormatJsonLine('not json {['), 'not json {[');
  assert.strictEqual(tryFormatJsonLine(''), '');
});
