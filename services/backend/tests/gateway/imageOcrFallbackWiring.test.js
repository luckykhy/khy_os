'use strict';

/**
 * imageOcrFallbackWiring.test.js — 端到端锁定「纯文本模型 + 图片输入 + 无可用视觉模型
 * → 落到本地 OCR 兜底」这条**接线**(而非纯决策)。
 *
 * 背景(/goal 2026-07-11):当运行模型不识图(纯文本/非多模态)、且识图模型不可用时,
 * khy 必须正确兜底,把图里的信息提取出来给原文本模型作答——绝不能把裸图丢给读不懂它的
 * 模型、也绝不能静默丢弃用户的图。
 *
 * 决策单一真源 gateway/visionRouting.decideVisionRouting 已有 25 例纯叶子覆盖;但真正把
 * 「剥图 + 注入 OCR 文本」执行出来的是 aiGatewayGenerateMethod.generate 里的接线,此前
 * 无任何集成测试锁定它——一次对该 3000+ 行 god-file 的重构可能在所有叶子测试全绿的情况下
 * 悄悄弄断这条兜底。本测试驱动**真实** generate() 走完整条链,钉死三个关键不变量:
 *
 *   ① 当前 provider 无任何视觉候选  → ocr-fallback:剥图 + 注入「当前模型不支持视觉…」OCR 块。
 *   ② 有视觉候选但**不可达**(404/无 key)→ describe 级联穷尽 → 失败说明 + 剥图 + OCR 兜底。
 *   ③ 视觉不可达且 OCR 取不到文字 → 剥图 + 注入诚实「收到图但读不出」说明(绝不静默)。
 *
 * 三者共有的最强不变量:**非视觉模型永不收到裸图**(adapter 收到的 options.images 必为空)。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

// 关掉会额外发起 adapter 调用/改变路由的旁路门,保留 OCR 兜底主路径默认行为。
const env = h.envSandbox(['KHY_TOOL_CAP_PROBE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FALLBACK_MODEL']);
const runner = h.makeRunner({ prompt: '请识别这张图片里的信息', model: 'text-only-model', tag: 'ocrfb' });

let rec;
function wire({ describeFails = false } = {}) {
  rec = h.makeRecordingAdapter({ content: '已据识别文本作答', captureImages: true, describe: true, describeFails });
  h.wireSingle(rec);
}

describe('image → OCR fallback wiring (text-only model, vision unavailable)', () => {
  before(() => {
    env.save();
    env.set({ KHY_TOOL_CAP_PROBE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_FALLBACK_MODEL: '' });
  });

  after(() => env.restore());

  test('① 无视觉候选 → 剥图 + 注入 OCR 文本,原文本模型据此作答', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [{ text: '发票金额 ¥1234.56 日期 2026-07-11', confidence: 92, needsAiFallback: false }],
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run();

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /1234\.56/, 'OCR 文本应注入 prompt');
    assert.match(rec.finalPrompt || '', /不支持视觉|OCR/, '应带有兜底说明');
    assert.doesNotMatch(rec.finalPrompt || '', /置信度较低/, '高置信 OCR 不应触发低置信告诫');
  });

  test('①b 低置信 OCR(needsAiFallback)→ 注入文本 + 追加诚实低置信告诫,绝不当铁定事实', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [{ text: '模糊的发票 88.20', confidence: 41, needsAiFallback: true }],
      collectProviderSiblingModels: () => ['text-only-sibling-a', 'text-only-sibling-b'],
    });
    wire();

    const res = await runner.run();

    assert.equal(res.success, true, '应成功作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.match(rec.finalPrompt || '', /88\.20/, '低置信 OCR 文本仍应注入 prompt');
    assert.match(rec.finalPrompt || '', /置信度较低/, '低置信应触发诚实告诫(桥闭合:质量信号不再被丢弃)');
  });

  test('② 有视觉候选但不可达(404/无 key)→ 描述级联穷尽后剥图 + OCR 兜底', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [{ text: '发票金额 ¥1234.56 日期 2026-07-11', confidence: 90, needsAiFallback: false }],
      collectProviderSiblingModels: () => ['gpt-4o-vision-sibling'],
    });
    wire({ describeFails: true });

    const res = await runner.run();

    assert.equal(res.success, true, '视觉不可达也应成功兜底作答');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:视觉失败后仍必须剥图,绝不把裸图留给文本模型');
    assert.match(rec.finalPrompt || '', /1234\.56/, '视觉失败 → 仍应回退本地 OCR 文本');
  });

  test('③ 视觉不可达且 OCR 取不到文字 → 剥图 + 注入诚实「收到图但读不出」说明(绝不静默)', async () => {
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => [], // 非文字类图像 / 缺字库 → 无文本
      collectProviderSiblingModels: () => ['gpt-4o-vision-sibling'],
    });
    wire({ describeFails: true });

    const res = await runner.run();

    assert.equal(res.success, true, '无文本也应成功返回(诚实说明,不静默)');
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:读不出也必须剥图');
    assert.match(
      rec.finalPrompt || '',
      /读不|无法|未能|不支持视觉|收到.*图/,
      '应注入诚实「收到图但读不出」说明,绝不假装没收到图'
    );
  });
});
