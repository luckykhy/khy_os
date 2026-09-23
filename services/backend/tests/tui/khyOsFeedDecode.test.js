'use strict';

/**
 * khyOsFeedDecode.test.js — KHY OS 内核终端覆盖层的「分块边界」守卫(BUG-49 / BUG-49b)。
 *
 * 缺陷本体:`KhyOsRunner` 把 QEMU 的 serial **TCP chunk** 原样 `emit('data', buf)`
 * (`platform/packages/shared/src/runtime/khyos/KhyOsRunner.js:416-420`),而覆盖层原先写
 * `feed(scr, buf.toString('utf-8'))` —— **每块各自解码**。一个三字节汉字跨块到达时两半各成
 * 一个 U+FFFD;四字节 astral 字符跨块则留下**孤立代理对**(探针实测屏上是 `ab\ud83dXY`)。
 * 同一条边界还劈转义序列:`ESC[3` 与 `2m` 分属两块时，屏上留下字面 "[32m"(BUG-49b)。
 * 分片边界由不得宿主:内核输出多长、QEMU 何时 flush 都不可控。
 *
 * 这里锁的是「喂进去任意切法的字节,屏幕上必须是原字/无痕」。
 * 纯模型测试,不挂 ink(普通 jest 即可跑)。
 */

const path = require('path');

process.env.KHY_TUI_PREWARM = '0';

const { makeScreen, feed } = require(path.join(
  '..',
  '..',
  'src',
  'cli',
  'tui',
  'ink-components',
  'KhyOsView.js'
)).__probe;

const B = (s) => Buffer.from(s, 'utf-8');
const REPLACEMENT = '\uFFFD';

function chunks(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

function collect(bufs) {
  const scr = makeScreen();
  for (const b of bufs) feed(scr, b);
  return scr.lines.join('\n');
}

function countOf(s, needle) {
  let n = 0;
  for (const ch of s) if (ch === needle) n += 1;
  return n;
}

function countLoneSurrogate(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const nx = s.charCodeAt(i + 1);
      if (!(nx >= 0xdc00 && nx <= 0xdfff)) n += 1;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      n += 1;
    }
  }
  return n;
}

const CN = '内核已启动：中文输出正常 OK';

describe('KhyOsView 串口行模型(BUG-49)', () => {
  test('中文逐字节投递:屏幕上是原句,一个替换符都不留', () => {
    const line = collect(chunks(B(`${CN}\n`), 1));
    expect(line).toBe(`${CN}\n`);
    expect(countOf(line, REPLACEMENT)).toBe(0);
  });

  test('与 3 字节不整除的块宽(4/5/7)同样完整', () => {
    for (const size of [4, 5, 7]) {
      const line = collect(chunks(B(CN), size));
      expect(line).toBe(CN);
      expect(countOf(line, REPLACEMENT)).toBe(0);
    }
  });

  test('emoji 被劈在任意两半之间:代理对必须完整', () => {
    const buf = B('启动 🚀 完成');
    for (let at = 1; at < buf.length; at += 1) {
      const line = collect([buf.subarray(0, at), buf.subarray(at)]);
      expect(countLoneSurrogate(line)).toBe(0);
      expect(line).toBe('启动 🚀 完成');
    }
  });

  test('退格逐码点回退,不会退进代理对中间', () => {
    const buf = B('ab🚀c\n');
    const head = buf.subarray(0, buf.indexOf(0x63) + 1); // 'ab🚀c'
    for (let at = 1; at < head.length; at += 1) {
      const scr = makeScreen();
      feed(scr, head.subarray(0, at));
      feed(scr, head.subarray(at));
      feed(scr, B('\b \b\b \b'));
      expect(countLoneSurrogate(scr.lines[0])).toBe(0);
      // "\b \b" 抹掉一格后留一个空格(控制台语义),两半 = 'ab' + 两个空格。
      expect(scr.lines[0]).toBe('ab  ');
      expect(scr.col).toBe(2);
    }
  });

  test('行内编辑(\\r 与 \\b \\b)在含 emoji 的行上仍然按格改写', () => {
    // 内核 shell.c:335-339 退格发 "\b \b";宿主按码点一格,不退半截代理对。
    const line = collect([B('ab🚀c\b \b\b \bXY\n')]);
    expect(countLoneSurrogate(line)).toBe(0);
    expect(line).toBe('abXY\n');
  });

  test('行内编辑在含中文的行上按格改写', () => {
    expect(collect([B('abcd中\b \b\b \bXY\n')])).toBe('abcXY\n');
  });

  test('负对照:纯 ASCII 任意切法与整块投递逐字节相同', () => {
    const buf = B('boot ok 123\n[SHELL] type help\n');
    const whole = collect([buf]);
    expect(whole).toBe('boot ok 123\n[SHELL] type help\n');
    for (const size of [1, 2, 3, 11]) {
      expect(collect(chunks(buf, size))).toBe(whole);
    }
  });

  test('仍接受字符串入参(feed 的旧契约,未接解码器的调用方不破)', () => {
    const scr = makeScreen();
    feed(scr, 'khy> 中文\n');
    expect(scr.lines[0]).toBe('khy> 中文');
  });

  test('超过 MAX_ROWS 仍裁剪环且 row 不越界', () => {
    const scr = makeScreen();
    feed(scr, B('x\n'.repeat(260)));
    expect(scr.lines.length).toBeLessThanOrEqual(200);
    expect(scr.row).toBe(scr.lines.length - 1);
    expect(typeof scr.lines[scr.row]).toBe('string');
  });
});

describe('KhyOsView 跨块的转义序列(BUG-49b)', () => {
  const ESC = String.fromCharCode(27);
  const SEQ = B(`ok ${ESC}[32mgo\n`);
  const WHOLE = 'ok go';

  test('任意切点都必须与整块投递同结果', () => {
    expect(collect([SEQ])).toBe(`${WHOLE}\n`);
    for (let at = 1; at < SEQ.length; at += 1) {
      const line = collect([SEQ.subarray(0, at), SEQ.subarray(at)]);
      expect(line).toBe(`${WHOLE}\n`);
      expect(line).not.toContain(ESC);
      expect(line).not.toContain('[32m');
    }
  });

  test('劈成三块(ESC / [3 / 2mgo)同样无痕', () => {
    expect(collect([B(ESC), B('[3'), B(`2m${WHOLE}\n`)])).toBe(`${WHOLE}\n`);
  });

  test('2 字符转义 ESC= 跨块也不留残片', () => {
    expect(collect([B(`a${ESC}`), B('=b\n')])).toBe('ab\n');
  });

  test('永不完结的前缀不得吞掉后续正文', () => {
    // 半截序列后面直接来正文：按 ANSI，ESC [ 3 h 本身是一条合法的 MODE SET 序列，
    // 被吃掉的是它的 final byte（这里恰好是正文首字符），其余必须照常上屏。
    const line = collect([B('A'), B(`${ESC}[3`), B('hello\n')]);
    expect(line.startsWith('A')).toBe(true);
    expect(line).toBe('Aello\n');
  });

  test('前缀过长(> MAX_HELD_SEQ)时放弃等待并落盘', () => {
    const scr = makeScreen();
    feed(scr, B(`${ESC}[${'9'.repeat(80)}`));
    expect(scr.pending).toBe('');
    expect(scr.lines[0].length).toBeGreaterThan(0);
  });
});
