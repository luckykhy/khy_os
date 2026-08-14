'use strict';

/**
 * visionDescribeFailFloorWiring.test.js — 端到端锁定 2026-07-12 用户实测「Khy 无法正确读图 /
 * 消息里没有附带图片」的**控制流断桥修复**接线。
 *
 * 断桥(reproduce 于 /tmp,已固化为本测试):纯文本模型收到图 → decideVisionRouting 判 switch-model
 * → describe-and-return 级联对视觉模型识图,视觉模型 404(model_not_found)全部失败。此时那段
 * 「剥图 + OCR 兜底 +『图片确实收到但读不出』诚实底线」被历史地嵌进 `if (_summaryOn)`
 * (_summaryOn = KHY_VISION_FAILURE_SUMMARY,纯装饰门)。**当用户关掉失败说明门**,底线被一并跳过 →
 * 控制流落到 switch 替换,把读不出的图**留着**改投**刚刚 404 的视觉模型** → 最终文本模型在**毫无
 * 「图片存在」说明**下作答 → 如实却荒谬地回「消息里没有附带图片」。
 *
 * 修复(独立 default-on 门 KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR 把底线与失败说明解耦):
 *   A) 失败说明**开** + OCR 有文本  → 剥图 + 注入 OCR 文本,原文本模型作答(历史正确路径);
 *   B) 失败说明**开** + OCR 无文本  → 剥图 + 注入「[图像无法读取]…绝不能说没有收到图片」底线;
 *   C) 失败说明**关** + OCR 无文本  → **修复点**:仍剥图 + 注入底线,由**原文本模型**(非已 404 的
 *      视觉模型)作答 —— 不再把图留给失败模型、不再让模型谎称「没有附带图片」;
 *   D) 底线门**关**(KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR=off)+ 失败说明关 → **逐字节回退**历史行为
 *      (图留着、切到 glm-4v-flash),证明门关即旧行为。
 *
 * 手法:与 imageOcrResolutionWiring 同款自包含 harness(记录型 adapter + DI),KHY_VISION_FALLBACK_MODEL
 * 钉一个视觉模型逼出 switch-model;describe-pass 返回 404 失败;OCR 明细由 DI 桩控。
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

// describe-pass 恒返回 404(模型拒绝);最终作答 call 记录 prompt/images/model。
let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '已作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
}

const runner = h.makeRunner({
  prompt: '请先描述图片中的关键信息，再推断我想做什么',
  model: 'text-only-model',
  tag: 'floor-wire',
});

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_INTERMEDIATE_MESSAGE',
]);

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];

describe('视觉描述级联全失败 → OCR 底线与失败说明门解耦(修「Khy 无法正确读图 / 没有附带图片」)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash'; // 逼出 switch-model(pinned 视觉)
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';        // _attempts 只含主模型,确定性
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
  });
  after(() => env.restore());

  test('A) 失败说明开 + OCR 有文本:剥图 + 注入 OCR 文本,原文本模型作答', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY = '1';
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => _OCR_TEXT_DETAIL, collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '不变量:非视觉模型永不收到裸图');
    assert.equal(res.model, 'text-only-model', '由原文本模型作答,不切到已 404 的视觉模型');
    assert.match(rec.finalPrompt || '', /以下为图片 OCR 识别文本/, '应注入 OCR 文本块');
    assert.match(rec.finalPrompt || '', /发票 金额 100/);
  });

  test('B) 失败说明开 + OCR 无文本:剥图 + 注入「图像无法读取」底线', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY = '1';
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages));
    assert.equal(res.model, 'text-only-model');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '应注入诚实底线');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/, '底线须命令模型别谎称没收到图');
  });

  test('C) 修复点:失败说明关 + OCR 无文本 → 仍剥图 + 底线,原文本模型作答(不再谎称没收到图)', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off';        // 关掉纯装饰失败说明门
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR; // 底线门默认开
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.ok(h.imagesStripped(rec.finalImages), '修复:失败说明关也必须剥图(非视觉模型永不收到裸图)');
    assert.equal(res.model, 'text-only-model', '修复:由原文本模型作答,绝不把图留给刚 404 的视觉模型');
    assert.match(rec.finalPrompt || '', /\[图像无法读取\]/, '修复:底线仍注入,堵住「消息里没有附带图片」幻觉');
    assert.match(rec.finalPrompt || '', /绝不能说没有收到图片/);
  });

  test('D) 门关(KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR=off)+ 失败说明关 → 逐字节回退历史行为', async () => {
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off';
    process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR = 'off';
    genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [], collectProviderSiblingModels: () => [] });
    wire();
    const res = await runner.run();
    assert.equal(res.success, true);
    assert.equal(h.imagesStripped(rec.finalImages), false, '门关:历史行为——图留着(未剥)');
    assert.equal(res.model, 'glm-4v-flash', '门关:历史行为——切到 switch-model 目标(已 404 的视觉模型)');
    assert.doesNotMatch(rec.finalPrompt || '', /\[图像无法读取\]/, '门关:不注入底线(逐字节回退)');
  });
});
