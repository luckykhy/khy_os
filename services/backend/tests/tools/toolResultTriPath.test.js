'use strict';

/**
 * Tri-path tool result serialization tests (_toolResultNormalizer).
 *
 * Pins the shared contract of the three pure serializers:
 *   - renderToolResultMessage: human-readable text, cap via
 *     KHY_TOOL_RESULT_RENDER_MAX_CHARS (numeric, default 4000);
 *   - mapToolResultToModelBlock: model-input shape, preserves _contentBlocks
 *     images, truncates text at the large-result persistence threshold with
 *     the canonical Chinese notice;
 *   - extractSearchText: plain index text, image → [image], resource →
 *     [resource:uri] placeholders.
 * Plus: consistency across the three shapes, truncation boundaries, fail-soft
 * on malformed input, and no input mutation (deep-freeze probe).
 *
 * Also pins the KHY_TOOL_RESULT_TRIPATH gate wiring in
 * toolUseLoopHelpers._buildToolResultMessage: gate off → byte-identical
 * structured entries; gate on → model content produced by
 * mapToolResultToModelBlock.
 *
 * Hermetic: no real ~/.khy/ access; env restored around every test.
 */

const assert = require('assert');

const {
  normalizeToolResult,
  renderToolResultMessage,
  mapToolResultToModelBlock,
  extractSearchText,
} = require('../../src/tools/_toolResultNormalizer');

// Existing large-result persistence threshold semantics (50K chars) — the
// model-input truncation bound must align with it (no new duplicate bound).
const MODEL_MAX = 50000;
const RENDER_DEFAULT = 4000;

const _envBackup = {};
const _ENV_KEYS = ['KHY_TOOL_RESULT_TRIPATH', 'KHY_TOOL_RESULT_RENDER_MAX_CHARS'];

