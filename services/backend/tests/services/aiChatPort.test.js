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
    const { defaultPrimitives } = require('../../src/services/workflow/workflowExecutor');
    const prim = defaultPrimitives();
    await assert.rejects(
      () => prim.chat('x'),
      /AI chat provider not registered/,
    );
  });

  test('workflowExecutor defaultPrimitives.chat routes through the port when registered', async () => {
    port.registerAiChat(async (p) => ({ reply: `p:${p}` }));
    const { defaultPrimitives } = require('../../src/services/workflow/workflowExecutor');
    const prim = defaultPrimitives();
    assert.deepEqual(await prim.chat('go'), { reply: 'p:go' });
  });
});
