'use strict';
/**
 * ansiSanitizer.test.js — 锁 cli/ansiSanitizer 的「完整控制序列覆盖」口径。
 *
 * 病灶背景（[DESIGN-ARCH-128]，证据 .khy/feedback/structured-output-20260922/）：
 * 旧路径只用 CONTROL_CHARS 剥 0x1B，留下可见的 CSI 参数（`[1m`）。屏幕因此出现
 * `1m`，且该参数破坏紧随下划线的 CommonMark 左侧接条件 → `_…_` 强调不成立 →
 * 下划线裸上屏。两条症状是同一个病。
 */
const { stripAnsiSequences, hasAnsiSequences } = require('../src/cli/ansiSanitizer');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('ansiSanitizer', () => {
  describe('CSI 全覆盖（旧 stripAnsi 只认纯数字 SGR）', () => {
    test('纯数字参数 SGR', () => {
      expect(stripAnsiSequences('\x1b[0m正常\x1b[1m粗体\x1b[22m')).toBe('正常粗体');
    });

    test('分号分隔真彩 SGR 38;5;n', () => {
      expect(stripAnsiSequences('温度 \x1b[38;5;213m25°C\x1b[39m')).toBe('温度 25°C');
    });

    test('冒号分隔真彩 SGR 38:2::r:g:b（旧 body 漏剥）', () => {
      expect(stripAnsiSequences('\x1b[38:2:255:0:0m红\x1b[0m')).toBe('红');
    });

    test('光标私有模式 ?25l / ?25h（旧 body 漏剥）', () => {
      expect(stripAnsiSequences('\x1b[?25l隐藏\x1b[?25h')).toBe('隐藏');
    });

    test('清屏 2J（旧 body 漏剥）', () => {
      expect(stripAnsiSequences('\x1b[2J清屏')).toBe('清屏');
    });

    test('光标移动 2A（旧 body 漏剥）', () => {
      expect(stripAnsiSequences('abc\x1b[2Adef')).toBe('abcdef');
    });
  });

  describe('ESC 短序列（ECMA-48 nF/Fs 形，含中间符）', () => {
    test('ESC#6 DEC 双宽', () => {
      expect(stripAnsiSequences('\x1b#6大标题')).toBe('大标题');
    });

    test('ESC( B 字符集选择', () => {
      expect(stripAnsiSequences('\x1b(B文本')).toBe('文本');
    });

    test('ESC 7 / ESC 8 存取光标', () => {
      expect(stripAnsiSequences('\x1b7a\x1b8b')).toBe('ab');
    });
  });

  describe('OSC 与 DCS', () => {
    test('OSC 超链接（BEL 终止）', () => {
      expect(stripAnsiSequences('\x1b]8;;http://x\x07链接\x1b]8;;\x07')).toBe('链接');
    });

    test('OSC 窗口标题（ST 终止）必须先于两字节规则', () => {
      expect(stripAnsiSequences('\x1b]0;标题\x1b\\正文')).toBe('正文');
    });

    test('DCS 设备控制串', () => {
      expect(stripAnsiSequences('\x1bP1;2|ignored\x1b\\可见')).toBe('可见');
    });
  });

  describe('保留正文与换行', () => {
    test('保留 \\n 与 \\t', () => {
      expect(stripAnsiSequences('a\nb\tc')).toBe('a\nb\tc');
    });

    test('不动任何可见字符', () => {
      const s = '普通中文 with English & 符号 [] {} # 1m-like text';
      expect(stripAnsiSequences(s)).toBe(s);
    });

    test('裸控制字符被清（保留 \\n \\t）', () => {
      expect(stripAnsiSequences('a\x00b\x07c\x7fd\n')).toBe('abcd\n');
    });

    test('零宽字符被清', () => {
      expect(stripAnsiSequences('a\u200bb\ufeffc')).toBe('abc');
    });
  });

  describe('契约：纯叶子、绝不抛', () => {
    test('空串原样', () => {
      expect(stripAnsiSequences('')).toBe('');
    });

    test('非字符串原样返回（不抛）', () => {
      expect(stripAnsiSequences(null)).toBeNull();
      expect(stripAnsiSequences(undefined)).toBeUndefined();
      expect(stripAnsiSequences(42)).toBe(42);
    });

    test('幂等：剥两次等于剥一次', () => {
      const s = '\x1b[1m_a_\x1b[0m\n\x1b[?25l_b_';
      const once = stripAnsiSequences(s);
      expect(stripAnsiSequences(once)).toBe(once);
    });
  });

  describe('回归：截图病灶（ESC 残留破坏下划线强调配对）', () => {
    test('剥净后不再残留可见的 `1m` / `[1m`', () => {
      const poisoned = '\x1b[1m_1m曲靖实况与预报（9月22日）_\x1b[0m';
      const fixed = stripAnsiSequences(poisoned);
      expect(fixed).not.toMatch(/\x1b/);
      expect(fixed).not.toMatch(/\[1m/);
      expect(fixed).not.toMatch(/\[0m/);
      // 下划线定界符保留给下游 Markdown 渲染器处理（本模块只管控制序列）
      expect(fixed).toBe('_1m曲靖实况与预报（9月22日）_');
    });

    test('hasAnsiSequences 正确判定', () => {
      expect(hasAnsiSequences('\x1b[1mX')).toBe(true);
      expect(hasAnsiSequences('裸控制\x00')).toBe(true);
      expect(hasAnsiSequences('干净文本')).toBe(false);
      expect(hasAnsiSequences('')).toBe(false);
    });
  });
});
