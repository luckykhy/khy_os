'use strict';

/**
 * ocrRescueStatusNoticeWiring.test.js — 端到端锁定 OPS-MAN-127 新断桥:post-failure 救援网(Site3)的
 * OCR-**成功**分支历史上从不 emitStatus,而 prep 期 Site1/Site2 成功时都发实时状态。恰在用户实测的
 * gpt-4o keep → 运行时 404 → 救援网路径上,OCR 成功降级发生时**实时进度层沉默**。
 *
 * 手法:复用 OPS-124/126 的双适配器 harness——视觉可用模型(gpt-4o)逼 keep-routing → #1 以 404 拒图
 * 触发 post-failure 救援网(Site3)→ #2 记录型文本适配器承接。经 options.onChunk 收集 {type:'status'}
 * 文本,断言 Site3 成功分支的「已降级用本地 OCR」实时状态是否出现。
 *   A) 门开 + OCR 有文本 → **修复点**:实时状态出现「已降级用本地 OCR 成功提取」(明显告知),且答复成功、OCR 文本仍注入(能力不回退);
 *   B) 门关(KHY_OCR_RESCUE_STATUS=off) → 逐字节回退:救援网成功状态**不出现**(历史静默);
 *   C) 无回归:OCR **无文本**(读不出) → 成功分支未进入 → 救援网成功状态**不出现**(走剥图留痕路径,答复仍成功)。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_ocrGatewayHarness');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_RESCUE_STATUS']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'rescue-status' });

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '发票金额是 100 元' });
  h.wireCascade(h.makeRejectAdapter(), rec);
}

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];
const _RESCUE_RE = /已降级用本地 OCR 成功提取/;

describe('OCR 兜底实时状态层透明告知端到端(OPS-MAN-127)', () => {
  before(() => {
    env.save();
    env.set({ KHY_VISION_FALLBACK_CASCADE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_INTERMEDIATE_MESSAGE: 'off', KHY_VISION_FALLBACK_MODEL: undefined, KHY_VISION_OCR_FALLBACK: undefined });
    // 救援网前置:OCR 功能门必须开(否则 shouldOcrRescue 恒 false,_visionFallback 不触发)。
  });
  after(() => env.restore());

  test('A) 修复点:门开 + OCR 有文本 → 实时状态出现「已降级用本地 OCR」,答复成功且 OCR 文本仍注入', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS: undefined }); // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, '不变量:OCR 文本仍注入(准确识别不回退)');
    assert.ok(statuses.some((s) => _RESCUE_RE.test(s)), `修复:救援网成功当场发实时状态;实收=${JSON.stringify(statuses)}`);
  });

  test('B) 门关(KHY_OCR_RESCUE_STATUS=off) → 逐字节回退:救援网成功状态不出现', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS: 'off' });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true, '门关不影响答复成功');
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, '门关:OCR 文本照旧注入(只是不发实时状态)');
    assert.ok(!statuses.some((s) => _RESCUE_RE.test(s)), `门关:历史静默,救援网成功状态不出现;实收=${JSON.stringify(statuses)}`);
  });

  test('C) 无回归:OCR 无文本(读不出) → 成功分支未进入 → 救援网成功状态不出现,答复仍成功', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS: undefined });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true);
    assert.ok(!statuses.some((s) => _RESCUE_RE.test(s)), `OCR 无文本:不该 announce 成功提取;实收=${JSON.stringify(statuses)}`);
  });
});
