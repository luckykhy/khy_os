'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fe = require('../src/services/gateway/failureExplainer');

const EMPTY_ENV = {}; // KHY_FAILURE_EXPLAINER unset → enabled

function att(over = {}) {
  return { success: false, provider: 'SenseNova', adapterKey: 'api', ...over };
}

// ── diagnoseFailure: 策展能力事实 ────────────────────────────────────────────

test('u1-fast 带图识别 404 → 信息图生成模型的确定性诊断 + 改用 flash-lite', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-u1-fast',
    hasImage: true,
    attempts: [att({ statusCode: 404, errorType: 'model_not_found', error: 'Request failed with status code 404' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'infographic-gen');
  assert.strictEqual(d.model, 'sensenova-u1-fast');
  assert.strictEqual(d.alternative, 'sensenova-6.7-flash-lite');
  assert.match(d.reason, /信息图生成/);
});

test('u1-fast 纯文本对话也 404(它不是 chat 模型) → 仍确定性诊断', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-u1-fast',
    hasImage: false,
    attempts: [att({ statusCode: 404, error: '404 not found' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'infographic-gen');
});

test('flash-image(不存在) 404 → nonexistent 诊断', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-6.7-flash-image',
    hasImage: true,
    attempts: [att({ statusCode: 404, errorType: 'model_not_found' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'nonexistent');
  assert.strictEqual(d.alternative, 'sensenova-6.7-flash-lite');
});

test('能从通道 key / 错误消息里(而非 model 字段)定位问题模型', () => {
  const d = fe.diagnoseFailure({
    model: 'auto',
    hasImage: true,
    attempts: [att({ adapterKey: 'api:sensenova:sensenova-u1-fast', statusCode: 404, error: 'channel api:sensenova:sensenova-u1-fast failed 404' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.model, 'sensenova-u1-fast');
});

// ── 通用 model-not-found ────────────────────────────────────────────────────

test('未知模型 404(非策展表) → 通用 model-not-found 诊断', () => {
  const d = fe.diagnoseFailure({
    model: 'foo-bar-9000',
    hasImage: false,
    attempts: [att({ statusCode: 404, errorType: 'model_not_found' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'model-not-found');
  assert.match(d.reason, /foo-bar-9000/);
  assert.strictEqual(d.alternative, '');
});

test('model=auto 的通用 404 不点名具体模型但仍下结论', () => {
  const d = fe.diagnoseFailure({
    model: 'auto',
    attempts: [att({ statusCode: 404 })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'model-not-found');
  assert.strictEqual(d.model, '');
});

// ── 零假阳性:瞬时类失败不臆测 ───────────────────────────────────────────────

test('网络失败(无 404/能力信号) → 不下结论(null)', () => {
  const d = fe.diagnoseFailure({
    model: 'foo-bar-9000',
    attempts: [att({ statusCode: 0, errorType: 'network', error: 'fetch failed' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d, null);
});

test('超时(瞬时类) → null', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-6.7-flash-lite',
    attempts: [att({ statusCode: 504, errorType: 'timeout', error: 'idle timeout' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d, null);
});

test('u1-fast 但失败是网络抖动且未带图 → 不把能力错配硬安到网络上(null)', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-u1-fast',
    hasImage: false,
    attempts: [att({ statusCode: 0, errorType: 'network', error: 'socket hang up' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d, null);
});

test('正常可用模型 + 网络失败 → null', () => {
  const d = fe.diagnoseFailure({
    model: 'sensenova-6.7-flash-lite',
    hasImage: true,
    attempts: [att({ statusCode: 0, errorType: 'network' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d, null);
});

test('空 attempts → null', () => {
  assert.strictEqual(fe.diagnoseFailure({ model: 'x', attempts: [], env: EMPTY_ENV }), null);
  assert.strictEqual(fe.diagnoseFailure({ env: EMPTY_ENV }), null);
});

// ── buildFailureExplanation: 格式化 + 门控 ──────────────────────────────────

test('buildFailureExplanation: u1-fast 带图 → 诚实图像指引(OCR/换视觉模型),绝不谎称改用 flash-lite 就能识图', () => {
  const s = fe.buildFailureExplanation({
    model: 'sensenova-u1-fast',
    hasImage: true,
    attempts: [att({ statusCode: 404, errorType: 'model_not_found' })],
    env: EMPTY_ENV,
  });
  assert.match(s, /诊断（确定性）/);
  assert.match(s, /信息图生成/);
  // flash-lite 不收图 → 绝不写「图像识别请改用 flash-lite」(那是谎称它能识图)。
  assert.doesNotMatch(s, /图像识别请改用 sensenova-6\.7-flash-lite/);
  // 诚实图像指引:退回本地 OCR + 提示换支持图像输入的模型;flash-lite 仅作纯文本回退。
  assert.match(s, /OCR/);
  assert.match(s, /支持图像输入的模型/);
  assert.match(s, /纯文本对话可改用 sensenova-6\.7-flash-lite/);
  assert.match(s, /khy gateway model/);
});

test('buildFailureExplanation: 纯文本场景的备选不写「图像识别请改用」而是「改用」', () => {
  const s = fe.buildFailureExplanation({
    model: 'sensenova-u1-fast',
    hasImage: false,
    attempts: [att({ statusCode: 404 })],
    env: EMPTY_ENV,
  });
  assert.match(s, /改用 sensenova-6\.7-flash-lite/);
  assert.doesNotMatch(s, /图像识别请改用/);
});

test('buildFailureExplanation: 通用 404 给 gateway model 指引', () => {
  const s = fe.buildFailureExplanation({
    model: 'foo-bar-9000',
    attempts: [att({ statusCode: 404, errorType: 'model_not_found' })],
    env: EMPTY_ENV,
  });
  assert.match(s, /诊断（确定性）/);
  assert.match(s, /foo-bar-9000/);
  assert.match(s, /khy gateway model/);
});

test('门控 KHY_FAILURE_EXPLAINER=off → null(字节回退)', () => {
  for (const v of ['off', '0', 'false', 'no']) {
    const s = fe.buildFailureExplanation({
      model: 'sensenova-u1-fast',
      hasImage: true,
      attempts: [att({ statusCode: 404 })],
      env: { KHY_FAILURE_EXPLAINER: v },
    });
    assert.strictEqual(s, null, `env=${v} 应回退`);
  }
});

test('门控默认开(未设)→ 有诊断', () => {
  const s = fe.buildFailureExplanation({
    model: 'sensenova-u1-fast',
    hasImage: true,
    attempts: [att({ statusCode: 404 })],
    env: {},
  });
  assert.ok(s && /诊断（确定性）/.test(s));
});

test('无确定结论 → buildFailureExplanation 返回 null', () => {
  const s = fe.buildFailureExplanation({
    model: 'sensenova-6.7-flash-lite',
    attempts: [att({ statusCode: 0, errorType: 'network' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(s, null);
});

test('文本里只有 404 字样(无结构化 code) 也能识别为被拒类', () => {
  const d = fe.diagnoseFailure({
    model: 'foo',
    attempts: [att({ statusCode: 0, error: 'Request failed with status code 404' })],
    env: EMPTY_ENV,
  });
  assert.strictEqual(d.matched, true);
  assert.strictEqual(d.kind, 'model-not-found');
});

test('绝不抛:畸形 attempts 仍安全返回', () => {
  assert.doesNotThrow(() => fe.diagnoseFailure({ model: 123, attempts: [null, 5, {}, { success: false }], env: EMPTY_ENV }));
  assert.doesNotThrow(() => fe.buildFailureExplanation({ attempts: 'nope', env: EMPTY_ENV }));
});

// ── isModelRejection: 「什么算模型拒绝」单一真源(visionOcrFallback 复用它)─────────

test('isModelRejection: 404 / 400 结构化 → true', () => {
  assert.strictEqual(fe.isModelRejection(att({ statusCode: 404 })), true);
  assert.strictEqual(fe.isModelRejection(att({ status: 400 })), true);
  assert.strictEqual(fe.isModelRejection(att({ code: 404 })), true);
});

test('isModelRejection: errorType=model_not_found / bad_request → true', () => {
  assert.strictEqual(fe.isModelRejection(att({ errorType: 'model_not_found' })), true);
  assert.strictEqual(fe.isModelRejection(att({ errorType: 'BAD_REQUEST' })), true);
});

test('isModelRejection: 瞬时类(网络/超时/限流)与成功 → false(不误判)', () => {
  assert.strictEqual(fe.isModelRejection(att({ statusCode: 504, errorType: 'timeout' })), false);
  assert.strictEqual(fe.isModelRejection(att({ statusCode: 0, errorType: 'network' })), false);
  assert.strictEqual(fe.isModelRejection(att({ statusCode: 429, errorType: 'rate_limit' })), false);
  assert.strictEqual(fe.isModelRejection({ success: true, statusCode: 404 }), false);
});

test('isModelRejection: 畸形输入不抛、返回 false', () => {
  assert.doesNotThrow(() => fe.isModelRejection(null));
  assert.strictEqual(fe.isModelRejection(null), false);
  assert.strictEqual(fe.isModelRejection(undefined), false);
  assert.strictEqual(fe.isModelRejection({}), false);
});
