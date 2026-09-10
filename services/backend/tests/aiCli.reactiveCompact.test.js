'use strict';

/**
 * Tests for the s08 reactive-compaction trigger detector (_isContextOverflowFailure).
 *
 * s08 reactiveCompact safety net: proactive compaction estimates tokens locally,
 * but the API's real count can still exceed the budget and reject the request with
 * prompt_too_long. The live loop must recognize that specific failure so it can
 * recompact aggressively and retry, instead of surfacing a hard error to the user.
 *
 * This test exercises only the pure classifier hook (exported via __test__), so it
 * needs no API key and no network.
 */

const assert = require('assert');

const ai = require('../src/cli/ai');
const { _isContextOverflowFailure } = ai.__test__;

describe('s08 — _isContextOverflowFailure (reactive compaction trigger)', () => {
  test('detects overflow by errorType=context_length', () => {
    expect(_isContextOverflowFailure({ success: false, errorType: 'context_length' })).toBe(true);
  });

  test('detects overflow by errorType=context_overflow', () => {
    expect(_isContextOverflowFailure({ success: false, errorType: 'context_overflow' })).toBe(true);
  });

  test('detects overflow by errorType=payload_too_large', () => {
    expect(_isContextOverflowFailure({ success: false, errorType: 'payload_too_large' })).toBe(true);
  });

  test('detects overflow from a prompt_too_long message', () => {
    assert.strictEqual(
      _isContextOverflowFailure({ success: false, content: 'Error: prompt is too long: 250000 tokens > 200000 maximum' }),
      true
    );
  });

  test('detects overflow from a 413 status + message', () => {
    assert.strictEqual(
      _isContextOverflowFailure({ success: false, statusCode: 413, error: 'maximum context length exceeded' }),
      true
    );
  });

  test('does NOT trigger on a successful result', () => {
    expect(_isContextOverflowFailure({ success: true, content: 'hello' })).toBe(false);
  });

  test('does NOT trigger on null / undefined', () => {
    expect(_isContextOverflowFailure(null)).toBe(false);
    expect(_isContextOverflowFailure(undefined)).toBe(false);
  });

  test('does NOT trigger on an unrelated failure (rate limit)', () => {
    assert.strictEqual(
      _isContextOverflowFailure({ success: false, errorType: 'rate_limit', content: '429 too many requests' }),
      false
    );
  });

  test('does NOT trigger on a generic network failure', () => {
    assert.strictEqual(
      _isContextOverflowFailure({ success: false, content: 'ECONNRESET socket hang up' }),
      false
    );
  });
});