beforeEach(() => {
  for (const k of _ENV_KEYS) {
    _envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of _ENV_KEYS) {
    if (_envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = _envBackup[k];
  }
});

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

describe('tri-path consistency — same input, three shapes, no info loss', () => {
  test('plain text result appears identically in all three shapes', () => {
    const result = normalizeToolResult({ success: true, output: 'hello world' });
    assert.strictEqual(result.content, 'hello world');
    assert.strictEqual(renderToolResultMessage(result), 'hello world');
    assert.strictEqual(mapToolResultToModelBlock(result), 'hello world');
    assert.strictEqual(extractSearchText(result), 'hello world');
  });

  test('structured (array) payload is serialized consistently', () => {
    const result = normalizeToolResult({ success: true, matches: ['a.js', 'b.js'] });
    assert.strictEqual(result.content, 'a.js\nb.js');
    assert.strictEqual(renderToolResultMessage(result), 'a.js\nb.js');
    assert.strictEqual(mapToolResultToModelBlock(result), 'a.js\nb.js');
    assert.strictEqual(extractSearchText(result), 'a.js\nb.js');
  });
});

describe('renderToolResultMessage — truncation boundary (env cap)', () => {
  test('exactly at the cap → untouched, no notice', () => {
    const text = 'x'.repeat(RENDER_DEFAULT);
    const out = renderToolResultMessage({ content: text });
    assert.strictEqual(out, text);
    assert.ok(!out.includes('结果已截断'));
  });

  test('one char over the cap → truncated with Chinese notice (N/M correct)', () => {
    const text = 'x'.repeat(RENDER_DEFAULT + 1);
    const out = renderToolResultMessage({ content: text });
    assert.ok(out.startsWith('x'.repeat(RENDER_DEFAULT)));
    assert.ok(out.includes(`[结果已截断: 共 ${RENDER_DEFAULT + 1} 字符，保留前 ${RENDER_DEFAULT} 字符]`));
  });

  test('env KHY_TOOL_RESULT_RENDER_MAX_CHARS overrides the default cap', () => {
    process.env.KHY_TOOL_RESULT_RENDER_MAX_CHARS = '10';
    const out = renderToolResultMessage({ content: 'abcdefghijKLM' });
    assert.ok(out.startsWith('abcdefghij'));
    assert.ok(out.includes('[结果已截断: 共 13 字符，保留前 10 字符]'));
  });

  test('opts.maxChars takes precedence over env', () => {
    process.env.KHY_TOOL_RESULT_RENDER_MAX_CHARS = '10';
    const out = renderToolResultMessage({ content: 'abcdef' }, { maxChars: 3 });
    assert.ok(out.startsWith('abc'));
    assert.ok(out.includes('[结果已截断: 共 6 字符，保留前 3 字符]'));
  });
});

describe('mapToolResultToModelBlock — persistence-threshold truncation', () => {
  test('exactly at the 50K threshold → untouched', () => {
    const text = 'y'.repeat(MODEL_MAX);
    assert.strictEqual(mapToolResultToModelBlock({ content: text }), text);
  });

  test('over the threshold → truncated with Chinese notice', () => {
    const text = 'y'.repeat(MODEL_MAX + 5);
    const out = mapToolResultToModelBlock({ content: text });
    assert.strictEqual(out.length, MODEL_MAX + `\n[结果已截断: 共 ${MODEL_MAX + 5} 字符，保留前 ${MODEL_MAX} 字符]`.length);
    assert.ok(out.includes(`[结果已截断: 共 ${MODEL_MAX + 5} 字符，保留前 ${MODEL_MAX} 字符]`));
  });
});

describe('MCP image / resource blocks across the three shapes', () => {
  const mcpRaw = {
    content: [
      { type: 'text', text: 'screenshot below' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  };

  test('mapToolResultToModelBlock preserves image blocks for the model', () => {
    const result = normalizeToolResult(mcpRaw);
    const blocks = mapToolResultToModelBlock(result);
    assert.ok(Array.isArray(blocks));
    const img = blocks.find((b) => b.type === 'image');
    assert.ok(img, 'image block must be preserved');
    assert.strictEqual(img.source.type, 'base64');
    assert.strictEqual(img.source.media_type, 'image/png');
    assert.strictEqual(img.source.data, 'AAAA');
  });

  test('extractSearchText emits [image] placeholder for image blocks', () => {
    const result = normalizeToolResult(mcpRaw);
    const text = extractSearchText(result);
    assert.ok(text.includes('screenshot below'));
    assert.ok(text.includes('[image]'));
    assert.ok(!text.includes('AAAA'), 'base64 payload must never leak into index text');
  });

  test('extractSearchText emits [resource:uri] placeholder for resource blocks', () => {
    const result = {
      content: 'r',
      _contentBlocks: [
        { type: 'resource', resource: { uri: 'file:///tmp/a.txt' } },
      ],
    };
    assert.strictEqual(extractSearchText(result), '[resource:file:///tmp/a.txt]');
  });

  test('oversized text block inside _contentBlocks is truncated, image untouched', () => {
    const bigText = 'z'.repeat(MODEL_MAX + 1);
    const result = {
      content: 'c',
      _contentBlocks: [
        { type: 'text', text: bigText },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ],
    };
    const blocks = mapToolResultToModelBlock(result);
    assert.ok(blocks[0].text.includes('结果已截断'));
    assert.strictEqual(blocks[1].source.data, 'BBBB');
    // Original input must stay unmodified (copy-on-truncate)
    assert.strictEqual(result._contentBlocks[0].text, bigText);
  });
});

describe('fail-soft — malformed input never throws', () => {
  const malformed = [null, undefined, 42, 'str', [], { content: null }, { content: { a: 1 } }, { _contentBlocks: 'bad' }, { _contentBlocks: [null, 7] }];
  test('renderToolResultMessage', () => {
    for (const m of malformed) assert.doesNotThrow(() => renderToolResultMessage(m));
  });
  test('mapToolResultToModelBlock', () => {
    for (const m of malformed) assert.doesNotThrow(() => mapToolResultToModelBlock(m));
  });
  test('extractSearchText', () => {
    for (const m of malformed) assert.doesNotThrow(() => extractSearchText(m));
  });
});

describe('no input mutation — deep-frozen input passes through all three', () => {
  test('frozen normalized result is not modified', () => {
    const result = deepFreeze({
      success: true,
      content: 'frozen text',
      _contentBlocks: [
        { type: 'text', text: 'frozen text' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
      ],
    });
    assert.doesNotThrow(() => {
      renderToolResultMessage(result);
      mapToolResultToModelBlock(result);
      extractSearchText(result);
    });
    assert.strictEqual(result.content, 'frozen text');
    assert.strictEqual(result._contentBlocks.length, 2);
  });

  test('frozen oversized input: truncation is copy-on-write, input intact', () => {
    const big = 'w'.repeat(MODEL_MAX + 10);
    const result = deepFreeze({ content: big, _contentBlocks: [{ type: 'text', text: big }] });
    const blocks = mapToolResultToModelBlock(result);
    assert.ok(blocks[0].text.includes('结果已截断'));
    assert.strictEqual(result._contentBlocks[0].text, big);
  });
});

describe('KHY_TOOL_RESULT_TRIPATH gate wiring — _buildToolResultMessage', () => {
  // Load helpers lazily with injected deps (hermetic: no loop core needed).
  function buildWith(envOn, toolResults) {
    jest.resetModules();
    if (envOn) process.env.KHY_TOOL_RESULT_TRIPATH = '1';
    else delete process.env.KHY_TOOL_RESULT_TRIPATH;
    const helpers = require('../../src/services/toolUseLoopHelpers');
    helpers.setToolUseLoopHelpersDeps({
      _extractToolOutput: (r) => (r && typeof r.content === 'string' ? r.content : ''),
      _getActiveModelContextWindow: () => 32768,
    });
    return helpers._buildToolResultMessage(toolResults);
  }

  const sampleResults = [{
    tool: 'read_file',
    _toolUseId: 'toolu_01',
    result: { success: true, content: 'file body here' },
  }];

  test('gate off → structured entry keeps the legacy formatted content', () => {
    const off1 = buildWith(false, sampleResults);
    const off2 = buildWith(false, sampleResults);
    // Deterministic: two gate-off runs are byte-identical (current behavior pinned)
    assert.deepStrictEqual(off1.structuredToolResults, off2.structuredToolResults);
    assert.strictEqual(off1.structuredToolResults[0].content, 'file body here');
    assert.strictEqual(off1.structuredToolResults[0]._contentBlocks, null);
  });

  test('gate on → content comes from mapToolResultToModelBlock (same text for small results)', () => {
    const on = buildWith(true, sampleResults);
    assert.strictEqual(on.structuredToolResults[0].content, 'file body here');
  });

  test('gate on → oversized result carries the Chinese truncation notice; gate off uses legacy smart truncation', () => {
    const big = [{
      tool: 'run_command',
      _toolUseId: 'toolu_02',
      result: { success: true, content: 'q'.repeat(MODEL_MAX + 100) },
    }];
    const on = buildWith(true, big);
    assert.ok(on.structuredToolResults[0].content.includes('结果已截断'));
    const off = buildWith(false, big);
    assert.ok(!off.structuredToolResults[0].content.includes('结果已截断'));
  });

  test('gate on → image _contentBlocks are forwarded to the structured entry', () => {
    const withImage = [{
      tool: 'screenshot',
      _toolUseId: 'toolu_03',
      result: {
        success: true,
        content: '[Image: image/png]',
        _contentBlocks: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'DDDD' } }],
      },
    }];
    const on = buildWith(true, withImage);
    const blocks = on.structuredToolResults[0]._contentBlocks;
    assert.ok(Array.isArray(blocks));
    assert.strictEqual(blocks[0].type, 'image');
    // Gate off keeps the same passthrough (legacy already forwarded blocks)
    const off = buildWith(false, withImage);
    assert.deepStrictEqual(off.structuredToolResults[0]._contentBlocks, blocks);
  });
});
