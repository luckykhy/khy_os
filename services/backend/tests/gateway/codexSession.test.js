'use strict';

/**
 * Responses API session chaining (previous_response_id / store).
 *
 * Two layers under test:
 *   1. responseSessionStore — the LRU+TTL persistence primitive (put/get/evict/
 *      expire), driven directly.
 *   2. proxyServer.handleMultiProtocol codex branch — that a non-stream turn is
 *      persisted under its `resp_…` id, that a follow-up request carrying
 *      previous_response_id PREPENDS the stored history, that an unknown id is
 *      rejected with a Responses-style 400, and that store:false returns an id
 *      WITHOUT persisting.
 *
 * Heavy gateway/router/expand/websearch deps are faked in require.cache before
 * proxyServer loads (mirrors codexStreaming.test.js).
 */

const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const gwDir = path.dirname(require.resolve('../../src/services/gateway/proxyServer'));

// Fake gateway: non-stream generate() returns a scripted result; captures the
// messages it was handed so we can assert history prepending.
const fakeGateway = {
  _initialized: true,
  _adapters: [],
  _result: { success: true, content: 'reply', toolUseBlocks: [] },
  _lastOptions: null,
  async init() {},
  async generate(_prompt, options) {
    this._lastOptions = options;
    return this._result;
  },
};

function stub(absPath, exportsObj) {
  require.cache[absPath] = {
    id: absPath, filename: absPath, loaded: true, exports: exportsObj, children: [], paths: [],
  };
}

stub(path.join(gwDir, 'aiGateway.js'), fakeGateway);
stub(require.resolve('../../src/services/gateway/modelRouter'), {
  resolveModelRoute: () => ({ modelId: 'gpt-5', adapterKey: 'codex', metadata: { source: 'explicit' } }),
});
stub(require.resolve('../../src/services/gateway/webSearchInterceptor'), {
  isPureWebSearchRequest: () => false,
});
stub(require.resolve('../../src/services/expandModelService'), {
  isExpandModel: () => false,
});

const proxyServer = require('../../src/services/gateway/proxyServer');
const store = require('../../src/services/gateway/responseSessionStore');
const { PROTOCOLS } = require('../../src/services/gateway/protocolConverter');

// ── Layer 1: the store primitive ──

describe('responseSessionStore — LRU + TTL primitive', () => {
  beforeEach(() => store._clear());

  test('put then get round-trips the payload', () => {
    store.put('resp_a', { messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(store.get('resp_a').messages, [{ role: 'user', content: 'hi' }]);
  });

  test('unknown id → null', () => {
    assert.equal(store.get('resp_nope'), null);
  });

  test('expired entry → null and is purged', async () => {
    process.env.RESPONSES_STORE_TTL_MS = '1'; // 1ms lifetime
    try {
      store.put('resp_exp', { messages: [] });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(store.get('resp_exp'), null);
      assert.equal(store._size(), 0, 'expired entry purged on access');
    } finally {
      delete process.env.RESPONSES_STORE_TTL_MS;
    }
  });

  test('LRU eviction drops the least-recently-used past the cap', () => {
    process.env.RESPONSES_STORE_MAX = '2';
    try {
      store.put('a', { messages: [1] });
      store.put('b', { messages: [2] });
      store.get('a'); // touch a → b is now LRU
      store.put('c', { messages: [3] }); // evicts b
      assert.ok(store.get('a'), 'a retained (recently used)');
      assert.equal(store.get('b'), null, 'b evicted (LRU)');
      assert.ok(store.get('c'), 'c retained (newest)');
    } finally {
      delete process.env.RESPONSES_STORE_MAX;
    }
  });

  test('re-put refreshes recency and overwrites payload', () => {
    store.put('x', { messages: [1] });
    store.put('x', { messages: [2] });
    assert.deepEqual(store.get('x').messages, [2]);
    assert.equal(store._size(), 1);
  });
});

// ── Layer 2: integration through handleMultiProtocol (non-stream) ──

function fakeReq(body) {
  const handlers = {};
  const req = { headers: {}, on(ev, cb) { handlers[ev] = cb; return req; } };
  Promise.resolve().then(() => {
    handlers.data && handlers.data(Buffer.from(JSON.stringify(body)));
    handlers.end && handlers.end();
  });
  return req;
}

function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0, headers: null, ended: false, _chunks: chunks,
    writeHead(code, h) { this.statusCode = code; this.headers = h; },
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s) chunks.push(String(s)); this.ended = true; },
    json() { return JSON.parse(this._chunks.join('')); },
  };
}

const body = (overrides = {}) => ({
  model: 'gpt-5',
  stream: false,
  instructions: 'be terse',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  ...overrides,
});

async function run(reqBody, result) {
  fakeGateway._result = result || { success: true, content: 'reply', toolUseBlocks: [] };
  fakeGateway._lastOptions = null;
  const req = fakeReq(reqBody);
  const res = fakeRes();
  await proxyServer.handleMultiProtocol(req, res, PROTOCOLS.CODEX);
  return res;
}

describe('handleMultiProtocol — codex session chaining (non-stream)', () => {
  before(() => store._clear());

  test('a stored turn persists under the returned resp_ id', async () => {
    store._clear();
    const res = await run(body());
    assert.equal(res.statusCode, 200);
    const out = res.json();
    assert.match(out.id, /^resp_/);
    const saved = store.get(out.id);
    assert.ok(saved, 'turn was persisted');
    // history = [user 'hi', assistant 'reply']
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[0].role, 'user');
    assert.equal(saved.messages[1].role, 'assistant');
    assert.equal(saved.messages[1].content, 'reply');
  });

  test('previous_response_id prepends the stored history to the model input', async () => {
    store._clear();
    const first = await run(body({ input: [{ type: 'message', role: 'user', content: 'first question' }] }),
      { success: true, content: 'first answer', toolUseBlocks: [] });
    const firstId = first.json().id;

    await run(body({
      previous_response_id: firstId,
      input: [{ type: 'message', role: 'user', content: 'follow-up' }],
    }));
    // The gateway saw the prior turn (2 msgs) + the new user msg = 3 messages.
    const seen = fakeGateway._lastOptions.messages.map((m) => m.content);
    assert.deepEqual(seen, ['first question', 'first answer', 'follow-up']);
  });

  test('unknown previous_response_id → Responses-style 400', async () => {
    store._clear();
    const res = await run(body({ previous_response_id: 'resp_doesnotexist' }));
    assert.equal(res.statusCode, 400);
    const err = res.json().error;
    assert.equal(err.type, 'invalid_request_error');
    assert.equal(err.code, 'previous_response_not_found');
    assert.equal(err.param, 'previous_response_id');
  });

  test('store:false returns an id but persists nothing', async () => {
    store._clear();
    const res = await run(body({ store: false }));
    const out = res.json();
    assert.match(out.id, /^resp_/);
    assert.equal(store.get(out.id), null, 'store:false must not persist');
    assert.equal(store._size(), 0);
  });

  test('RESPONSES_STORE_STRICT=false ignores an unknown id instead of 400ing', async () => {
    store._clear();
    process.env.RESPONSES_STORE_STRICT = 'false';
    try {
      const res = await run(body({ previous_response_id: 'resp_missing' }));
      assert.equal(res.statusCode, 200, 'lenient mode proceeds');
    } finally {
      delete process.env.RESPONSES_STORE_STRICT;
    }
  });
});
