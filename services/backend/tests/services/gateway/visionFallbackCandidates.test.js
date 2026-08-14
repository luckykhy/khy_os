'use strict';

/**
 * visionFallbackCandidates.test.js — 备用视觉模型候选枚举纯叶子契约 SSoT(node:test)。
 *
 * 背景:describe-and-return 主视觉模型描述失败时,旧行为静默切回**同一失败模型**→ 必然二次
 * 失败。用户诉求「路由模型不能用应由文本模型说明原因,并且可以帮忙替换」→ 二次确认「两者都要」:
 * 先自动试备用视觉模型。本叶子只负责「给定失败模型 + 环境,枚举可再试的备用视觉模型」。
 *
 * 锁死契约(全部经注入 deps,零真实 IO):
 *   - GLM 视觉 pin 优先(有 key)、其后各 provider 视觉可用 models;
 *   - 排除 failedModel(去前缀裸 id 比对,`glm/x` ≡ `x`);
 *   - 仅收「pool 有可用 key」的候选;剔除非视觉模型;去重且保序;
 *   - 绝不抛:任何 deps 抛错 → `[]`。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  collectVisionFallbackCandidates,
  _bareId,
} = require('../../../src/services/gateway/visionFallbackCandidates');

// 便于构造 deps 的 stub 工厂:两个 provider,一有 key 一无 key。
function makeDeps(overrides = {}) {
  const providers = overrides.providers || [
    {
      name: 'zhipu', poolKey: 'glm', endpoint: 'x', defaultModel: 'glm-4', serviceType: 'openai',
      models: ['glm-4.6v-flash', 'glm-4-plain'],
    },
    {
      name: 'openai', poolKey: 'openai', endpoint: 'y', defaultModel: 'gpt-4o', serviceType: 'openai',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
  ];
  const keyedPools = overrides.keyedPools || new Set(['openai']); // 默认只有 openai 有 key
  const visionModels = overrides.visionModels || new Set(['glm-4.6v-flash', 'gpt-4o']);
  return {
    listProviders: overrides.listProviders || (() => providers),
    hasAvailableKeys: overrides.hasAvailableKeys || ((pool) => keyedPools.has(pool)),
    isVisionCapable: overrides.isVisionCapable || ((id) => visionModels.has(String(id))),
    // 默认关掉 GLM pin,让 provider 枚举独立可测;需要时单测覆盖。
    glmPin: overrides.glmPin || (() => null),
  };
}

test('_bareId:去 provider 前缀取裸 id(小写),空/null → 空串', () => {
  assert.strictEqual(_bareId('glm/glm-4.6v-flash'), 'glm-4.6v-flash');
  assert.strictEqual(_bareId('GLM-4.6V-Flash'), 'glm-4.6v-flash');
  assert.strictEqual(_bareId('a/b/c'), 'c');
  assert.strictEqual(_bareId(''), '');
  assert.strictEqual(_bareId(null), '');
  assert.strictEqual(_bareId(undefined), '');
});

test('只返「pool 有 key」的视觉模型,剔除无 key pool 与非视觉模型', () => {
  const deps = makeDeps(); // 仅 openai 有 key;视觉:glm-4.6v-flash、gpt-4o
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-6.7-flash-lite', env: {}, deps });
  // glm pool 无 key → glm-4.6v-flash 不收;openai 有 key → gpt-4o 收、gpt-4o-mini 非视觉剔除
  assert.deepStrictEqual(out, [{ model: 'gpt-4o', poolHint: 'openai' }]);
});

test('排除 failedModel(裸 id 比对,容忍前缀差异)', () => {
  const deps = makeDeps({ keyedPools: new Set(['glm', 'openai']) });
  // 失败模型带前缀 glm/glm-4.6v-flash,provider 里是裸 glm-4.6v-flash → 应被排除
  const out = collectVisionFallbackCandidates({ failedModel: 'glm/glm-4.6v-flash', env: {}, deps });
  assert.deepStrictEqual(out, [{ model: 'gpt-4o', poolHint: 'openai' }]);
});

test('GLM pin 优先排在最前(有 key 才收)', () => {
  const deps = makeDeps({
    keyedPools: new Set(['glm', 'openai']),
    glmPin: () => ({ model: 'glm-4.6v-flash', poolHint: 'glm' }),
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  assert.strictEqual(out[0].model, 'glm-4.6v-flash');
  assert.strictEqual(out[0].poolHint, 'glm');
  // gpt-4o 仍在其后
  assert.ok(out.some((c) => c.model === 'gpt-4o'));
});

test('GLM pin 无 key → 不收(诚实:无 key 绝不路由)', () => {
  const deps = makeDeps({
    keyedPools: new Set(['openai']), // glm 无 key
    glmPin: () => ({ model: 'glm-4.6v-flash', poolHint: 'glm' }),
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  assert.ok(!out.some((c) => c.model === 'glm-4.6v-flash'), 'glm pin 无 key 不应出现');
});

test('去重(裸 id):GLM pin 与 provider 里同一模型只出现一次', () => {
  const deps = makeDeps({
    keyedPools: new Set(['glm', 'openai']),
    glmPin: () => ({ model: 'glm-4.6v-flash', poolHint: 'glm' }),
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  const glmCount = out.filter((c) => _bareId(c.model) === 'glm-4.6v-flash').length;
  assert.strictEqual(glmCount, 1);
});

test('fail-soft:listProviders 抛错 → [](绝不外抛)', () => {
  const deps = makeDeps({
    listProviders: () => { throw new Error('registry boom'); },
    glmPin: () => null,
  });
  assert.deepStrictEqual(collectVisionFallbackCandidates({ failedModel: 'x', env: {}, deps }), []);
});

test('fail-soft:hasAvailableKeys / isVisionCapable 抛错 → 该项跳过,不外抛', () => {
  const deps = makeDeps({
    keyedPools: new Set(['openai']),
    hasAvailableKeys: (pool) => { if (pool === 'glm') throw new Error('pool boom'); return pool === 'openai'; },
    isVisionCapable: (id) => { if (id === 'gpt-4o-mini') throw new Error('cap boom'); return id === 'gpt-4o'; },
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'x', env: {}, deps });
  assert.deepStrictEqual(out, [{ model: 'gpt-4o', poolHint: 'openai' }]);
});

test('无参 / 空对象调用 → 绝不抛,恒返数组(用真实默认 deps,不假设内容)', () => {
  // 无 deps → 内部 require 真实模块。断言仅锁「绝不抛 + 恒数组」契约;
  // 内容取决于本机实际配置的 key/provider,不在纯叶子单测断言范围。
  assert.ok(Array.isArray(collectVisionFallbackCandidates()));
  assert.ok(Array.isArray(collectVisionFallbackCandidates({})));
  // 注入空 provider + 无 GLM pin → 确定性 []
  const emptyDeps = { listProviders: () => [], hasAvailableKeys: () => false, isVisionCapable: () => false, glmPin: () => null };
  assert.deepStrictEqual(collectVisionFallbackCandidates({ failedModel: 'x', env: {}, deps: emptyDeps }), []);
});

test('保序:GLM pin → provider 声明序;跨 provider 多视觉模型全收', () => {
  const deps = makeDeps({
    providers: [
      { poolKey: 'glm', models: ['glm-4.6v-flash'] },
      { poolKey: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
    ],
    keyedPools: new Set(['glm', 'openai']),
    visionModels: new Set(['glm-4.6v-flash', 'gpt-4o', 'gpt-4o-mini']),
    glmPin: () => null,
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  assert.deepStrictEqual(out.map((c) => c.model), ['glm-4.6v-flash', 'gpt-4o', 'gpt-4o-mini']);
});

test('降级链:glmPin 返回有序数组 → 全部按序收(有 key,共用一次 glm 判定)', () => {
  const deps = makeDeps({
    keyedPools: new Set(['glm', 'openai']),
    glmPin: () => [
      { model: 'glm-4.6v-flash', poolHint: 'glm' },
      { model: 'glm-4v-flash', poolHint: 'glm' },
    ],
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  // 两个 GLM 视觉模型按序排最前,其后才是 provider 里 openai 的 gpt-4o
  assert.strictEqual(out[0].model, 'glm-4.6v-flash');
  assert.strictEqual(out[1].model, 'glm-4v-flash');
  assert.ok(out.every((c) => c.poolHint === 'glm' || c.model === 'gpt-4o'));
});

test('降级链核心:主 glm-4.6v-flash 失败 → 次选 glm-4v-flash 仍被提供(主被排除)', () => {
  // 失败模型带前缀,provider 里是裸 id;降级链数组含主+次选,主选按裸 id 排除、次选保留。
  const deps = makeDeps({
    keyedPools: new Set(['glm']),
    providers: [{ poolKey: 'glm', models: [] }], // provider 侧无补充,候选全来自降级链
    glmPin: () => [
      { model: 'glm-4.6v-flash', poolHint: 'glm' },
      { model: 'glm-4v-flash', poolHint: 'glm' },
    ],
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'glm/glm-4.6v-flash', env: {}, deps });
  assert.deepStrictEqual(out, [{ model: 'glm-4v-flash', poolHint: 'glm' }]);
});

test('降级链 glm 无 key → 整条链都不收(诚实:无 key 绝不路由)', () => {
  const deps = makeDeps({
    keyedPools: new Set(['openai']), // glm 无 key
    glmPin: () => [
      { model: 'glm-4.6v-flash', poolHint: 'glm' },
      { model: 'glm-4v-flash', poolHint: 'glm' },
    ],
  });
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-x', env: {}, deps });
  assert.ok(!out.some((c) => c.poolHint === 'glm'), 'glm 无 key 时降级链不应出现任何 glm 候选');
});

test('默认 deps(glmVisionModel 降级链)集成:glm 有 key + 失败非 glm → 主+次选按序在最前', () => {
  // 不注入 glmPin,走真实 _defaultGlmPin → glmVisionCandidatePins;仅注入 has-key/providers 隔离。
  const deps = {
    listProviders: () => [],
    hasAvailableKeys: (pool) => pool === 'glm',
    isVisionCapable: () => false,
    // glmPin 不注入 → 用默认(读 glmVisionModel)
  };
  const out = collectVisionFallbackCandidates({ failedModel: 'sensenova-6.7-flash-lite', env: {}, deps });
  assert.deepStrictEqual(out, [
    { model: 'glm-4.6v-flash', poolHint: 'glm' },
    { model: 'glm-4v-flash', poolHint: 'glm' },
  ]);
});
