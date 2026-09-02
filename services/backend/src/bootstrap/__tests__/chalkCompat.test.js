'use strict';

/**
 * chalkCompat 回归测试 — 守护「picocolors 上的 chalk 链式 API」这一单一契约。
 *
 * 历史 bug:兼容垫片的 Proxy get 陷阱从不查自有属性,导致 `chain.hex(color)`
 * 被当普通样式合成 —— 色值被当成文本把链调用掉,返回字符串,再调文本时抛
 * "c().bold.hex(...) is not a function"。markdownRenderer 全部链式样式因此
 * 静默抛错,上层 fail-soft 回退裸文本 → 用户看到裸 `**` 与不渲染的管道表格。
 */

const { test } = require('node:test');
const assert = require('node:assert');

// 安装 require 缓存补丁(install 幂等);之后 require('picocolors') 拿到兼容版。
require('../chalkCompat');
const pc = require('picocolors');

test('bold.hex(color) 返回可调用链,颜色码正确嵌入(历史崩溃点)', () => {
  const chain = pc.bold.hex('#E5C07B');
  assert.strictEqual(typeof chain, 'function');
  const out = chain('x');
  assert.ok(out.includes('\x1b[1m'), 'bold open');
  assert.ok(out.includes('\x1b[38;2;229;192;123m'), 'truecolor open');
  assert.ok(out.endsWith('\x1b[39m'), 'fg close emitted as full CSI sequence');
});

test('bgAnsi256 / bgHex / ansi256 色板对(代码块底色等在用)', () => {
  assert.match(pc.bgAnsi256(237)('x'), /\x1b\[48;5;237mx\x1b\[49m/);
  assert.match(pc.ansi256(39)('x'), /\x1b\[38;5;39mx\x1b\[39m/);
  assert.match(pc.bgHex('#123456')('x'), /\x1b\[48;2;18;52;86mx\x1b\[49m/);
});

test('深层链 bgCyan.black.bold 不抛且三种样式全部生效', () => {
  const out = pc.bgCyan.black.bold('t');
  assert.ok(out.includes('\x1b[46m'), 'bg open');
  assert.ok(out.includes('\x1b[30m'), 'fg open');
  assert.ok(out.includes('\x1b[1m'), 'bold open');
  assert.ok(out.endsWith('\x1b[49m\x1b[39m\x1b[22m'), 'closes in reverse application order');
});

test('扁平样式与原生 picocolors 等价', () => {
  assert.match(pc.cyan('x'), /\x1b\[36mx\x1b\[39m/);
  assert.match(pc.bold('x'), /\x1b\[1mx\x1b\[22m/);
  assert.match(pc.dim('x'), /\x1b\[2mx\x1b\[22m/);
});

test('未知样式属性 → noop 链,绝不抛', () => {
  assert.strictEqual(pc.definitelyNotAStyle('x'), 'x');
  assert.strictEqual(typeof pc.definitelyNotAStyle.bold, 'function');
});

test('非法色值保留既有样式(不清链)', () => {
  const out = pc.bold.hex('#nope')('t');
  assert.ok(out.includes('\x1b[1m'));
  assert.ok(!out.includes('38;2;'));
});

test('isColorSupported 以布尔透传', () => {
  assert.strictEqual(typeof pc.isColorSupported, 'boolean');
});
