'use strict';

/**
 * aiConversationPort.test.js — contract tests for the conversation-state inversion
 * port (DESIGN-ARCH-021, Batch 3 addendum). Pins the surface cli/ai registers
 * ({ getEffort, saveConversation, loadLastConversation, clearHistory }) and the
 * null-fallback contract queryEngine relies on, plus an end-to-end check that
 * queryEngine routes its conversation-state methods through the port and degrades
 * safely when the CLI was never loaded. Pure leaf: the CLI layer is never loaded.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const port = require('../../src/services/aiConversationPort');

describe('aiConversationPort', () => {
  beforeEach(() => port._resetForTest());

  test('unregistered → getAiConversation() returns null', () => {
    assert.equal(port.getAiConversation(), null);
  });

  test('registers the four handlers and returns them callable', () => {
    const calls = [];
    port.registerAiConversation({
      getEffort: () => 'max',
      saveConversation: () => { calls.push('save'); return '/tmp/x.json'; },
      loadLastConversation: () => { calls.push('load'); },
      clearHistory: () => { calls.push('clear'); },
    });
    const conv = port.getAiConversation();
    assert.equal(conv.getEffort(), 'max');
    assert.equal(conv.saveConversation(), '/tmp/x.json');
    conv.loadLastConversation();
    conv.clearHistory();
    assert.deepEqual(calls, ['save', 'load', 'clear']);
  });

  test('missing members normalize to null (partial registration)', () => {
    port.registerAiConversation({ getEffort: () => 'low' });
    const conv = port.getAiConversation();
    assert.equal(typeof conv.getEffort, 'function');
    assert.equal(conv.saveConversation, null);
    assert.equal(conv.loadLastConversation, null);
    assert.equal(conv.clearHistory, null);
  });

  test('non-object argument registers null', () => {
    port.registerAiConversation(null);
    assert.equal(port.getAiConversation(), null);
    port.registerAiConversation('nope');
    assert.equal(port.getAiConversation(), null);
  });
});

describe('queryEngine routes conversation-state ops through the port', () => {
  const { QueryEngine } = require('../../src/services/queryEngine');

  beforeEach(() => port._resetForTest());

  test('saveConversation/loadConversation/clearHistory delegate to the registered port', () => {
    const calls = [];
    port.registerAiConversation({
      getEffort: () => 'medium',
      saveConversation: () => { calls.push('save'); return '/tmp/conv.json'; },
      loadLastConversation: () => { calls.push('load'); },
      clearHistory: () => { calls.push('clear'); },
    });
    const engine = new QueryEngine();
    assert.equal(engine.saveConversation(), '/tmp/conv.json');
    engine.loadConversation();
    engine.clearHistory();
    assert.deepEqual(calls, ['save', 'load', 'clear']);
  });

  test('unregistered port → conversation-state ops degrade safely (no throw)', () => {
    const engine = new QueryEngine();
    assert.equal(engine.saveConversation(), null);
    assert.doesNotThrow(() => engine.loadConversation());
    assert.doesNotThrow(() => engine.clearHistory());
    // clearHistory still clears the engine's own state regardless of the port.
    engine._messages.push({ role: 'user', content: 'x' });
    engine.clearHistory();
    assert.deepEqual(engine._messages, []);
  });
});
