'use strict';

/**
 * visionFailureCauseDedup.test.js — 失败墙「真实失败原因」标签去重(OPS-MAN-161,承 OPS-159)。
 *
 * 断桥:describe 子调用失败时,gateway 用 aiGateway._buildFailureReasonSection 前置
 * `真实失败原因:\n<真因…>`,该串成为 _lastRawError → 交失败墙 buildVisionFailureMessage 的 rawError。
 * 墙内 cause = sanitizeCause(rawError) 保留自带 `真实失败原因:` 标签,line 223 再前置一次 →
 * `真实失败原因:真实失败原因:…` stutter。这是失败墙上与 OPS-159(模型名前缀)正交的另一枚心灵噪音,
 * 且 aiGateway._prependFailureReason 早有 `if(/真实失败原因/.test(body)) return body` 同款去重意图,
 * 唯此处历史上漏了守卫。
 *
 * 门 KHY_VISION_FAILURE_CAUSE_DEDUP(default-on):cause 已以标签开头 → 剥掉自带标签只保留一次;
 * 门关 / 异常 → 逐字节回退到重复行为。半/全角冒号都认。
 *
 * 锁死:
 *   ── 叶级(确定性)──
 *   A) 门开 + rawError 自带 `真实失败原因:` → 墙里标签恰好一次(去 stutter)。
 *   B) 门关(=off)→ 逐字节回退:墙里标签出现两次(stutter 重现)。
 *   C) rawError 不带标签 → 门开/门关都恰好一次(不过度剥离,幂等安全)。
 *   D) 全角冒号 `真实失败原因：` 自带标签 → 门开也剥离(半/全角都认)。
 *   E) 源级接线:visionFailureSummary.js 引用 isFailureCauseDedupEnabled + KHY_VISION_FAILURE_CAUSE_DEDUP。
 *   ── 端到端(harness:级联全失败 + OCR 读空 → 墙可见)──
 *   F) 门开 → 失败墙 `真实失败原因` 标签恰好一次;答复仍成功。
 *   G) 门关 → 墙标签出现两次(逐字节回退,证明仅本门作用);答复仍成功。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const V = require(BE + '/src/services/gateway/visionFailureSummary');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const LABEL_RE = /真实失败原因/g;
const TAIL = '- api [unavailable]: preferred adapter "api" is not registered';
// 模拟 aiGateway._buildFailureReasonSection 的产物:标签 + 换行 + 真因(sanitizeCause 会把 \n 归一为空格)。
const RAW_LABELLED = `真实失败原因:\n${TAIL}`;
const RAW_LABELLED_FULLWIDTH = `真实失败原因：\n${TAIL}`;
const RAW_BARE = TAIL;

function countLabel(s) {
  return ((s || '').match(LABEL_RE) || []).length;
}

describe('失败墙「真实失败原因」标签去重 · 叶级(OPS-MAN-161)', () => {
  test('A) 门开 + 自带标签 → 标签恰好一次(去 stutter)', () => {
    const msg = V.buildVisionFailureMessage({ rawError: RAW_LABELLED, model: 'glm-4v-flash', env: {} });
    assert.ok(msg && msg.length > 0, '应产出失败墙');
    assert.equal(countLabel(msg), 1, `门开应只保留一次标签:${msg}`);
    assert.ok(!/真实失败原因[:：]\s*真实失败原因/.test(msg), '不得出现连续两次标签');
  });

  test('B) 门关 → 逐字节回退:标签出现两次(stutter 重现)', () => {
    const msg = V.buildVisionFailureMessage({
      rawError: RAW_LABELLED, model: 'glm-4v-flash', env: { KHY_VISION_FAILURE_CAUSE_DEDUP: 'off' },
    });
    assert.equal(countLabel(msg), 2, `门关应逐字节回退到两次标签(stutter):${msg}`);
  });

  test('C) rawError 不带标签 → 门开/门关都恰好一次(幂等,不过度剥离)', () => {
    for (const env of [{}, { KHY_VISION_FAILURE_CAUSE_DEDUP: 'off' }]) {
      const msg = V.buildVisionFailureMessage({ rawError: RAW_BARE, model: 'glm-4v-flash', env });
      assert.equal(countLabel(msg), 1,
        `无自带标签时,墙自身仍加恰好一次标签(env=${JSON.stringify(env)}):${msg}`);
    }
  });

  test('D) 全角冒号 `真实失败原因：` 自带标签 → 门开也剥离', () => {
    const msg = V.buildVisionFailureMessage({ rawError: RAW_LABELLED_FULLWIDTH, model: 'glm-4v-flash', env: {} });
    assert.equal(countLabel(msg), 1, `全角冒号自带标签也应剥离到一次:${msg}`);
  });

  test('E) 源级接线:引用 isFailureCauseDedupEnabled + KHY_VISION_FAILURE_CAUSE_DEDUP', () => {
    const src = fs.readFileSync(BE + '/src/services/gateway/visionFailureSummary.js', 'utf8');
    assert.ok(/isFailureCauseDedupEnabled/.test(src), '源码应定义/调用 isFailureCauseDedupEnabled');
    assert.ok(/KHY_VISION_FAILURE_CAUSE_DEDUP/.test(src), '源码应引用门 KHY_VISION_FAILURE_CAUSE_DEDUP');
  });
});

// ── 端到端:级联全失败 + OCR 读空 → 失败墙对用户可见 ──────────────────────────────
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_MODEL_DISPLAY_NAME', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_FAILURE_CAUSE_DEDUP', 'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'fail-wall-cause-dedup' });
const IMG = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

function stubOcrEmpty() {
  genLeaf.setAiGatewayGenerateMethodDeps({
    extractImageOcrDetails: () => [],
    collectProviderSiblingModels: () => [],
  });
}
function wireFailingCascade() {
  const rec = h.makeRecordingAdapter({ content: '我没有看到任何图片内容', captureImages: true, describe: true, describeFails: true });
  h.wireSingle(rec);
  return rec;
}
function runCaptureWall() {
  const msgs = [];
  return runner.run({
    images: IMG,
    onChunk: (c) => { if (c && c.type === 'assistant_message' && c.content) msgs.push(String(c.content)); },
  }).then((res) => ({ res, wall: msgs.find((m) => /图像识别失败/.test(m)) || null }));
}

describe('失败墙「真实失败原因」标签去重 · 端到端(OPS-MAN-161)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on';
    delete process.env.KHY_GLM_VISION_MODEL;
    delete process.env.KHY_VISION_FAILURE_SUMMARY;
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS;
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
  });
  after(() => env.restore());

  test('F) 门开 → 失败墙标签恰好一次;答复仍成功', async () => {
    delete process.env.KHY_VISION_FAILURE_CAUSE_DEDUP; // 默认开
    stubOcrEmpty();
    wireFailingCascade();
    const { res, wall } = await runCaptureWall();
    assert.equal(res.success, true, '答复仍成功(能力不回退)');
    assert.ok(wall, '级联全失败 + OCR 空 → 应有失败墙 assistant_message');
    assert.equal(countLabel(wall), 1, `门开:失败墙应只保留一次真实失败原因标签:${wall}`);
  });

  test('G) 门关 → 墙标签出现两次(逐字节回退,证明仅本门作用);答复仍成功', async () => {
    process.env.KHY_VISION_FAILURE_CAUSE_DEDUP = 'off';
    stubOcrEmpty();
    wireFailingCascade();
    const { res, wall } = await runCaptureWall();
    assert.equal(res.success, true, '门关不影响答复成功');
    assert.ok(wall, '门关仍应有失败墙');
    assert.equal(countLabel(wall), 2, `门关:应逐字节回退到两次标签(stutter):${wall}`);
  });
});
