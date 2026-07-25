'use strict';

/**
 * snipConversation.test.js — manual context-trim (CC's Snip) on the authoritative
 * module-closure `_messages` of cli/ai.js.
 *
 * /snip is the user-driven counterpart to /compact: instead of summarizing, it
 * removes content the user judges no longer worth its tokens. Modes:
 *   - default → drop the most recent turn (last `user` message through the end)
 *   - count   → drop the last N messages
 *   - range   → drop 1-based messages a..b (inclusive)
 *
 * After removal a trailing assistant message carrying an unresolved tool_use is
 * popped too, so stored history stays Anthropic-API-valid.
 *
 * Exercises the real `_messages` via the __test__ seam (same as orphanTurnRollback).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { _pushRawMessage } = ai.__test__;

describe('ai.js — snipConversation (manual context trim, CC Snip alignment)', () => {
  beforeEach(() => {
    ai.clearHistory();
  });

  test('default drops the most recent turn (from last user message to end)', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });

    const res = ai.snipConversation();

    assert.equal(res.success, true);
    assert.equal(res.changed, true);
    assert.equal(res.mode, 'turn');
    assert.equal(res.previousCount, 4);
    assert.equal(res.nextCount, 2);
    assert.equal(res.removedCount, 2);
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('count mode removes exactly the last N messages', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });

    const res = ai.snipConversation({ count: 1 });

    assert.equal(res.mode, 'count');
    assert.equal(res.removedCount, 1);
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('count larger than history clamps to a full clear', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });

    const res = ai.snipConversation({ count: 99 });

    assert.equal(res.changed, true);
    assert.equal(res.nextCount, 0);
    assert.equal(ai.getConversation().length, 0);
  });

  test('range mode removes the inclusive 1-based slice', () => {
    _pushRawMessage({ role: 'user', content: 'M1' });
    _pushRawMessage({ role: 'assistant', content: 'M2' });
    _pushRawMessage({ role: 'user', content: 'M3' });
    _pushRawMessage({ role: 'assistant', content: 'M4' });

    const res = ai.snipConversation({ range: [2, 3] });

    assert.equal(res.mode, 'range');
    assert.equal(res.removedCount, 2);
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['M1', 'M4']);
  });

  test('invalid range returns a structured error and does not mutate history', () => {
    _pushRawMessage({ role: 'user', content: 'M1' });
    _pushRawMessage({ role: 'assistant', content: 'M2' });

    const res = ai.snipConversation({ range: [3, 1] });

    assert.equal(res.success, false);
    assert.match(res.error, /无效区间/);
    assert.equal(ai.getConversation().length, 2, 'history untouched on invalid range');
  });

  test('tidies a trailing assistant tool_use orphaned by the trim', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] });
    _pushRawMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] });

    // Remove just the trailing tool_result; the assistant tool_use above it is
    // now orphaned and must be popped too to keep history API-valid.
    const res = ai.snipConversation({ count: 1 });

    assert.equal(res.removedCount, 2, 'orphaned assistant tool_use popped alongside its result');
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1']);
  });

  test('no-op on empty history', () => {
    const res = ai.snipConversation();
    assert.equal(res.success, true);
    assert.equal(res.changed, false);
    assert.equal(res.mode, 'empty');
    assert.equal(res.removedCount, 0);
  });
});
