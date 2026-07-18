'use strict';

/**
 * toolProtocolAdapter.parity.test.js — the protocol seam, proven symmetric.
 *
 * The whole point of collapsing the two tool loops into one is that the protocol
 * (native tool_use ↔ text <tool_call>) becomes a pluggable axis. These tests pin
 * the contract both adapters must honor:
 *
 *   1. Same model turn, two transports → equivalent {name, params}. A native
 *      tool_use block and the text <tool_call> form of the same call parse to the
 *      same canonical tool name + params.
 *   2. Native parse carries structure (_structured, _toolUseId); text parse does
 *      not (the loop canonicalizes it downstream).
 *   3. Result formatting diverges by design: native → structured (delegated, null
 *      here), text → plain text turn the weak model can read.
 *   4. selectTools / buildSystemAddendum are text-only; native injects nothing.
 *   5. resolveAdapter routes by protocol string and defaults to native.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  nativeAdapter,
  textAdapter,
  resolveAdapter,
  TEXT_PROTOCOL,
  NATIVE_PROTOCOL,
} = require('../../src/services/toolProtocolAdapter');

describe('toolProtocolAdapter — parse parity across transports', () => {
  test('native tool_use block and text <tool_call> of the SAME call parse equivalently', () => {
    // A weak model would emit this as text; a cloud model as a native block.
    const call = { name: 'Read', params: { file_path: 'src/index.js' } };

    const nativeParsed = nativeAdapter.parseToolCalls({
      toolUseBlocks: [{ id: 'tu_1', name: 'Read', input: { file_path: 'src/index.js' } }],
    });
    const textParsed = textAdapter.parseToolCalls({
      reply: `<tool_call>${JSON.stringify(call)}</tool_call>`,
    });

    assert.equal(nativeParsed.length, 1);
    assert.equal(textParsed.length, 1);
    // Both canonicalize Read → readFile via claudeCompat, so names match.
    assert.equal(nativeParsed[0].name, textParsed[0].name);
    assert.deepEqual(nativeParsed[0].params, textParsed[0].params);
  });

  test('native parse carries structure; text parse does not', () => {
    const nativeParsed = nativeAdapter.parseToolCalls({
      toolUseBlocks: [{ id: 'tu_42', name: 'Grep', input: { pattern: 'foo' } }],
    });
    assert.equal(nativeParsed[0]._structured, true);
    assert.equal(nativeParsed[0]._toolUseId, 'tu_42');

    const textParsed = textAdapter.parseToolCalls({
      reply: '<tool_call>{"name":"Grep","params":{"pattern":"foo"}}</tool_call>',
    });
    assert.equal(textParsed[0]._structured, undefined);
    assert.equal(textParsed[0]._toolUseId, undefined);
  });

  test('native parse tolerates a stringified arguments payload (function-call shape)', () => {
    const parsed = nativeAdapter.parseToolCalls({
      toolUseBlocks: [{ id: 'tu_9', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].params.file_path, 'a.txt');
  });

  test('empty / missing blocks parse to []', () => {
    assert.deepEqual(nativeAdapter.parseToolCalls({}), []);
    assert.deepEqual(nativeAdapter.parseToolCalls({ toolUseBlocks: [] }), []);
    assert.deepEqual(textAdapter.parseToolCalls({ reply: 'just prose, no tools' }), []);
    assert.deepEqual(textAdapter.parseToolCalls({}), []);
  });
});

describe('toolProtocolAdapter — result formatting diverges by design', () => {
  test('native formatToolResults returns null (delegates to the loop inline builder)', () => {
    assert.equal(nativeAdapter.formatToolResults([{ tool: 'Read', result: { success: true, output: 'x' } }]), null);
  });

  test('text formatToolResults renders a plain-text turn, no structured blocks', () => {
    const out = textAdapter.formatToolResults([
      { tool: 'Read', result: { success: true, output: 'hello world' } },
      { tool: 'gitStatus', result: { success: false, error: 'not a repo' } },
    ]);
    assert.equal(out.structuredBlocks, null);
    assert.equal(out.structuredToolResults, null);
    assert.match(out.text, /工具结果 \[Read\]/);
    assert.match(out.text, /hello world/);
    assert.match(out.text, /工具结果 \[gitStatus\]/);
    assert.match(out.text, /失败：not a repo/);
  });

  test('text formatToolResults skips the _legacy_cmd sentinel', () => {
    const out = textAdapter.formatToolResults([
      { tool: '_legacy_cmd', result: { success: true, output: 'ignored' } },
      { tool: 'Read', result: { success: true, output: 'kept' } },
    ]);
    assert.doesNotMatch(out.text, /ignored/);
    assert.match(out.text, /kept/);
  });

  test('text formatToolResults honors a maxLen cap', () => {
    const big = 'A'.repeat(5000);
    const out = textAdapter.formatToolResults([{ tool: 'Read', result: { success: true, output: big } }], { maxLen: 100 });
    // header + capped body — far below the raw 5000 chars.
    assert.ok(out.text.length < 200, `expected capped output, got ${out.text.length}`);
  });
});

describe('toolProtocolAdapter — system addendum & tool selection are text-only', () => {
  const allDefs = [
    { name: 'Read', description: 'read a file', parameters: { properties: { file_path: {} }, required: ['file_path'] } },
    { name: 'Write', description: 'write a file', parameters: { properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } },
    { name: 'deploy', description: 'too powerful', parameters: {} },
  ];

  test('native injects nothing', () => {
    assert.equal(nativeAdapter.buildSystemAddendum(allDefs, { writeEnabled: true }), null);
    assert.equal(nativeAdapter.selectTools(allDefs, { writeEnabled: true }), null);
  });

  test('text selectTools yields the read-only base tier by default (no write tools)', () => {
    const defs = textAdapter.selectTools(allDefs, {});
    const names = defs.map(d => d.name);
    assert.ok(names.includes('Read'));
    assert.ok(!names.includes('Write'), 'write tier is opt-in, not default');
    assert.ok(!names.includes('deploy'), 'deploy is never curated');
  });

  test('text selectTools merges the write tier when writeEnabled', () => {
    const defs = textAdapter.selectTools(allDefs, { writeEnabled: true });
    const names = defs.map(d => d.name);
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'), 'write tier merges in when enabled');
    assert.ok(!names.includes('deploy'), 'deploy stays excluded even in delivery mode');
  });

  test('text buildSystemAddendum advertises the protocol and switches persona on writeEnabled', () => {
    const readOnly = textAdapter.buildSystemAddendum([{ name: 'Read', description: 'read', parameters: {} }], {});
    assert.match(readOnly, /<tool_call>/);
    assert.doesNotMatch(readOnly, /权限分级/);

    const delivery = textAdapter.buildSystemAddendum([{ name: 'Write', description: 'write', parameters: {} }], { writeEnabled: true });
    assert.match(delivery, /权限分级/, 'delivery persona surfaces the L0/L1/L2 guidance');
  });
});

describe('toolProtocolAdapter — resolveAdapter routing', () => {
  test('routes by protocol string', () => {
    assert.equal(resolveAdapter(TEXT_PROTOCOL), textAdapter);
    assert.equal(resolveAdapter(NATIVE_PROTOCOL), nativeAdapter);
  });

  test('defaults to native for unknown / falsy protocol (safe default for cloud)', () => {
    assert.equal(resolveAdapter(undefined), nativeAdapter);
    assert.equal(resolveAdapter(''), nativeAdapter);
    assert.equal(resolveAdapter('garbage'), nativeAdapter);
  });

  test('adapters are frozen (single source, not mutable at runtime)', () => {
    assert.ok(Object.isFrozen(nativeAdapter));
    assert.ok(Object.isFrozen(textAdapter));
  });
});
