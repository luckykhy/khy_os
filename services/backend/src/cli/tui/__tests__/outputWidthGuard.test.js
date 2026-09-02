'use strict';

/**
 * outputWidthGuard 测试 — 行宽守卫(TUI 输出 ≤ 输入框宽度契约)。
 *
 * 契约要点:
 *  1. 纯文本 + SGR 的超宽行按显示宽度(CJK=2)折行,续行首重放已开 SGR;
 *  2. 含非 SGR 转义(CUP/EL/OSC…)或 \r 的写入逐字节放行(ink 帧/进度行不可折);
 *  3. 不超宽的写入逐字节放行(热路径零改动);
 *  4. install 幂等、uninstall 还原、非 TTY / 门控关 → noop。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../runtime/outputWidthGuard');

const ESC = '\x1b';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
// ASCII 度量(测试里避免 formatters 的 CJK 记忆化干扰,显式注入)
const asciiW = (s) => strip(s).length;

test('wrapAnsiLine: 不超宽的纯文本原样返回(同一引用值,零改动)', () => {
  assert.deepStrictEqual(guard.wrapAnsiLine('hello', 80), ['hello']);
});

test('wrapAnsiLine: 超宽 ASCII 按列折行', () => {
  const lines = guard.wrapAnsiLine('a'.repeat(100), 80, asciiW);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].length, 80);
  assert.strictEqual(lines[0] + lines[1], 'a'.repeat(100));
});

test('wrapAnsiLine: CJK 用显示度量时首行占满 cols 列', () => {
  const wide = (s) => strip(s).length * 2; // 每字符 2 列
  const lines = guard.wrapAnsiLine('汉'.repeat(60), 80, wide);
  assert.strictEqual(lines[0].length, 40); // 40 字 × 2 = 80 列
  assert.strictEqual(lines.length, 2);
});

test('wrapAnsiLine: 折行处闭合 SGR,续行首重放(颜色不串行)', () => {
  const line = `${ESC}[31m` + 'r'.repeat(100) + `${ESC}[0m`;
  const lines = guard.wrapAnsiLine(line, 80, asciiW);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], `${ESC}[31m` + 'r'.repeat(80) + `${ESC}[0m`);
  assert.strictEqual(lines[1], `${ESC}[31m` + 'r'.repeat(20) + `${ESC}[0m`);
  // 去掉 ANSI 后内容完整
  assert.strictEqual(strip(lines.join('')), 'r'.repeat(100));
});

test('wrapAnsiLine: SGR reset 清空活跃栈,reset 后折行不再重放', () => {
  const line = `${ESC}[31mred${ESC}[0m` + 'x'.repeat(100);
  const lines = guard.wrapAnsiLine(line, 80, asciiW);
  assert.ok(!lines[1].startsWith(ESC), 'reset 之后不应重放红色');
});

test('wrapAnsiLine: 折点尾随空白被丢弃,续行不以空格开头', () => {
  const line = 'word '.repeat(30); // 150 列,折点落在空格附近
  const lines = guard.wrapAnsiLine(line, 80, asciiW);
  for (const ln of lines) {
    assert.ok(!ln.startsWith(' '));
    assert.ok(asciiW(ln) <= 80);
  }
});

test('clampChunkToWidth: 多行纯文本逐行折,短行保持字节不变', () => {
  const chunk = 'short\n' + 'x'.repeat(100) + '\nalso short';
  const out = guard.clampChunkToWidth(chunk, 80, asciiW);
  assert.strictEqual(out, 'short\n' + 'x'.repeat(80) + '\n' + 'x'.repeat(20) + '\nalso short');
});

test('clampChunkToWidth: 短 chunk 热路径逐字节返回原串', () => {
  const chunk = `${ESC}[32mgreen${ESC}[0m`;
  assert.strictEqual(guard.clampChunkToWidth(chunk, 80, asciiW), chunk);
});

test('clampChunkToWidth: 含光标控制序列(ink 帧/进度行)逐字节放行', () => {
  const frame = `${ESC}[2K${ESC}[G` + 'x'.repeat(200) + `${ESC}[K`;
  assert.strictEqual(guard.clampChunkToWidth(frame, 80, asciiW), frame);
  const cr = '\r  进度 50%...\x1b[K';
  assert.strictEqual(guard.clampChunkToWidth(cr, 80, asciiW), cr);
  const osc = `${ESC}]0;title${ESC}\\` + 'x'.repeat(200);
  assert.strictEqual(guard.clampChunkToWidth(osc, 80, asciiW), osc);
});

function fakeStdout(columns) {
  const writes = [];
  const stream = {
    isTTY: true,
    columns,
    write(fnOrChunk) {
      // 记录最终落到真实层的字节
      writes.push(fnOrChunk);
      return true;
    },
  };
  return { stream, writes };
}

test('install: 超宽纯文本行被折到 columns 内;不超宽字节不变', () => {
  guard._resetForTests();
  const { stream, writes } = fakeStdout(80);
  const realWrite = stream.write;
  const h = guard.install({ stdout: stream, env: {}, measure: asciiW });
  assert.strictEqual(typeof stream.write, 'function');
  assert.notStrictEqual(stream.write, realWrite);

  stream.write('x'.repeat(100) + '\n');
  assert.strictEqual(writes[0], 'x'.repeat(80) + '\n' + 'x'.repeat(20) + '\n');

  stream.write('short line\n');
  assert.strictEqual(writes[1], 'short line\n');

  h.uninstall();
  assert.strictEqual(stream.write, realWrite, 'uninstall 还原原 write');
});

test('install: 非 TTY → noop;门控关 → noop;幂等不叠加', () => {
  guard._resetForTests();
  const pipe = { isTTY: false, columns: 80, write(c) { return c; } };
  const before = pipe.write;
  const h1 = guard.install({ stdout: pipe, env: {}, measure: asciiW });
  assert.strictEqual(pipe.write, before, '非 TTY 不替换 write');
  h1.uninstall();
  assert.strictEqual(pipe.write, before);

  guard._resetForTests();
  const tty = { isTTY: true, columns: 80, write(c) { return c; } };
  const h2 = guard.install({ stdout: tty, env: { KHY_OUTPUT_WIDTH_GUARD: '0' }, measure: asciiW });
  const before2 = tty.write;
  h2.uninstall();
  assert.strictEqual(tty.write, before2);

  // 幂等:第二次 install 不叠加(还原一次即回到原生)
  guard._resetForTests();
  const tty3 = { isTTY: true, columns: 80, write(c) { return c; } };
  const native = tty3.write;
  const a = guard.install({ stdout: tty3, env: {}, measure: asciiW });
  const b = guard.install({ stdout: tty3, env: {}, measure: asciiW });
  b.uninstall();
  a.uninstall();
  assert.strictEqual(tty3.write, native);
});

test('install: Buffer 输入也能折行;守卫自身异常不阻断输出', () => {
  guard._resetForTests();
  const { stream, writes } = fakeStdout(80);
  const h = guard.install({ stdout: stream, env: {}, measure: asciiW });
  stream.write(Buffer.from('y'.repeat(100), 'utf8'));
  assert.ok(writes[0].includes('y'.repeat(80)));
  h.uninstall();
});
