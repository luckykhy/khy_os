'use strict';

/**
 * aiChatPort.test.js — contract tests for the chat-core inversion port
 * (DESIGN-ARCH-021, Batch 3 addendum). Pins the exact shape cli/ai must register
 * and the null-fallback contract its consumers (ultraplanService /
 * workflowExecutor) rely on. Pure leaf: the CLI layer is never loaded.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const port = require('../../src/services/aiChatPort');

describe('aiChatPort', () => {
  beforeEach(() => port._resetForTest());

  test('unregistered → getAiChat() returns null (consumer reports unavailable)', () => {
    assert.equal(port.getAiChat(), null);
  });

  test('registers a chat fn and returns the same reference, callable', async () => {
    const chat = async (prompt, opts = {}) => ({ reply: `echo:${prompt}:${opts.effort || ''}` });
    port.registerAiChat(chat);
    assert.equal(port.getAiChat(), chat);
    assert.deepEqual(await port.getAiChat()('hi', { effort: 'max' }), { reply: 'echo:hi:max' });
  });

  test('registerAiChat(non-function) normalizes to null', () => {
    port.registerAiChat({});
    assert.equal(port.getAiChat(), null);
    port.registerAiChat(null);
    assert.equal(port.getAiChat(), null);
  });

  test('workflowExecutor defaultPrimitives.chat throws structured error when unregistered', async () => {
    const { defaultPrimitives } = require('../../src/services/domain/project/workflow/workflowExecutor.js');
    const prim = defaultPrimitives();
    await assert.rejects(
      () => prim.chat('x'),
      /AI chat provider not registered/,
    );
  });

  test('workflowExecutor defaultPrimitives.chat routes through the port when registered', async () => {
    port.registerAiChat(async (p) => ({ reply: `p:${p}` }));
    const { defaultPrimitives } = require('../../src/services/domain/project/workflow/workflowExecutor.js');
    const prim = defaultPrimitives();
    assert.deepEqual(await prim.chat('go'), { reply: 'p:go' });
  });
});

/**
 * CLI session-control surface — added so the ilink messaging channel stops
 * reaching up into cli/ai and cli/aiConversationOps at four call sites
 * (clearHistory / cancelActiveRequest / scopeSession / maybeAutoCheckpointProgress).
 * Same inversion contract: cli/ai registers on load, a non-CLI process gets null
 * and the caller keeps its existing fail-soft behaviour.
 */
describe('aiChatPort — session-control surface', () => {
  beforeEach(() => port._resetForTest());

  test('all four getters return null before any registration', () => {
    assert.equal(port.getClearHistory(), null);
    assert.equal(port.getCancelActiveRequest(), null);
    assert.equal(port.getScopeSession(), null);
    assert.equal(port.getMaybeAutoCheckpointProgress(), null);
  });

  test('registerAiSessionControl wires each operation and returns the same references', () => {
    const clearHistory = () => {};
    const cancelActiveRequest = () => {};
    const scopeSession = () => {};
    const maybeAutoCheckpointProgress = () => {};
    port.registerAiSessionControl({
      clearHistory, cancelActiveRequest, scopeSession, maybeAutoCheckpointProgress,
    });
    assert.equal(port.getClearHistory(), clearHistory);
    assert.equal(port.getCancelActiveRequest(), cancelActiveRequest);
    assert.equal(port.getScopeSession(), scopeSession);
    assert.equal(port.getMaybeAutoCheckpointProgress(), maybeAutoCheckpointProgress);
  });

  test('non-function entries normalize to null (partial CLI load cannot half-wire)', () => {
    port.registerAiSessionControl({
      clearHistory: 'not-a-fn',
      cancelActiveRequest: null,
      scopeSession: 42,
      maybeAutoCheckpointProgress: undefined,
    });
    assert.equal(port.getClearHistory(), null);
    assert.equal(port.getCancelActiveRequest(), null);
    assert.equal(port.getScopeSession(), null);
    assert.equal(port.getMaybeAutoCheckpointProgress(), null);
  });

  test('registerAiSessionControl() with no args leaves every slot null', () => {
    port.registerAiSessionControl();
    assert.equal(port.getClearHistory(), null);
    assert.equal(port.getScopeSession(), null);
  });

  test('_resetForTest clears the session-control slots too', () => {
    port.registerAiSessionControl({ clearHistory: () => {}, scopeSession: () => {} });
    port._resetForTest();
    assert.equal(port.getClearHistory(), null);
    assert.equal(port.getScopeSession(), null);
  });

  test('session-control registration does not clobber the chat slot (independent state)', () => {
    const chat = async () => 'ok';
    port.registerAiChat(chat);
    port.registerAiSessionControl({ clearHistory: () => {} });
    assert.equal(port.getAiChat(), chat, 'chat 槽必须与会话控制槽相互独立');
  });
});
