'use strict';

/**
 * claudeAdapter.oneMContext.test.js — locks the 1M-context beta gating of
 * src/services/gateway/adapters/claudeAdapter.js (the honesty contract between
 * the anthropic-beta header and the effective context window):
 *
 *   - is1MContextActive: model-family gate (opus/sonnet 4.x) × env kill-switch
 *     KHY_BETA_1M_CONTEXT × sticky 400 opt-out (TTL semantics via
 *     __test__.setBetaOptOut / expireBetaOptOut);
 *   - effectiveContextWindow: a Claude model declaring >200k must clamp to
 *     200k unless the context-1m beta is actually being sent;
 *   - buildBetaHeader: which beta tokens ship for T0 vs T1 models, the
 *     KHY_BETA_INTERLEAVED gate, KHY_ANTHROPIC_BETA extras, and the opt-out
 *     stripping;
 *   - defaultThinkingBudget: tier-aware 16000 (T0) vs 10000 (others).
 *
 * Zero network, zero disk. Module state (the sticky opt-out) is controlled
 * through the adapter's `__test__` hooks; env is scrubbed/restored around
 * every test. Who reorders the gate checks or changes the clamp value goes
 * red first.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ENV_KEYS = [
  'KHY_BETA_1M_CONTEXT',
  'KHY_BETA_INTERLEAVED',
  'KHY_ANTHROPIC_BETA',
  'KHY_CAPABILITY_TIER',
  'KHY_MODEL_TIER_MAP',
];

function loadAdapter() {
  jest.resetModules();
  // Pin the persisted runtime-diagnostics store to a throwaway dir so the
  // adapter module never touches a real ~/.khyquant tree on load.
  const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-claude-1m-'));
  process.env.KHY_DATA_HOME = tempDataHome;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  const adapter = require('../../src/services/gateway/adapters/claudeAdapter');
  return { adapter, tempDataHome };
}

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('claudeAdapter 1M-context & beta-header gating (offline)', () => {
  let adapter;
  let tempDataHome;

  beforeEach(() => {
    clearEnv();
    ({ adapter, tempDataHome } = loadAdapter());
    adapter.__test__.setBetaOptOut(false);
  });

  afterEach(() => {
    adapter.destroy();
    clearEnv();
    delete process.env.KHY_DATA_HOME;
    jest.resetModules();
    fs.rmSync(tempDataHome, { recursive: true, force: true });
  });

  test('is1MContextActive: 仅 opus/sonnet 4.x 家族为真', () => {
    expect(adapter.is1MContextActive('claude-opus-4-8')).toBe(true);
    expect(adapter.is1MContextActive('claude-sonnet-4-6')).toBe(true);
    expect(adapter.is1MContextActive('claude-opus-5')).toBe(false);
    expect(adapter.is1MContextActive('claude-3-7-sonnet')).toBe(false);
    expect(adapter.is1MContextActive('gpt-5')).toBe(false);
    expect(adapter.is1MContextActive(null)).toBe(false);
  });

  test('KHY_BETA_1M_CONTEXT=0 关断 1M 上下文', () => {
    process.env.KHY_BETA_1M_CONTEXT = '0';
    expect(adapter.is1MContextActive('claude-opus-4-8')).toBe(false);
    process.env.KHY_BETA_1M_CONTEXT = '1';
    expect(adapter.is1MContextActive('claude-opus-4-8')).toBe(true);
  });

  test('sticky opt-out: 400 触发后置位，TTL 到期后自动复位', () => {
    const t = adapter.__test__;
    expect(t.getBetaOptOut()).toBe(false);

    t.setBetaOptOut(true);
    expect(t.getBetaOptOut()).toBe(true);
    expect(adapter.is1MContextActive('claude-opus-4-8')).toBe(false);

    // back-date the opt-out timestamp past its TTL → flag self-resets
    t.expireBetaOptOut();
    expect(t.getBetaOptOut()).toBe(false);
    expect(adapter.is1MContextActive('claude-opus-4-8')).toBe(true);
    expect(t.betaOptOutTtlMs()).toBe(5 * 60 * 1000);
  });

  test('effectiveContextWindow: 1M beta 未激活时 Claude 声明 >200k 收拢到 200k', () => {
    // sonnet 4.6 is 1M-capable and the beta is live by default → keeps 1M
    expect(adapter.effectiveContextWindow('claude-sonnet-4-6', 1000000)).toBe(1000000);
    // kill-switch off → 200k ceiling
    process.env.KHY_BETA_1M_CONTEXT = '0';
    expect(adapter.effectiveContextWindow('claude-sonnet-4-6', 1000000)).toBe(200000);
    clearEnv();
    // non-Claude models pass through unchanged
    expect(adapter.effectiveContextWindow('gpt-5', 1000000)).toBe(1000000);
    expect(adapter.effectiveContextWindow('claude-opus-5', 1000000)).toBe(200000);
    // sub-200k declarations never clamp
    expect(adapter.effectiveContextWindow('claude-haiku-4-5-latest', 200000)).toBe(200000);
    expect(adapter.effectiveContextWindow('gpt-4o', 0)).toBe(0);
  });

  test('buildBetaHeader: T0 发全量 beta，T1 只发 1M，工具搜索恒在', () => {
    const t = adapter.__test__;
    const opus = t.buildBetaHeader('claude-opus-4-8');
    expect(opus).toContain('tool-search-tool-2025-10-19');
    expect(opus).toContain('context-1m-2025-08-07');
    expect(opus).toContain('interleaved-thinking-2025-05-14');

    const sonnet = t.buildBetaHeader('claude-sonnet-4-6');
    expect(sonnet).toContain('context-1m-2025-08-07');
    expect(sonnet).not.toContain('interleaved-thinking-2025-05-14');

    // KHY_BETA_INTERLEAVED=0 suppresses the interleaved beta even for T0
    process.env.KHY_BETA_INTERLEAVED = '0';
    expect(t.buildBetaHeader('claude-opus-4-8')).not.toContain('interleaved-thinking');
    clearEnv();

    // KHY_ANTHROPIC_BETA extras are appended
    process.env.KHY_ANTHROPIC_BETA = ' alpha-x , beta-y ,, ';
    const extra = t.buildBetaHeader('claude-opus-4-8');
    expect(extra).toContain('alpha-x');
    expect(extra).toContain('beta-y');
    clearEnv();
  });

  test('buildBetaHeader: sticky opt-out 后只保留工具搜索 + 自定义 beta', () => {
    const t = adapter.__test__;
    t.setBetaOptOut(true);
    process.env.KHY_ANTHROPIC_BETA = 'my-token';
    const stripped = t.buildBetaHeader('claude-opus-4-8');
    expect(stripped).not.toContain('context-1m');
    expect(stripped).not.toContain('interleaved-thinking');
    expect(stripped).toContain('tool-search-tool-2025-10-19');
    expect(stripped).toContain('my-token');
  });

  test('defaultThinkingBudget: T0 前端模型 16000，其余 10000', () => {
    const t = adapter.__test__;
    expect(t.defaultThinkingBudget('claude-opus-4-8')).toBe(16000);
    expect(t.defaultThinkingBudget('gpt-5')).toBe(16000);
    expect(t.defaultThinkingBudget('claude-sonnet-4-6')).toBe(10000);
    expect(t.defaultThinkingBudget('unknown-model-xyz')).toBe(10000);
  });
});
