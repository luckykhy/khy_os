'use strict';

/**
 * visionCascadeAttemptNoticeWiring.test.js — 级联候选逐候选「正在调用...请稍候」减冗余接线(OPS-MAN-145)。
 *
 * 减少心灵噪音:文本模型 + 图 → 视觉级联(KHY_VISION_FALLBACK_CASCADE 门开,GLM pin 内置 key → ≥2 候选)
 * 逐候选发中间「请稍候」。旧行为把逐字节相同的首句「我无法直接识别图片内容。正在调用 X 请稍候」刷 N 遍。
 * 锁死:
 *   A) 提示门开(KHY_VISION_INTERMEDIATE_MESSAGE 默认)+ 本门开(默认)→ 第 1 条保留完整历史首句(逐字节),
 *      第 2..N 条折成「视觉模型 <prev> 不可用，正在改用 <model> 继续识别...」(去掉冗余「我无法直接识别图片内容」前缀)。
 *   B) 本门关(KHY_VISION_CASCADE_ATTEMPT_NOTICE=off)→ 每条都退回完整历史首句(byte-revert),零 reframe。
 *   C) 提示门关(KHY_VISION_INTERMEDIATE_MESSAGE=off)→ 共享前提不成立 → 零中间「请稍候」。
 *
 * 注:级联候选个数依赖内置 GLM key,只锁「第 1 legacy、其后 reframe 且无冗余前缀」的结构不变量,
 * 不硬编码候选数;OCR 成功闭合(OPS-144「视觉模型均不可用，已改用本地 OCR...」)非本族,过滤排除。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

// 历史首句(逐字节)与减冗余 reframe;两者互斥,靠此把「视觉级联中间提示」从其它 assistant_message 里分出来。
const LEGACY_RE = /我无法直接识别图片内容。正在调用 .+ 进行识别，请稍候/;
const REFRAME_RE = /视觉模型 .+ 不可用，正在改用 .+ 继续识别/;
// OCR 成功闭合(OPS-144)——「视觉模型均不可用，已改用本地 OCR」;与 reframe 的「正在改用 <model> 继续识别」不同,须排除。
const CLOSURE_RE = /已改用本地 OCR/;

function visionNotices(msgs) {
  return msgs.filter((m) => (LEGACY_RE.test(m) || REFRAME_RE.test(m)) && !CLOSURE_RE.test(m));
}

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_OCR_SUCCESS_CLOSURE', 'KHY_VISION_FAILURE_SUMMARY',
  'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'cascade-notice-wire' });
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
function wireFailingCascade() {
  // 视觉位逐候选 describeFails → 走完全部候选 → 本地 OCR 成功兜底。
  const rec = h.makeRecordingAdapter({ content: '已据 OCR 作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
  return rec;
}

describe('级联逐候选提示减冗余接线(OPS-145)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 触发多候选级联
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:不掺失败墙
    delete process.env.KHY_GLM_VISION_MODEL; // 默认开 → GLM pin 候选就绪
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
  });
  after(() => env.restore());

  test('A) 门开 → 第 1 条 legacy,第 2..N 条 reframe 且无冗余前缀', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE;
    stubOcr(['INVOICE 2026']);
    wireFailingCascade();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 2, `内置 GLM pin 应产 ≥2 候选提示,实得 ${notices.length}`);
    assert.match(notices[0], LEGACY_RE, '第 1 条保留完整历史首句(逐字节)');
    for (let i = 1; i < notices.length; i += 1) {
      assert.match(notices[i], REFRAME_RE, `第 ${i + 1} 条应为减冗余 reframe`);
      assert.ok(!/我无法直接识别图片内容/.test(notices[i]), `第 ${i + 1} 条不得复述冗余前缀`);
    }
  });

  test('B) 本门关 → 每条退回完整历史首句(byte-revert),零 reframe', async () => {
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE;
    process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE = 'off';
    stubOcr(['INVOICE 2026']);
    wireFailingCascade();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 2, `门关仍应有 ≥2 条中间提示,实得 ${notices.length}`);
    for (let i = 0; i < notices.length; i += 1) {
      assert.match(notices[i], LEGACY_RE, `门关第 ${i + 1} 条应为完整历史首句`);
    }
    assert.ok(!notices.some((m) => REFRAME_RE.test(m)), '门关不得出现 reframe');
  });

  test('C) 提示门关 → 共享前提不成立 → 零中间提示', async () => {
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE;
    stubOcr(['INVOICE 2026']);
    wireFailingCascade();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    const notices = visionNotices(msgs);
    assert.equal(notices.length, 0, '提示门关时整体不发中间「请稍候」');
  });
});
