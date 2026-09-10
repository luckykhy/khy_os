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
    expect(items.length).toBe(2);
    expect(items[0].label).toBe('foo');
    expect(items[0].insertText).toBe('foo()');
    expect(items[1].insertText).toBe('bar'); // falls back to label
  });

  it('completion handles array result', async () => {
    client._request = async () => [{ label: 'x' }];
    const items = await client.completion('/tmp/test.js', 0, 0);
    expect(items.length).toBe(1);
  });

  it('completion handles null result', async () => {
    client._request = async () => null;
    const items = await client.completion('/tmp/test.js', 0, 0);
    expect(items).toEqual([]);
  });

  it('rename returns normalized changes', async () => {
    client._request = async () => ({
      changes: {
        'file:///tmp/test.js': [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: 'newFn' }],
      },
    });
    const result = await client.rename('/tmp/test.js', 0, 4, 'newFn');
    expect(result.changes['/tmp/test.js']).toBeTruthy();
    expect(result.changes['/tmp/test.js'][0].newText).toBe('newFn');
  });

  it('rename handles documentChanges format', async () => {
    client._request = async () => ({
      documentChanges: [{
        textDocument: { uri: 'file:///tmp/test.js' },
        edits: [{ range: {}, newText: 'x' }],
      }],
    });
    const result = await client.rename('/tmp/test.js', 0, 0, 'x');
    expect(result.changes['/tmp/test.js']).toBeTruthy();
  });

  it('formatting returns edit array', async () => {
    client._request = async () => [{ range: {}, newText: '  x' }];
    const edits = await client.formatting('/tmp/test.js');
    expect(edits.length).toBe(1);
    expect(edits[0].newText).toBe('  x');
  });

  it('codeActions returns normalized actions', async () => {
    client._request = async () => [
      { title: 'Add import', kind: 'quickfix', isPreferred: true },
    ];
    const actions = await client.codeActions('/tmp/test.js', { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } });
    expect(actions.length).toBe(1);
    expect(actions[0].title).toBe('Add import');
    expect(actions[0].isPreferred).toBe(true);
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
    expect(result.signatures.length).toBe(1);
    expect(result.activeParameter).toBe(1);
  });

  it('signatureHelp returns null when server returns null', async () => {
    client._request = async () => null;
    const result = await client.signatureHelp('/tmp/test.js', 0, 0);
    expect(result).toBe(null);
  });

  it('workspaceSymbols returns normalized symbols', async () => {
    client._request = async () => [
      { name: 'MyClass', kind: 5, location: { uri: 'file:///tmp/test.js', range: {} }, containerName: '' },
    ];
    const syms = await client.workspaceSymbols('MyClass');
    expect(syms.length).toBe(1);
    expect(syms[0].name).toBe('MyClass');
    expect(syms[0].location.filePath).toBe('/tmp/test.js');
  });
});

// ── MessageRouter tests ──

const { MessageRouter } = require('../src/services/domain/messaging/channels/messageRouter.js');
const { BaseChannel } = require('../src/services/domain/messaging/channels/_baseChannel.js');
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

    expect(router.getChannels().length).toBe(1);
    expect(router.getChannels()[0].name).toBe('test');

    // Simulate incoming message
    ch.emit('message', { channelId: 'c1', userId: 'u1', text: 'hello' });
    await new Promise(r => setTimeout(r, 50));

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('hello');
    expect(ch._lastSent.text).toBe('pong');
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

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('/help --verbose');
  });

  it('unregisterChannel removes the channel', () => {
    const router = new MessageRouter();
    const ch = new EventEmitter();
    ch.name = 'rm-test';
    ch.toJSON = () => ({ name: 'rm-test', connected: false });
    router.registerChannel(ch);
    expect(router.getChannels().length).toBe(1);
    router.unregisterChannel('rm-test');
    expect(router.getChannels().length).toBe(0);
  });
});

// ── SlackChannel unit tests ──

const { SlackChannel } = require('../src/services/domain/messaging/channels/slackChannel.js');

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

    expect(slack.verifySignature(expected, ts, body)).toBe();
    expect(!slack.verifySignature('v0=bad', ts, body)).toBe();
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

    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe('help me'); // bot mention stripped
    expect(msgs[0].channelId).toBe('C456');
  });

  it('handleWebhookEvent ignores bot own messages', () => {
    const slack = new SlackChannel({ botToken: 'xoxb-test' });
    slack._botUserId = 'U123';
    const msgs = [];
    slack.on('message', m => msgs.push(m));

    slack.handleWebhookEvent({ type: 'message', user: 'U123', text: 'self' });
    slack.handleWebhookEvent({ type: 'message', bot_id: 'B1', text: 'bot' });

    expect(msgs.length).toBe(0);
  });
});

// ── LSPTool schema test ──

describe('LSPTool schema', () => {
  it('includes all 11 actions in enum', () => {
    const LSPTool = require('../src/tools/LSPTool/index');
    const tool = new LSPTool();
    const actions = tool.inputSchema.properties.action.enum;
    expect(actions.length).toBe(11);
    expect(actions).toContain('completion');
    expect(actions).toContain('rename');
    expect(actions).toContain('formatting');
    expect(actions).toContain('codeActions');
    expect(actions).toContain('signatureHelp');
    expect(actions).toContain('workspaceSymbols');
  });

  it('file_path is not required (workspaceSymbols needs only query)', () => {
    const LSPTool = require('../src/tools/LSPTool/index');
    const tool = new LSPTool();
    expect(!tool.inputSchema.required).toContain('file_path');
  });
});

