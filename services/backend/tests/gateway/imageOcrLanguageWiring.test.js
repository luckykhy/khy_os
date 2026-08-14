'use strict';

/**
 * imageOcrLanguageWiring.test.js — 端到端锁定「OCR 语言包可用性诚实告诫」这条**接线**:
 * 当 khy 请求的 OCR 语言在本机缺包被窄化(明细里 requestedLang 含、而 lang 不含某语言)时,
 * 最终 prompt 必须带一句诚实告诫,别让文本模型把英文模型对中文图的乱码转写当权威。
 *
 * 背景(/goal 2026-07-12,与低置信/覆盖率/截断三条接线正交,直击「没有识图模型下准确识别图片」):
 * gateway 三处 OCR 注入点提取的明细现携带 lang(生效)+ requestedLang(原始请求)。本测试驱动真实
 * generate() 走 ocr-fallback 接线,用 DI 桩把 requestedLang!=lang(丢弃 jpn)解耦注入,确定性触发告诫。
 *
 * 手法:与 imageOcrTruncationWiring 同款自包含 harness(记录型 adapter + DI 注入),独立单例改写不外溢。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这些图片里的信息', model: 'text-only-model', tag: 'ocrlang' });

const imgs = (n) => Array.from({ length: n }, () => ({ base64: 'ZmFrZQ==', mimeType: 'image/png' }));

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true });
  h.wireSingle(rec);
}

// DI:一条明细,lang=生效语言,requestedLang=原始请求(含未装语言时二者不同)。
function _detail(requestedLang, lang) {
  return [{
    text: '图片文本 金额 100',
    confidence: 90,
    needsAiFallback: false,
    truncated: false,
    lang,
    requestedLang,
  }];
}

describe('OCR 兜底语言包可用性诚实告诫接线(纯文本模型 + 缺语言包 + 无视觉候选)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('语言被窄化:请求 jpn+eng、生效仅 eng → 注入语言包缺失告诫(桥闭合:被吞语言不再无声)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail('jpn+eng', 'eng'),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本应注入');
    assert.match(rec.finalPrompt || '', /未安装以下 OCR 语言包/, '应带语言包缺失告诫');
    assert.match(rec.finalPrompt || '', /jpn/, '应指名被丢弃的 jpn');
  });

  test('无窄化:请求==生效(chi_sim+eng 都装)→ 绝不注入告诫(无误报,逐字节回退)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _detail('chi_sim+eng', 'chi_sim+eng'),
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run({ images: imgs(1) });

    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
    assert.doesNotMatch(rec.finalPrompt || '', /未安装以下 OCR 语言包/, '无窄化不得触发告诫');
  });

  test('门关(KHY_OCR_LANGUAGE_NOTICE=off):即便被窄化也不注入(逐字节回退)', async () => {
    const saved = process.env.KHY_OCR_LANGUAGE_NOTICE;
    process.env.KHY_OCR_LANGUAGE_NOTICE = 'off';
    try {
      genLeaf.setAiGatewayGenerateMethodDeps({
        extractImageOcrDetails: () => _detail('jpn+eng', 'eng'),
        collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
      });
      wire();

      const res = await runner.run({ images: imgs(1) });

      assert.equal(res.success, true);
      assert.match(rec.finalPrompt || '', /图片文本/, 'OCR 文本仍注入');
      assert.doesNotMatch(rec.finalPrompt || '', /未安装以下 OCR 语言包/, '门关应逐字节回退,无语言告诫');
    } finally {
      if (saved === undefined) delete process.env.KHY_OCR_LANGUAGE_NOTICE;
      else process.env.KHY_OCR_LANGUAGE_NOTICE = saved;
    }
  });
});
