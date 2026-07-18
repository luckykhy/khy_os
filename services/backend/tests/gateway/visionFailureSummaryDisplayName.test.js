'use strict';

/**
 * visionFailureSummaryDisplayName.test.js — 失败墙「本次尝试的视觉模型」显示归一去 provider 前缀
 * (OPS-MAN-159,承 OPS-150)。
 *
 * 断桥:OPS-150 只归一了**级联逐候选中间提示**的模型名(buildCascadeAttemptNotice),而**失败墙**
 * (visionFailureSummary.buildVisionFailureMessage)有自己的一行 `本次尝试的视觉模型:<model>`,
 * 调用方传入的 _primaryModel = decision.model 保留 `glm/` 路由前缀 → 失败墙仍泄漏
 * `本次尝试的视觉模型:glm/glm-4.6v-flash`,与已归一的级联提示不一致 = 残留心灵噪音。该墙在
 * **视觉级联全失败 + 本地 OCR 读不出文字**(照片/截图/无字库)时对用户可见(OCR 成功时被 OPS-142 抑制)。
 *
 * 复用 OPS-150 纯叶 toDisplayModelName + 同门 KHY_VISION_MODEL_DISPLAY_NAME(default-on),
 * 在失败墙的**显示边界**归一;内部路由态(_primaryModel/poolHint)完全不动。
 *
 * 锁死:
 *   ── 叶级(确定性,不依赖 harness)──
 *   A) 门开 + 带前缀 model → 墙里 `本次尝试的视觉模型` 行去前缀显示裸名,全串不含 `glm/glm-4.6v-flash`。
 *   B) 门关(=off)→ 逐字节回退:墙里重现带前缀 `本次尝试的视觉模型:glm/glm-4.6v-flash。`。
 *   C) model 为 null/空/畸形 → 不抛,不产出模型行(与历史一致)。
 *   D) 裸 model → 原样(归一是幂等的,不误伤已裸名)。
 *   E) 源级接线:visionFailureSummary.js 源码 require('./visionModelDisplayName')。
 *   ── 端到端(harness:级联全失败 + OCR 读空 → 墙可见)──
 *   F) 门开 → 墙 assistant_message 的模型行不含 `glm/` 前缀,含裸 glm-4.6v-flash;答复仍成功。
 *   G) 门关 → 墙模型行逐字节回退带前缀 glm/glm-4.6v-flash(证明仅本门作用);答复仍成功。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const V = require(BE + '/src/services/gateway/visionFailureSummary');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const RAW = '- api [unavailable]: preferred adapter "api" is not registered';
const MODEL_LINE_RE = /本次尝试的视觉模型:([^\n。]+)。/;
const PREFIXED_RE = /本次尝试的视觉模型:glm\/glm-4\.6v-flash。/;
const BARE_RE = /本次尝试的视觉模型:glm-4\.6v-flash。/;
const ANY_PREFIX_LEAK_RE = /glm\/glm-4\.6v-flash/;

describe('失败墙模型名显示归一去前缀 · 叶级(OPS-MAN-159)', () => {
  test('A) 门开 + 带前缀 model → 去前缀显示裸名,全串无 glm/ 泄漏', () => {
    const msg = V.buildVisionFailureMessage({ rawError: RAW, model: 'glm/glm-4.6v-flash', env: {} });
    assert.ok(msg && msg.length > 0, '应产出失败墙');
    assert.ok(!ANY_PREFIX_LEAK_RE.test(msg), `全串不得泄漏带前缀路由 id:${msg}`);
    assert.match(msg, BARE_RE, '模型行应显示裸 glm-4.6v-flash');
  });

  test('B) 门关 → 逐字节回退:墙里重现带前缀', () => {
    const msg = V.buildVisionFailureMessage({
      rawError: RAW, model: 'glm/glm-4.6v-flash', env: { KHY_VISION_MODEL_DISPLAY_NAME: 'off' },
    });
    assert.match(msg, PREFIXED_RE, '门关应逐字节回退 本次尝试的视觉模型:glm/glm-4.6v-flash。');
  });

  test('C) model null/空/空白 → 不抛,无模型行;非串输入不抛(前缀归一保守)', () => {
    // 仅这些「归一后为空」的输入历史上就不产模型行(modelId = String(model||'').trim() 为空)。
    for (const m of [null, undefined, '', '   ']) {
      const msg = V.buildVisionFailureMessage({ rawError: RAW, model: m, env: {} });
      assert.ok(msg != null, `model=${JSON.stringify(m)}:仍应产出墙(不抛)`);
      assert.ok(!/本次尝试的视觉模型/.test(msg), `model=${JSON.stringify(m)}:不该产出模型行`);
    }
    // 非串真值输入(非本改动契约,只验归一不抛、逐字节回退到历史 String() 行为)。
    for (const m of [{}, 123]) {
      assert.doesNotThrow(() => V.buildVisionFailureMessage({ rawError: RAW, model: m, env: {} }),
        `model=${JSON.stringify(m)}:归一显示边界不得抛`);
    }
  });

  test('D) 裸 model → 原样(归一幂等,不误伤)', () => {
    const msg = V.buildVisionFailureMessage({ rawError: RAW, model: 'gpt-5.3-codex-review', env: {} });
    assert.match(msg, /本次尝试的视觉模型:gpt-5\.3-codex-review。/, '裸名应原样');
  });

  test('E) 源级接线:visionFailureSummary.js require visionModelDisplayName', () => {
    const src = fs.readFileSync(BE + '/src/services/gateway/visionFailureSummary.js', 'utf8');
    assert.ok(
      /require\(['"]\.\/visionModelDisplayName['"]\)/.test(src),
      '失败墙源码应 require 归一叶 visionModelDisplayName',
    );
    assert.ok(/toDisplayModelName/.test(src), '应调用 toDisplayModelName 归一显示');
  });
});

// ── 端到端:级联全失败 + OCR 读空 → 失败墙对用户可见 ──────────────────────────────
const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_CASCADE_ATTEMPT_NOTICE',
  'KHY_VISION_MODEL_DISPLAY_NAME', 'KHY_VISION_OCR_SUCCESS_CLOSURE',
  'KHY_VISION_FAILURE_SUMMARY', 'KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS',
  'KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR',
]);
const runner = h.makeRunner({ prompt: '请描述图片', model: 'text-only-model', tag: 'fail-wall-display' });
const IMG = [{ base64: 'ZmFrZQ==', mimeType: 'image/png' }];

function stubOcrEmpty() {
  // OCR 读不出文字 → 失败墙不被 OPS-142 抑制,照发。
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

describe('失败墙模型名显示归一去前缀 · 端到端(OPS-MAN-159)', () => {
  before(() => {
    env.save();
    process.env.KHY_VISION_FALLBACK_CASCADE = 'on';       // 触发级联(首候选 _primaryModel 带 glm/ 前缀)
    delete process.env.KHY_GLM_VISION_MODEL;              // GLM pin 候选就绪
    delete process.env.KHY_VISION_FAILURE_SUMMARY;        // 失败墙门默认开
    delete process.env.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS; // OPS-142 默认开(OCR 空 → 照发墙)
    delete process.env.KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';  // 隔离级联中间提示,只验失败墙
    delete process.env.KHY_VISION_CASCADE_ATTEMPT_NOTICE;
    delete process.env.KHY_VISION_OCR_SUCCESS_CLOSURE;
  });
  after(() => env.restore());

  test('F) 门开 → 失败墙模型行无 glm/ 前缀,含裸 glm-4.6v-flash;答复仍成功', async () => {
    delete process.env.KHY_VISION_MODEL_DISPLAY_NAME; // 默认开
    stubOcrEmpty();
    wireFailingCascade();
    const { res, wall } = await runCaptureWall();
    assert.equal(res.success, true, '答复仍成功(能力不回退)');
    assert.ok(wall, '级联全失败 + OCR 空 → 应有失败墙 assistant_message');
    assert.ok(!ANY_PREFIX_LEAK_RE.test(wall), `失败墙不得泄漏带前缀路由 id:${wall}`);
    assert.match(wall, BARE_RE, '失败墙模型行应显示裸 glm-4.6v-flash');
  });

  test('G) 门关 → 墙模型行逐字节回退带前缀 glm/glm-4.6v-flash;答复仍成功', async () => {
    process.env.KHY_VISION_MODEL_DISPLAY_NAME = 'off';
    stubOcrEmpty();
    wireFailingCascade();
    const { res, wall } = await runCaptureWall();
    assert.equal(res.success, true, '门关不影响答复成功');
    assert.ok(wall, '门关仍应有失败墙');
    assert.match(wall, PREFIXED_RE, '门关应逐字节回退 本次尝试的视觉模型:glm/glm-4.6v-flash。(证明仅本门作用)');
  });
});
