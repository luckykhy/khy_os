'use strict';

/**
 * glmAdaptationWiring.test.js — GLM-5.2 适配的三处接线 + OpenAI thinking 透传。
 *
 * 锁死:
 *   1. providerPresets.getProviderPresets() zhipu 条目:门开 → defaultModel/​models 收敛到 glm-5.2 打头;
 *      门关 → 逐字节回退静态 preset(glm-4 默认 / 空 models)。
 *   2. builtinProviderConfig list/find:门开 → glm 条目 models 以 glm-5.2 打头;门关 → 历史 glm-4 清单。
 *   3. _protocolPipeline OpenAI 请求体:门开(KHY_OPENAI_THINKING_PASSTHROUGH)→ 透传 thinking;
 *      门关 → 丢弃(逐字节回退历史「只透传 reasoning_effort」)。
 * 模块均在**调用时**读 env,故直接切 process.env 即可(无需清 require 缓存)。
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const GLM_KEY = 'KHY_GLM_LATEST_MODEL';
const THINK_KEY = 'KHY_OPENAI_THINKING_PASSTHROUGH';
let saved;

beforeEach(() => { saved = { glm: process.env[GLM_KEY], think: process.env[THINK_KEY] }; });
afterEach(() => {
  if (saved.glm === undefined) delete process.env[GLM_KEY]; else process.env[GLM_KEY] = saved.glm;
  if (saved.think === undefined) delete process.env[THINK_KEY]; else process.env[THINK_KEY] = saved.think;
});

// ── 1. providerPresets ─────────────────────────────────────────────────────
test('providerPresets: gate-on zhipu → glm-5.2 default + list leads with glm-5.2', () => {
  delete process.env[GLM_KEY]; // default-on
  const { getProviderPresets } = require('../../src/services/gateway/providerPresets');
  const zhipu = getProviderPresets().find((p) => p.id === 'zhipu');
  assert.ok(zhipu);
  assert.equal(zhipu.defaultModel, 'glm-5.2');
  assert.equal(zhipu.models[0], 'glm-5.2');
});

test('providerPresets: gate-off zhipu → byte-reverts to static glm-4 default + empty models', () => {
  process.env[GLM_KEY] = 'off';
  const { getProviderPresets } = require('../../src/services/gateway/providerPresets');
  const zhipu = getProviderPresets().find((p) => p.id === 'zhipu');
  assert.ok(zhipu);
  assert.equal(zhipu.defaultModel, 'glm-4');
  assert.deepEqual(zhipu.models, []);
});

// ── 2. builtinProviderConfig ───────────────────────────────────────────────
test('builtinProviderConfig: gate-on glm → models lead with glm-5.2 (list + find)', () => {
  delete process.env[GLM_KEY];
  const { listBuiltinProviders, findBuiltinProvider } = require('../../src/services/gateway/builtinProviderConfig');
  const fromList = listBuiltinProviders().find((p) => p.poolKey === 'glm');
  assert.equal(fromList.models[0], 'glm-5.2');
  const fromFind = findBuiltinProvider('glm');
  assert.equal(fromFind.models[0], 'glm-5.2');
});

test('builtinProviderConfig: gate-off glm → byte-reverts to [glm-4, glm-4-flash, glm-4-air]', () => {
  process.env[GLM_KEY] = '0';
  const { listBuiltinProviders, findBuiltinProvider } = require('../../src/services/gateway/builtinProviderConfig');
  assert.deepEqual(listBuiltinProviders().find((p) => p.poolKey === 'glm').models, ['glm-4', 'glm-4-flash', 'glm-4-air']);
  assert.deepEqual(findBuiltinProvider('智谱 GLM').models, ['glm-4', 'glm-4-flash', 'glm-4-air']);
});

test('builtinProviderConfig: non-glm providers untouched by the gate', () => {
  delete process.env[GLM_KEY];
  const { findBuiltinProvider } = require('../../src/services/gateway/builtinProviderConfig');
  const deepseek = findBuiltinProvider('deepseek');
  assert.deepEqual(deepseek.models, ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner']);
});

// ── 3. OpenAI thinking passthrough ─────────────────────────────────────────
function buildOpenAIBody(options) {
  const { createProtocolHandler } = require('../../src/services/gateway/adapters/_protocolPipeline');
  const handler = createProtocolHandler({ protocol: 'openai', adapterName: 'zhipu' });
  return handler.buildRequestBody('hi', options).body;
}

test('OpenAI path: gate-on forwards request-side thinking (glm-5.2 style)', () => {
  delete process.env[THINK_KEY];
  const body = buildOpenAIBody({ model: 'glm-5.2', thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max'); // pre-existing passthrough intact
});

test('OpenAI path: gate-off drops thinking (byte-reverts), reasoning_effort still flows', () => {
  process.env[THINK_KEY] = 'false';
  const body = buildOpenAIBody({ model: 'glm-5.2', thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, 'max');
});

test('OpenAI path: no thinking option → no thinking field either way', () => {
  delete process.env[THINK_KEY];
  const body = buildOpenAIBody({ model: 'glm-5.2' });
  assert.equal(body.thinking, undefined);
});
