'use strict';

/**
 * inlineImageOcrGuardPolicy.test.js — 「消息含图片路径但无附件 → 注入禁 DIY-OCR 护栏」
 * 决策纯叶子单测。守护(goal 2026-06-28「识别图片 / 修复识别图片问题」):
 *   1. 门控 KHY_INLINE_IMAGE_OCR_GUARD 默认开 / 显式 0/false/off/no 关闭即字节回退(恒 null)
 *   2. 消息含图片路径 + 无图片附件 → 返回护栏指令(含禁 python/tesseract DIY-OCR 措辞)
 *   3. 含图片路径但已带附件 → null(图已附上,既有视觉/OCR 路由接手,无需护栏)
 *   4. 不含图片路径(普通对话/非图片路径)→ null(零误触)
 *   5. fail-soft:畸形输入不抛
 */

const test = require('node:test');
const assert = require('node:assert');

const guard = require('../src/services/gateway/inlineImageOcrGuardPolicy');

const WIN_PNG = String.raw`"C:\Users\25789\.khy\clipboard-img2file\screenshot_20260628_073653_203.png"识别图片`;
const POSIX_PNG = '/home/user/pics/diagram.png 看看这张图';

// ── 1. 门控 ──────────────────────────────────────────────────────────────────
test('门控默认开(未设 env)', () => {
  assert.strictEqual(guard.isEnabled({}), true);
  assert.strictEqual(guard.isEnabled({ KHY_INLINE_IMAGE_OCR_GUARD: 'true' }), true);
});

test('仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(guard.isEnabled({ KHY_INLINE_IMAGE_OCR_GUARD: v }), false, `env=${v}`);
  }
});

test('关闭后 buildInlineImageOcrGuardDirective 恒 null(字节回退,不注入)', () => {
  const r = guard.buildInlineImageOcrGuardDirective({
    message: WIN_PNG,
    hasAttachedImage: false,
    env: { KHY_INLINE_IMAGE_OCR_GUARD: 'off' },
  });
  assert.strictEqual(r, null);
});

// ── 2. messageHasImagePath 检出 ───────────────────────────────────────────────
test('检出带引号 Windows 图片路径', () => {
  assert.strictEqual(guard.messageHasImagePath(WIN_PNG), true);
});

test('检出 POSIX 图片路径', () => {
  assert.strictEqual(guard.messageHasImagePath(POSIX_PNG), true);
});

test('普通对话无图片路径 → false', () => {
  assert.strictEqual(guard.messageHasImagePath('帮我写一个快速排序'), false);
  assert.strictEqual(guard.messageHasImagePath('看看 /etc/hosts 这个文件'), false); // 非图片扩展名
});

// ── 3. 含路径 + 无附件 → 返回护栏指令 ─────────────────────────────────────────
test('含图片路径且无附件 → 返回禁 DIY-OCR 护栏指令', () => {
  const r = guard.buildInlineImageOcrGuardDirective({ message: WIN_PNG, hasAttachedImage: false });
  assert.ok(typeof r === 'string' && r.length > 0);
  assert.ok(r.includes(guard.GUARD_NOTE_MARKER));
  // 必须明确禁止自己跑 python/tesseract OCR
  assert.match(r, /python/);
  assert.match(r, /tesseract/);
  assert.match(r, /khy gateway model/);
});

// ── 4. 含路径但已带附件 → null（图已附上，无需护栏）──────────────────────────
test('含图片路径但已带附件 → null', () => {
  const r = guard.buildInlineImageOcrGuardDirective({ message: WIN_PNG, hasAttachedImage: true });
  assert.strictEqual(r, null);
});

// ── 5. 无路径 → null（零误触）─────────────────────────────────────────────────
test('普通对话(无图片路径)→ null', () => {
  assert.strictEqual(
    guard.buildInlineImageOcrGuardDirective({ message: '解释一下事件循环', hasAttachedImage: false }),
    null
  );
});

// ── 6. fail-soft：畸形输入不抛 ────────────────────────────────────────────────
test('畸形输入不抛、返回 null', () => {
  assert.strictEqual(guard.buildInlineImageOcrGuardDirective(), null);
  assert.strictEqual(guard.buildInlineImageOcrGuardDirective({}), null);
  assert.strictEqual(guard.buildInlineImageOcrGuardDirective({ message: null }), null);
  assert.strictEqual(guard.messageHasImagePath(undefined), false);
  assert.strictEqual(guard.messageHasImagePath(12345), false);
});
