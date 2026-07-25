'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACP_METHODS,
  ACP_ERRORS,
  createRequest,
  createNotification,
  createResponse,
  createErrorResponse,
  validateMessage,
  ACPTransport,
} = require('../src/services/acpTransport');

describe('ACP message builders', () => {
  it('createRequest produces valid JSON-RPC 2.0 request', () => {
    const msg = createRequest(ACP_METHODS.TASK_SUBMIT, { agentId: 'a1', prompt: 'hi' }, 'req-1');
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.id, 'req-1');
    assert.equal(msg.method, 'task.submit');
    assert.equal(msg.params.agentId, 'a1');
  });

  it('createRequest auto-generates id if omitted', () => {
    const msg = createRequest(ACP_METHODS.HEARTBEAT, {});
    assert.ok(msg.id);
    assert.equal(typeof msg.id, 'string');
  });

  it('createNotification has no id field', () => {
    const msg = createNotification(ACP_METHODS.HEARTBEAT, {});
    assert.equal(msg.id, undefined);
    assert.equal(msg.method, 'heartbeat');
  });

  it('createResponse wraps result', () => {
    const msg = createResponse('r1', { status: 'ok' });
    assert.equal(msg.id, 'r1');
    assert.deepStrictEqual(msg.result, { status: 'ok' });
    assert.equal(msg.error, undefined);
  });

  it('createErrorResponse wraps error with code', () => {
    const msg = createErrorResponse('r2', ACP_ERRORS.AGENT_NOT_FOUND, 'gone');
    assert.equal(msg.error.code, -40001);
    assert.equal(msg.error.message, 'gone');
  });
});

describe('validateMessage', () => {
  it('rejects non-objects', () => {
    assert.equal(validateMessage(null).valid, false);
    assert.equal(validateMessage('string').valid, false);
  });

  it('rejects missing jsonrpc', () => {
    assert.equal(validateMessage({ method: 'heartbeat' }).valid, false);
  });

  it('rejects unknown method', () => {
    const r = validateMessage({ jsonrpc: '2.0', method: 'unknown.method' });
    assert.equal(r.valid, false);
  });

  it('accepts valid request', () => {
    const r = validateMessage(createRequest(ACP_METHODS.AGENT_SPAWN, { role: 'coder' }));
    assert.equal(r.valid, true);
  });

  it('accepts valid response (no method, has id)', () => {
    const r = validateMessage(createResponse('x', {}));
    assert.equal(r.valid, true);
  });
});

describe('ACP_METHODS enum', () => {
  it('contains all 12 methods', () => {
    const methods = Object.values(ACP_METHODS);
    assert.equal(methods.length, 12);
    assert.ok(methods.includes('agent.spawn'));
    assert.ok(methods.includes('task.submit'));
    assert.ok(methods.includes('tool.invoke'));
    assert.ok(methods.includes('message.send'));
    assert.ok(methods.includes('heartbeat'));
  });
});

describe('ACPTransport IPC', () => {
  it('request-response round trip via mock IPC channel', async () => {
    const EventEmitter = require('events');
    const ch = new EventEmitter();
    ch.send = (msg) => {
      // Echo back as a response
      setImmediate(() => {
        ch.emit('message', createResponse(msg.id, { echo: msg.params }));
      });
    };

    const transport = new ACPTransport({ type: 'ipc', channel: ch });
    const result = await transport.request(ACP_METHODS.HEARTBEAT, { ping: true });
    assert.deepStrictEqual(result, { echo: { ping: true } });
    transport.destroy();
  });

  it('request rejects on error response', async () => {
    const EventEmitter = require('events');
    const ch = new EventEmitter();
    ch.send = (msg) => {
      setImmediate(() => {
        ch.emit('message', createErrorResponse(msg.id, ACP_ERRORS.AGENT_NOT_FOUND, 'not found'));
      });
    };

    const transport = new ACPTransport({ type: 'ipc', channel: ch });
    await assert.rejects(
      () => transport.request(ACP_METHODS.AGENT_STATUS, {}),
      (err) => err.message === 'not found' && err.code === ACP_ERRORS.AGENT_NOT_FOUND,
    );
    transport.destroy();
  });

  it('request rejects after timeout', async () => {
    const EventEmitter = require('events');
    const ch = new EventEmitter();
    ch.send = () => {}; // swallow — never reply

    const transport = new ACPTransport({ type: 'ipc', channel: ch, timeoutMs: 50 });
    await assert.rejects(
      () => transport.request(ACP_METHODS.HEARTBEAT, {}),
      /timeout/i,
    );
    transport.destroy();
  });

  it('handle() responds to incoming requests', async () => {
    const EventEmitter = require('events');
    const ch = new EventEmitter();
    const sent = [];
    ch.send = (msg) => sent.push(msg);

    const transport = new ACPTransport({ type: 'ipc', channel: ch });
    transport.handle(ACP_METHODS.HEARTBEAT, async (params) => ({ pong: true }));

    // Simulate incoming request
    ch.emit('message', createRequest(ACP_METHODS.HEARTBEAT, {}, 'hb-1'));

    // Wait for async handler
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'hb-1');
    assert.deepStrictEqual(sent[0].result, { pong: true });
    transport.destroy();
  });

  it('destroy rejects pending requests', async () => {
    const EventEmitter = require('events');
    const ch = new EventEmitter();
    ch.send = () => {};

    const transport = new ACPTransport({ type: 'ipc', channel: ch, timeoutMs: 60000 });
    const p = transport.request(ACP_METHODS.HEARTBEAT, {});
    transport.destroy();
    await assert.rejects(p, /destroyed/i);
  });
});

// ── agentCommunicationService ACP format test ──

describe('agentCommunicationService ACP internal format', () => {
  it('sendMessage stores _acp envelope with JSON-RPC 2.0 format', () => {
    const acs = require('../src/services/agentCommunicationService');
    const msgId = acs.sendMessage('fundamental', 'technical', 'signal', { data: 'test' });
    assert.ok(msgId);
    // Verify the message in history has _acp
    const msgs = acs.getMessages('technical');
    const found = msgs.find(m => m.id === msgId);
    assert.ok(found, 'message should be in queue for technical agent');
    assert.ok(found._acp, 'message should have _acp envelope');
    assert.equal(found._acp.jsonrpc, '2.0');
    assert.equal(found._acp.method, 'message.send');
    assert.equal(found._acp.params.from, 'fundamental');
    assert.equal(found._acp.params.to, 'technical');
  });
});
