'use strict';

/**
 * aiManagementServer.inlineImagePath.test.js — web/协作通道 chat 入口的「打字粘本地图片
 * 路径 → 图片附件」补齐(Layer 1)集成回归。守护(goal 2026-06-28「识别图片」):
 *   1. 门控 KHY_WEB_INLINE_IMAGE_PATH 开:消息含本地图片路径 → 复用 REPL 同一 SSOT
 *      (extractInlineImageIntent + imageService.readImageFromFile)转成 images 附件,
 *      并把路径从 message 剥成纯提示(与 repl.js:5007 一致)。
 *   2. 门控关 → message/images 与上传解析后逐字节相同(不提取,字节回退)。
 *   3. 非图片路径(.txt)/普通对话 → 不动(零误触)。
 *   4. 读图失败(路径不存在)→ message 保留原文、不抛(parity with repl.js:5020)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __test__ } = require('../src/services/aiManagementServer');
const { _resolveChatAttachments } = __test__;

// 最小合法 PNG(1x1 透明像素),让 imageService.readImageFromFile 的魔数/格式校验通过。
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let tmpPng = '';
test.before(() => {
  tmpPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-inline-img-')), 'shot.png');
  fs.writeFileSync(tmpPng, PNG_1x1);
});

function withEnv(value, fn) {
  const prev = process.env.KHY_WEB_INLINE_IMAGE_PATH;
  if (value === undefined) delete process.env.KHY_WEB_INLINE_IMAGE_PATH;
  else process.env.KHY_WEB_INLINE_IMAGE_PATH = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_WEB_INLINE_IMAGE_PATH;
    else process.env.KHY_WEB_INLINE_IMAGE_PATH = prev;
  }
}

test('门控默认开:含图片路径 → 附图 + 剥路径成提示', () => {
  withEnv(undefined, () => {
    const msg = `"${tmpPng}"识别图片`;
    const { message, images } = _resolveChatAttachments({}, msg);
    assert.strictEqual(images.length, 1);
    assert.ok(images[0].base64 && images[0].mimeType === 'image/png');
    assert.strictEqual(message, '识别图片'); // 路径被剥掉
  });
});

test('门控关:逐字节回退(不提取,路径留在 message,images 空)', () => {
  withEnv('off', () => {
    const msg = `"${tmpPng}"识别图片`;
    const { message, images } = _resolveChatAttachments({}, msg);
    assert.strictEqual(images.length, 0);
    assert.strictEqual(message, msg); // 原文不动
  });
});

test('普通对话(无图片路径)→ 不动', () => {
  withEnv(undefined, () => {
    const { message, images } = _resolveChatAttachments({}, '帮我写个快排');
    assert.strictEqual(images.length, 0);
    assert.strictEqual(message, '帮我写个快排');
  });
});

test('图片路径不存在 → 保留原文、不抛(parity repl.js:5020)', () => {
  withEnv(undefined, () => {
    const msg = String.raw`"C:\nope\missing.png"识别图片`;
    const { message, images } = _resolveChatAttachments({}, msg);
    assert.strictEqual(images.length, 0);
    assert.strictEqual(message, msg);
  });
});

test('门控判定:仅显式 0/false/off/no 关闭', () => {
  const { _isWebInlineImagePathEnabled } = __test__;
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    withEnv(v, () => assert.strictEqual(_isWebInlineImagePathEnabled(), false, `env=${v}`));
  }
  withEnv(undefined, () => assert.strictEqual(_isWebInlineImagePathEnabled(), true));
  withEnv('true', () => assert.strictEqual(_isWebInlineImagePathEnabled(), true));
});
