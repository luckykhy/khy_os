'use strict';

/**
 * visionModelDisplayNameWiring.test.js — 级联候选中间提示「显示归一去 provider 前缀」接线(OPS-MAN-150)。
 *
 * 减少心灵噪音:文本模型 + 图 → 视觉级联(KHY_VISION_FALLBACK_CASCADE 门开,GLM pin 内置 key)。
 * `_attempts[0]` = 被切换钉住的视觉模型带 provider 路由前缀(`glm/glm-4.6v-flash`),其余候选是裸 id。
 * 旧行为把内部路由 id `glm/glm-4.6v-flash` 原样灌进逐候选中间提示 prose,与其余裸名不一致 = 泄漏噪音。
 * 锁死:
 *   A) 本门开(KHY_VISION_MODEL_DISPLAY_NAME 默认)→ 任一中间提示 prose 里**不得**出现带 `glm/` 前缀的
 *      `glm/glm-4.6v-flash`;首候选应显示裸 `glm-4.6v-flash`。
 *   B) 本门关(=off)→ 逐字节回退:首候选中间提示重新出现带前缀 `glm/glm-4.6v-flash`(证明仅本门作用)。
 *
 * 注:内部路由态(_att.model/_prevAttemptModel/poolHint)不受影响——本测只断言用户可见 prose;
 * 只锁「前缀是否入 prose」的结构不变量,不硬编码候选数;OCR 成功闭合/失败墙非本族,不干扰断言。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

// 逐候选中间提示(OPS-145 首句或 reframe),用于把「视觉级联中间提示」从其它 assistant_message 里分出来。
const NOTICE_RE = /(我无法直接识别图片内容。正在调用 .+ 进行识别|视觉模型 .+ 不可用，正在改用 .+ 继续识别)/;
const CLOSURE_RE = /已改用本地 OCR/;
// 带 provider 路由前缀的泄漏形态(本轮要消灭的噪音)。
const PREFIXED_RE = /glm\/glm-4\.6v-flash/;
// 归一后的裸形态。
const BARE_FIRST_RE = /(?<!\/)glm-4\.6v-flash/;

function visionNotices(msgs) {
  return msgs.filter((m) => NOTICE_RE.test(m) && !CLOSURE_RE.test(m));
}

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_MODEL_DISPLAY_NAME',
  'KHY_VISION_OCR_SUCCESS_CLOSURE', 'KHY_VISION_FAILURE_SUMMARY',
  'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'display-name-wire' });
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
  const rec = h.makeRecordingAdapter({ content: '已据 OCR 作答', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
  return rec;
}

describe('级联中间提示显示归一去前缀接线(OPS-150)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on'; // 触发多候选级联(首候选带 glm/ 前缀)
    process.env.KHY_VISION_FAILURE_SUMMARY = 'off'; // 隔离:不掺失败墙(墙里模型名不归一,非本族)
    delete process.env.KHY_GLM_VISION_MODEL; // 默认开 → GLM pin 候选就绪
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    delete process.env.KHY_VISION_INTERMEDIATE_MESSAGE; // 中间提示门默认开
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE; // OPS-145 门默认开
  });
  after(() => env.restore());

  test('A) 本门开 → 中间提示 prose 不含 glm/ 前缀,首候选显示裸名', async () => {
    delete process.env.KHY_VISION_MODEL_DISPLAY_NAME; // 默认开
    stubOcr(['INVOICE 2026']);
    wireFailingCascade();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 1, `应至少一条中间提示,实得 ${notices.length}`);
    for (const n of notices) {
      assert.ok(!PREFIXED_RE.test(n), `中间提示不得泄漏带前缀路由 id:${n}`);
    }
    // 首候选(glm/glm-4.6v-flash)应归一为裸 glm-4.6v-flash。
    assert.match(notices[0], BARE_FIRST_RE, '首候选应显示裸 glm-4.6v-flash');
  });

  test('B) 本门关 → 逐字节回退,首候选重现带前缀 glm/glm-4.6v-flash', async () => {
    process.env.KHY_VISION_MODEL_DISPLAY_NAME = 'off';
    stubOcr(['INVOICE 2026']);
    wireFailingCascade();
    const { res, msgs } = await runCaptureMsgs();
    assert.equal(res.success, true);
    const notices = visionNotices(msgs);
    assert.ok(notices.length >= 1, `门关仍应有中间提示,实得 ${notices.length}`);
    assert.ok(
      notices.some((n) => PREFIXED_RE.test(n)),
      '门关时首候选应逐字节回退带前缀 glm/glm-4.6v-flash(证明仅本门作用)',
    );
  });
});
