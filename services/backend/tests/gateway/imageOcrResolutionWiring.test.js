'use strict';

/**
 * imageOcrResolutionWiring.test.js — 端到端锁定「低分辨率图片自动放大诚实告诫」这条**接线**:
 * 当某图的 OCR 明细带 upscaledFactor>1(docHelper 已把低分辨率图放大后才识别成功)时,最终 prompt
 * 必须带一句诚实告诫,让纯文本模型知道文本取自被自动放大的低分辨率图像。
 *
 * 背景(/goal 2026-07-12,第六条正交轴、第二条「纠正型」,与准确性/覆盖率/截断/语言包四条「披露型」
 * 及方向轴正交,直击「没有识图模型下准确识别图片」尤其分辨率过低的小图):gateway 三处 OCR 注入点的
 * 明细现携带 upscaledFactor。本测试驱动真实 generate() 走 ocr-fallback 接线,用 DI 桩把 upscaledFactor=2
 * 解耦注入,确定性触发。
 *
 * 手法:与 imageOcrOrientationWiring 同款自包含 harness(记录型 adapter + DI 注入),独立单例改写不外溢。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这些图片里的信息', model: 'text-only-model', tag: 'ocrres' });

const imgs = (n) => Array.from({ length: n }, () => ({ base64: 'ZmFrZQ==', mimeType: 'image/png' }));

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true });
  h.wireSingle(rec);
}

// DI:一条明细,upscaledFactor=放大倍数(>1 表示 docHelper 已放大后才识别成功)。
function _detail(upscaledFactor) {
  return [{
    text: '图片文本 金额 100',
    confidence: 90,
    needsAiFallback: false,
    truncated: false,
    lang: 'eng',
    requestedLang: 'eng',
    orientationCorrected: 0,
    upscaledFactor,
  }];
}

describe('OCR 兜底低分辨率自动放大诚实告诫接线(纯文本模型 + 小图放大 + 无视觉候选)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('低分辨率图被放大:upscaledFactor=2 → 注入放大诚实告诫(桥闭合:放大事实不再无声)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail(2),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本应注入');
    assert.match(rec.finalPrompt || '', /自动放大/, '应带放大诚实告诫');
    assert.match(rec.finalPrompt || '', /2×/, '应指名放大倍数 2×');
  });

  test('未放大:upscaledFactor=0 → 绝不注入告诫(无误报,逐字节回退)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail(0),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
    assert.doesNotMatch(rec.finalPrompt || '', /自动放大/, '未放大不得触发告诫');
  });

  test('门关(KHY_OCR_UPSCALE=off):即便明细带 upscaledFactor 也不注入(逐字节回退)', async () => {
    const saved = process.env.KHY_OCR_UPSCALE;
    process.env.KHY_OCR_UPSCALE = 'off';
    try {
      genLeaf.setAiGatewayGenerateMethodDeps({
        extractImageOcrDetails: () => _detail(2),
        collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
      });
      wire();

      const res = await runner.run({ images: imgs(1) });

      assert.equal(res.success, true);
      assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
      assert.doesNotMatch(rec.finalPrompt || '', /自动放大/, '门关应逐字节回退,无放大告诫');
    } finally {
      if (saved === undefined) delete process.env.KHY_OCR_UPSCALE;
      else process.env.KHY_OCR_UPSCALE = saved;
    }
  });
});
