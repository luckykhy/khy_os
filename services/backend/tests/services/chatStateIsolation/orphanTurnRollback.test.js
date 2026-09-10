'use strict';
/**
 * orphanTurnRollback.test.js â€?authoritative-history orphan-turn regression for
 * DESIGN-ARCH-046 (extension).
 *
 * The model's real context is built from ai.js's module-level `_messages`
 * (conversationPrompt), NOT queryEngine._messages. On a failed/empty turn,
 * ai.chat returns early after having already pushed this turn's user message,
 * leaving it ORPHANED (no assistant pair) â€?the role-alternation corruption that
 * actually pollutes the next turn in the REPL.
 *
 * The fix surgically un-commits ONLY that one stranded message and must:
 *   â€?drop the orphan user message when it is the tail (no role-alternation break);
 *   â€?NEVER discard prior tool iterations (mission progress) earlier in the turn;
 *   â€?be a safe no-op when a concurrent trim already removed the message;
 *   â€?be a safe no-op on an empty history.
 *
 * Exercises the real module-closure `_messages` via the __test__ seam.
 */
const ai = require('../../../src/cli/ai');
const { _uncommitOrphanTurn, _pushRawMessage } = ai.__test__;
describe('ai.js â€?orphan-turn rollback on failed turn (DESIGN-ARCH-046)', () => {
  beforeEach(() => {
    ai.clearHistory();
  });
});

describe('Orphan Turn Rollback', () => {
  test('pops the orphaned user message when it is the tail', () => {
        _pushRawMessage({ role: 'user', content: 'Q1' });
        _pushRawMessage({ role: 'assistant', content: 'A1' });
        const orphan = _pushRawMessage({ role: 'user', content: 'Q2-failed' });
    
        _uncommitOrphanTurn(orphan);
    
        const hist = ai.getConversation();
        expect(hist.length).toBe(2);
        assert.deepEqual(hist.map((m) => m.content), ['Q1', 'A1']);
        assert.notEqual(hist[hist.length - 1].content, 'Q2-failed', 'no orphan user left to break alternation');
  });

  test('NEVER discards prior tool iterations (mission progress is preserved)', () => {
        // A multi-iteration tool turn: prior iterations succeeded; the LAST chat
        // call (the tool-result follow-up) is what failed.
        _pushRawMessage({ role: 'user', content: 'å¤æ‚ä»»åŠ¡' });
        _pushRawMessage({ role: 'assistant', content: '[tool_use Read]' });
        _pushRawMessage({ role: 'user', content: '[Tool Result] file body...' });
        _pushRawMessage({ role: 'assistant', content: '[tool_use Edit]' });
        const orphan = _pushRawMessage({ role: 'user', content: '[Tool Result] edit applied' });
    
        _uncommitOrphanTurn(orphan);
    
        const hist = ai.getConversation();
        expect(hist.length).toBe(4);
        assert.deepEqual(
          hist.map((m) => m.content),
          ['å¤æ‚ä»»åŠ¡', '[tool_use Read]', '[Tool Result] file body...', '[tool_use Edit]'],
        );
  });

  test('safe no-op when the message was already trimmed away (not the tail)', () => {
        const orphan = _pushRawMessage({ role: 'user', content: 'stale' });
        // Simulate a later push that made `orphan` no longer the tail.
        _pushRawMessage({ role: 'assistant', content: 'newer' });
    
        _uncommitOrphanTurn(orphan);
    
        const hist = ai.getConversation();
        expect(hist.length).toBe(2);
        expect(hist[hist.length - 1].content).toBe('newer');
  });

  test('safe no-op on empty history / null target', () => {
        expect(() => _uncommitOrphanTurn(null).not.toThrow());
        expect(() => _uncommitOrphanTurn({ role: 'user', content: 'ghost' }).not.toThrow());
        expect(ai.getConversation().length).toBe(0);
  });

});

