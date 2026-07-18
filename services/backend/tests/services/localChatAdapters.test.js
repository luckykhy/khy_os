'use strict';

/**
 * localChatAdapters.test.js — the weak-local → main-loop chat wrapper contract.
 *
 * These tests pin the aiResult shape `runToolUseLoop` depends on for the TEXT
 * protocol, plus the two ownership responsibilities the wrapper carries:
 * conversation history and the system/tool surface. The executeTool funnel is
 * out of scope here — this is purely the chat bridge.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { makeLocalModelChat } = require('../../src/services/localChatAdapters');

// A fake gateway recording the calls it received; content is scripted per turn.
function fakeGateway(scripted) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async generateWithSubModel(prompt, key, options) {
      calls.push({ prompt, key, options });
      const next = typeof scripted === 'function' ? scripted(i, calls) : scripted[i];
      i += 1;
      return next;
    },
  };
}

// Minimal tool defs so selectTools/buildSystemAddendum have a surface to curate.
const TOOL_DEFS = [
  { name: 'Read', description: 'read a file', parameters: { properties: { file_path: {} }, required: ['file_path'] } },
  { name: 'Write', description: 'write a file', parameters: { properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } },
];

describe('makeLocalModelChat — aiResult shape', () => {
  test('remaps .content → .reply and never sets toolUseBlocks/errorType', async () => {
    const gw = fakeGateway([{ success: true, content: '<tool_call>{"name":"Read","params":{"file_path":"a.txt"}}</tool_call>', provider: 'ollama', tokenUsage: { total: 7 } }]);
    const chat = makeLocalModelChat(gw, 'ollama', { toolDefinitions: TOOL_DEFS });

    const r = await chat('读一下 a.txt');
    assert.equal(r.reply, '<tool_call>{"name":"Read","params":{"file_path":"a.txt"}}</tool_call>');
    assert.equal(r.provider, 'ollama');
    assert.deepEqual(r.tokenUsage, { total: 7 });
    assert.equal(r.toolUseBlocks, undefined, 'text protocol must not carry native tool_use blocks');
    assert.equal(r.errorType, undefined, 'must not set errorType (would trigger transient recovery)');
  });

  test('success:false degrades to plain reply text, still no errorType', async () => {
    const gw = fakeGateway([{ success: false, content: 'Sub-model adapter "ollama" is not available.', provider: 'none' }]);
    const chat = makeLocalModelChat(gw, 'ollama', { toolDefinitions: TOOL_DEFS });

    const r = await chat('hi');
    assert.equal(r.reply, 'Sub-model adapter "ollama" is not available.');
    assert.equal(r.errorType, undefined);
    assert.equal(r.toolUseBlocks, undefined);
  });

  test('a thrown generation surfaces as reply text, not an errorType', async () => {
    const gw = {
      async generateWithSubModel() { throw new Error('socket hang up'); },
    };
    const chat = makeLocalModelChat(gw, 'ollama', { toolDefinitions: TOOL_DEFS });

    const r = await chat('hi');
    assert.match(r.reply, /本地模型生成失败/);
    assert.match(r.reply, /socket hang up/);
    assert.equal(r.errorType, undefined);
    assert.equal(r.provider, 'ollama');
    assert.equal(r.tokenUsage, null);
  });
});

describe('makeLocalModelChat — history & system surface', () => {
  test('feeds the FULL running transcript on each turn (keeps the original goal alive)', async () => {
    const gw = fakeGateway([
      { success: true, content: '<tool_call>{"name":"Read","params":{"file_path":"a.txt"}}</tool_call>' },
      { success: true, content: '完成了' },
    ]);
    const chat = makeLocalModelChat(gw, 'ollama', { toolDefinitions: TOOL_DEFS });

    await chat('原始目标：读 a.txt');
    // The loop rewrites currentMessage to tool-result text on the next turn.
    await chat('[工具结果] a.txt 内容是 hello');

    // First call: [user]
    assert.deepEqual(gw.calls[0].options.messages, [
      { role: 'user', content: '原始目标：读 a.txt' },
    ]);
    // Second call: [user, assistant, user] — original goal still at index 0.
    const m2 = gw.calls[1].options.messages;
    assert.equal(m2.length, 3);
    assert.deepEqual(m2[0], { role: 'user', content: '原始目标：读 a.txt' });
    assert.equal(m2[1].role, 'assistant');
    assert.deepEqual(m2[2], { role: 'user', content: '[工具结果] a.txt 内容是 hello' });
  });

  test('passes a text-protocol system prompt; write tier is opt-in', async () => {
    const gw = fakeGateway([{ success: true, content: 'ok' }]);

    const readOnly = makeLocalModelChat(gw, 'ollama', { toolDefinitions: TOOL_DEFS });
    await readOnly('x');
    const sysRead = gw.calls[0].options.system;
    assert.match(sysRead, /<tool_call>/, 'system advertises the text protocol');
    assert.doesNotMatch(sysRead, /权限分级/, 'read-only persona omits the L0/L1/L2 delivery guidance');

    const gw2 = fakeGateway([{ success: true, content: 'ok' }]);
    const delivery = makeLocalModelChat(gw2, 'ollama', { toolDefinitions: TOOL_DEFS, writeEnabled: true });
    await delivery('x');
    assert.match(gw2.calls[0].options.system, /权限分级/, 'delivery persona surfaces when writeEnabled');
  });

  test('rejects a gateway without generateWithSubModel', () => {
    assert.throws(() => makeLocalModelChat({}, 'ollama'), /generateWithSubModel is required/);
  });
});
