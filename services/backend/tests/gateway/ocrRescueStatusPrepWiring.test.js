'use strict';

/**
 * ocrRescueStatusPrepWiring.test.js — 端到端锁定 OPS-MAN-132 断桥:prep 期 Site1/Site2 的 OCR-成功
 * 实时状态历史上**只在 _isVerbose 时**发(aiGatewayGenerateMethod Site1~1618 / Site2~1692 都嵌在
 * `if (_isVerbose)` 里)→ **非 verbose 会话**(默认 KHY_STATUS_VERBOSITY=auto)在 prep 期 OCR 降级时
 * 实时进度层一片沉默,与 OPS-127 已补齐的无条件 Site3 不对称。
 *
 * 手法:纯文本模型(text-only-model,非视觉、无视觉兄弟)带图 → decideVisionRouting 判 ocr-fallback →
 * 进 Site2 prep OCR 兜底成功分支。经 options.onChunk 收 {type:'status'} 文本,断言我新增的无条件
 * prep 状态(仅 !_isVerbose 时)是否出现。
 *   A) 修复点:默认(非 verbose)+ 门开 + OCR 有文本 → prep 实时状态出现「已降级用本地 OCR 成功提取」,
 *      且 OCR 文本仍注入(能力不回退)、答复成功;
 *   B) verbose(KHY_STATUS_VERBOSITY=detailed)+ 门开 → 我的新 prep 状态**不出现**(!_isVerbose 守卫),
 *      改由既有 verbose 状态承担(证不重复);
 *   C) 门关(KHY_OCR_RESCUE_STATUS_PREP=off)+ 非 verbose → prep 状态**不出现**(逐字节回退),OCR 文本照旧注入。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./_ocrGatewayHarness');

const BE = require('path').resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_RESCUE_STATUS_PREP', 'KHY_STATUS_VERBOSITY']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'text-only-model', tag: 'prep-status' });

let rec;
function wire() {
  rec = h.makeRecordingAdapter({ content: '发票金额是 100 元' });
  h.wireSingle(rec);
}

const _OCR_TEXT_DETAIL = [{ text: '发票 金额 100', confidence: 90, needsAiFallback: false, truncated: false, lang: 'chi_sim', requestedLang: 'chi_sim', orientationCorrected: 0, upscaledFactor: 0 }];
const _PREP_RE = /已降级用本地 OCR 成功提取/;
const _OCR_INJECT_RE = /当前模型不支持视觉|OCR 识别文本/;

describe('prep 期 OCR 兜底非 verbose 实时状态端到端(OPS-MAN-132)', () => {
  before(() => {
    env.save();
    env.set({ KHY_VISION_FALLBACK_CASCADE: 'off', KHY_GLM_VISION_MODEL: 'off', KHY_VISION_INTERMEDIATE_MESSAGE: 'off', KHY_VISION_FALLBACK_MODEL: undefined, KHY_VISION_OCR_FALLBACK: undefined });
    // KHY_GLM_VISION_MODEL=off:无 GLM pin → 不改选,落 ocr-fallback。
    // KHY_VISION_FALLBACK_MODEL 清空:无钉选视觉模型。KHY_VISION_OCR_FALLBACK 清空:OCR 功能门默认开。
    // Site2 无视觉兄弟:DI collectProviderSiblingModels → []。
    genLeaf.setAiGatewayGenerateMethodDeps({
      extractImageOcrDetails: () => _OCR_TEXT_DETAIL,
      collectProviderSiblingModels: () => [],
    });
  });
  after(() => env.restore());

  test('A) 修复点:非 verbose + 门开 + OCR 有文本 → prep 实时状态出现「已降级用本地 OCR」,OCR 文本仍注入,答复成功', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS_PREP: undefined, KHY_STATUS_VERBOSITY: undefined }); // 默认开;auto → 非 verbose
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', _OCR_INJECT_RE, '不变量:OCR 文本仍注入(准确识别不回退)');
    assert.ok(statuses.some((s) => _PREP_RE.test(s)), `修复:非 verbose prep 期当场发实时状态;实收=${JSON.stringify(statuses)}`);
  });

  test('B) verbose + 门开 → 我的新 prep 状态不出现(!_isVerbose 守卫),既有 verbose 状态承担(不重复)', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS_PREP: undefined, KHY_STATUS_VERBOSITY: 'detailed' }); // verbose
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true);
    assert.ok(!statuses.some((s) => _PREP_RE.test(s)), `verbose:新 prep 状态被 !_isVerbose 守卫挡下,避免重复;实收=${JSON.stringify(statuses)}`);
    assert.ok(statuses.some((s) => /已用 OCR 提取/.test(s)), `verbose:既有 verbose 状态仍在;实收=${JSON.stringify(statuses)}`);
  });

  test('C) 门关(KHY_OCR_RESCUE_STATUS_PREP=off)+ 非 verbose → prep 状态不出现(逐字节回退),OCR 文本照旧注入', async () => {
    env.set({ KHY_OCR_RESCUE_STATUS_PREP: 'off', KHY_STATUS_VERBOSITY: undefined });
    wire();
    const { res, statuses } = await runner.runCapture();
    assert.equal(res.success, true, '门关不影响答复成功');
    assert.match(rec.finalPrompt || '', _OCR_INJECT_RE, '门关:OCR 文本照旧注入(只是不发实时状态)');
    assert.ok(!statuses.some((s) => _PREP_RE.test(s)), `门关:非 verbose prep 期历史静默;实收=${JSON.stringify(statuses)}`);
  });
});
