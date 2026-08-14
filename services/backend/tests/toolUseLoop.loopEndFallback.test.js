'use strict';

/**
 * toolUseLoop.loopEndFallback.test.js — regression for the "tool loop ends with
 * NO final reply" bug: the model keeps calling the same tool (e.g. `news`)
 * round after round, and when the loop exits (normal / grace / max-iterations)
 * the final text is empty → the CLI shows only "✓ 9m 13s · 62 tokens".
 *
 * Covers the unit surface of the fix:
 *   1. _buildLoopEndFallbackReply — honest end-of-loop fallback text
 *   2. _accumUsage/_cumulativeUsage — whole-loop cumulative token usage
 *   3. _trackRepeatedCallStreak — consecutive identical tool-call reminder
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  _buildLoopEndFallbackReply,
  _accumUsage,
  _cumulativeUsage,
  _trackRepeatedCallStreak,
} = require('../src/services/toolUseLoopCore');

describe('toolUseLoop — end-of-loop empty reply must yield an honest fallback', () => {
  test('fallback reply reports rounds, call counts and recent tool outcomes', () => {
    const log = [
      { iteration: 1, tool: 'news', params: { q: '今日新闻' }, result: { success: true, content: '要闻A' } },
      { iteration: 2, tool: 'news', params: { q: '今日新闻' }, result: { success: true, content: '要闻B' } },
      { iteration: 3, tool: 'news', params: { q: '今日新闻' }, result: { success: false, error: 'timeout' } },
      { iteration: 4, tool: '_legacy_cmd', params: {}, result: { success: true } }, // internal — excluded
    ];
    const reply = _buildLoopEndFallbackReply(log, { iterations: 4, userMessage: '查新闻' });
    assert.ok(reply.trim().length > 0, 'fallback must never be empty');
    assert.match(reply, /4 轮/, 'must state iteration count');
    assert.match(reply, /3 次工具调用/, 'internal _-prefixed entries are excluded');
    assert.match(reply, /2 成功、1 失败/, 'must state success/failure split');
    assert.match(reply, /news（成功）/, 'recent calls must name the tool with outcome');
    assert.match(reply, /未生成最终总结回复/, 'must be honest that the model produced no summary');
    assert.match(reply, /重新发送|缩小/, 'must suggest retry or narrowing the question');
  });

  test('fallback works with an empty/absent toolCallLog (never throws, never blank)', () => {
    const reply = _buildLoopEndFallbackReply([], {});
    assert.ok(reply.trim().length > 0);
    assert.match(reply, /0 次工具调用/);
    const reply2 = _buildLoopEndFallbackReply(null, { iterations: 0 });
    assert.ok(reply2.trim().length > 0);
  });
});

describe('toolUseLoop — cumulative tokenUsage across all rounds', () => {
  test('accumulates snake_case and camelCase shapes; returns both key families', () => {
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, rounds: 0 };
    _accumUsage(totals, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    _accumUsage(totals, { promptTokens: 20, completionTokens: 7 }); // total derived = 27
    _accumUsage(totals, { input_tokens: 3, output_tokens: 2 });     // total derived = 5
    _accumUsage(totals, null);                                       // ignored
    const usage = _cumulativeUsage(totals, { total_tokens: 5 });
    assert.equal(usage.promptTokens, 33);
    assert.equal(usage.completionTokens, 14);
    assert.equal(usage.totalTokens, 47);
    assert.equal(usage.inputTokens, 33, 'replSession reads inputTokens||promptTokens');
    assert.equal(usage.outputTokens, 14, 'replSession reads outputTokens||completionTokens');
    assert.equal(usage.total_tokens, 47, 'snake_case mirror for extractTokenCount');
    assert.equal(usage.rounds, 3);
    assert.equal(usage.cumulative, true);
  });

  test('accumulates and exposes cache read/write segments (HUD + cache warning)', () => {
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, rounds: 0 };
    // Canonical khy names (from _cacheUsage.js normalization)
    _accumUsage(totals, { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 78000, cacheWriteInputTokens: 500 });
    // Anthropic raw snake_case fallback
    _accumUsage(totals, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 40 });
    // Round without cache data — must not disturb cache totals
    _accumUsage(totals, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(totals.cacheReadInputTokens, 80000, '_accumUsage sums cache reads across shapes');
    assert.equal(totals.cacheWriteInputTokens, 540, '_accumUsage sums cache writes across shapes');
    const usage = _cumulativeUsage(totals, null);
    assert.equal(usage.cacheReadInputTokens, 80000, '_cumulativeUsage exposes cumulative cache reads');
    assert.equal(usage.cacheWriteInputTokens, 540, '_cumulativeUsage exposes cumulative cache writes');
    // contextResidentTokens.js reads tokenUsage.cacheReadInputTokens/WriteInputTokens;
    // cacheWarning.js probes canonical names first — both must see the fields.
    assert.ok('cacheReadInputTokens' in usage && 'cacheWriteInputTokens' in usage);
  });

  test('cache fields default to 0 when no round carried cache data', () => {
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, rounds: 0 };
    _accumUsage(totals, { prompt_tokens: 10, completion_tokens: 5 });
    const usage = _cumulativeUsage(totals, null);
    assert.equal(usage.cacheReadInputTokens, 0);
    assert.equal(usage.cacheWriteInputTokens, 0);
  });

  test('falls back to last-round usage when nothing was accumulated', () => {
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, rounds: 0 };
    const last = { total_tokens: 62 };
    assert.equal(_cumulativeUsage(totals, last), last);
    assert.equal(_cumulativeUsage(totals, null), null);
  });
});

describe('toolUseLoop — repeated identical tool-call reminder', () => {
  const mkRound = (params, success = true) => ([
    { tool: 'news', params, result: { success, content: '新华网今日要闻：经济、科技版块更新。' } },
  ]);

  test('3 consecutive identical calls → reminder with previous result summary', () => {
    const state = { key: null, count: 0 };
    const params = { topic: '今日新闻' };
    assert.equal(_trackRepeatedCallStreak(state, mkRound(params)), null);
    assert.equal(_trackRepeatedCallStreak(state, mkRound(params)), null);
    const reminder = _trackRepeatedCallStreak(state, mkRound(params));
    assert.ok(reminder, 'third identical call must trigger the reminder');
    assert.match(reminder, /连续 3 次/, 'reminder states the streak count');
    assert.match(reminder, /news/, 'reminder names the tool');
    assert.match(reminder, /新华网今日要闻/, 'reminder carries the previous result summary');
    assert.match(reminder, /请勿再用相同参数重复调用/, 'reminder forbids re-calling');
  });

  test('different params or multiple calls per round reset the streak', () => {
    const state = { key: null, count: 0 };
    assert.equal(_trackRepeatedCallStreak(state, mkRound({ topic: 'a' })), null);
    assert.equal(_trackRepeatedCallStreak(state, mkRound({ topic: 'b' })), null); // param change → reset
    assert.equal(state.count, 1);
    const twoCalls = [...mkRound({ topic: 'b' }), ...mkRound({ topic: 'b' })];
    assert.equal(_trackRepeatedCallStreak(state, twoCalls), null); // >1 call → reset
    assert.equal(state.count, 0);
    assert.equal(_trackRepeatedCallStreak(state, []), null);
    assert.equal(_trackRepeatedCallStreak(null, mkRound({ topic: 'c' })), null);
  });
});
