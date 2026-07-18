'use strict';

// Uses Jest's global describe/it/beforeEach (previously imported from node:test,
// which Jest does not collect). Assertions still run via node:assert/strict.
const assert = require('node:assert/strict');

// ── LSP Client new methods (unit-level: mock _request) ──

const { LspClient } = require('../src/services/lspClient');

describe('LspClient extended methods', () => {
  let client;

  beforeEach(() => {
    client = new LspClient({ rootPath: '/tmp' });
    // Force initialized state
    client._initialized = true;
    // Mock _request and _openDocument
    client._openDocument = async () => {};
    client._process = { stdin: { writable: true, write: () => {} } };
  });

  it('completion returns normalized items', async () => {
    client._request = async () => ({
      items: [
        { label: 'foo', kind: 6, detail: 'function', insertText: 'foo()' },
        { label: 'bar', kind: 5 },
      ],
    });
    const items = await client.completion('/tmp/test.js', 0, 3);
    assert.equal(items.length, 2);
    assert.equal(items[0].label, 'foo');
    assert.equal(items[0].insertText, 'foo()');
    assert.equal(items[1].insertText, 'bar'); // falls back to label
  });

  it('completion handles array result', async () => {
    client._request = async () => [{ label: 'x' }];
    const items = await client.completion('/tmp/test.js', 0, 0);
    assert.equal(items.length, 1);
  });

  it('completion handles null result', async () => {
    client._request = async () => null;
    const items = await client.completion('/tmp/test.js', 0, 0);
    assert.deepStrictEqual(items, []);
  });

  it('rename returns normalized changes', async () => {
    client._request = async () => ({
      changes: {
        'file:///tmp/test.js': [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: 'newFn' }],
      },
    });
    const result = await client.rename('/tmp/test.js', 0, 4, 'newFn');
    assert.ok(result.changes['/tmp/test.js']);
    assert.equal(result.changes['/tmp/test.js'][0].newText, 'newFn');
  });

  it('rename handles documentChanges format', async () => {
    client._request = async () => ({
      documentChanges: [{
        textDocument: { uri: 'file:///tmp/test.js' },
        edits: [{ range: {}, newText: 'x' }],
      }],
    });
    const result = await client.rename('/tmp/test.js', 0, 0, 'x');
    assert.ok(result.changes['/tmp/test.js']);
  });

  it('formatting returns edit array', async () => {
    client._request = async () => [{ range: {}, newText: '  x' }];
    const edits = await client.formatting('/tmp/test.js');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].newText, '  x');
  });

  it('codeActions returns normalized actions', async () => {
    client._request = async () => [
      { title: 'Add import', kind: 'quickfix', isPreferred: true },
    ];
    const actions = await client.codeActions('/tmp/test.js', { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, 'Add import');
    assert.equal(actions[0].isPreferred, true);
  });

  it('signatureHelp returns normalized signatures', async () => {
    client._request = async () => ({
      signatures: [
        { label: 'fn(a: string, b: number)', parameters: [{ label: 'a' }, { label: 'b' }] },
      ],
      activeSignature: 0,
      activeParameter: 1,
    });
    const result = await client.signatureHelp('/tmp/test.js', 5, 10);
    assert.equal(result.signatures.length, 1);
    assert.equal(result.activeParameter, 1);
  });

  it('signatureHelp returns null when server returns null', async () => {
    client._request = async () => null;
    const result = await client.signatureHelp('/tmp/test.js', 0, 0);
    assert.equal(result, null);
  });

  it('workspaceSymbols returns normalized symbols', async () => {
    client._request = async () => [
      { name: 'MyClass', kind: 5, location: { uri: 'file:///tmp/test.js', range: {} }, containerName: '' },
    ];
    const syms = await client.workspaceSymbols('MyClass');
    assert.equal(syms.length, 1);
    assert.equal(syms[0].name, 'MyClass');
    assert.equal(syms[0].location.filePath, '/tmp/test.js');
  });
});

// ── MessageRouter tests ──

const { MessageRouter } = require('../src/services/channels/messageRouter');
const { BaseChannel } = require('../src/services/channels/_baseChannel');
const EventEmitter = require('events');

