'use strict';

/**
 * ollamaAdapterStreaming.test.js — regression for "本地 Ollama 在 KHY 中 AI 超时 / 等不到响应".
 *
 * Root cause: the Ollama adapter used to run `stream:false`, so it emitted NO
 * onChunk during generation. The gateway idle-watchdog only resets on onChunk,
 * so a slow local model (cold load + low tok/s) was killed mid-generation as
 * "stale" → "AI 超时". The fix makes the adapter stream token-by-token.
 *
 * This suite locks the streaming behavior:
 *   1. _accumulateOllamaStream (pure): concat deltas, per-delta onToken, tool_calls
 *      capture, /api/generate `response` key, per-line onActivity.
 *   2. ollamaStreamRequest (real HTTP against a local server): assembled content +
 *      onToken called per line; non-200 buffers for the fallback path; a genuine
 *      inter-token stall rejects with an idle timeout (it does NOT cap a steadily
 *      progressing stream).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const adapter = require('../../src/services/gateway/adapters/ollamaAdapter');
const { _accumulateOllamaStream, ollamaStreamRequest } = adapter;

// Helper: turn an array of line objects into an async iterable, optionally with a
// delay before each item (to exercise activity callbacks deterministically).
async function* fromArray(items) {
  for (const it of items) yield it;
}

describe('_accumulateOllamaStream — pure NDJSON accumulation', () => {
  test('chat: concatenates message.content deltas and fires onToken per non-empty delta', async () => {
    const tokens = [];
    let activity = 0;
    const acc = await _accumulateOllamaStream(
      fromArray([
        { message: { role: 'assistant', content: '今天' }, done: false },
        { message: { role: 'assistant', content: '中国' }, done: false },
        { message: { role: 'assistant', content: '有8条新闻' }, done: false },
        { message: { role: 'assistant', content: '' }, done: true },
      ]),
      { onToken: (d) => tokens.push(d), onActivity: () => { activity += 1; } },
    );
    assert.equal(acc.content, '今天中国有8条新闻', 'deltas are concatenated in order');
    assert.deepEqual(tokens, ['今天', '中国', '有8条新闻'], 'onToken fires once per non-empty delta');
    assert.equal(activity, 4, 'onActivity fires once per line (drives idle-timer reset)');
    assert.equal(acc.sawMessage, true);
    assert.equal(acc.last.done, true, 'the terminal line is retained');
  });

  test('chat: captures tool_calls emitted on the done line', async () => {
    const acc = await _accumulateOllamaStream(fromArray([
      { message: { role: 'assistant', content: '' }, done: false },
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'news', arguments: { query: '中国' } } }],
        },
        done: true,
      },
    ]));
    assert.equal(acc.toolCalls.length, 1, 'tool_calls are captured');
    assert.equal(acc.toolCalls[0].function.name, 'news');
  });

  test('generate: concatenates the `response` key', async () => {
    const tokens = [];
    const acc = await _accumulateOllamaStream(
      fromArray([
        { response: 'Hello', done: false },
        { response: ' world', done: true },
      ]),
      { onToken: (d) => tokens.push(d) },
    );
    assert.equal(acc.content, 'Hello world');
    assert.equal(acc.sawResponse, true);
    assert.deepEqual(tokens, ['Hello', ' world']);
  });

  test('a throwing onToken never breaks accumulation (best-effort)', async () => {
    const acc = await _accumulateOllamaStream(
      fromArray([{ message: { content: 'a' }, done: false }, { message: { content: 'b' }, done: true }]),
      { onToken: () => { throw new Error('boom'); } },
    );
    assert.equal(acc.content, 'ab', 'content still assembled despite onToken throwing');
  });
});

// --- HTTP integration against a throwaway local server -----------------------
// We point the adapter at a local server by overriding the host via DEFAULT_HOST?
// ollamaStreamRequest resolves the host from module-internal DEFAULT_HOST, which
// we cannot easily override. Instead, we exercise it by spinning a server on the
// default Ollama port is unsafe. So we test ollamaStreamRequest by constructing a
// server and pointing at it through the OLLAMA_HOST env BEFORE require — but the
// module is already required. To keep this hermetic and deterministic, we test the
// streaming HTTP path with a server whose URL we pass via a thin re-require under a
// patched env.

describe('ollamaStreamRequest — HTTP streaming behavior', () => {
  // Fresh module instance bound to our test server's host.
  function loadAdapterFor(port) {
    const prev = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
    // serviceDefaults caches OLLAMA_HOST at first require; bust both caches.
    delete require.cache[require.resolve('../../src/constants/serviceDefaults')];
    delete require.cache[require.resolve('../../src/services/gateway/adapters/ollamaAdapter')];
    const fresh = require('../../src/services/gateway/adapters/ollamaAdapter');
    return { fresh, restore: () => { if (prev === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = prev; } };
  }

  test('200: assembles streamed chat content and forwards each line to onToken', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '你好' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { role: 'assistant', content: '世界' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { fresh, restore } = loadAdapterFor(port);
    try {
      const tokens = [];
      const result = await fresh.ollamaStreamRequest('/api/chat',
        { model: 'qwen3.5:4b', stream: true, messages: [] },
        { idleTimeoutMs: 5000, onToken: (d) => tokens.push(d) });
      assert.equal(result.status, 200);
      assert.equal(result.data.message.content, '你好世界', 'streamed deltas assembled');
      assert.deepEqual(tokens, ['你好', '世界'], 'onToken forwarded per token');
    } finally {
      restore();
      await new Promise((r) => server.close(r));
    }
  });

  test('non-200: buffers the error body so the caller fallback path still works', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'model is loading' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { fresh, restore } = loadAdapterFor(port);
    try {
      const result = await fresh.ollamaStreamRequest('/api/chat',
        { model: 'x', stream: true, messages: [] }, { idleTimeoutMs: 5000 });
      assert.equal(result.status, 500, 'status surfaced for fallback');
      assert.equal(result.data.error, 'model is loading', 'error body buffered & parsed');
    } finally {
      restore();
      await new Promise((r) => server.close(r));
    }
  });

  test('idle stall between tokens rejects with an idle timeout (does NOT cap a progressing stream)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // One token, then go silent forever — simulates a stalled generation.
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: false }) + '\n');
      // never end / never send more
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { fresh, restore } = loadAdapterFor(port);
    try {
      await assert.rejects(
        () => fresh.ollamaStreamRequest('/api/chat',
          { model: 'x', stream: true, messages: [] },
          { idleTimeoutMs: 1000, onToken: () => {} }),
        /idle timeout/i,
        'a genuine inter-token stall must reject with an idle timeout',
      );
    } finally {
      restore();
      await new Promise((r) => server.close(r));
    }
  });

  test('progressing stream slower than idleTimeoutMs total still succeeds (reset-on-token)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // 4 tokens spaced 150ms apart = 600ms total, each gap < idleTimeoutMs(400ms).
      let i = 0;
      const parts = ['a', 'b', 'c', 'd'];
      const tick = () => {
        if (i < parts.length) {
          res.write(JSON.stringify({ message: { content: parts[i] }, done: false }) + '\n');
          i += 1;
          setTimeout(tick, 150);
        } else {
          res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
        }
      };
      tick();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { fresh, restore } = loadAdapterFor(port);
    try {
      const result = await fresh.ollamaStreamRequest('/api/chat',
        { model: 'x', stream: true, messages: [] }, { idleTimeoutMs: 400, onToken: () => {} });
      assert.equal(result.status, 200);
      assert.equal(result.data.message.content, 'abcd',
        'a stream that keeps progressing (each gap < idle) is never timed out, even past the per-gap budget');
    } finally {
      restore();
      await new Promise((r) => server.close(r));
    }
  });
});
