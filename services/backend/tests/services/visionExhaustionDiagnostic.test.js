'use strict';

/**
 * visionExhaustionDiagnostic 纯叶子契约测试(node:test)。
 *
 * 覆盖:404/model_not_found 单因、429/rate_limit 单因、两因叠加、无匹配信号、非带图请求、
 * 空/缺 attempts、门关(自门 + parent 语义由 flagRegistry 另测)、绝不抛。
 * 只测纯叶子——不读文件、不碰真实网关,确定性、快速、无副作用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  diagnoseVisionExhaustion,
  _isModelNotProvisioned,
  _isRateLimited,
  _isNetworkFailure,
} = require('../../src/services/gateway/visionExhaustionDiagnostic');

const ON = {}; // 门默认开(未设 KHY_VISION_EXHAUSTION_DIAG → 视为开)

test('404 / model_not_found 单因 → reason=model_not_provisioned + 领取指引', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [{ errorType: 'model_not_found', statusCode: 404, error: 'model_not_found' }],
  });
  assert.ok(r, '应产出诊断');
  assert.strictEqual(r.reason, 'model_not_provisioned');
  assert.match(r.message, /未领取|open\.bigmodel\.cn/);
  assert.doesNotMatch(r.message, /限流/, '单 404 不应提限流');
});

test('429 / rate_limit 单因 → reason=rate_limited + 降并发指引', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [{ errorType: 'rate_limit', statusCode: 429, error: 'code 1302 too many requests' }],
  });
  assert.ok(r);
  assert.strictEqual(r.reason, 'rate_limited');
  assert.match(r.message, /限流|降低并发/);
  assert.doesNotMatch(r.message, /未领取/, '单 429 不应提未领取');
});

test('404 + 429 两因叠加 → reason=both,两段指引都在', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [
      { errorType: 'model_not_found', statusCode: 404, error: 'glm-4.6v-flash model_not_found' },
      { errorType: 'rate_limit', statusCode: 429, error: '并发超限' },
    ],
  });
  assert.ok(r);
  assert.strictEqual(r.reason, 'both');
  assert.match(r.message, /未领取|领取/);
  assert.match(r.message, /限流|降低并发/);
});

test('文本信号(无 errorType/statusCode)也能识别:错误文本含 model_not_found / 1302', () => {
  const np = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [{ error: 'Request failed: The model does not exist' }],
  });
  assert.strictEqual(np && np.reason, 'model_not_provisioned');

  const rl = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [{ error: '智谱AI: code 1302 请求过多' }],
  });
  assert.strictEqual(rl && rl.reason, 'rate_limited');
});

test('无匹配信号(纯 auth/timeout 失败)→ null', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [
      { errorType: 'auth', statusCode: 401, error: 'unauthorized' },
      { errorType: 'timeout', statusCode: 0, error: 'gateway idle timeout' },
    ],
  });
  assert.strictEqual(r, null);
});

test('非带图请求 → null(文本失败不适用视觉诊断)', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: false,
    env: ON,
    attempts: [{ errorType: 'model_not_found', statusCode: 404 }],
  });
  assert.strictEqual(r, null);
});

test('空 / 缺 attempts → null', () => {
  assert.strictEqual(diagnoseVisionExhaustion({ hasImageInput: true, env: ON, attempts: [] }), null);
  assert.strictEqual(diagnoseVisionExhaustion({ hasImageInput: true, env: ON }), null);
  assert.strictEqual(diagnoseVisionExhaustion({}), null);
  assert.strictEqual(diagnoseVisionExhaustion(), null);
});

test('门关(KHY_VISION_EXHAUSTION_DIAG=0/false/off/no)→ null,逐字节回退', () => {
  const attempts = [{ errorType: 'model_not_found', statusCode: 404 }];
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    const r = diagnoseVisionExhaustion({
      hasImageInput: true,
      env: { KHY_VISION_EXHAUSTION_DIAG: off },
      attempts,
    });
    assert.strictEqual(r, null, `门=${off} 应回退 null`);
  }
});

test('门开的非关闭词(如 1/true/空)仍诊断', () => {
  const attempts = [{ errorType: 'rate_limit', statusCode: 429 }];
  for (const on of ['1', 'true', '', undefined]) {
    const r = diagnoseVisionExhaustion({
      hasImageInput: true,
      env: on === undefined ? {} : { KHY_VISION_EXHAUSTION_DIAG: on },
      attempts,
    });
    assert.ok(r, `门=${String(on)} 应诊断`);
  }
});

test('绝不抛:畸形 attempts(null/非对象/循环)→ 安全降级', () => {
  const weird = [null, 42, 'x', { errorType: 'model_not_found' }];
  const r = diagnoseVisionExhaustion({ hasImageInput: true, env: ON, attempts: weird });
  assert.strictEqual(r && r.reason, 'model_not_provisioned');
  // attempts 非数组
  assert.strictEqual(diagnoseVisionExhaustion({ hasImageInput: true, env: ON, attempts: 'nope' }), null);
});

// —— OPS-MAN-134:网络不可达(socket hang up)子分支 ——
test('socket hang up 单因(errorType=network)→ reason=network_unreachable + 承认收到图', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [{ errorType: 'network', statusCode: 0, error: 'recent network failure cached: socket hang up' }],
  });
  assert.ok(r, '应产出诊断');
  assert.strictEqual(r.reason, 'network_unreachable');
  assert.match(r.message, /网络不可达|socket hang up/);
  assert.match(r.message, /确实收到了你的图片/, '必须承认收到图,绝不谎称没收到');
  assert.doesNotMatch(r.message, /未领取|限流/, '纯网络不应提未领取/限流');
});

test('纯文本网络信号(无 errorType)也识别:socket hang up / ECONNRESET / 代理隧道', () => {
  for (const msg of ['Error: socket hang up', 'read ECONNRESET', 'tunneling socket could not be established']) {
    const r = diagnoseVisionExhaustion({
      hasImageInput: true, env: ON, attempts: [{ error: msg }],
    });
    assert.strictEqual(r && r.reason, 'network_unreachable', `「${msg}」应判网络`);
  }
});

test('网络 + 429 叠加 → reason=multiple,两段指引都在且承认收到图', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [
      { errorType: 'network', error: 'socket hang up' },
      { errorType: 'rate_limit', statusCode: 429, error: 'code 1302' },
    ],
  });
  assert.ok(r);
  assert.strictEqual(r.reason, 'multiple');
  assert.match(r.message, /网络不可达/);
  assert.match(r.message, /限流|降低并发/);
  assert.match(r.message, /图确实已收到/);
});

test('网络 + 404 + 429 三因叠加 → multiple,三段都在', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [
      { errorType: 'network', error: 'socket hang up' },
      { errorType: 'model_not_found', statusCode: 404 },
      { errorType: 'rate_limit', statusCode: 429 },
    ],
  });
  assert.strictEqual(r && r.reason, 'multiple');
  assert.match(r.message, /网络不可达/);
  assert.match(r.message, /未领取|领取/);
  assert.match(r.message, /限流|降低并发/);
});

test('裸 timeout 不误判为网络(保住既有 auth+timeout → null 契约)', () => {
  // gateway idle timeout / errorType=timeout 都不该命中网络分支。
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: ON,
    attempts: [
      { errorType: 'auth', statusCode: 401, error: 'unauthorized' },
      { errorType: 'timeout', statusCode: 0, error: 'gateway idle timeout' },
    ],
  });
  assert.strictEqual(r, null, '裸 timeout/auth 不构成网络诊断');
});

test('子门 KHY_VISION_NETWORK_EXHAUSTION_DIAG=off → 网络信号不可见,逐字节回退', () => {
  const netOnly = [{ errorType: 'network', error: 'socket hang up' }];
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    // 网络-only:子门关 → 无匹配信号 → null(与今日通用墙一致)
    const r1 = diagnoseVisionExhaustion({
      hasImageInput: true,
      env: { KHY_VISION_NETWORK_EXHAUSTION_DIAG: off },
      attempts: netOnly,
    });
    assert.strictEqual(r1, null, `子门=${off} 网络-only 应回退 null`);
    // 网络 + 429:子门关 → 只识 429 → reason=rate_limited(与今日一致,非 multiple)
    const r2 = diagnoseVisionExhaustion({
      hasImageInput: true,
      env: { KHY_VISION_NETWORK_EXHAUSTION_DIAG: off },
      attempts: [{ errorType: 'network', error: 'socket hang up' }, { errorType: 'rate_limit', statusCode: 429 }],
    });
    assert.strictEqual(r2 && r2.reason, 'rate_limited', `子门=${off} 网络+429 应回退 rate_limited`);
  }
});

test('子门默认开(未设/1/true)→ 网络信号可见', () => {
  for (const on of [undefined, '1', 'true', '']) {
    const r = diagnoseVisionExhaustion({
      hasImageInput: true,
      env: on === undefined ? {} : { KHY_VISION_NETWORK_EXHAUSTION_DIAG: on },
      attempts: [{ errorType: 'network', error: 'socket hang up' }],
    });
    assert.strictEqual(r && r.reason, 'network_unreachable', `子门=${String(on)} 应识网络`);
  }
});

test('parent 门关(KHY_VISION_EXHAUSTION_DIAG=0)→ 网络分支也一并回退 null', () => {
  const r = diagnoseVisionExhaustion({
    hasImageInput: true,
    env: { KHY_VISION_EXHAUSTION_DIAG: '0' },
    attempts: [{ errorType: 'network', error: 'socket hang up' }],
  });
  assert.strictEqual(r, null, 'parent 门关 → 整函数 null,网络分支不例外');
});

// —— 内部谓词直接契约 ——
test('_isModelNotProvisioned:errorType/statusCode/文本三路命中,其余不命中', () => {
  assert.strictEqual(_isModelNotProvisioned({ errorType: 'model_not_found' }), true);
  assert.strictEqual(_isModelNotProvisioned({ statusCode: 404 }), true);
  assert.strictEqual(_isModelNotProvisioned({ error: 'code 1211 未开通' }), true);
  assert.strictEqual(_isModelNotProvisioned({ errorType: 'rate_limit', statusCode: 429 }), false);
  assert.strictEqual(_isModelNotProvisioned(null), false);
});

test('_isRateLimited:errorType/statusCode/文本三路命中,404 不误判', () => {
  assert.strictEqual(_isRateLimited({ errorType: 'rate_limit' }), true);
  assert.strictEqual(_isRateLimited({ statusCode: 429 }), true);
  assert.strictEqual(_isRateLimited({ error: 'code 1302 请求过多' }), true);
  assert.strictEqual(_isRateLimited({ statusCode: 404, errorType: 'model_not_found' }), false);
  assert.strictEqual(_isRateLimited(null), false);
});

test('_isNetworkFailure:errorType=network / socket hang up 文本命中,裸 timeout / 404 不命中', () => {
  assert.strictEqual(_isNetworkFailure({ errorType: 'network' }), true);
  assert.strictEqual(_isNetworkFailure({ error: 'socket hang up' }), true);
  assert.strictEqual(_isNetworkFailure({ error: 'read ECONNRESET' }), true);
  assert.strictEqual(_isNetworkFailure({ error: 'tunneling socket could not be established' }), true);
  assert.strictEqual(_isNetworkFailure({ errorType: 'timeout', error: 'gateway idle timeout' }), false);
  assert.strictEqual(_isNetworkFailure({ statusCode: 404, errorType: 'model_not_found' }), false);
  assert.strictEqual(_isNetworkFailure(null), false);
});
