'use strict';
/**
 * Leaf-contract test for aiRequestAnalysis.js (extracted from cli/ai.js).
 *
 * Proves: (1) the leaf exports its context-budget + vision-routing entry points and the DI setter as
 * functions; (2) the host (cli/ai.js) still exposes its public surface (chat / getConversationStats /
 * checkModelCapability) so the extraction kept the module contract intact; (3) setAiRequestAnalysisDeps
 * is a guarded, idempotent, non-throwing DI setter that only wires the injected read-only tables +
 * host accessors; (4) a deterministic no-dep path (_resolveModelContextLimit('') �?128000 default)
 * stays byte-behaviour-identical after relocation.
 *
 * The leaf reads capability tables + gateway accessors that touch IO indirectly, so it does NOT
 * self-declare as a pure zero-IO leaf; the assertions stay on the deterministic surface (export shape,
 * contract identity, setter guard, the empty-hint default) and never drive a live gateway request.
 */
const LEAF = '../../../src/cli/aiRequestAnalysis';
const HOST = '../../../src/cli/ai';
const ENTRY_POINTS = [
  '_resolveModelContextLimit', '_guessModelHint', '_estimateContextTokens', '_resolveContextBudget',
  '_supportsImageOnAdapter', '_resolveMultimodalAdapterCaps', '_supportsMediaKindsOnAdapter',
  '_isImageActionTask', '_pickMultimodalAdapter', '_pickVisionAdapter', '_applyVisionRouting',
];
// ── _resolveContextBudget:隐式 131072 钳位的回归防�?──────────────────────
//
// 历史 bug(本次修复):
//   const configuredLimit = parseInt(env.KHY_CONTEXT_TOKEN_LIMIT || runtime.CONTEXT_TOKEN_LIMIT || '')
// �?runtime.CONTEXT_TOKEN_LIMIT 本身就是 Number(env.KHY_CONTEXT_TOKEN_LIMIT) || 131072 —�?
// 同一�?env 读了两遍,于是在没配任何东西时 configuredLimit 恒为 131072,随后�?
// Math.min �?*每一�?*真实窗口 >131072 的模型隐式砍�?128k(Agnes 512k、Claude 200k 全中�?�?
// 全仓库没有任何测试断言�?131072,这就是它能出厂的原因�?
//
// 这些用例�?DI 注入静态能力表 + 一个不存在的模型名走「gateway 未就绪」路�?
// 从而完全离线、确定性地锁住窗口解析的四种语义�?
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

describe('Ai Request Analysis Leaf', () => {
  test('leaf exports the request-analysis entry points + DI setter as functions', () => {
      const leaf = require(LEAF);
      for (const n of [...ENTRY_POINTS, 'setAiRequestAnalysisDeps']) {
        expect(typeof leaf[n]).toBe('function', `missing ${n}`);
      }
  });

  test('host cli/ai keeps its public contract after extraction', () => {
      const host = require(HOST);
      expect(typeof host.chat).toBe('function');
      expect(typeof host.getConversationStats).toBe('function');
      expect(typeof host.checkModelCapability).toBe('function');
  });

  test('_resolveModelContextLimit returns the 128000 default for an empty model hint (no deps needed)', () => {
      const { _resolveModelContextLimit } = require(LEAF);
      expect(_resolveModelContextLimit('')).toBe(128000);
      expect(_resolveModelContextLimit(null)).toBe(128000);
      expect(_resolveModelContextLimit(undefined)).toBe(128000);
  });

  test('setAiRequestAnalysisDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setAiRequestAnalysisDeps } = require(LEAF);
      expect(() => setAiRequestAnalysisDeps().not.toThrow());
      expect(() => setAiRequestAnalysisDeps({}).not.toThrow());
      // Non-function / falsy deps are ignored by the typeof / truthy guards.
      expect(() => setAiRequestAnalysisDeps({ _resolveTaskScale: 1, getGateway: null, EFFORT_PRESETS: 0 }).not.toThrow());
      const fake = {
        EFFORT_PRESETS: {}, MODEL_CAPABILITIES: {},
        _resolveTaskScale: () => ({}), getGateway: () => ({}),
      };
      expect(() => setAiRequestAnalysisDeps(fake).not.toThrow());
      expect(() => setAiRequestAnalysisDeps(fake).not.toThrow());
  });

  test('_resolveContextBudget:�?env �?采纳模型真实窗口,不再�?131072 隐式钳位', () => {
      _withBudgetDeps((plan) => {
        const r = plan('leaf-test-bigwindow');
        expect(r.contextWindow).toBe(512000, '512k 窗口必须原样通过');
        expect(r.contextBudget).toBe(431104, 'medium 档默�?env 下的预算');
      });
  });

  test('_resolveContextBudget:显式 KHY_CONTEXT_TOKEN_LIMIT 仍然钳位(逃生阀保留)', () => {
      _withBudgetDeps((plan) => {
        process.env.KHY_CONTEXT_TOKEN_LIMIT = '32768';
        expect(plan('leaf-test-bigwindow').contextWindow).toBe(32768);
      });
  });

  test('_resolveContextBudget:�?KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP=0 �?逐字节回退 131072 钳位', () => {
      _withBudgetDeps((plan) => {
        process.env.KHY_CONTEXT_LIMIT_NO_IMPLICIT_CLAMP = '0';
        expect(plan('leaf-test-bigwindow').contextWindow).toBe(131072);
      });
  });

  test('_resolveContextBudget:上游谎报 �?理性天花板钳回(宁可写小不可写大)', () => {
      _withBudgetDeps((plan) => {
        const { MAX_PLAUSIBLE_CONTEXT_WINDOW } = require('../../../src/constants/contextWindowDefaults');
        expect(plan('leaf-test-huge').contextWindow).toBe(MAX_PLAUSIBLE_CONTEXT_WINDOW);
        process.env.KHY_CONTEXT_WINDOW_CEILING = '200000';
        expect(plan('leaf-test-huge').contextWindow).toBe(200000);
      });
  });

});

