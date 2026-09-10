'use strict';
/**
 * toolProtocolAdapter.parity.test.js â€?the protocol seam, proven symmetric.
 *
 * The whole point of collapsing the two tool loops into one is that the protocol
 * (native tool_use â†?text <tool_call>) becomes a pluggable axis. These tests pin
 * the contract both adapters must honor:
 *
 *   1. Same model turn, two transports â†?equivalent {name, params}. A native
 *      tool_use block and the text <tool_call> form of the same call parse to the
 *      same canonical tool name + params.
 *   2. Native parse carries structure (_structured, _toolUseId); text parse does
 *      not (the loop canonicalizes it downstream).
 *   3. Result formatting diverges by design: native â†?structured (delegated, null
 *      here), text â†?plain text turn the weak model can read.
 *   4. selectTools / buildSystemAddendum are text-only; native injects nothing.
 *   5. resolveAdapter routes by protocol string and defaults to native.
 */
const {
  nativeAdapter,
  textAdapter,
  resolveAdapter,
  TEXT_PROTOCOL,
  NATIVE_PROTOCOL,
} = require('../../src/services/toolProtocolAdapter');
describe('toolProtocolAdapter â€?parse parity across transports', () => {
});
describe('toolProtocolAdapter â€?result formatting diverges by design', () => {
});
describe('toolProtocolAdapter â€?system addendum & tool selection are text-only', () => {
  const allDefs = [
    { name: 'Read', description: 'read a file', parameters: { properties: { file_path: {} }, required: ['file_path'] } },
    { name: 'Write', description: 'write a file', parameters: { properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } },
    { name: 'deploy', description: 'too powerful', parameters: {} },
  ];
});
describe('toolProtocolAdapter â€?resolveAdapter routing', () => {
});

