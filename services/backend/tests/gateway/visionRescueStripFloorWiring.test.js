'use strict';

/**
 * visionRescueStripFloorWiring.test.js — 端到端锁定 2026-07-12 用户实测「Khy 无法正确读图 /
 * 消息里没有附带图片」的**第三条控制流断桥修复**(OPS-122,承 OPS-118/120)。
 *
 * 断桥(与 prep 期 Site1/Site2 同症,但发生在 post-failure 救援网,历史上从未加固):
 * 当前模型被判为**支持视觉**(decideVisionRouting → keep,图保留),主级联把带图请求发给某适配器,
 * 该适配器却以**模型拒绝类错误**(404 / model_not_found)在运行时拒图 → shouldOcrRescue 提升为
 * _visionFallback → 救援网退回本地 OCR。OCR **提取到文本**时剥图 + 注入(既有行为无回归);但 OCR
 * **无文本 / 抛错**(常见:照片/场景类无字图,或 OCR 引擎抛错)时,历史上救援网只 emitStatus 就 break
 * → 级联带着**裸图**继续 → 下游纯文本适配器静默丢图、如实却荒谬地回「消息里没有附带图片」。
 *
 * 修复(独立 default-on 门 KHY_VISION_RESCUE_STRIP_FLOOR,与 OCR 功能门、Site1 底线门正交):救援网
 * OCR 无文本时,与 OCR-成功分支**同款无条件剥图**并留下诚实底线,保住「剥图 ⟹ 必留痕」不变量。
 *   A) 救援网触发 + OCR 无文本 + 救援底线门开(默认) → **修复点**:剥图 + 注入「图收到但读不出」
 *      底线,下游文本适配器据实作答,不再谎称没收到图;
 *   B) 救援底线门**关**(KHY_VISION_RESCUE_STRIP_FLOOR=off) → **逐字节回退**历史行为(裸图存活,
 *      下游适配器仍收到图、无底线痕迹);
 *   C) 无回归:OCR **有文本** → 走既有 OCR 文本注入分支,救援底线不登场(_ocrFallbackApplied 已置)。
 *
 * 手法:与 visionStripImageFloorWiring 同款自包含 harness(记录型 adapter + DI)。关键差异——本轮
 * 断桥在 post-failure 救援网,故用**视觉可用模型**(gpt-4o)逼出 decideVisionRouting=keep(图保留到
 * 主级联),再由**双适配器**级联:#1 以 404 拒图触发 _visionFallback,#2 为记录型文本适配器承接
 * 剥图后的续跑。OCR 明细由 DI 桩控。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_ocrGatewayHarness');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const fb = require(BE + '/src/services/gateway/visionOcrFallback');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_VISION_STRIP_IMAGE_FLOOR', 'KHY_VISION_RESCUE_STRIP_FLOOR']);
// 模型名 gpt-4o 命中 VISION_NAME_HINTS → decideVisionRouting=keep → 图保留到主级联,
// 使 404 拒图发生在**运行时**(而非 prep 期被路由改写),精确复现 post-failure 救援网断桥。
const runner = h.makeRunner({ prompt: '请先描述图片中的关键信息，再推断我想做什么', model: 'gpt-4o', tag: 'rescue-floor' });

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true });
  h.wireCascade(h.makeRejectAdapter(), rec);
}

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('visionOcrFallback 纯叶子:救援网底线门 isRescueStripFloorEnabled', () => {
  test('默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(fb.isRescueStripFloorEnabled({}), true, '缺省默认开');
    assert.equal(fb.isRescueStripFloorEnabled({ KHY_VISION_RESCUE_STRIP_FLOOR: '1' }), true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(fb.isRescueStripFloorEnabled({ KHY_VISION_RESCUE_STRIP_FLOOR: off }), false, `off-word: ${off}`);
    }
    assert.equal(fb.isRescueStripFloorEnabled({ KHY_VISION_RESCUE_STRIP_FLOOR: 'yes' }), true, '非 off-word 视为开');
  });
});

describe('post-failure 救援网 OCR 无文本 → 剥图必留痕(修「没有附带图片」第三条断桥·OPS-122)', () => {
  before(() => {
    env.save();
    // 关掉透明视觉改道相关门,让 gpt-4o=keep 后的 404 拒图确定性落到救援网。
    // 救援网前置条件:OCR 功能门必须开(否则 shouldOcrRescue 恒 false,_visionFallback 不触发)。
    env.set({ KHY_VISION_FALLBACK_CASCADE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_INTERMEDIATE_MESSAGE: 'off', KHY_VISION_FALLBACK_MODEL: undefined, KHY_VISION_OCR_FALLBACK: undefined, KHY_VISION_STRIP_IMAGE_FLOOR: undefined });
  });
  after(() => env.restore());

  test('A) 修复点:救援网触发 + OCR 无文本 + 底线门开 → 剥图 + 注入底线,下游文本适配器据实作答', async () => {
    env.set({ KHY_VISION_RESCUE_STRIP_FLOOR: undefined }); // 救援底线门默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:救援网 OCR 无文本时,下游非视觉适配器永不收到裸图');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '修复:剥图同时留下「图收到但读不出」痕迹,堵「没有附带图片」幻觉');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/);
  });

  test('B) 门关(KHY_VISION_RESCUE_STRIP_FLOOR=off) → 逐字节回退历史行为(裸图存活,无底线痕迹)', async () => {
    env.set({ KHY_VISION_RESCUE_STRIP_FLOOR: 'off' });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    // 历史断桥现场:救援网 OCR 无文本时不剥图 → 下游适配器仍收到裸图。
    assert.ok(Array.isArray(rec.finalImages) && rec.finalImages.length > 0, '门关:裸图存活到下游(逐字节回退)');
    assert.doesNotMatch(rec.finalPrompt || '', /\[图像无法读取\]/, '门关:不注入底线(逐字节回退)');
  });

  test('C) 无回归:救援网触发 + OCR 有文本 → 走既有 OCR 文本注入,救援底线不登场', async () => {
    env.set({ KHY_VISION_RESCUE_STRIP_FLOOR: undefined });
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), 'OCR 有文本时既有分支同样剥图');
    assert.match(rec.finalPrompt || '', /OCR 图像文本识别结果/, '门开:用既有 OCR 文本注入(证救援底线只在 OCR 无文本时兜底,无回归)');
    assert.match(rec.finalPrompt || '', /发票 金额 100/);
  });
});
