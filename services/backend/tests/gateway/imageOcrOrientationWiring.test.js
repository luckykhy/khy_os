'use strict';

/**
 * imageOcrOrientationWiring.test.js — 端到端锁定「图片方向自动校正诚实告诫」这条**接线**:
 * 当某图的 OCR 明细带 orientationCorrected>0(docHelper 已把旋转图旋正后才识别成功)时,最终
 * prompt 必须带一句诚实告诫,让纯文本模型知道文本取自被自动旋正的图像、而非原图方向。
 *
 * 背景(/goal 2026-07-12,第五条「纠正型」轴,与准确性/覆盖率/截断/语言包四条「披露型」正交,直击
 * 「没有识图模型下准确识别图片」尤其被旋转的图):gateway 三处 OCR 注入点的明细现携带 orientationCorrected。
 * 本测试驱动真实 generate() 走 ocr-fallback 接线,用 DI 桩把 orientationCorrected=90 解耦注入,确定性触发。
 *
 * 手法:与 imageOcrLanguageWiring 同款自包含 harness(记录型 adapter + DI 注入),独立单例改写不外溢。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这些图片里的信息', model: 'text-only-model', tag: 'ocrorient' });

const imgs = (n) => Array.from({ length: n }, () => ({ base64: 'ZmFrZQ==', mimeType: 'image/png' }));

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true });
  h.wireSingle(rec);
}

// DI:一条明细,orientationCorrected=旋正角度(>0 表示 docHelper 已旋正后才识别成功)。
function _detail(orientationCorrected) {
  return [{
    text: '图片文本 金额 100',
    confidence: 90,
    needsAiFallback: false,
    truncated: false,
    lang: 'eng',
    requestedLang: 'eng',
    orientationCorrected,
  }];
}

describe('OCR 兜底方向自动校正诚实告诫接线(纯文本模型 + 旋转图旋正 + 无视觉候选)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('旋转图被旋正:orientationCorrected=90 → 注入方向校正告诫(桥闭合:旋正事实不再无声)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail(90),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本应注入');
    assert.match(rec.finalPrompt || '', /旋转校正/, '应带方向校正告诫');
    assert.match(rec.finalPrompt || '', /90°/, '应指名旋正角度 90°');
  });

  test('未旋正:orientationCorrected=0 → 绝不注入告诫(无误报,逐字节回退)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail(0),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
    assert.doesNotMatch(rec.finalPrompt || '', /旋转校正/, '未旋正不得触发告诫');
  });

  test('门关(KHY_OCR_AUTO_ORIENT=off):即便明细带 orientationCorrected 也不注入(逐字节回退)', async () => {
    const saved = process.env.KHY_OCR_AUTO_ORIENT;
    process.env.KHY_OCR_AUTO_ORIENT = 'off';
    try {
      genLeaf.setAiGatewayGenerateMethodDeps({
        extractImageOcrDetails: () => _detail(90),
        collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
      });
      wire();

      const res = await runner.run({ images: imgs(1) });

      assert.equal(res.success, true);
      assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
      assert.doesNotMatch(rec.finalPrompt || '', /旋转校正/, '门关应逐字节回退,无方向告诫');
    } finally {
      if (saved === undefined) delete process.env.KHY_OCR_AUTO_ORIENT;
      else process.env.KHY_OCR_AUTO_ORIENT = saved;
    }
  });
});
