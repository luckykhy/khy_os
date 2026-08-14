'use strict';

/**
 * tui.inlineImageSubmit.test.js — TUI 提交期「打字粘本地图片路径 → 图片附件」补齐
 * (goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐,两处对齐」)回归。
 * 守护:
 *   1. 门控 KHY_TUI_INLINE_IMAGE_PATH 默认开:含本地图片路径 → 复用 REPL 同一 SSOT
 *      (extractInlineImageIntent + imageService.readImageFromFile)转成 images 附件,
 *      并把路径从 text 剥成提示词(与 repl.js:5003-5022 一致)。
 *   2. 门控关 → text 原样、images 空(逐字节回退,不提取)。
 *   3. 普通对话(无图片路径)→ 不动、零误触。
 *   4. 读图失败(路径不存在)→ text 原样、images 空、不抛(parity repl.js:5020)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInlineImageSubmit, isEnabled } = require('../src/cli/tui/inlineImageSubmit');

// 最小合法 PNG(1x1 透明像素),让 imageService 的魔数/格式校验通过。
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let tmpPng = '';
test.before(() => {
  tmpPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tui-img-')), 'shot.png');
  fs.writeFileSync(tmpPng, PNG_1x1);
});

test('门控默认开:含图片路径 → 附图 + 剥路径成提示', () => {
  const { text, images } = resolveInlineImageSubmit(`"${tmpPng}"识别图片`, { env: {} });
  assert.strictEqual(images.length, 1);
  assert.ok(images[0].base64 && images[0].mimeType === 'image/png');
  // 路径被剥掉,prompt 由 imageIntent 上下文构造给出(非空、不含原始路径)。
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(!text.includes(tmpPng));
});

test('门控关:逐字节回退(不提取,路径留在 text,images 空)', () => {
  const msg = `"${tmpPng}"识别图片`;
  const { text, images } = resolveInlineImageSubmit(msg, { env: { KHY_TUI_INLINE_IMAGE_PATH: 'off' } });
  assert.strictEqual(images.length, 0);
  assert.strictEqual(text, msg);
});

test('普通对话(无图片路径)→ 不动', () => {
  const { text, images } = resolveInlineImageSubmit('帮我写个快排', { env: {} });
  assert.strictEqual(images.length, 0);
  assert.strictEqual(text, '帮我写个快排');
});

test('图片路径不存在 → 保留原文、不抛(parity repl.js:5020)', () => {
  const msg = String.raw`"C:\nope\missing.png"识别图片`;
  const { text, images } = resolveInlineImageSubmit(msg, { env: {} });
  assert.strictEqual(images.length, 0);
  assert.strictEqual(text, msg);
});

test('门控判定:仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(isEnabled({ KHY_TUI_INLINE_IMAGE_PATH: v }), false, `env=${v}`);
  }
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_TUI_INLINE_IMAGE_PATH: 'true' }), true);
});

test('畸形输入不抛', () => {
  assert.deepStrictEqual(resolveInlineImageSubmit(undefined, { env: {} }), { text: '', images: [] });
  assert.deepStrictEqual(resolveInlineImageSubmit(null, { env: {} }), { text: '', images: [] });
});
