'use strict';
/**
 * tui.inlineImageSubmit.test.js �?TUI 提交期「打字粘本地图片路径 �?图片附件」补�?
 * (goal 2026-06-28「我只要�?TUI,REPL 有�?TUI 没有的功能要补齐,两处对齐�?回归�?
 * 守护:
 *   1. 门控 KHY_TUI_INLINE_IMAGE_PATH 默认开:含本地图片路�?�?复用 REPL 同一 SSOT
 *      (extractInlineImageIntent + imageService.readImageFromFile)转成 images 附件,
 *      并把路径�?text 剥成提示�?�?repl.js:5003-5022 一�?�?
 *   2. 门控�?�?text 原样、images �?逐字节回退,不提�?�?
 *   3. 普通对�?无图片路�?�?不动、零误触�?
 *   4. 读图失败(路径不存�?�?text 原样、images 空、不�?parity repl.js:5020)�?
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInlineImageSubmit, isEnabled } = require('../src/cli/tui/inlineImageSubmit');
// 最小合�?PNG(1x1 透明像素),�?imageService 的魔�?格式校验通过�?
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
let tmpPng = '';
test.before(() => {
  tmpPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tui-img-')), 'shot.png');
  fs.writeFileSync(tmpPng, PNG_1x1);
});

describe('Tui inline Image Submit', () => {
  test('门控默认开:含图片路�?�?附图 + 剥路径成提示', () => {
      const { text, images } = resolveInlineImageSubmit(`"${tmpPng}"识别图片`, { env: {} });
      expect(images.length).toBe(1);
      expect(images[0].base64 && images[0].mimeType === 'image/png').toBeTruthy();
      // 路径被剥�?prompt �?imageIntent 上下文构造给�?非空、不含原始路�?�?
      expect(typeof text === 'string' && text.length > 0).toBeTruthy();
      expect(!text).toContain(tmpPng);
  });

  test('门控�?逐字节回退(不提�?路径留在 text,images �?', () => {
      const msg = `"${tmpPng}"识别图片`;
      const { text, images } = resolveInlineImageSubmit(msg, { env: { KHY_TUI_INLINE_IMAGE_PATH: 'off' } });
      expect(images.length).toBe(0);
      expect(text).toBe(msg);
  });

  test('普通对�?无图片路�?�?不动', () => {
      const { text, images } = resolveInlineImageSubmit('帮我写个快排', { env: {} });
      expect(images.length).toBe(0);
      expect(text).toBe('帮我写个快排');
  });

  test('图片路径不存�?�?保留原文、不�?parity repl.js:5020)', () => {
      const msg = String.raw`"C:\nope\missing.png"识别图片`;
      const { text, images } = resolveInlineImageSubmit(msg, { env: {} });
      expect(images.length).toBe(0);
      expect(text).toBe(msg);
  });

  test('门控判定:仅显�?0/false/off/no 关闭', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
        expect(isEnabled({ KHY_TUI_INLINE_IMAGE_PATH: v })).toBe(false, `env=${v}`);
      }
      expect(isEnabled({})).toBe(true);
      expect(isEnabled({ KHY_TUI_INLINE_IMAGE_PATH: 'true' })).toBe(true);
  });

  test('畸形输入不抛', () => {
      expect(resolveInlineImageSubmit(undefined).toEqual({ env: {} }), { text: '', images: [] });
      expect(resolveInlineImageSubmit(null).toEqual({ env: {} }), { text: '', images: [] });
  });

});

