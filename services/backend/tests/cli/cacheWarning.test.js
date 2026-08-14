'use strict';

// cacheWarning 契约测试 — 纯叶子(缓存命中率警告)。对齐 CC src/utils/cacheWarning.ts
// calculateCacheHitRate / threshold=80 / trend / 首观抑制。零 IO 零网络。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/cacheWarning');

test('cacheWarningEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.cacheWarningEnabled({}), true);
  assert.strictEqual(leaf.cacheWarningEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.cacheWarningEnabled({ KHY_CACHE_WARNING: off }), false, `应关: ${off}`);
  }
});

test('getCacheThreshold:默认 80,env 覆盖须在 1..100 内否则回退', () => {
  assert.strictEqual(leaf.getCacheThreshold({}), 80);
  assert.strictEqual(leaf.DEFAULT_CACHE_THRESHOLD, 80);
  assert.strictEqual(leaf.getCacheThreshold({ KHY_CACHE_THRESHOLD: '90' }), 90);
  assert.strictEqual(leaf.getCacheThreshold({ KHY_CACHE_THRESHOLD: '0' }), 80, '<1 越界回退');
  assert.strictEqual(leaf.getCacheThreshold({ KHY_CACHE_THRESHOLD: '150' }), 80, '>100 越界回退');
  assert.strictEqual(leaf.getCacheThreshold({ KHY_CACHE_THRESHOLD: 'x' }), 80, '非数回退');
});

test('calculateCacheHitRate:read/(input+write+read)*100(对齐 CC 三段口径)', () => {
  // read=800, write=0, input=200 → 800/1000 = 80%
  assert.strictEqual(
    leaf.calculateCacheHitRate({ inputTokens: 200, cacheWriteInputTokens: 0, cacheReadInputTokens: 800 }),
    80,
  );
  // read=300, write=100, input=100 → 300/500 = 60%
  assert.strictEqual(
    leaf.calculateCacheHitRate({ inputTokens: 100, cacheWriteInputTokens: 100, cacheReadInputTokens: 300 }),
    60,
  );
});

test('calculateCacheHitRate:两缓存段全 0 → null(无缓存数据,对齐 CC)', () => {
  assert.strictEqual(
    leaf.calculateCacheHitRate({ inputTokens: 500, cacheWriteInputTokens: 0, cacheReadInputTokens: 0 }),
    null,
  );
  assert.strictEqual(leaf.calculateCacheHitRate({ inputTokens: 500 }), null, '缺缓存字段 → null');
  assert.strictEqual(leaf.calculateCacheHitRate(null), null);
  assert.strictEqual(leaf.calculateCacheHitRate(undefined), null);
  assert.strictEqual(leaf.calculateCacheHitRate('x'), null);
});

test('calculateCacheHitRate:容忍 CC 原生 snake_case 字段', () => {
  assert.strictEqual(
    leaf.calculateCacheHitRate({ input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 }),
    80,
  );
});

test('evaluateCacheWarning:趋势=hitRate-lastHitRate·首观(null)→trend null·<阈值→shouldWarn', () => {
  assert.deepStrictEqual(
    leaf.evaluateCacheWarning({ hitRate: 42, lastHitRate: null, threshold: 80 }),
    { shouldWarn: true, trend: null },
  );
  assert.deepStrictEqual(
    leaf.evaluateCacheWarning({ hitRate: 42, lastHitRate: 55, threshold: 80 }),
    { shouldWarn: true, trend: -13 },
  );
  assert.deepStrictEqual(
    leaf.evaluateCacheWarning({ hitRate: 90, lastHitRate: 80, threshold: 80 }),
    { shouldWarn: false, trend: 10 },
  );
  assert.strictEqual(leaf.evaluateCacheWarning({ hitRate: null, lastHitRate: 50, threshold: 80 }).shouldWarn, false);
});

test('buildCacheWarningLine:CC 文案对齐·趋势仅 |trend|>0.1 才显·↑/↓ 箭头', () => {
  assert.strictEqual(
    leaf.buildCacheWarningLine({ hitRate: 42, threshold: 80, trend: null }),
    '缓存命中率 42%,低于 80% 阈值',
  );
  assert.strictEqual(
    leaf.buildCacheWarningLine({ hitRate: 42, threshold: 80, trend: -13 }),
    '缓存命中率 42%,低于 80% 阈值(↓13%)',
  );
  assert.strictEqual(
    leaf.buildCacheWarningLine({ hitRate: 42, threshold: 80, trend: 5 }),
    '缓存命中率 42%,低于 80% 阈值(↑5%)',
  );
  // |trend| <= 0.1 → 不显趋势段(对齐 CC 守卫)
  assert.strictEqual(
    leaf.buildCacheWarningLine({ hitRate: 42, threshold: 80, trend: 0.05 }),
    '缓存命中率 42%,低于 80% 阈值',
  );
});

test('cacheWarningFor:首观只播种(text null,回 hitRate)', () => {
  const r = leaf.cacheWarningFor(
    { usage: { inputTokens: 800, cacheWriteInputTokens: 0, cacheReadInputTokens: 200 }, lastHitRate: null },
    {},
  );
  // 200/1000 = 20%
  assert.strictEqual(r.hitRate, 20);
  assert.strictEqual(r.text, null, '首观不警告');
});

