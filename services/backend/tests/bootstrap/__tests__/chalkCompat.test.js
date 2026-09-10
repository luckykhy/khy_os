'use strict';
/**
 * chalkCompat 回归测试 �?守护「picocolors 上的 chalk 链式 API」这一单一契约�? *
 * 历史 bug:兼容垫片�?Proxy get 陷阱从不查自有属�?导致 `chain.hex(color)`
 * 被当普通样式合�?—�?色值被当成文本把链调用�?返回字符�?再调文本时抛
 * "c().bold.hex(...) is not a function"。markdownRenderer 全部链式样式因此
 * 静默抛错,上层 fail-soft 回退裸文�?�?用户看到�?`**` 与不渲染的管道表格�? */
// 安装 require 缓存补丁(install 幂等);之后 require('picocolors') 拿到兼容版�?require('../chalkCompat');
const pc = require('picocolors');

describe('Chalk Compat', () => {
  test('bold.hex(color) 返回可调用链,颜色码正确嵌�?历史崩溃�?', () => {
      const chain = pc.bold.hex('#E5C07B');
      expect(typeof chain).toBe('function');
      const out = chain('x');
      expect(out.includes('\x1b[1m')).toBeTruthy();
      expect(out.includes('\x1b[38;2;229;192;123m')).toBeTruthy();
      expect(out.endsWith('\x1b[39m')).toBeTruthy();
  });

  test('bgAnsi256 / bgHex / ansi256 色板�?代码块底色等在用)', () => {
      expect(pc.bgAnsi256(237)('x')).toBe(/\x1b\[48;5;237mx\x1b\[49m/);
      expect(pc.ansi256(39)('x')).toBe(/\x1b\[38;5;39mx\x1b\[39m/);
      expect(pc.bgHex('#123456')('x')).toBe(/\x1b\[48;2;18;52;86mx\x1b\[49m/);
  });

  test('深层�?bgCyan.black.bold 不抛且三种样式全部生�?, () => {
      const out = pc.bgCyan.black.bold('t');
      expect(out.includes('\x1b[46m')).toBeTruthy();
      expect(out.includes('\x1b[30m')).toBeTruthy();
      expect(out.includes('\x1b[1m')).toBeTruthy();
      expect(out.endsWith('\x1b[49m\x1b[39m\x1b[22m')).toBeTruthy();
  });

  test('扁平样式与原�?picocolors 等价', () => {
      expect(pc.cyan('x')).toBe(/\x1b\[36mx\x1b\[39m/);
      expect(pc.bold('x')).toBe(/\x1b\[1mx\x1b\[22m/);
      expect(pc.dim('x')).toBe(/\x1b\[2mx\x1b\[22m/);
  });

  test('未知样式属�?�?noop �?绝不�?, () => {
      expect(pc.definitelyNotAStyle('x')).toBe('x');
      expect(typeof pc.definitelyNotAStyle.bold).toBe('function');
  });

  test('非法色值保留既有样�?不清�?', () => {
      const out = pc.bold.hex('#nope')('t');
      expect(out).toContain('\x1b[1m');
      expect(!out).toContain('38;2;');
  });

  test('isColorSupported 以布尔透传', () => {
      expect(typeof pc.isColorSupported).toBe('boolean');
  });

});

