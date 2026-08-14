'use strict';

/**
 * imageRecognitionIntent — 「有识图意图但没附图」确定性守卫的单测(node:test)。
 *
 * 回归目标(goal「让 khy 正确识别图片，即使没有模型也能 ocr 兜底」):裸「图片识别」
 * 不再落进 agentic loop 瞎 glob。验证:意图判定保守(不劫持「写个图片识别功能」)、
 * 剪贴板自动取用(Q1)、无图确定性回复(Q2)、门控关字节回退、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/cli/repl/imageRecognitionIntent');

test('looksLikeImageRecognitionRequest:纯识图指令 → true', () => {
  for (const s of [
    '图片识别', '识别图片', '识别一下这张图', '识别这张图片里的文字',
    '识别文字', '提取文字', 'ocr', 'OCR 一下', '图片里的文字',
    'recognize this image', 'read text from image', 'extract text',
  ]) {
    assert.strictEqual(mod.looksLikeImageRecognitionRequest(s), true, s);
  }
});

test('looksLikeImageRecognitionRequest:开发请求 / 无关 / 超长 → false(不劫持)', () => {
  for (const s of [
    '写个图片识别功能',           // 开发请求
    '如何实现图片识别',           // how-to
    '帮我实现一个图片识别组件',   // 组件
    '图片识别 api 怎么接入',      // api / 接入
    '帮我看看这段代码',           // 代码
    '请解释一下事件循环',         // 无关
    '',
    null,
    // 超长(>60 chars)即使含识图词也不拦(更可能是复杂请求)
    '请帮我识别这张图片里的所有文字并翻译成英文再总结成三段话最后给出改进建议以及后续可以怎么优化整个流程谢谢你了',
  ]) {
    assert.strictEqual(mod.looksLikeImageRecognitionRequest(s), false, String(s));
  }
});

test('looksLikeImageRecognitionRequest:能力提问 → false(不劫持自然对话)', () => {
  // 用户实测:自然聊天问「是否/哪些模型支持图像识别」被误当识图请求,弹「未检测到图片」。
  // 这些都是**问能力**而非**命令识别一张图**,必须回退到正常送模型。
  for (const s of [
    'agnes那些模型支持图像识别呢',   // 问哪些模型支持
    '你是多模态模型吗',              // 问是不是多模态
    '哪些模型支持图片识别',          // 问哪些
    '你支持图像识别吗',              // 问是否支持
    '有没有支持图像识别的模型',      // 问有没有
    'which models support image recognition',
    'do you support ocr',
    'are you a multimodal model',
  ]) {
    assert.strictEqual(mod.looksLikeImageRecognitionRequest(s), false, String(s));
  }
});

test('imageIntentGuardEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.imageIntentGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(mod.imageIntentGuardEnabled({ KHY_IMAGE_INTENT_GUARD: off }), false, off);
  }
  assert.strictEqual(mod.imageIntentGuardEnabled({ KHY_IMAGE_INTENT_GUARD: 'on' }), true);
});

test('resolveImageRecognitionAssist:剪贴板有图 → clipboard-image(自动取用·Q1)', () => {
  const fakeSvc = {
    isClipboardImageAvailable: () => true,
    readImageFromClipboard: () => ({ base64: 'AAAA', mimeType: 'image/png' }),
  };
  const r = mod.resolveImageRecognitionAssist('图片识别', { env: {}, imageService: fakeSvc });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.action, 'clipboard-image');
  assert.deepStrictEqual(r.images, [{ base64: 'AAAA', mimeType: 'image/png' }]);
  assert.ok(/识别/.test(r.text), '应带识别提示词');
  assert.ok(/图片识别/.test(r.text), '应保留用户原始请求');
});

test('resolveImageRecognitionAssist:无剪贴板图 → no-image-reply(确定性·Q2·不调模型)', () => {
  const fakeSvc = {
    isClipboardImageAvailable: () => false,
    readImageFromClipboard: () => { throw new Error('should not be called'); },
  };
  const r = mod.resolveImageRecognitionAssist('图片识别', { env: {}, imageService: fakeSvc });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.action, 'no-image-reply');
  assert.ok(/未检测到图片/.test(r.reply));
  assert.ok(/OCR/.test(r.reply), '应提示无模型时用本地 OCR 兜底');
});

test('resolveImageRecognitionAssist:已附图 → handled:false(不介入)', () => {
  const r = mod.resolveImageRecognitionAssist('图片识别', { env: {}, hasImages: true, imageService: {} });
  assert.deepStrictEqual(r, { handled: false });
});

test('resolveImageRecognitionAssist:非识图意图 → handled:false', () => {
  const r = mod.resolveImageRecognitionAssist('写个图片识别功能', { env: {}, imageService: {} });
  assert.deepStrictEqual(r, { handled: false });
});

test('resolveImageRecognitionAssist:门控关 → handled:false(字节回退)', () => {
  const fakeSvc = { isClipboardImageAvailable: () => true, readImageFromClipboard: () => ({ base64: 'AAAA', mimeType: 'image/png' }) };
  const r = mod.resolveImageRecognitionAssist('图片识别', { env: { KHY_IMAGE_INTENT_GUARD: 'off' }, imageService: fakeSvc });
  assert.deepStrictEqual(r, { handled: false });
});

test('resolveImageRecognitionAssist:imageService 抛异常 → no-image-reply(fail-soft·绝不抛)', () => {
  const fakeSvc = {
    isClipboardImageAvailable: () => { throw new Error('clipboard blew up'); },
    readImageFromClipboard: () => { throw new Error('nope'); },
  };
  const r = mod.resolveImageRecognitionAssist('图片识别', { env: {}, imageService: fakeSvc });
  // isClipboardImageAvailable 抛 → hasClip=false → 落无图确定性回复(不抛)。
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.action, 'no-image-reply');
});

test('resolveImageRecognitionAssist:剪贴板读图返回空 → no-image-reply', () => {
  const fakeSvc = {
    isClipboardImageAvailable: () => true,
    readImageFromClipboard: () => null,
  };
  const r = mod.resolveImageRecognitionAssist('识别一下这张图', { env: {}, imageService: fakeSvc });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.action, 'no-image-reply');
});
