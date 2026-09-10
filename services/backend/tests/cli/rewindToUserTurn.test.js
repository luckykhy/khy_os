'use strict';
/**
 * rewindToUserTurn.test.js â€?model-history rewind primitive on cli/ai.js's
 * authoritative `_messages`. Powers the TUI double-ESC rewind and the readline
 * `/rewind` command: "rewind to the N-th user message from the end" removes that
 * user message and everything after it, delegating to snipConversation for the
 * splice + trailing-unresolved-tool_use tidy.
 *
 * Uses the same __test__._pushRawMessage seam as snipConversation.test.js, so it
 * runs under `node --test` (NOT jest).
 */
const ai = require('../../src/cli/ai');
const { _pushRawMessage } = ai.__test__;
describe('ai.js â€?rewindToUserTurn (model-history rewind)', () => {
  beforeEach(() => {
    ai.clearHistory();
  });
});

describe('Rewind To User Turn', () => {
  test('n=1 rewinds to the most recent user turn (drops it + everything after)', () => {
        _pushRawMessage({ role: 'user', content: 'Q1' });
        _pushRawMessage({ role: 'assistant', content: 'A1' });
        _pushRawMessage({ role: 'user', content: 'Q2' });
        _pushRawMessage({ role: 'assistant', content: 'A2' });
    
        const res = ai.rewindToUserTurn(1);
    
        expect(res.success).toBe(true);
        expect(res.changed).toBe(true);
        expect(res.previousCount).toBe(4);
        expect(res.nextCount).toBe(2);
        expect(res.removedCount).toBe(2);
        assert.deepEqual(ai.getConversation().map((m) => m.content), ['Q1', 'A1']);
  });

  test('n=2 rewinds to the second-from-last user turn', () => {
        _pushRawMessage({ role: 'user', content: 'Q1' });
        _pushRawMessage({ role: 'assistant', content: 'A1' });
        _pushRawMessage({ role: 'user', content: 'Q2' });
        _pushRawMessage({ role: 'assistant', content: 'A2' });
        _pushRawMessage({ role: 'user', content: 'Q3' });
    
        const res = ai.rewindToUserTurn(2);
    
        expect(res.removedCount).toBe(3);
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
    
        expect(res.removedCount).toBe(2);
        expect(ai.getConversation().length).toBe(3);
  });

  test('out-of-range n returns a structured error and does not mutate history', () => {
        _pushRawMessage({ role: 'user', content: 'Q1' });
        _pushRawMessage({ role: 'assistant', content: 'A1' });
    
        const res = ai.rewindToUserTurn(5);
    
        expect(res.success).toBe(false);
        expect(res.mode).toBe('out-of-range');
        expect(res.error).toMatch(/æ— æ³•å›žæº¯/);
        expect(ai.getConversation().length).toBe(2);
  });

  test('n < 1 / NaN is rejected as invalid', () => {
        _pushRawMessage({ role: 'user', content: 'Q1' });
    
        for (const bad of [0, -1, NaN, 'x', undefined]) {
          const res = ai.rewindToUserTurn(bad);
          expect(res.success).toBe(false);
          expect(res.mode).toBe('invalid');
        }
        expect(ai.getConversation().length).toBe(1);
  });

  test('no user messages â†?out-of-range, history untouched', () => {
        _pushRawMessage({ role: 'assistant', content: 'A0' });
    
        const res = ai.rewindToUserTurn(1);
    
        expect(res.success).toBe(false);
        expect(res.mode).toBe('out-of-range');
        expect(ai.getConversation().length).toBe(1);
  });

});

