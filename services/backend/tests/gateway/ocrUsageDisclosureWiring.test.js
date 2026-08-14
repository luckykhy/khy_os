'use strict';

/**
 * ocrUsageDisclosureWiring.test.js — 端到端锁定本轮(OPS-MAN-123)新断桥:OCR **成功路径**上缺一条
 * 面向用户的「用了 OCR」透明披露。
 *
 * 断桥:三处 OCR 成功注入点(Site1 describe-fail / Site2 ocr-fallback / Site3 post-failure 救援网)
 * 都只注入一个面向**模型**的「以下为图片 OCR 识别文本,请据此作答」头 + 六条**条件型**告诫(低置信/
 * 覆盖/截断/语言/方向/分辨率——只在 OCR 结果有缺陷时才触发)。当 OCR **干净成功**、图片文字被准确读出
 * 时,六条一条都不触发 → 模型据 OCR 文本作答,却从不被要求**告诉用户**这段内容经 OCR 读取而非原生看图
 * → 模型像亲眼看图般作答,用户全程不知用了 OCR。违反本轮目标「Khy 降级到 OCR,要能无感明显告知用户
 * 用了 OCR 但正确识别图片」。
 *
 * 修复(独立 default-on 门 KHY_OCR_USAGE_DISCLOSURE,与六条条件型告诫正交):OCR 成功注入文本后
 * **无条件**追加一句面向模型的指令,要求它用一句自然、简短的话向用户明确说明用了 OCR。
 *   A) OCR 成功 + 披露门开(默认) → **修复点**:prompt 同时含 OCR 文本 + 披露指令,下游作答;
 *   B) 披露门**关**(KHY_OCR_USAGE_DISCLOSURE=off) → 逐字节回退(prompt 含 OCR 文本但无披露指令);
 *   C) 无回归:OCR **无文本**(读不出) → 不注入披露(披露仅在 OCR 成功时登场)。
 *
 * 手法:复用 visionRescueStripFloorWiring 的双适配器 harness——视觉可用模型(gpt-4o)逼 keep-routing
 * → #1 以 404 拒图触发 post-failure 救援网(Site3),#2 记录型文本适配器承接剥图后续跑,回填 _final*。
 * 救援网 Site3 是三处成功注入点里最易确定性触达的一处;OCR 明细由 DI 桩控。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_ocrGatewayHarness');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const un = require(BE + '/src/services/gateway/ocrUsageNotice');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_USAGE_DISCLOSURE']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'usage-disclosure' });

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
  h.wireCascade(h.makeRejectAdapter(), rec);
}

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('ocrUsageNotice 纯叶:披露门 isEnabled', () => {
  test('默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(un.isEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(un.isEnabled({ KHY_OCR_USAGE_DISCLOSURE: off }), false, `off-word ${off}`);
    }
  });
});

describe('OCR 成功路径「使用 OCR 透明告知」端到端(OPS-MAN-123)', () => {
  before(() => {
    env.save();
    env.set({ KHY_VISION_FALLBACK_CASCADE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_INTERMEDIATE_MESSAGE: 'off', KHY_VISION_FALLBACK_MODEL: undefined, KHY_VISION_OCR_FALLBACK: undefined });
    // 救援网前置:OCR 功能门必须开(否则 shouldOcrRescue 恒 false,_visionFallback 不触发)。
  });
  after(() => env.restore());

  test('A) 修复点:OCR 成功 + 披露门开 → prompt 同含 OCR 文本 + 披露指令,下游文本适配器作答', async () => {
    env.set({ KHY_OCR_USAGE_DISCLOSURE: undefined }); // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:OCR 成功后下游非视觉适配器收到剥图后的纯文本');
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, 'OCR 文本仍注入(准确识别不回退)');
    assert.match(rec.finalPrompt || '', /发票 金额 100/, 'OCR 读出的内容进入 prompt');
    assert.match(rec.finalPrompt || '', /通过 OCR 文字识别读取/, '修复:无条件追加面向用户的「用了 OCR」披露(明显告知)');
    assert.match(rec.finalPrompt || '', /向用户明确说明/, '修复:指令模型主动向用户说明');
  });

  test('B) 披露门关(KHY_OCR_USAGE_DISCLOSURE=off) → 逐字节回退(含 OCR 文本但无披露指令)', async () => {
    env.set({ KHY_OCR_USAGE_DISCLOSURE: 'off' });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, '门关:OCR 文本照旧注入(能力不受影响)');
    assert.doesNotMatch(rec.finalPrompt || '', /通过 OCR 文字识别读取/, '门关:不注入披露(逐字节回退历史行为)');
  });

  test('C) 无回归:OCR 无文本(读不出) → 不注入披露(披露仅在 OCR 成功时登场)', async () => {
    env.set({ KHY_OCR_USAGE_DISCLOSURE: undefined });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.doesNotMatch(rec.finalPrompt || '', /通过 OCR 文字识别读取/, 'OCR 无文本 → 无成功可披露,不注入(count>0 才触发)');
  });
});
