'use strict';

/**
 * wildcardPoolGuard.test.js — api 通配兜底守卫(纯叶子)。
 *
 * 用户实测复现:`agnes-2.0-flash`(裸模型名,无 `:`/`/`)→ `api` 通道 pool 解析显式/scoped 全落空
 * → 盲落通配 GATEWAY_API_POOL_PROVIDER=relay(→glm 服务,端点 open.bigmodel.cn)→ 400 code 1211
 * 「模型不存在」。agnes 明明是已登记 provider preset,但运行时池无 agnes 池。本套件锁死叶子契约:
 *   - evaluateWildcardModel:厂商=已知 preset & 无运行时池 & ≠通配池 → mismatch(拦截);
 *     厂商=通配池本身 / 厂商有运行时池 / 厂商非已知 preset / 信号不足 → 放行(保守不误伤);
 *   - buildUnregisteredModelHint:门开出清晰指引(含 pool:model),门关出 '',绝不含 key;
 *   - 门控 KHY_WILDCARD_POOL_GUARD 默认开,off 值(0/false/off/no)→ 关;
 *   - 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  extractVendorPrefix,
  evaluateWildcardModel,
  buildUnregisteredModelHint,
  describeWildcardPoolGuard,
} = require('../../../src/services/gateway/wildcardPoolGuard');

// 复用真实现场:agnes 是已登记 preset,运行时池只有 sensenova/glm/example-provider。
const PRESET_IDS = ['openai', 'anthropic', 'gemini', 'vertex', 'deepseek', 'agnes', 'zhipu', 'moonshot', 'qwen'];
const REGISTERED_POOLS = ['sensenova', 'glm', 'example-provider'];

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_WILDCARD_POOL_GUARD: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(isEnabled({ KHY_WILDCARD_POOL_GUARD: v }), false, v);
  }
});

test('extractVendorPrefix: leading token before first separator, lowercased', () => {
  assert.strictEqual(extractVendorPrefix('agnes-2.0-flash'), 'agnes');
  assert.strictEqual(extractVendorPrefix('GLM-4.6'), 'glm');
  assert.strictEqual(extractVendorPrefix('gpt-4o'), 'gpt');
  assert.strictEqual(extractVendorPrefix('deepseek.chat'), 'deepseek');
  assert.strictEqual(extractVendorPrefix('qwen:max'), 'qwen');
  assert.strictEqual(extractVendorPrefix('solo'), 'solo');
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.strictEqual(extractVendorPrefix(bad), '', String(bad));
  }
});

test('evaluateWildcardModel: THE bug — agnes preset without pool ≠ wildcard → mismatch', () => {
  const v = evaluateWildcardModel({
    model: 'agnes-2.0-flash',
    wildcardPool: 'relay',
    knownPresetIds: PRESET_IDS,
    registeredPools: REGISTERED_POOLS,
  });
  assert.strictEqual(v.mismatch, true);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.vendor, 'agnes');
});

test('evaluateWildcardModel: vendor IS the wildcard pool → pass through', () => {
  const v = evaluateWildcardModel({
    model: 'relay-something',
    wildcardPool: 'relay',
    knownPresetIds: PRESET_IDS,
    registeredPools: REGISTERED_POOLS,
  });
  assert.strictEqual(v.mismatch, false);
  assert.strictEqual(v.ok, true);
});

test('evaluateWildcardModel: vendor has a registered runtime pool → pass through', () => {
  // glm is both a preset (zhipu id differs) and a real pool → must never be blocked.
  const v = evaluateWildcardModel({
    model: 'glm-4.6',
    wildcardPool: 'relay',
    knownPresetIds: [...PRESET_IDS, 'glm'],
    registeredPools: REGISTERED_POOLS,
  });
  assert.strictEqual(v.mismatch, false);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, 'vendor-has-registered-pool');
});

test('evaluateWildcardModel: vendor not a known preset → pass through (could be wildcard family)', () => {
  // gpt-4o under a relay/openai wildcard: gpt is not necessarily a preset id here → do not block.
  const v = evaluateWildcardModel({
    model: 'gpt-4o',
    wildcardPool: 'relay',
    knownPresetIds: ['agnes', 'zhipu'], // gpt intentionally absent
    registeredPools: REGISTERED_POOLS,
  });
  assert.strictEqual(v.mismatch, false);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reason, 'vendor-not-a-known-preset');
});

test('evaluateWildcardModel: insufficient signal (no model / no vendor / no wildcard) → pass through', () => {
  assert.strictEqual(evaluateWildcardModel({ model: '', wildcardPool: 'relay', knownPresetIds: PRESET_IDS }).mismatch, false);
  assert.strictEqual(evaluateWildcardModel({ model: 'agnes-2.0-flash', wildcardPool: '', knownPresetIds: PRESET_IDS }).mismatch, false);
  assert.strictEqual(evaluateWildcardModel({ model: '---', wildcardPool: 'relay', knownPresetIds: PRESET_IDS }).mismatch, false);
});

test('evaluateWildcardModel: never throws on garbage input', () => {
  assert.doesNotThrow(() => evaluateWildcardModel());
  assert.doesNotThrow(() => evaluateWildcardModel({ model: 42, wildcardPool: {}, knownPresetIds: null, registeredPools: 7 }));
  const v = evaluateWildcardModel(null);
  assert.strictEqual(v.mismatch, false);
});

test('buildUnregisteredModelHint: gate-on → clear actionable guidance incl pool:model; gate-off → empty', () => {
  const on = buildUnregisteredModelHint({ model: 'agnes-2.0-flash', vendor: 'agnes' }, {});
  assert.match(on, /agnes-2\.0-flash/);
  assert.match(on, /未登记/);
  assert.match(on, /agnes:agnes-2\.0-flash/); // pool:model form suggested
  const off = buildUnregisteredModelHint({ model: 'agnes-2.0-flash', vendor: 'agnes' }, { KHY_WILDCARD_POOL_GUARD: '0' });
  assert.strictEqual(off, '');
  // never throws / empty model → ''
  assert.strictEqual(buildUnregisteredModelHint({ model: '' }, {}), '');
  assert.doesNotThrow(() => buildUnregisteredModelHint());
});

test('describeWildcardPoolGuard: self-describing metadata', () => {
  const d = describeWildcardPoolGuard();
  assert.strictEqual(d.gate, 'KHY_WILDCARD_POOL_GUARD');
  assert.strictEqual(d.defaultOn, true);
  assert.match(d.summary, /通配|wildcard/i);
});
