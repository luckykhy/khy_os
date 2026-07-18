'use strict';

/**
 * imageOcrTruncationWiring.test.js — 端到端锁定「OCR 兜底单图内文本完整性诚实告诫」这条**接线**:
 * 当注入给纯文本模型的某张图片 OCR 文本因长度上限被截断(只保留前一部分、尾部丢弃)时,最终 prompt
 * 必须带一句诚实的截断告诫,别让模型把残缺文本当完整依据。
 *
 * 背景(/goal 2026-07-12,与低置信告诫、覆盖率告诫两条接线正交):
 * gateway 三处 OCR 注入点都用 `extractImageOcrDetails(images,{maxChars:1200})` 提取,单张稠密图
 * 全文超 1200 字符被截断,此前只在文本里留内嵌英文 `...[truncated]` 标记、从不作为结构化 truncated
 * 信号离开。本测试驱动**真实** generate() 走 ocr-fallback 接线,用 DI 桩把明细的 truncated 标志解耦,
 * 确定性触发截断告诫,钉死它确实注入最终 prompt。
 *
 * 手法:与 imageOcrCoverageWiring 同款自包含 harness(记录型 adapter + DI 注入),独立单例改写不外溢。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这些图片里的信息', model: 'text-only-model', tag: 'ocrtrunc' });

const imgs = (n) => Array.from({ length: n }, () => ({ base64: 'ZmFrZQ==', mimeType: 'image/png' }));

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true });
  h.wireSingle(rec);
}

// DI:返回 count 条明细,前 truncCount 条标 truncated:true(模拟稠密图被 maxChars 截断)。
function _details(count, truncCount) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      text: `图片${i + 1}文本 金额 ${100 + i}`,
      confidence: 90,
      needsAiFallback: false,
      truncated: i < truncCount,
    });
  }
  return out;
}

describe('OCR 兜底截断诚实告诫接线(纯文本模型 + 稠密图 + 无视觉候选)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('有截断:发 2 张、其中 1 张文本被截断 → 注入截断告诫(桥闭合:残缺不再无声)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _details(2, 1),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(2) });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本应注入');
    assert.match(rec.finalPrompt || '', /其中 1\/2 张/, '应披露 1/2 张被截断');
    assert.match(rec.finalPrompt || '', /因长度上限被截断/, '应带截断诚实告诫');
  });

  test('无截断:发 2 张、均未截断 → 绝不注入截断告诫(无误报,逐字节回退)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _details(2, 0),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(2) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本仍注入');
    assert.doesNotMatch(rec.finalPrompt || '', /因长度上限被截断/, '未截断不得触发告诫');
  });

  test('门关(KHY_OCR_TRUNCATION_NOTICE=off):即便有截断也不注入(逐字节回退)', async () => {
    const saved = process.env.KHY_OCR_TRUNCATION_NOTICE;
    process.env.KHY_OCR_TRUNCATION_NOTICE = 'off';
    try {
      genLeaf.setAiGatewayGenerateMethodDeps({
        extractImageOcrDetails: () => _details(2, 1),
        collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
      });
      wire();

      const res = await runner.run({ images: imgs(2) });

      assert.equal(res.success, true);
      assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本仍注入');
      assert.doesNotMatch(rec.finalPrompt || '', /因长度上限被截断/, '门关应逐字节回退,无截断告诫');
    } finally {
      if (saved === undefined) delete process.env.KHY_OCR_TRUNCATION_NOTICE;
      else process.env.KHY_OCR_TRUNCATION_NOTICE = saved;
    }
  });
});
