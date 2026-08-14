'use strict';

/**
 * bulkLines.test.js — 多行大段输出的单次缓冲写(修「逐行 console.log 刷屏卡顿」)。
 *
 * 现场:多处把 AI 回复/大段动态输出按 `.split('\n').forEach(l => console.log(...))` 逐行
 * 打印 → 千行输出 = 千次同步写 syscall,Windows ConHost 逐次阻塞。本套件锁死:
 *   - 开门(default)→ 单次 process.stdout.write,输出与逐行 console.log 逐字节等价
 *     (含 indent、空文本、尾部换行、多个连续空行);
 *   - 关门(0/false/off/no)→ 逐行 console.log 回退历史行为;
 *   - 绝不抛:null/undefined/数字等非字符串输入按 String(x) 转换(与 console.log 同族)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { isEnabled, printLines } = require('../../src/cli/bulkLines');

// Capture both channels: coalesced path hits process.stdout.write, legacy path
// hits console.log (which itself writes "<args>\n" to stdout).
function capture(fn) {
  const writes = [];
  const logs = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  // Normalize to the byte stream a real terminal would receive.
  const combined = writes.join('') + logs.map((l) => `${l}\n`).join('');
  return { writes, logs, combined };
}

// 历史基准:逐行 console.log(indent + line) 落到终端的字节流。
function legacyBytes(text, indent = '') {
  return String(text).split('\n').map((l) => `${indent}${l}\n`).join('');
}

test('gate default-on / off (0/false/off/no)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_BULK_LINE_WRITE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_BULK_LINE_WRITE: v }), false, v);
  }
});

test('coalesced output is byte-identical to per-line console.log', () => {
  const cases = [
    ['hello\nworld\nfoo', '  '],
    ['single line', '  '],
    ['', '  '],                       // 空文本 → 一个缩进空行
    ['a\n\n\nb', '  '],               // 多个连续空行
    ['trailing newline\n', '  '],     // 尾部换行 → 末尾多一空行
    ['no indent\nsecond', ''],
    ['\n', '    '],                   // 纯换行
  ];
  for (const [text, indent] of cases) {
    const { writes, combined } = capture(() => printLines(text, indent, {}));
    assert.strictEqual(combined, legacyBytes(text, indent), JSON.stringify([text, indent]));
    // 开门路径必须是单次合并写(可能另有 spinner 通知,但正文只 1 次 write)。
    assert.strictEqual(writes.length, 1, `expected exactly one write for ${JSON.stringify(text)}`);
  }
});

test('gate off falls back to per-line console.log (legacy path)', () => {
  const env = { KHY_BULK_LINE_WRITE: '0' };
  const { writes, logs, combined } = capture(() => printLines('a\nb\nc', '  ', env));
  assert.strictEqual(writes.length, 0, 'legacy path must not call process.stdout.write directly');
  assert.deepStrictEqual(logs, ['  a', '  b', '  c']);
  assert.strictEqual(combined, legacyBytes('a\nb\nc', '  '));
});

test('never throws on non-string input; behaves like console.log(String(x))', () => {
  for (const junk of [null, undefined, 42, { a: 1 }, ['x', 'y']]) {
    for (const env of [{}, { KHY_BULK_LINE_WRITE: '0' }]) {
      let out;
      assert.doesNotThrow(() => { out = capture(() => printLines(junk, '  ', env)); });
      assert.strictEqual(out.combined, legacyBytes(junk, '  '), JSON.stringify([String(junk), env]));
    }
  }
});

test('never throws even when stdout.write itself throws (falls back to console.log)', () => {
  const logs = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;
  process.stdout.write = () => { throw new Error('boom'); };
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    assert.doesNotThrow(() => printLines('x\ny', '  ', {}));
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  assert.deepStrictEqual(logs, ['  x', '  y']);
});

test('LIVE wiring: replSession routes AI-reply rendering through the leaf', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cli/replSession.js'),
    'utf8',
  );
  assert.ok(/require\('\.\/bulkLines'\)/.test(src), 'replSession should require the bulkLines leaf');
});
