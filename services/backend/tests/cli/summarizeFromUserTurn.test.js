'use strict';

/**
 * summarizeFromUserTurn.test.js — "summarize from here" on cli/ai.js's
 * authoritative `_messages` (CC MessageSelector 'summarize' parity). Unlike
 * rewindToUserTurn (which discards the tail), this keeps everything BEFORE the
 * N-th user turn from the end and collapses that turn + everything after it into
 * a single compact summary message, preserving role alternation so stored history
 * stays API-valid.
 *
 * Uses the same __test__._pushRawMessage seam as rewindToUserTurn.test.js, so it
 * runs under `node --test` (NOT jest).
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { _pushRawMessage } = ai.__test__;

/** No two adjacent messages share a role (the API-400 invariant). */
function assertAlternating(msgs) {
  for (let i = 1; i < msgs.length; i++) {
    const a = String(msgs[i - 1].role || '').toLowerCase();
    const b = String(msgs[i].role || '').toLowerCase();
    assert.notEqual(a, b, `adjacent same-role at ${i - 1}/${i}: ${a}`);
  }
}

describe('ai.js — summarizeFromUserTurn (summarize from here)', () => {
  beforeEach(() => {
    ai.clearHistory();
  });

  test('n=1 keeps the prefix and collapses the last user turn onward into a summary', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2 please refactor the parser' });
    _pushRawMessage({ role: 'assistant', content: 'A2 done refactoring' });

    const res = ai.summarizeFromUserTurn(1);

    assert.equal(res.success, true);
    assert.equal(res.changed, true);
    assert.equal(res.summarized, true);
    assert.equal(res.mode, 'summarize');
    assert.equal(res.previousCount, 4);
    assert.equal(res.summarizedCount, 2, 'Q2 + A2 collapsed');

    const conv = ai.getConversation();
    // Prefix Q1/A1 preserved verbatim.
    assert.deepEqual(conv.slice(0, 2).map((m) => m.content), ['Q1', 'A1']);
    // Tail replaced by a summary that mentions the collapsed content.
    const summaryMsg = conv[2];
    assert.match(String(summaryMsg.content), /SummarizeFromHere/);
    assert.match(String(summaryMsg.content), /refactor/);
    assertAlternating(conv);
  });

  test('preserves role alternation and lets the NEXT user turn alternate', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });
    _pushRawMessage({ role: 'assistant', content: 'A2' });
    _pushRawMessage({ role: 'user', content: 'Q3' });
    _pushRawMessage({ role: 'assistant', content: 'A3' });

    // Summarize from the 2nd-from-end user turn (Q2): keep Q1/A1, collapse Q2..A3.
    const res = ai.summarizeFromUserTurn(2);
    assert.equal(res.summarizedCount, 4, 'Q2,A2,Q3,A3 collapsed');

    const conv = ai.getConversation();
    assert.deepEqual(conv.slice(0, 2).map((m) => m.content), ['Q1', 'A1']);
    assertAlternating(conv);

    // Simulate the next real user turn arriving after the summary.
    _pushRawMessage({ role: 'user', content: 'Q4' });
    assertAlternating(ai.getConversation());
  });

  test('summarizing the very first user turn produces a summary-led history', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });
    _pushRawMessage({ role: 'user', content: 'Q2' });

    // n === number of user turns → anchor is the first user message; nothing kept.
    const res = ai.summarizeFromUserTurn(2);
    assert.equal(res.success, true);
    assert.equal(res.summarizedCount, 3);

    const conv = ai.getConversation();
    assert.equal(String(conv[0].role).toLowerCase(), 'user', 'summary leads as user');
    assert.match(String(conv[0].content), /SummarizeFromHere/);
    assertAlternating(conv);
  });

  test('out-of-range n returns a structured error and does not mutate history', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });
    _pushRawMessage({ role: 'assistant', content: 'A1' });

    const res = ai.summarizeFromUserTurn(5);

    assert.equal(res.success, false);
    assert.equal(res.mode, 'out-of-range');
    assert.match(res.error, /无法回溯/);
    assert.equal(ai.getConversation().length, 2, 'history untouched');
  });

  test('n < 1 / NaN is rejected as invalid, history untouched', () => {
    _pushRawMessage({ role: 'user', content: 'Q1' });

    for (const bad of [0, -1, NaN, 'x', undefined]) {
      const res = ai.summarizeFromUserTurn(bad);
      assert.equal(res.success, false, `bad=${String(bad)}`);
      assert.equal(res.mode, 'invalid', `bad=${String(bad)}`);
    }
    assert.equal(ai.getConversation().length, 1, 'history untouched on invalid input');
  });

  test('no user messages → out-of-range, history untouched', () => {
    _pushRawMessage({ role: 'assistant', content: 'A0' });

    const res = ai.summarizeFromUserTurn(1);

    assert.equal(res.success, false);
    assert.equal(res.mode, 'out-of-range');
    assert.equal(ai.getConversation().length, 1);
  });
});
