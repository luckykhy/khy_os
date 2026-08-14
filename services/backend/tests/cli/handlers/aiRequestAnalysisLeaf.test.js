'use strict';

/**
 * Leaf-contract test for aiRequestAnalysis.js (extracted from cli/ai.js).
 *
 * Proves: (1) the leaf exports its context-budget + vision-routing entry points and the DI setter as
 * functions; (2) the host (cli/ai.js) still exposes its public surface (chat / getConversationStats /
 * checkModelCapability) so the extraction kept the module contract intact; (3) setAiRequestAnalysisDeps
 * is a guarded, idempotent, non-throwing DI setter that only wires the injected read-only tables +
 * host accessors; (4) a deterministic no-dep path (_resolveModelContextLimit('') → 128000 default)
 * stays byte-behaviour-identical after relocation.
 *
 * The leaf reads capability tables + gateway accessors that touch IO indirectly, so it does NOT
 * self-declare as a pure zero-IO leaf; the assertions stay on the deterministic surface (export shape,
 * contract identity, setter guard, the empty-hint default) and never drive a live gateway request.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../../src/cli/aiRequestAnalysis';
const HOST = '../../../src/cli/ai';

const ENTRY_POINTS = [
  '_resolveModelContextLimit', '_guessModelHint', '_estimateContextTokens', '_resolveContextBudget',
  '_supportsImageOnAdapter', '_resolveMultimodalAdapterCaps', '_supportsMediaKindsOnAdapter',
  '_isImageActionTask', '_pickMultimodalAdapter', '_pickVisionAdapter', '_applyVisionRouting',
];

test('leaf exports the request-analysis entry points + DI setter as functions', () => {
  const leaf = require(LEAF);
  for (const n of [...ENTRY_POINTS, 'setAiRequestAnalysisDeps']) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
});

test('host cli/ai keeps its public contract after extraction', () => {
  const host = require(HOST);
  assert.strictEqual(typeof host.chat, 'function');
  assert.strictEqual(typeof host.getConversationStats, 'function');
  assert.strictEqual(typeof host.checkModelCapability, 'function');
});

test('_resolveModelContextLimit returns the 128000 default for an empty model hint (no deps needed)', () => {
  const { _resolveModelContextLimit } = require(LEAF);
  assert.strictEqual(_resolveModelContextLimit(''), 128000);
  assert.strictEqual(_resolveModelContextLimit(null), 128000);
  assert.strictEqual(_resolveModelContextLimit(undefined), 128000);
});

test('setAiRequestAnalysisDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiRequestAnalysisDeps } = require(LEAF);
  assert.doesNotThrow(() => setAiRequestAnalysisDeps());
  assert.doesNotThrow(() => setAiRequestAnalysisDeps({}));
  // Non-function / falsy deps are ignored by the typeof / truthy guards.
  assert.doesNotThrow(() => setAiRequestAnalysisDeps({ _resolveTaskScale: 1, getGateway: null, EFFORT_PRESETS: 0 }));
  const fake = {
    EFFORT_PRESETS: {}, MODEL_CAPABILITIES: {},
    _resolveTaskScale: () => ({}), getGateway: () => ({}),
  };
  assert.doesNotThrow(() => setAiRequestAnalysisDeps(fake));
  assert.doesNotThrow(() => setAiRequestAnalysisDeps(fake));
});

// ── _resolveContextBudget:隐式 131072 钳位的回归防线 ──────────────────────
//
// 历史 bug(本次修复):
//   const configuredLimit = parseInt(env.KHY_CONTEXT_TOKEN_LIMIT || runtime.CONTEXT_TOKEN_LIMIT || '')
// 而 runtime.CONTEXT_TOKEN_LIMIT 本身就是 Number(env.KHY_CONTEXT_TOKEN_LIMIT) || 131072 ——
// 同一个 env 读了两遍,于是在没配任何东西时 configuredLimit 恒为 131072,随后的
// Math.min 把**每一个**真实窗口 >131072 的模型隐式砍到 128k(Agnes 512k、Claude 200k 全中招)。
// 全仓库没有任何测试断言过 131072,这就是它能出厂的原因。
//
// 这些用例用 DI 注入静态能力表 + 一个不存在的模型名走「gateway 未就绪」路径,
// 从而完全离线、确定性地锁住窗口解析的四种语义。
function _withBudgetDeps(fn) {
  const leaf = require(LEAF);
  const savedEnv = {
    KHY_CONTEXT_TOKEN_LIMIT: process.env.KHY_CONTEXT_TOKEN_LIMIT,
    KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP: process.env.KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP,
    KHY_CONTEXT_WINDOW_CEILING: process.env.KHY_CONTEXT_WINDOW_CEILING,
    GATEWAY_PREFERRED_MODEL: process.env.GATEWAY_PREFERRED_MODEL,
  };
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  leaf.setAiRequestAnalysisDeps({
    EFFORT_PRESETS: { medium: { maxTokens: 8192 } },
    MODEL_CAPABILITIES: { 'leaf-test-bigwindow': { context: 512000 }, 'leaf-test-huge': { context: 9000000 } },
    _resolveTaskScale: () => 'medium',
  });
  try {
    return fn((model) => {
      process.env.GATEWAY_PREFERRED_MODEL = model;
      return leaf._resolveContextBudget({}, { maxTokens: 8192 }, 'hi');
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('_resolveContextBudget:无 env → 采纳模型真实窗口,不再被 131072 隐式钳位', () => {
  _withBudgetDeps((plan) => {
    const r = plan('leaf-test-bigwindow');
    assert.strictEqual(r.contextWindow, 512000, '512k 窗口必须原样通过');
    assert.strictEqual(r.contextBudget, 431104, 'medium 档默认 env 下的预算');
  });
});

test('_resolveContextBudget:显式 KHY_CONTEXT_TOKEN_LIMIT 仍然钳位(逃生阀保留)', () => {
  _withBudgetDeps((plan) => {
    process.env.KHY_CONTEXT_TOKEN_LIMIT = '32768';
    assert.strictEqual(plan('leaf-test-bigwindow').contextWindow, 32768);
  });
});

test('_resolveContextBudget:门 KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP=0 → 逐字节回退 131072 钳位', () => {
  _withBudgetDeps((plan) => {
    process.env.KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP = '0';
    assert.strictEqual(plan('leaf-test-bigwindow').contextWindow, 131072);
  });
});

test('_resolveContextBudget:上游谎报 → 理性天花板钳回(宁可写小不可写大)', () => {
  _withBudgetDeps((plan) => {
    const { MAX_PLAUSIBLE_CONTEXT_WINDOW } = require('../../../src/constants/contextWindowDefaults');
    assert.strictEqual(plan('leaf-test-huge').contextWindow, MAX_PLAUSIBLE_CONTEXT_WINDOW);
    process.env.KHY_CONTEXT_WINDOW_CEILING = '200000';
    assert.strictEqual(plan('leaf-test-huge').contextWindow, 200000);
  });
});
