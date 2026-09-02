'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Use the consumer with a mock gateway and broadcast, so we don't have to
// import the real aiGateway (which pulls in adapters + network code).
const { attach } = require('../../src/bridge/aiChatConsumer');

function _mockDeps() {
  const broadcasts = [];
  const state = { gateway: null, history: null };
  const deps = {
    getUserId: (clientId) => (clientId === 'c-good' ? 'alice' : 'anon'),
    broadcastOutput: (data) => broadcasts.push(data),
    get gateway() {
      return state.gateway;
    },
    get history() {
      return state.history;
    },
  };
  return {
    broadcasts,
    deps,
    register(g, h) {
      state.gateway = g;
      state.history = h;
    },
    consumer() {
      return attach({
        getUserId: deps.getUserId,
        broadcastOutput: deps.broadcastOutput,
        gateway: deps.gateway,
        history: deps.history,
      });
    },
  };
}

function _fakeHistory() {
  return {
    calls: [],
    appendTurn(userId, turn) {
      this.calls.push({ op: 'append', userId, turn });
    },
    updateTurn(userId, turnId, patch) {
      this.calls.push({ op: 'update', userId, turnId, patch });
      return true;
    },
  };
}

test('handleChat broadcasts turn_start, chunk_text, turn_complete for a streaming turn', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  const gateway = {
    async generate(_prompt, opts) {
      opts.onChunk({ type: 'thinking', text: 'hmm' });
      opts.onChunk({ type: 'text', text: 'Hello' });
      opts.onChunk({ type: 'text', text: ' world' });
      opts.onChunk({ type: 'cost', promptTokens: 1, completionTokens: 2 });
      return { content: '', model: 'gpt-x' };
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-good', { text: 'hi there' });

  const types = ctx.broadcasts.map((b) => b.type);
  assert.ok(types.includes('turn_start'), 'expected turn_start, got ' + types.join(','));
  assert.ok(types.includes('chunk_thinking'), 'expected chunk_thinking, got ' + types.join(','));
  assert.ok(types.includes('chunk_text'), 'expected chunk_text, got ' + types.join(','));
  assert.ok(types.includes('turn_complete'), 'expected turn_complete, got ' + types.join(','));
  assert.ok(!types.includes('turn_error'), 'should not error on a happy turn');

  const textDeltas = ctx.broadcasts
    .filter((b) => b.type === 'chunk_text')
    .map((b) => b.content);
  assert.deepEqual(textDeltas, ['Hello', ' world']);

  const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
  assert.equal(final.content, 'Hello world');
  assert.equal(final.model, 'gpt-x');

  // History was written.
  const append = history.calls.find((c) => c.op === 'append');
  const update = history.calls.find((c) => c.op === 'update');
  assert.ok(append, 'expected history.appendTurn');
  assert.equal(append.userId, 'alice');
  assert.equal(append.turn.user, 'hi there');
  assert.ok(update, 'expected history.updateTurn');
  assert.equal(update.patch.assistant, 'Hello world');
  assert.equal(update.patch.cancelled, false);
  assert.ok(update.patch.finishedAt > 0);
});

test('handleChat falls back to result.content when no chunks arrived (non-streaming)', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  const gateway = {
    async generate(_p, opts) {
      // No onChunk calls: simulate a non-streaming response.
      return { content: 'static answer', model: 'm1' };
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-good', { text: 'q' });

  const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
  assert.equal(final.content, 'static answer');
});

test('handleChat broadcasts turn_error when gateway throws', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  const gateway = {
    async generate() {
      throw new Error('boom');
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-good', { text: 'hi' });

  const types = ctx.broadcasts.map((b) => b.type);
  assert.ok(types.includes('chunk_status'));
  assert.ok(types.includes('turn_error'));
  const err = ctx.broadcasts.find((b) => b.type === 'turn_error');
  assert.match(err.error, /boom/);
});

test('handleChat ignores empty / whitespace-only text (no broadcasts, no history)', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  const gateway = {
    async generate() {
      throw new Error('should not be called');
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-good', { text: '   ' });
  await c.handleChat('c-good', { text: '' });

  assert.equal(ctx.broadcasts.length, 0);
  assert.equal(history.calls.length, 0);
});

test('handleCancel aborts an in-flight turn and the turn completes with cancelled:true', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  let capturedSignal = null;
  let abortedSeen = false;
  const gateway = {
    async generate(_p, opts) {
      capturedSignal = opts.abortSignal;
      // Pretend we got one chunk then hit the abort.
      opts.onChunk({ type: 'text', text: 'partial' });
      // Block until aborted.
      await new Promise((resolve) => {
        if (opts.abortSignal.aborted) {
          resolve();
          return;
        }
        opts.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      abortedSeen = opts.abortSignal.aborted;
      return { content: 'partial' };
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  const chatPromise = c.handleChat('c-good', { text: 'go' });
  // Wait for first chunk to land, then cancel.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const turnId = ctx.broadcasts.find((b) => b.type === 'turn_start').turnId;
  const cancelled = c.handleCancel('c-good', { turnId });
  assert.equal(cancelled, true);
  await chatPromise;

  assert.equal(abortedSeen, true);
  const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
  assert.equal(final.cancelled, true);
});

test('handleCancel returns false for unknown / empty turnId (no crash)', () => {
  const ctx = _mockDeps();
  ctx.register({ async generate() {} }, _fakeHistory());
  const c = ctx.consumer();

  assert.equal(c.handleCancel('c-good', {}), false);
  assert.equal(c.handleCancel('c-good', { turnId: '' }), false);
  assert.equal(c.handleCancel('c-good', { turnId: 'never-started' }), false);
});

test('handleChat passes preferred adapter/model and sessionId=turnId to gateway', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  let captured = null;
  const gateway = {
    async generate(prompt, opts) {
      captured = { prompt, opts };
      return { content: '' };
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-good', {
    text: 'hi',
    preferredAdapter: 'claude',
    preferredModel: 'claude-3',
  });
  assert.equal(captured.opts.preferredAdapter, 'claude');
  assert.equal(captured.opts.preferredModel, 'claude-3');
  assert.ok(captured.opts.sessionId, 'sessionId (turnId) should be set');
  assert.equal(captured.opts.userId, 'alice');
});

test('anon client (no userId from getUserId) still gets a working turn', async () => {
  const ctx = _mockDeps();
  const history = _fakeHistory();
  const gateway = {
    async generate(_p, opts) {
      opts.onChunk({ type: 'text', text: 'ok' });
      return { content: '' };
    },
  };
  ctx.register(gateway, history);
  const c = ctx.consumer();

  await c.handleChat('c-anon', { text: 'hi' });
  const append = history.calls.find((c) => c.op === 'append');
  assert.equal(append.userId, 'anon');
  const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
  assert.equal(final.content, 'ok');
});
