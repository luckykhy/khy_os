'use strict';
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

describe('Ai Chat Consumer', () => {
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
      expect(types.includes('turn_start')).toBeTruthy();
      expect(types.includes('chunk_thinking')).toBeTruthy();
      expect(types.includes('chunk_text')).toBeTruthy();
      expect(types.includes('turn_complete')).toBeTruthy();
      expect(!types.includes('turn_error')).toBeTruthy();
    
      const textDeltas = ctx.broadcasts
        .filter((b) => b.type === 'chunk_text')
        .map((b) => b.content);
      assert.deepEqual(textDeltas, ['Hello', ' world']);
    
      const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
      expect(final.content).toBe('Hello world');
      expect(final.model).toBe('gpt-x');
    
      // History was written.
      const append = history.calls.find((c) => c.op === 'append');
      const update = history.calls.find((c) => c.op === 'update');
      expect(append).toBeTruthy();
      expect(append.userId).toBe('alice');
      expect(append.turn.user).toBe('hi there');
      expect(update).toBeTruthy();
      expect(update.patch.assistant).toBe('Hello world');
      expect(update.patch.cancelled).toBe(false);
      expect(update.patch.finishedAt > 0).toBeTruthy();
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
      expect(final.content).toBe('static answer');
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
      expect(types).toContain('chunk_status');
      expect(types).toContain('turn_error');
      const err = ctx.broadcasts.find((b) => b.type === 'turn_error');
      expect(err.error).toMatch(/boom/);
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
    
      expect(ctx.broadcasts.length).toBe(0);
      expect(history.calls.length).toBe(0);
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
      expect(cancelled).toBe(true);
      await chatPromise;
    
      expect(abortedSeen).toBe(true);
      const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
      expect(final.cancelled).toBe(true);
  });

  test('handleCancel returns false for unknown / empty turnId (no crash)', async () => {
      const ctx = _mockDeps();
      ctx.register({ async generate() {} }, _fakeHistory());
      const c = ctx.consumer();
    
      expect(c.handleCancel('c-good')).toBe({});
      expect(c.handleCancel('c-good')).toBe({ turnId: '' });
      expect(c.handleCancel('c-good')).toBe({ turnId: 'never-started' });
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
      expect(captured.opts.preferredAdapter).toBe('claude');
      expect(captured.opts.preferredModel).toBe('claude-3');
      expect(captured.opts.sessionId).toBeTruthy();
      expect(captured.opts.userId).toBe('alice');
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
      expect(append.userId).toBe('anon');
      const final = ctx.broadcasts.find((b) => b.type === 'turn_complete');
      expect(final.content).toBe('ok');
  });

});

