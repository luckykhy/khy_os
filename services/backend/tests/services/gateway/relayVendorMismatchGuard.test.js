'use strict';

/**
 * relayVendorMismatchGuard — 纯叶子判定 + relayApiAdapter 接线(node:test)。
 *
 * 锚定的核心 LOGIC:relay_api 用自有 RELAY_API_ENDPOINT + 透传 model,不经 `api` 通道池解析
 * (wildcardPoolGuard 罩不到),relayModelGuard 又是端点无关的静态家族表。当端点是某已知厂商官方
 * host(如 open.bigmodel.cn = 智谱 GLM)、而 model 属另一厂商(如 agnes-2.0-flash = Agnes)时,
 * 上游必回「模型不存在」(实测 400 code 1211)。本守卫据 providerPresets 单一真源派生「端点厂商 vs
 * 模型厂商」,确证不同 → 发请求前短路;门关/未知一律放行(逐字节回退今日行为)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../../../src/services/gateway/relayVendorMismatchGuard');

// 确定性 fixture:不依赖 env / zhipuGlmModel 门控,精确锁定判定逻辑。
const PRESETS = [
  { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4', models: [] },
  { id: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', defaultModel: 'agnes-2.0-flash', models: ['agnes-2.0-flash'] },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: [] },
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', models: [] },
];

// ── 门控 ──
test('isEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(G.isEnabled({}), true);
  assert.strictEqual(G.isEnabled({ KHY_RELAY_VENDOR_GUARD: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(G.isEnabled({ KHY_RELAY_VENDOR_GUARD: v }), false, `expected off for ${v}`);
  }
});

// ── host / bare / family 提取 ──
test('hostOf: extracts host, tolerates missing scheme, fail-soft', () => {
  assert.strictEqual(G.hostOf('https://open.bigmodel.cn/api/paas/v4'), 'open.bigmodel.cn');
  assert.strictEqual(G.hostOf('open.bigmodel.cn/api/paas/v4'), 'open.bigmodel.cn');
  assert.strictEqual(G.hostOf('https://apihub.agnes-ai.com/v1'), 'apihub.agnes-ai.com');
  assert.strictEqual(G.hostOf(''), '');
  assert.strictEqual(G.hostOf(null), '');
  assert.strictEqual(G.hostOf(12345), '');
});

test('bareModel: strips scoped prefix, lowercases', () => {
  assert.strictEqual(G.bareModel('agnes-2.0-flash'), 'agnes-2.0-flash');
  assert.strictEqual(G.bareModel('agnes:agnes-2.0-flash'), 'agnes-2.0-flash');
  assert.strictEqual(G.bareModel('api/agnes-2.0-flash'), 'agnes-2.0-flash');
  assert.strictEqual(G.bareModel('GLM-4.6'), 'glm-4.6');
  assert.strictEqual(G.bareModel(''), '');
  assert.strictEqual(G.bareModel(undefined), '');
});

test('familyToken: leading alpha run before digit/sep', () => {
  assert.strictEqual(G.familyToken('agnes-2.0-flash'), 'agnes');
  assert.strictEqual(G.familyToken('glm-4.6'), 'glm');
  assert.strictEqual(G.familyToken('gpt-4o-mini'), 'gpt');
  assert.strictEqual(G.familyToken('deepseek-chat'), 'deepseek');
  assert.strictEqual(G.familyToken(''), '');
});

// ── endpoint → vendor ──
test('vendorForEndpoint: official host → preset id, custom relay → ""', () => {
  assert.strictEqual(G.vendorForEndpoint('https://open.bigmodel.cn/api/paas/v4', PRESETS), 'zhipu');
  assert.strictEqual(G.vendorForEndpoint('https://apihub.agnes-ai.com/v1', PRESETS), 'agnes');
  // 自定义 relay / 代理 host 不属任何 preset → 放行信号
  assert.strictEqual(G.vendorForEndpoint('https://your-relay.example.com/v1', PRESETS), '');
  assert.strictEqual(G.vendorForEndpoint('', PRESETS), '');
});

// ── model → vendor ──
test('vendorForModel: exact models-list match wins', () => {
  assert.strictEqual(G.vendorForModel('agnes-2.0-flash', PRESETS), 'agnes');
  assert.strictEqual(G.vendorForModel('agnes:agnes-2.0-flash', PRESETS), 'agnes'); // scoped 前缀剥离
});

test('vendorForModel: family-token match derived from presets', () => {
  assert.strictEqual(G.vendorForModel('glm-4.6', PRESETS), 'zhipu'); // 不在 models 清单,靠家族
  assert.strictEqual(G.vendorForModel('gpt-4o', PRESETS), 'openai');
  assert.strictEqual(G.vendorForModel('deepseek-reasoner', PRESETS), 'deepseek');
});

test('vendorForModel: unknown family → "" (conservative)', () => {
  assert.strictEqual(G.vendorForModel('some-unknown-model', PRESETS), '');
  assert.strictEqual(G.vendorForModel('', PRESETS), '');
});

// ── evaluateRelayRequest 核心判定 ──
test('evaluate: bigmodel(zhipu) endpoint + agnes model → MISMATCH', () => {
  const v = G.evaluateRelayRequest({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'agnes-2.0-flash',
    presets: PRESETS,
  });
  assert.strictEqual(v.mismatch, true);
  assert.strictEqual(v.endpointVendor, 'zhipu');
  assert.strictEqual(v.modelVendor, 'agnes');
});

test('evaluate: matching vendor pairs → pass', () => {
  // bigmodel + glm-4.6 (both zhipu)
  assert.strictEqual(G.evaluateRelayRequest({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', presets: PRESETS,
  }).mismatch, false);
  // agnes host + agnes model
  assert.strictEqual(G.evaluateRelayRequest({
    endpoint: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', presets: PRESETS,
  }).mismatch, false);
});

test('evaluate: custom relay host → pass (never break multi-vendor relay)', () => {
  const v = G.evaluateRelayRequest({
    endpoint: 'https://your-relay.example.com/v1', model: 'agnes-2.0-flash', presets: PRESETS,
  });
  assert.strictEqual(v.mismatch, false);
  assert.strictEqual(v.reason, 'insufficient-signal');
});

test('evaluate: known endpoint + unknown model family → pass', () => {
  assert.strictEqual(G.evaluateRelayRequest({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'some-unknown-model', presets: PRESETS,
  }).mismatch, false);
});

test('evaluate: fail-soft on hostile inputs, never throws', () => {
  assert.doesNotThrow(() => G.evaluateRelayRequest());
  assert.doesNotThrow(() => G.evaluateRelayRequest({ endpoint: {}, model: [], presets: 'nope' }));
  assert.strictEqual(G.evaluateRelayRequest({ endpoint: 42, model: 42, presets: null }).mismatch, false);
});

// ── hint(可执行、无密钥) ──
test('buildMismatchHint: names both vendors, suggests correct endpoint, no secret', () => {
  const hint = G.buildMismatchHint({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'agnes-2.0-flash',
    endpointVendor: 'zhipu',
    modelVendor: 'agnes',
    presets: PRESETS,
  }, {});
  assert.match(hint, /zhipu/);
  assert.match(hint, /agnes/);
  assert.match(hint, /apihub\.agnes-ai\.com/); // 建议正确端点
  assert.match(hint, /RELAY_API_ENDPOINT/);
  assert.doesNotMatch(hint, /sk-/); // key 本体绝不出现
});

test('buildMismatchHint: gate off → "" (no injection)', () => {
  const hint = G.buildMismatchHint({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'agnes-2.0-flash',
    endpointVendor: 'zhipu', modelVendor: 'agnes', presets: PRESETS,
  }, { KHY_RELAY_VENDOR_GUARD: 'off' });
  assert.strictEqual(hint, '');
});

// ── 真实 providerPresets 派生(证明内建 agnes/zhipu preset 确实触发) ──
test('real providerPresets: bigmodel + agnes-2.0-flash is a mismatch', () => {
  const presets = require('../../../src/services/gateway/providerPresets').getProviderPresets();
  const v = G.evaluateRelayRequest({
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'agnes-2.0-flash',
    presets,
  });
  assert.strictEqual(v.mismatch, true);
  assert.strictEqual(v.endpointVendor, 'zhipu');
  assert.strictEqual(v.modelVendor, 'agnes');
});

// ── 接线:relayApiAdapter.generate 在错配时发请求前短路(不触网络) ──
test('wiring: relayApiAdapter.generate short-circuits on vendor mismatch (no network)', async () => {
  const adapter = require('../../../src/services/gateway/adapters/relayApiAdapter');
  const saved = {
    ep: process.env.RELAY_API_ENDPOINT,
    key: process.env.RELAY_API_KEY,
    model: process.env.RELAY_API_MODEL,
    fb: process.env.RELAY_API_ENDPOINT_FALLBACKS,
    guard: process.env.KHY_RELAY_VENDOR_GUARD,
  };
  process.env.RELAY_API_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4';
  process.env.RELAY_API_KEY = 'sk-fake-placeholder-not-a-real-key';
  delete process.env.RELAY_API_MODEL;
  delete process.env.RELAY_API_ENDPOINT_FALLBACKS;
  delete process.env.KHY_RELAY_VENDOR_GUARD; // default on
  try {
    const res = await adapter.generate('hello', { model: 'agnes-2.0-flash' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorType, 'model_not_found');
    assert.ok(Array.isArray(res.attempts) && res.attempts[0] && res.attempts[0].error === 'vendor_mismatch',
      'attempt should be marked vendor_mismatch (proves preflight short-circuit, not a network failure)');
    assert.match(String(res.error), /agnes/);
    assert.match(String(res.error), /zhipu/);
  } finally {
    for (const [k, v] of [
      ['RELAY_API_ENDPOINT', saved.ep], ['RELAY_API_KEY', saved.key],
      ['RELAY_API_MODEL', saved.model], ['RELAY_API_ENDPOINT_FALLBACKS', saved.fb],
      ['KHY_RELAY_VENDOR_GUARD', saved.guard],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
