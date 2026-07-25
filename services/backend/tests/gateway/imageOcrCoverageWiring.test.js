'use strict';

/**
 * imageOcrCoverageWiring.test.js — 端到端锁定「OCR 兜底覆盖率诚实告诫」这条**接线**:
 * 当注入给纯文本模型的 OCR 文本并未覆盖全部输入图片(超单次上限被丢 / 部分图片读不出)时,
 * 最终 prompt 必须带一句诚实的覆盖率告诫,别让模型默认已看到所有图片。
 *
 * 背景(/goal 2026-07-12,与低置信告诫 imageOcrFallbackWiring ①b 正交):
 * gateway 三处 OCR 注入点都用 `extractImageOcrDetails(images,{maxImages:3})` 提取,
 * `images.slice(0,3)` 会静默丢弃第 4 张起 → 用户发 5 张、模型只拿到 3 张文本却以为是全部。
 * 本测试驱动**真实** generate() 走 ocr-fallback 接线,用 DI 桩把「输入图片总数」与「提取到文字
 * 的图片数」解耦,确定性地触发 omitted / unreadable 两类覆盖缺口,钉死告诫确实注入最终 prompt。
 *
 * 手法:与 imageOcrFallbackWiring 同款自包含 harness(记录型 adapter + DI 注入),但本文件独立
 * 单例改写不外溢。totalImages 由 run 发送的真实 images 数决定;ocrTextCount 由 DI 的
 * extractImageOcrDetails 返回条数决定 —— 二者解耦即可精确构造覆盖缺口,无需真实 tesseract。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这些图片里的信息', model: 'text-only-model', tag: 'ocrcov' });

// 发送 n 张图片(内容无关紧要,真实 OCR 被 DI 桩取代;数量才是本测试的关键)。
const imgs = (n) => Array.from({ length: n }, () => ({ base64: 'ZmFrZQ==', mimeType: 'image/png' }));

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true });
  h.wireSingle(rec);
}

// DI:返回 count 条「有文字」的 OCR 明细(模拟 maxImages 截断后仅 count 张产出文本)。
function _detailsWithText(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ text: `图片${i + 1}文本 金额 ${100 + i}`, confidence: 90, needsAiFallback: false });
  }
  return out;
}

describe('OCR 兜底覆盖率诚实告诫接线(纯文本模型 + 多图 + 无视觉候选)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('超单次上限:发 5 张、仅 3 张有文本 → 注入 omitted 覆盖告诫(桥闭合:被丢的图不再无声)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detailsWithText(3), // 模拟 slice(0,3) 后 3 张有文字
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(5) });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本应注入');
    assert.match(rec.finalPrompt || '', /共 5 张/, '应披露输入总数 5');
    assert.match(rec.finalPrompt || '', /另有 2 张未做识别/, '应披露被丢弃的 2 张');
    assert.match(rec.finalPrompt || '', /并未覆盖全部图片/, '应带覆盖率诚实告诫');
  });

  test('部分读不出:发 3 张、仅 2 张有文本 → 注入 unreadable 覆盖告诫', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detailsWithText(2), // 3 张里 1 张读不出
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(3) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /1 张图片未能提取到文字/, '应披露 1 张读不出');
    assert.doesNotMatch(rec.finalPrompt || '', /未做识别/, '未超上限 → 无 omitted 段');
  });

  test('干净单图:发 1 张、1 张有文本 → 绝不注入覆盖告诫(无误报,逐字节回退)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detailsWithText(1),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本仍注入');
    assert.doesNotMatch(rec.finalPrompt || '', /并未覆盖全部图片/, '干净单图不得触发覆盖告诫');
  });

  test('门关(KHY_OCR_COVERAGE_NOTICE=off):即便超上限也不注入(逐字节回退)', async () => {
    const saved = process.env.KHY_OCR_COVERAGE_NOTICE;
    process.env.KHY_OCR_COVERAGE_NOTICE = 'off';
    try {
      genLeaf.setAiGatewayGenerateMethodDeps({
        extractImageOcrDetails: () => _detailsWithText(3),
        collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
      });
      wire();

      const res = await runner.run({ images: imgs(5) });

      assert.equal(res.success, true);
      assert.match(rec.finalPrompt || '', /图片1文本/, 'OCR 文本仍注入');
      assert.doesNotMatch(rec.finalPrompt || '', /并未覆盖全部图片/, '门关应逐字节回退,无覆盖告诫');
    } finally {
      if (saved === undefined) delete process.env.KHY_OCR_COVERAGE_NOTICE;
      else process.env.KHY_OCR_COVERAGE_NOTICE = saved;
    }
  });
});