describe('MessageRouter', () => {
  it('registerChannel adds channel and forwards messages', async () => {
    const router = new MessageRouter();
    const received = [];
    router.setAIHandler(async (msg) => {
      received.push(msg);
      return 'pong';
    });

    // Create mock channel
    const ch = new EventEmitter();
    ch.name = 'test';
    ch.toJSON = () => ({ name: 'test', connected: true });
    ch.sendMessage = async (channelId, text) => { ch._lastSent = { channelId, text }; };
    router.registerChannel(ch);

    assert.equal(router.getChannels().length, 1);
    assert.equal(router.getChannels()[0].name, 'test');

    // Simulate incoming message
    ch.emit('message', { channelId: 'c1', userId: 'u1', text: 'hello' });
    await new Promise(r => setTimeout(r, 50));

    assert.equal(received.length, 1);
    assert.equal(received[0].text, 'hello');
    assert.equal(ch._lastSent.text, 'pong');
  });

  it('handleCommand forwards as /command text', async () => {
    const router = new MessageRouter();
    const received = [];
    router.setAIHandler(async (msg) => { received.push(msg); return null; });

    const ch = new EventEmitter();
    ch.name = 'cmd-test';
    ch.toJSON = () => ({ name: 'cmd-test', connected: true });
    ch.sendMessage = async () => {};
    router.registerChannel(ch);

    ch.emit('command', { channelId: 'c2', userId: 'u2', command: 'help', args: '--verbose' });
    await new Promise(r => setTimeout(r, 50));

    assert.equal(received.length, 1);
    assert.equal(received[0].text, '/help --verbose');
  });

  it('unregisterChannel removes the channel', () => {
    const router = new MessageRouter();
    const ch = new EventEmitter();
    ch.name = 'rm-test';
    ch.toJSON = () => ({ name: 'rm-test', connected: false });
    router.registerChannel(ch);
    assert.equal(router.getChannels().length, 1);
    router.unregisterChannel('rm-test');
    assert.equal(router.getChannels().length, 0);
  });
});

// ── SlackChannel unit tests ──

const { SlackChannel } = require('../src/services/channels/slackChannel');

describe('SlackChannel', () => {
  it('verifySignature validates HMAC correctly', () => {
    const secret = 'test-secret-12345';
    const slack = new SlackChannel({ signingSecret: secret });

    const ts = '1234567890';
    const body = '{"type":"event_callback"}';
    const crypto = require('crypto');
    const expected = 'v0=' + crypto.createHmac('sha256', secret)
      .update(`v0:${ts}:${body}`, 'utf8')
      .digest('hex');

    assert.ok(slack.verifySignature(expected, ts, body));
    assert.ok(!slack.verifySignature('v0=bad', ts, body));
  });

  it('handleWebhookEvent emits message event', () => {
    const slack = new SlackChannel({ botToken: 'xoxb-test' });
    slack._botUserId = 'U123';
    const msgs = [];
    slack.on('message', m => msgs.push(m));

    slack.handleWebhookEvent({
      type: 'message',
      channel: 'C456',
      user: 'U789',
      text: '<@U123> help me',
      ts: '1234567890.123456',
    });

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'help me'); // bot mention stripped
    assert.equal(msgs[0].channelId, 'C456');
  });

  it('handleWebhookEvent ignores bot own messages', () => {
    const slack = new SlackChannel({ botToken: 'xoxb-test' });
    slack._botUserId = 'U123';
    const msgs = [];
    slack.on('message', m => msgs.push(m));

    slack.handleWebhookEvent({ type: 'message', user: 'U123', text: 'self' });
    slack.handleWebhookEvent({ type: 'message', bot_id: 'B1', text: 'bot' });

    assert.equal(msgs.length, 0);
  });
});

// ── LSPTool schema test ──

describe('LSPTool schema', () => {
  it('includes all 11 actions in enum', () => {
    const LSPTool = require('../src/tools/LSPTool/index');
    const tool = new LSPTool();
    const actions = tool.inputSchema.properties.action.enum;
    assert.equal(actions.length, 11);
    assert.ok(actions.includes('completion'));
    assert.ok(actions.includes('rename'));
    assert.ok(actions.includes('formatting'));
    assert.ok(actions.includes('codeActions'));
    assert.ok(actions.includes('signatureHelp'));
    assert.ok(actions.includes('workspaceSymbols'));
  });

  it('file_path is not required (workspaceSymbols needs only query)', () => {
    const LSPTool = require('../src/tools/LSPTool/index');
    const tool = new LSPTool();
    assert.ok(!tool.inputSchema.required.includes('file_path'));
  });
});
