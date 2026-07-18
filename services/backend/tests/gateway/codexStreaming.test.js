'use strict';

/**
 * Inbound /v1/responses TRUE streaming — golden SSE event-sequence safety net.
 *
 * proxyServer.handleMultiProtocol's codex branch emits the OpenAI Responses API
 * streaming protocol (semantic `response.*` events), NOT the legacy fake
 * content_block blob. These tests drive that branch with a FAKE gateway whose
 * `generate` replays a scripted chunk sequence through `onChunk`, then assert:
 *
 *   - the exact ordered list of `event:` types (the golden sequence),
 *   - a strictly monotonic `sequence_number` starting at 0 with no gaps,
 *   - that NO `data: [DONE]` sentinel is written (response.completed is terminal),
 *   - tool calls carry a JSON-string `arguments`, an `fc_` item_id and a
 *     `call_id` that the terminal snapshot reproduces verbatim.
 *
 * The heavy gateway / router / expand / websearch deps are replaced in
 * require.cache BEFORE proxyServer is loaded so no real adapters are touched.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── Inject fakes into require.cache before proxyServer pulls them in ──
const gwDir = path.dirname(require.resolve('../../src/services/gateway/proxyServer'));

// Mutable script the fake gateway replays on each generate() call.
const fakeGateway = {
  _initialized: true,
  _adapters: [],
  _script: [],
  _result: { success: true, content: '', toolUseBlocks: [] },
  async init() { this._initialized = true; },
  async generate(_prompt, options) {
    for (const chunk of this._script) {
      options.onChunk(chunk);
    }
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
const converter = require('../../src/services/gateway/protocolConverter');
const { PROTOCOLS } = converter;

// ── Minimal req/res doubles ──
function fakeReq(body) {
  const handlers = {};
  const req = { headers: {}, on(ev, cb) { handlers[ev] = cb; return req; } };
  // parseBody attaches data/end listeners then awaits; drive them next microtask.
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
  };
}

// Parse the SSE byte stream into an ordered list of { event, data }.
function parseSse(res) {
  const raw = res._chunks.join('');
  const events = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    let event = null; let dataLine = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    let data = null;
    if (dataLine && dataLine !== '[DONE]') { try { data = JSON.parse(dataLine); } catch { data = dataLine; } }
    events.push({ event, data, rawData: dataLine });
  }
  return events;
}

async function runCodex(body, script, result) {
  fakeGateway._script = script;
  fakeGateway._result = result || { success: true, content: '', toolUseBlocks: [] };
  const req = fakeReq(body);
  const res = fakeRes();
  await proxyServer.handleMultiProtocol(req, res, PROTOCOLS.CODEX);
  return res;
}

const baseBody = (overrides = {}) => ({
  model: 'gpt-5',
  stream: true,
  instructions: 'be terse',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  ...overrides,
});

describe('codex inbound streaming — text-only golden sequence', () => {
  let events;
  before(async () => {
    const res = await runCodex(
      baseBody(),
      [
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'token_usage', inputTokens: 5, outputTokens: 2 },
      ],
      { success: true, content: 'Hello', toolUseBlocks: [] },
    );
    events = parseSse(res);
  });

  test('emits the exact ordered Responses event sequence for text', () => {
    assert.deepEqual(events.map((e) => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  test('sequence_number is monotonic from 0 with no gaps', () => {
    const seqs = events.map((e) => e.data.sequence_number);
    assert.deepEqual(seqs, seqs.map((_, i) => i));
  });

  test('no [DONE] sentinel is written — response.completed is terminal', () => {
    assert.equal(events.some((e) => e.rawData === '[DONE]'), false);
    assert.equal(events[events.length - 1].event, 'response.completed');
  });

  test('the terminal snapshot carries the full text and usage with input/output_tokens', () => {
    const done = events[events.length - 1].data.response;
    assert.equal(done.status, 'completed');
    assert.equal(done.output[0].type, 'message');
    assert.equal(done.output[0].content[0].text, 'Hello');
    assert.deepEqual(done.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });

  test('the streamed deltas reconstruct the message text', () => {
    const text = events.filter((e) => e.event === 'response.output_text.done')[0].data.text;
    assert.equal(text, 'Hello');
  });
});

describe('codex inbound streaming — text then a streamed tool call', () => {
  let events;
  before(async () => {
    const res = await runCodex(
      baseBody(),
      [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use_start', toolUseId: 'call_weather1', name: 'get_weather' },
        { type: 'tool_use_input_delta', partialJson: '{"city":' },
        { type: 'tool_use_input_delta', partialJson: '"SF"}' },
        { type: 'tool_use_end' },
        { type: 'token_usage', inputTokens: 8, outputTokens: 4 },
      ],
      { success: true, content: 'let me check', toolUseBlocks: [{ id: 'call_weather1', name: 'get_weather', input: { city: 'SF' } }] },
    );
    events = parseSse(res);
  });

  test('closes the message before opening the function_call item', () => {
    assert.deepEqual(events.map((e) => e.event), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',      // message
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',       // message closed…
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',      // …then function_call opens
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  test('function_call item_id is an fc_ id distinct from the call_id', () => {
    const added = events.find((e) => e.event === 'response.output_item.added' && e.data.item.type === 'function_call');
    assert.match(added.data.item.id, /^fc_/);
    assert.equal(added.data.item.call_id, 'call_weather1');
  });

  test('arg deltas concatenate to a valid JSON arguments string', () => {
    const deltas = events.filter((e) => e.event === 'response.function_call_arguments.delta').map((e) => e.data.delta);
    const joined = deltas.join('');
    assert.equal(joined, '{"city":"SF"}');
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    assert.equal(typeof done.data.arguments, 'string');
    assert.deepEqual(JSON.parse(done.data.arguments), { city: 'SF' });
  });

  test('status flips to requires_action and the snapshot reproduces the call verbatim', () => {
    const done = events[events.length - 1].data.response;
    assert.equal(done.status, 'requires_action');
    const fc = done.output.find((o) => o.type === 'function_call');
    assert.equal(fc.call_id, 'call_weather1');
    assert.equal(fc.name, 'get_weather');
    assert.equal(typeof fc.arguments, 'string');
    assert.deepEqual(JSON.parse(fc.arguments), { city: 'SF' });
  });

  test('sequence_number stays monotonic across message→tool transition', () => {
    const seqs = events.map((e) => e.data.sequence_number);
    assert.deepEqual(seqs, seqs.map((_, i) => i));
  });
});

describe('codex inbound streaming — tool call via non-streamed fallback', () => {
  let events;
  before(async () => {
    // Adapter yields NO tool chunks in-stream; result.toolUseBlocks drives the
    // fallback emission of a complete function_call item.
    const res = await runCodex(
      baseBody(),
      [{ type: 'text', text: 'ok' }],
      { success: true, content: 'ok', toolUseBlocks: [{ id: 'call_x', name: 'search', input: { q: 'cats' } }] },
    );
    events = parseSse(res);
  });

  test('fallback emits a full function_call item sequence after the message', () => {
    const types = events.map((e) => e.event);
    assert.deepEqual(types.slice(-5), [
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  test('the fallback tool snapshot is requires_action with the right call_id', () => {
    const done = events[events.length - 1].data.response;
    assert.equal(done.status, 'requires_action');
    const fc = done.output.find((o) => o.type === 'function_call');
    assert.equal(fc.call_id, 'call_x');
    assert.deepEqual(JSON.parse(fc.arguments), { q: 'cats' });
  });

  test('no [DONE] in the fallback path either', () => {
    assert.equal(events.some((e) => e.rawData === '[DONE]'), false);
  });
});
