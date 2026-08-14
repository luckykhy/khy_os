'use strict';

/**
 * Tests for services/usageTracker.js — cost and token usage tracking.
 */

// Model names are single-sourced in constants/models.js. Reference PRIMARY.<role>
// instead of hardcoding ids so a model swap only touches models.js (enforced by
// scripts/lib/modelHardcodingGuard.js). PRIMARY.ide === the IDE default model.
const { PRIMARY } = require('../../src/constants/models');

let usageTrackerModule;
let loadError;

beforeAll(() => {
  try {
    usageTrackerModule = require('../../src/services/usageTracker');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('usageTracker exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports UsageTracker class', () => {
    if (!usageTrackerModule) return;
    expect(typeof usageTrackerModule.UsageTracker).toBe('function');
  });

  test('exports usageTracker singleton instance', () => {
    if (!usageTrackerModule) return;
    expect(usageTrackerModule.usageTracker).toBeInstanceOf(usageTrackerModule.UsageTracker);
  });

  test('exports PRICING object', () => {
    if (!usageTrackerModule) return;
    expect(typeof usageTrackerModule.PRICING).toBe('object');
    expect(usageTrackerModule.PRICING).toHaveProperty('default');
    expect(usageTrackerModule.PRICING.default).toHaveProperty('input');
    expect(usageTrackerModule.PRICING.default).toHaveProperty('output');
  });

  test('exports CACHE_VERSION and MAX_LATENCY_MS constants', () => {
    if (!usageTrackerModule) return;
    expect(usageTrackerModule.CACHE_VERSION).toBe(2);
    expect(typeof usageTrackerModule.MAX_LATENCY_MS).toBe('number');
  });
});

describe('UsageTracker instance', () => {
  let tracker;

  beforeEach(() => {
    if (!usageTrackerModule) return;
    tracker = new usageTrackerModule.UsageTracker();
  });

  test('record() returns costUSD and pricing', () => {
    if (!tracker) return;
    const result = tracker.record({
      sessionId: 'test-session',
      model: PRIMARY.ide,
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 1200,
    });
    expect(typeof result.costUSD).toBe('number');
    expect(result.costUSD).toBeGreaterThan(0);
    expect(result.pricing).toHaveProperty('input');
    expect(result.pricing).toHaveProperty('output');
  });

  test('getSessionSummary() returns session data after recording', () => {
    if (!tracker) return;
    tracker.record({ sessionId: 's1', model: PRIMARY.ide, inputTokens: 100, outputTokens: 50, durationMs: 500 });
    const summary = tracker.getSessionSummary('s1');
    expect(summary).not.toBeNull();
    expect(summary.requests).toBe(1);
    expect(summary.inputTokens).toBe(100);
    expect(summary.outputTokens).toBe(50);
  });

  test('getSessionSummary() returns null for unknown session', () => {
    if (!tracker) return;
    expect(tracker.getSessionSummary('nonexistent')).toBeNull();
  });

  test('getGlobalSummary() aggregates all sessions', () => {
    if (!tracker) return;
    tracker.record({ sessionId: 's1', model: PRIMARY.ide, inputTokens: 100, outputTokens: 50, durationMs: 500 });
    tracker.record({ sessionId: 's2', model: PRIMARY.haiku, inputTokens: 200, outputTokens: 100, durationMs: 800 });
    const global = tracker.getGlobalSummary();
    expect(global.totalRequests).toBe(2);
    expect(global.totalInputTokens).toBe(300);
    expect(global.totalOutputTokens).toBe(150);
  });

  test('getModelBreakdown() returns per-model stats', () => {
    if (!tracker) return;
    const model = PRIMARY.ide;
    tracker.record({ sessionId: 's1', model, inputTokens: 1000, outputTokens: 500, durationMs: 500 });
    tracker.record({ sessionId: 's1', model, inputTokens: 2000, outputTokens: 1000, durationMs: 700 });
    const breakdown = tracker.getModelBreakdown();
    expect(breakdown[model]).toBeDefined();
    expect(breakdown[model].requests).toBe(2);
    expect(breakdown[model].inputTokens).toBe(3000);
  });

  test('cached requests have zero cost', () => {
    if (!tracker) return;
    const result = tracker.record({
      sessionId: 's1',
      model: PRIMARY.ide,
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 100,
      cached: true,
    });
    expect(result.costUSD).toBe(0);
  });

  test('cleanup() removes old sessions', () => {
    if (!tracker) return;
    tracker.record({ sessionId: 'old', model: PRIMARY.ide, inputTokens: 100, outputTokens: 50, durationMs: 100 });
    // Force the session to appear old
    const session = tracker._sessions.get('old');
    session.startTime = Date.now() - 10_000_000; // 10000 seconds ago
    tracker.cleanup(1000); // 1 second max age
    expect(tracker.getSessionSummary('old')).toBeNull();
  });

  // Regression: versioned model ids (what OpenAI/relay adapters actually send)
  // must resolve to their real pricing tier via the LONGEST matching key, not
  // the first substring hit. 'gpt-4o-2024-08-06' contains both 'gpt-4' and
  // 'gpt-4o'; the old first-match/insertion-order loop returned the pricier
  // 'gpt-4' tier (6×), and 'gpt-4o-mini-*' was 200× off.
  test('_getPricing resolves versioned ids to the most-specific tier', () => {
    if (!tracker) return;
    expect(tracker._getPricing('gpt-4o-2024-08-06')).toEqual({ input: 5.0, output: 15.0 });
    expect(tracker._getPricing('gpt-4o-mini-2024-07-18')).toEqual({ input: 0.15, output: 0.6 });
    // Plain gpt-4 date variants still resolve to gpt-4.
    expect(tracker._getPricing('gpt-4-0613')).toEqual({ input: 30.0, output: 60.0 });
    // Exact keys and unknown ids are unchanged.
    expect(tracker._getPricing(PRIMARY.ide)).toEqual({ input: 5.0, output: 15.0 });
    expect(tracker._getPricing('claude-3.5-sonnet-20241022')).toEqual({ input: 3.0, output: 15.0 });
    expect(tracker._getPricing('totally-unknown')).toEqual({ input: 1.0, output: 3.0 });
  });

  test('record() prices a versioned gpt-4o id at the gpt-4o rate (not gpt-4)', () => {
    if (!tracker) return;
    const r = tracker.record({
      sessionId: 'v', model: 'gpt-4o-2024-08-06',
      inputTokens: 1_000_000, outputTokens: 1_000_000, durationMs: 100,
    });
    // 1M in @ $5 + 1M out @ $15 = $20 (was $90 under the gpt-4 mis-resolution).
    expect(r.costUSD).toBe(20);
  });
});
