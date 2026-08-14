'use strict';

/**
 * rewindToUserTurn.test.js — model-history rewind primitive on cli/ai.js's
 * authoritative `_messages`. Powers the TUI double-ESC rewind and the readline
 * `/rewind` command: "rewind to the N-th user message from the end" removes that
 * user message and everything after it, delegating to snipConversation for the
 * splice + trailing-unresolved-tool_use tidy.
 *
 * Uses the same __test__._pushRawMessage seam as snipConversation.test.js, so it
 * runs under `node --test` (NOT jest).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { _pushRawMessage } = ai.__test__;

describe('ai.js — rewindToUserTurn (model-history rewind)', () => {
  beforeEach(() => {
    ai.clearHistory();
  });

  test('n=1 rewinds to the most recent user turn (drops it + everything after)', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });

    const res = ai.rewindToUserTurn(1);

    assert.equal(res.success, true);
    assert.equal(res.changed, true);
    assert.equal(res.previousCount, 4);
    assert.equal(res.nextCount, 2);
    assert.equal(res.removedCount, 2);
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('n=2 rewinds to the second-from-last user turn', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });
    _pushRawMessage({ role: 'user', content: 'Q3' });

    const res = ai.rewindToUserTurn(2);

    assert.equal(res.removedCount, 3, 'drops Q2, A2, Q3');
    assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('tidies a trailing assistant tool_use orphaned by the rewind', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] });
    _pushRawMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] });
    _pushRawMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] });
    _pushRawMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'body2' }] });

    // Rewind to the most recent *user* turn: that is the tool_result at index 4.
    // Removing it orphans the assistant tool_use at index 3, which must be popped.
    const res = ai.rewindToUserTurn(1);

    assert.equal(res.removedCount, 2, 'tool_result + its orphaned assistant tool_use both removed');
    assert.equal(ai.getConversation().length, 3);
  });

  test('out-of-range n returns a structured error and does not mutate history', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });

    const res = ai.rewindToUserTurn(5);

    assert.equal(res.success, false);
    assert.equal(res.mode, 'out-of-range');
    assert.match(res.error, /无法回溯/);
    assert.equal(ai.getConversation().length, 2, 'history untouched');
  });

  test('n < 1 / NaN is rejected as invalid', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });

    for (const bad of [0, -1, NaN, 'x', undefined]) {
      const res = ai.rewindToUserTurn(bad);
      assert.equal(res.success, false, `bad=${String(bad)}`);
      assert.equal(res.mode, 'invalid', `bad=${String(bad)}`);
    }
    assert.equal(ai.getConversation().length, 1, 'history untouched on invalid input');
  });

  test('no user messages → out-of-range, history untouched', () => {
    _pushRawMessage({ role: 'assistant', content: 'A0' });

    const res = ai.rewindToUserTurn(1);

    assert.equal(res.success, false);
    assert.equal(res.mode, 'out-of-range');
    assert.equal(ai.getConversation().length, 1);
  });
});