test('cacheWarningFor:低于阈值且有基线 → 警告串带趋势', () => {
  const r = leaf.cacheWarningFor(
    { usage: { inputTokens: 800, cacheWriteInputTokens: 0, cacheReadInputTokens: 200 }, lastHitRate: 50 },
    {},
  );
  assert.strictEqual(r.hitRate, 20);
  assert.strictEqual(r.text, '缓存命中率 20%,低于 80% 阈值(↓30%)');
});

test('cacheWarningFor:高于阈值 → text null(仍回 hitRate 供下回合趋势)', () => {
  const r = leaf.cacheWarningFor(
    { usage: { inputTokens: 100, cacheWriteInputTokens: 0, cacheReadInputTokens: 900 }, lastHitRate: 70 },
    {},
  );
  assert.strictEqual(r.hitRate, 90);
  assert.strictEqual(r.text, null);
});

test('cacheWarningFor:无缓存数据 → null(caller 不动 state)', () => {
  assert.strictEqual(
    leaf.cacheWarningFor({ usage: { inputTokens: 500 }, lastHitRate: 50 }, {}),
    null,
  );
});

test('cacheWarningFor:门控关 → null(字节回退),即便命中率低', () => {
  assert.strictEqual(
    leaf.cacheWarningFor(
      { usage: { inputTokens: 900, cacheWriteInputTokens: 0, cacheReadInputTokens: 100 }, lastHitRate: 90 },
      { KHY_CACHE_WARNING: '0' },
    ),
    null,
  );
});

test('防呆:坏输入绝不抛,返回 null', () => {
  assert.doesNotThrow(() => leaf.cacheWarningFor(null, {}));
  assert.strictEqual(leaf.cacheWarningFor(null, {}), null);
  assert.strictEqual(leaf.cacheWarningFor(undefined, {}), null);
  assert.strictEqual(leaf.cacheWarningFor({ usage: 12345 }, {}), null);
});

// ── 缓存前缀击穿归因(prefixAttributionFor)——承 constants/promptPrefixShape 叶子接线 ──
const fs = require('fs');
const path = require('path');
const _pps = require('../../src/constants/promptPrefixShape');

const _SYS_A = 'You are khy. Static prefix.';
const _SYS_B = 'You are khy. Static prefix. NOW 2026-07-13';
const _TOOLS = [
  { name: 'Read', description: 'read', input_schema: { type: 'object' } },
  { name: 'Bash', description: 'run', input_schema: { type: 'object' } },
];

test('prefixAttributionFor:首观(prevShape 空)→ text:null,回带 shape', () => {
  const cur = _pps.captureShape({ system: _SYS_A, tools: _TOOLS }, {});
  const r = leaf.prefixAttributionFor({ curShape: cur, prevShape: null }, {});
  assert.ok(r, '有 curShape 应返回对象');
  assert.strictEqual(r.text, null, '首观不归因');
  assert.deepStrictEqual(r.shape, cur, '回带本轮 shape 供下轮做 prev');
});

test('prefixAttributionFor:系统提示变 → text 含「系统提示」', () => {
  const prev = _pps.captureShape({ system: _SYS_A, tools: _TOOLS }, {});
  const cur = _pps.captureShape({ system: _SYS_B, tools: _TOOLS }, {});
  const r = leaf.prefixAttributionFor({ curShape: cur, prevShape: prev }, {});
  assert.ok(r && typeof r.text === 'string');
  assert.match(r.text, /系统提示/);
});

test('prefixAttributionFor:前缀未变 → text:null(命中,不打扰)', () => {
  const prev = _pps.captureShape({ system: _SYS_A, tools: _TOOLS }, {});
  const cur = _pps.captureShape({ system: _SYS_A, tools: _TOOLS }, {});
  const r = leaf.prefixAttributionFor({ curShape: cur, prevShape: prev }, {});
  assert.ok(r);
  assert.strictEqual(r.text, null);
});

test('prefixAttributionFor:门控 KHY_CACHE_PREFIX_SHAPE 关 → null(逐字节回退)', () => {
  const cur = _pps.captureShape({ system: _SYS_A, tools: _TOOLS }, {});
  assert.strictEqual(leaf.prefixAttributionFor({ curShape: cur, prevShape: null }, { KHY_CACHE_PREFIX_SHAPE: 'off' }), null);
});

test('prefixAttributionFor:无 curShape / 坏输入 → null,绝不抛', () => {
  assert.doesNotThrow(() => leaf.prefixAttributionFor(null, {}));
  assert.strictEqual(leaf.prefixAttributionFor(null, {}), null);
  assert.strictEqual(leaf.prefixAttributionFor({ curShape: null }, {}), null);
  assert.strictEqual(leaf.prefixAttributionFor({ curShape: 12345 }, {}), null);
});

test('接线断言:aiGatewayGenerateMethod 在 finishResult 挂 result.prefixShape', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'gateway', 'aiGatewayGenerateMethod.js'), 'utf8');
  assert.match(src, /promptPrefixShape/, '应 require prefixShape 叶子');
  assert.match(src, /result\.prefixShape\s*=\s*_shape/, '应把快照挂到 result.prefixShape');
});

test('接线断言:replSession 命中率低时调 prefixAttributionFor 并持 _lastPrefixShape', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'replSession.js'), 'utf8');
  assert.match(src, /prefixAttributionFor/, '应调用归因');
  assert.match(src, /_lastPrefixShape/, '应持跨回合前缀基线');
  assert.match(src, /result\.prefixShape/, '应读取本轮 shape');
});
