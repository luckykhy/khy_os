'use strict';

/**
 * ocrRescuePrepClosureDedupWiring.test.js — Site1 prep-status 与 OCR-成功闭合跨层去重接线(OPS-MAN-148)。
 *
 * 减少心灵噪音:用户复现的确切路径(非 verbose · describe 级联全失败 → 本地 OCR 成功)上,同一条
 * 「已降级到 OCR 并成功识别」被**两层各发一遍**:
 *   - status  chunk:OPS-132 prep(buildOcrRescuePrepStatus,含「已降级用本地 OCR 成功提取」);
 *   - assistant_message chunk:OPS-144 闭合(buildOcrSuccessClosure,含「视觉模型均不可用…本地 OCR 成功识别」)。
 * OPS-144 闭合已把「明显告知用了 OCR」交付 → Site1 的 prep-status 沦为冗余第二遍公告。本去重门抑制它。
 *
 * 锁死:
 *   A) 去重门开(默认)+ 中间消息门开 + 闭合门开(均默认)→ Site1 **不发** prep-status(status 无
 *      「已降级用本地 OCR」),但闭合照发(assistant_message 有「视觉模型均不可用」)= 净 1 条公告;
 *   B) 去重门关(KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP=off)→ prep-status **与**闭合并存(byte-revert)= 2 条公告;
 *   C) Site2(ocr-fallback,无级联 → 无闭合)不调用本守卫 → prep-status **始终**保留,即便去重门开
 *      (证明抑制仅限 Site1,非 verbose 用户在 Site2 不会又变回沉默)。
 *
 * 手法同 OPS-145 wiring:Site1 经 KHY_VISION_FALLBACK_CASCADE=on + 内置 GLM key → ≥2 候选级联,
 * describeFails 走完全部 → 本地 OCR 成功;Site2 经 cascade off + GLM off → decideVisionRouting 判 ocr-fallback。
 * 每 run 用唯一 prompt(harness uniq)规避 describe 冷却缓存跨例污染。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

// status 层 prep(OPS-132)与 assistant_message 层闭合(OPS-144)——两条同义 OCR-降级公告。
const PREP_RE = /已降级用本地 OCR 成功提取/;
const CLOSURE_RE = /视觉模型均不可用[\s\S]*本地 OCR 成功识别/;

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_OCR_RESCUE_STATUS_PREP', 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR', 'KHY_VISION_OCR_FALLBACK', 'KHY_STATUS_VERBOSITY',
]);
const IMG = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

function stubOcr(texts) {
  genLeaf.setAiGatewayGenerateMethodDeps({
    extractImageOcrDetails: () => texts.map((t) => ({ text: t })),
    collectProviderSiblingModels: () => [],
  });
}

// 同时收 status(prep)与 assistant_message(闭合)两条流。
function runCaptureBoth(runner) {
  const statuses = [];
  const msgs = [];
  return runner.run({
    images: IMG,
    onChunk: (c) => {
      if (!c) return;
      if (c.type === 'status' && c.text) statuses.push(String(c.text));
      else if (c.type === 'assistant_message' && c.content) msgs.push(String(c.content));
    },
  }).then((res) => ({ res, statuses, msgs }));
}

// Site1:视觉级联逐候选 describeFails → 走完全部候选 → 本地 OCR 成功兜底。
function wireCascadeFail() {
  const rec = h.makeRecordingAdapter({ content: '已据 OCR 作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
  return rec;
}

describe('Site1 prep/闭合跨层去重接线(OPS-148)', () => {
  const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'prep-closure-dedup-s1' });
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 触发多候选级联 → Site1
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:不掺失败墙
    delete process.env.KHY_GLM_VISION_MODEL; // 默认开 → GLM pin 候选就绪
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    delete process.env.KHY_STATUS_VERBOSITY; // auto → 非 verbose(prep-status 才会发)
  });
  after(() => env.restore());

  test('A) 去重门开(默认)→ prep-status 被抑制,闭合照发 = 净 1 条公告', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_OCR_RESCUE_STATUS_PREP;
    delete process.env.KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP; // 默认开
    stubOcr(['INVOICE 2026']);
    wireCascadeFail();
    const { res, statuses, msgs } = await runCaptureBoth(runner);
    assert.equal(res.success, true);
    assert.ok(msgs.some((m) => CLOSURE_RE.test(m)), '闭合仍应发(明显告知用了 OCR)');
    assert.ok(!statuses.some((s) => PREP_RE.test(s)),
      `去重门开:Site1 冗余 prep-status 应被抑制;实收 status=${JSON.stringify(statuses)}`);
  });

  test('B) 去重门关 → prep-status 与闭合并存(byte-revert)= 2 条公告', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_OCR_RESCUE_STATUS_PREP;
    process.env.KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP = 'off';
    stubOcr(['INVOICE 2026']);
    wireCascadeFail();
    const { res, statuses, msgs } = await runCaptureBoth(runner);
    assert.equal(res.success, true);
    assert.ok(msgs.some((m) => CLOSURE_RE.test(m)), '门关:闭合照发');
    assert.ok(statuses.some((s) => PREP_RE.test(s)),
      `去重门关:prep-status 逐字节回退并存;实收 status=${JSON.stringify(statuses)}`);
  });
});

describe('Site2(ocr-fallback,无闭合)prep-status 不受去重门影响(OPS-148)', () => {
  const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'text-only-model', tag: 'prep-closure-dedup-s2' });
  before(() => {
    env.save();
    // cascade off + GLM off → decideVisionRouting 判 ocr-fallback → Site2(无级联无闭合)。
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_FALLBACK_MODEL;
    delete process.env.KHY_VISION_OCR_FALLBACK;
    delete process.env.KHY_STATUS_VERBOSITY;
    stubOcr(['发票 金额 100']);
  });
  after(() => env.restore());

  test('C) 去重门开(默认)时 Site2 prep-status 仍保留(守卫仅限 Site1)', async () => {
    delete process.env.KHY_OCR_RESCUE_STATUS_PREP;
    delete process.env.KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP; // 默认开
    const rec = h.makeRecordingAdapter({ content: '发票金额是 100 元' });
    h.wireSingle(rec);
    const { res, statuses, msgs } = await runCaptureBoth(runner);
    assert.equal(res.success, true);
    assert.ok(!msgs.some((m) => CLOSURE_RE.test(m)), 'Site2 无级联 → 无闭合');
    assert.ok(statuses.some((s) => PREP_RE.test(s)),
      `Site2 prep-status 始终保留(去重仅限 Site1);实收 status=${JSON.stringify(statuses)}`);
    assert.match(rec.finalPrompt || '', /OCR 识别文本|不支持视觉/, '不变量:OCR 文本仍注入');
  });
});
