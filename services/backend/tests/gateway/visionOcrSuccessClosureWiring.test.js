'use strict';

/**
 * visionOcrSuccessClosureWiring.test.js — describe-fail → OCR-成功用户可见闭合接线(OPS-MAN-144)。
 *
 * 视觉级联全失败(describeFails)→ 本地 OCR **成功**(桩 extractImageOcrDetails 返文本)→ 走剥图+OCR 注入
 * 分支。锁死:
 *   A) 中间消息门开 + 闭合门开(均默认)→ 发一条闭合 assistant_message(含「视觉模型均不可用」+
 *      「本地 OCR 成功识别」),闭合前面的悬空「正在调用...请稍候」承诺;
 *   B) 闭合门关(KHY_VISION_OCR_SUCCESS_CLOSURE=off)→ 无闭合(byte-revert),OCR 注入照常;
 *   C) 中间消息门关(KHY_VISION_INTERMEDIATE_MESSAGE=off)→ 共享前提不成立 → 无闭合;
 *   D) OCR 读空(桩返 [])→ 非本分支 → 无闭合。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const CLOSURE = /视觉模型均不可用[\s\S]*本地 OCR 成功识别/;
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'closure-wire' });
const IMG = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

function stubOcr(texts) {
  genLeaf.setAiGatewayGenerateMethodDeps({
    extractImageOcrDetails: () => texts.map((t) => ({ text: t })),
    collectProviderSiblingModels: () => [],
  });
}
function runCaptureMsgs() {
  const msgs = [];
  return runner.run({
    images: IMG,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, msgs }));
}
function wireFailingVision() {
  const rec = h.makeRecordingAdapter({ content: '已据 OCR 作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
  return rec;
}

describe('OCR-成功闭合接线(OPS-144)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_MODEL = 'glm-4v-flash';
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:只观察闭合,不掺失败墙
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
  });
  after(() => env.restore());

  test('A) 中间消息门开 + 闭合门开 → 发闭合', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    stubOcr(['INVOICE 2026']);
    wireFailingVision();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(msgs.some((m) => CLOSURE.test(m)), '应发一条 OCR 成功闭合');
  });

  test('B) 闭合门关 → 无闭合(byte-revert),OCR 注入照常', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    process.env.KHY_VISION_OCR_SUCCESS_CLOSURE = 'off';
    stubOcr(['INVOICE 2026']);
    const rec = wireFailingVision();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(!msgs.some((m) => CLOSURE.test(m)), '门关不应发闭合');
    assert.match(String(rec.finalPrompt || '').toUpperCase(), /INVOICE/, 'OCR 注入不受影响');
  });

  test('C) 中间消息门关 → 共享前提不成立 → 无闭合', async () => {
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    stubOcr(['INVOICE 2026']);
    wireFailingVision();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(!msgs.some((m) => CLOSURE.test(m)), '中间消息门关时整体不发闭合');
  });

  test('D) OCR 读空 → 非本分支 → 无闭合', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    stubOcr([]);
    wireFailingVision();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    assert.ok(!msgs.some((m) => CLOSURE.test(m)), 'OCR 读空不走成功分支,无闭合');
  });
});