describe('Tool Protocol Adapter parity', () => {
  test('native tool_use block and text <tool_call> of the SAME call parse equivalently', () => {
        // A weak model would emit this as text; a cloud model as a native block.
        const call = { name: 'Read', params: { file_path: 'src/index.js' } };
    
        const nativeParsed = nativeAdapter.parseToolCalls({
          toolUseBlocks: [{ id: 'tu_1', name: 'Read', input: { file_path: 'src/index.js' } }],
        });
        const textParsed = textAdapter.parseToolCalls({
          reply: `<tool_call>${JSON.stringify(call)}</tool_call>`,
        });
    
        expect(nativeParsed.length).toBe(1);
        expect(textParsed.length).toBe(1);
        // Both canonicalize Read â†?readFile via claudeCompat, so names match.
        expect(nativeParsed[0].name).toBe(textParsed[0].name);
        assert.deepEqual(nativeParsed[0].params, textParsed[0].params);
  });

  test('native parse carries structure; text parse does not', () => {
        const nativeParsed = nativeAdapter.parseToolCalls({
          toolUseBlocks: [{ id: 'tu_42', name: 'Grep', input: { pattern: 'foo' } }],
        });
        expect(nativeParsed[0]._structured).toBe(true);
        expect(nativeParsed[0]._toolUseId).toBe('tu_42');
    
        const textParsed = textAdapter.parseToolCalls({
          reply: '<tool_call>{"name":"Grep","params":{"pattern":"foo"}}</tool_call>',
        });
        expect(textParsed[0]._structured).toBe(undefined);
        expect(textParsed[0]._toolUseId).toBe(undefined);
  });

  test('native parse tolerates a stringified arguments payload (function-call shape)', () => {
        const parsed = nativeAdapter.parseToolCalls({
          toolUseBlocks: [{ id: 'tu_9', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }],
        });
        expect(parsed.length).toBe(1);
        expect(parsed[0].params.file_path).toBe('a.txt');
  });

  test('empty / missing blocks parse to []', () => {
        assert.deepEqual(nativeAdapter.parseToolCalls({}), []);
        assert.deepEqual(nativeAdapter.parseToolCalls({ toolUseBlocks: [] }), []);
        assert.deepEqual(textAdapter.parseToolCalls({ reply: 'just prose, no tools' }), []);
        assert.deepEqual(textAdapter.parseToolCalls({}), []);
  });

  test('native formatToolResults returns null (delegates to the loop inline builder)', () => {
        expect(nativeAdapter.formatToolResults([{ tool: 'Read', result: { success: true, output: 'x' } }])).toBe(null);
  });

  test('text formatToolResults renders a plain-text turn, no structured blocks', () => {
        const out = textAdapter.formatToolResults([
          { tool: 'Read', result: { success: true, output: 'hello world' } },
          { tool: 'gitStatus', result: { success: false, error: 'not a repo' } },
        ]);
        expect(out.structuredBlocks).toBe(null);
        expect(out.structuredToolResults).toBe(null);
        expect(out.text).toMatch(/å·¥å…·ç»“æžœ \[Read\]/);
        expect(out.text).toMatch(/hello world/);
        expect(out.text).toMatch(/å·¥å…·ç»“æžœ \[gitStatus\]/);
        expect(out.text).toMatch(/å¤±è´¥ï¼šnot a repo/);
  });

  test('text formatToolResults skips the _legacy_cmd sentinel', () => {
        const out = textAdapter.formatToolResults([
          { tool: '_legacy_cmd', result: { success: true, output: 'ignored' } },
          { tool: 'Read', result: { success: true, output: 'kept' } },
        ]);
        expect(out.text).not.toMatch(/ignored/);
        expect(out.text).toMatch(/kept/);
  });

  test('text formatToolResults honors a maxLen cap', () => {
        const big = 'A'.repeat(5000);
        const out = textAdapter.formatToolResults([{ tool: 'Read', result: { success: true, output: big } }], { maxLen: 100 });
        // header + capped body â€?far below the raw 5000 chars.
        expect(out.text.length < 200).toBeTruthy();
  });

  test('native injects nothing', () => {
        expect(nativeAdapter.buildSystemAddendum(allDefs, { writeEnabled: true })).toBe(null);
        expect(nativeAdapter.selectTools(allDefs, { writeEnabled: true })).toBe(null);
  });

  test('text selectTools yields the read-only base tier by default (no write tools)', () => {
        const defs = textAdapter.selectTools(allDefs, {});
        const names = defs.map(d => d.name);
        expect(names).toContain('Read');
        expect(!names.includes('Write')).toBeTruthy();
        expect(!names.includes('deploy')).toBeTruthy();
  });

  test('text selectTools merges the write tier when writeEnabled', () => {
        const defs = textAdapter.selectTools(allDefs, { writeEnabled: true });
        const names = defs.map(d => d.name);
        expect(names).toContain('Read');
        expect(names.includes('Write')).toBeTruthy();
        expect(!names.includes('deploy')).toBeTruthy();
  });

  test('text buildSystemAddendum advertises the protocol and switches persona on writeEnabled', () => {
        const readOnly = textAdapter.buildSystemAddendum([{ name: 'Read', description: 'read', parameters: {} }], {});
        expect(readOnly).toMatch(/<tool_call>/);
        expect(readOnly).not.toMatch(/æƒé™åˆ†çº§/);
    
        const delivery = textAdapter.buildSystemAddendum([{ name: 'Write', description: 'write', parameters: {} }], { writeEnabled: true });
        expect(delivery).toMatch(/æƒé™åˆ†çº§/);
  });

  test('routes by protocol string', () => {
        expect(resolveAdapter(TEXT_PROTOCOL)).toBe(textAdapter);
        expect(resolveAdapter(NATIVE_PROTOCOL)).toBe(nativeAdapter);
  });

  test('defaults to native for unknown / falsy protocol (safe default for cloud)', () => {
        expect(resolveAdapter(undefined)).toBe(nativeAdapter);
        expect(resolveAdapter('')).toBe(nativeAdapter);
        expect(resolveAdapter('garbage')).toBe(nativeAdapter);
  });

  test('adapters are frozen (single source, not mutable at runtime)', () => {
        expect(Object.isFrozen(nativeAdapter).toBeTruthy());
        expect(Object.isFrozen(textAdapter).toBeTruthy());
  });

});

