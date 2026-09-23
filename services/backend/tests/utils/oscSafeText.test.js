'use strict';

/**
 * oscSafeText.test.js — toOscSafeText 是窗口标题 OSC 载荷的唯一清洗出口。
 *
 * 两条契约:
 *  1. 安全(BUG-33):定界符 BEL/ESC 与任何 C0/DEL/C1 控制字符绝不留存 ——
 *     否则载荷会开出第二条独立 OSC(实测可注入 OSC 52 剪贴板写入)。
 *  2. 无残片(BUG-115):转义序列必须**整段**吞掉。若 CSI 参数字节认得窄了
 *     (`[0-9;?]` 而非 ECMA-48 的 `[0-9:;<=>?]`),冒号 truecolor SGR 与私有
 *     参数序列会留下 `[38:2:...m` / `[>c` 之类的可见残片 —— 正是本模块立誓
 *     要防的「乱码」,也正是 wrapCell/formatters 同轮放宽的那一处。
 */

const { toOscSafeText } = require('../../src/utils/oscSafeText');

const E = String.fromCharCode(27); // ESC
const BEL = String.fromCharCode(7);

// 清洗后不得残留任何 C0 / DEL / C1 控制字符(定界符与越权入口都在此列)。
const CTRL = /[\u0000-\u001f\u007f-\u009f]/;

describe('toOscSafeText — 安全:定界符与控制字符零留存(BUG-33)', () => {
  test('主题里的 BEL 不留存,不再开出第二条 OSC', () => {
    const out = toOscSafeText('标题' + BEL + 'pwned');
    expect(out).toBe('标题pwned');
    expect(CTRL.test(out)).toBe(false);
  });

  test('OSC 52 剪贴板注入载荷被彻底中和', () => {
    const out = toOscSafeText('t' + BEL + E + ']52;c;ZXhmaWx0cmF0ZWQ=' + BEL + 'link');
    expect(out).toBe('tlink');
    expect(out).not.toMatch(/\]52;/);
    expect(CTRL.test(out)).toBe(false);
  });

  test('ST(ESC \\)不能提前终结,也不留存 ESC', () => {
    const out = toOscSafeText('A' + E + '\\' + 'B' + E + ']1;假标题');
    expect(CTRL.test(out)).toBe(false);
    expect(out).not.toMatch(/\]1;/);
  });

  test('裸 C1(8-bit CSI/OSC)与 DEL 一并清除', () => {
    expect(CTRL.test(toOscSafeText('x\u009by\u007fz'))).toBe(false);
  });
});

describe('toOscSafeText — 无残片:转义序列整段吞掉(BUG-115)', () => {
  test('冒号 truecolor SGR 不留 `[38:2:...m` 可见残片', () => {
    expect(toOscSafeText('a' + E + '[38:2:255:128:0mbc')).toBe('abc');
  });

  test('私有参数 CSI(`ESC [ > c`)不留 `[>c` 残片', () => {
    expect(toOscSafeText('ab' + E + '[>ccd')).toBe('abcd');
  });

  test('ESC-中间字节派发(`ESC ( B`)不留 `(B` 残片', () => {
    expect(toOscSafeText('ab' + E + '(Bcd')).toBe('abcd');
  });

  test('基础 SGR(`ESC [ 31m`)不留 `[31m` 残片', () => {
    expect(toOscSafeText('a' + E + '[31mbc')).toBe('abc');
  });
});

describe('toOscSafeText — 正常文本逐字节不变(清洗不顺手改坏)', () => {
  test('可读标题、emoji、斜杠/问号原样保留', () => {
    for (const s of ['修复登录 bug', 'AST parser', '🍀 混合 emoji 标题', 'a/b? c=d']) {
      expect(toOscSafeText(s)).toBe(s);
    }
  });

  test('换行/制表等 C0 空白折成单空格,不粘连也不留控制字符', () => {
    expect(toOscSafeText('第一行\n第二行')).toBe('第一行 第二行');
    expect(toOscSafeText('a\t\tb')).toBe('a b');
  });

  test('braille 空白 U+2800 是刻意装饰,不当乱码清掉', () => {
    expect(toOscSafeText('标题\u2800续')).toBe('标题\u2800续');
  });

  test('nullish 安全、绝不抛', () => {
    expect(toOscSafeText(null)).toBe('');
    expect(toOscSafeText(undefined)).toBe('');
    expect(() => toOscSafeText({})).not.toThrow();
  });
});
