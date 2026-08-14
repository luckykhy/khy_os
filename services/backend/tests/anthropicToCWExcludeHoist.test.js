'use strict';

/**
 * anthropicToCWExcludeHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the default exclude-Set in
 * anthropicToCW(): the default `web_search`/`websearch` exclusion is now a
 * single shared module constant instead of a fresh `new Set([...])` per call.
 *
 * Contract:
 *   1. The default exclusion filters `web_search`/`websearch` (behavior kept).
 *   2. An explicit `excludeNames` still overrides the default.
 *   3. The default Set is the same shared instance across calls (hoisted).
 *   4. The shared Set is never mutated by conversion (membership stable).
 *   5. The converter output never leaks the Set.
 */

const test = require('node:test');
const assert = require('node:assert');

const conv = require('../src/services/gateway/adapters/_toolSchemaConverter.js');
const { anthropicToCW, _DEFAULT_CW_EXCLUDE } = conv;

function names(out) {
  return (out || []).map((t) => t.toolSpecification.name);
}

test('default exclusion drops web_search/websearch, keeps others', () => {
  const tools = [
    { name: 'web_search', description: 'x', input_schema: {} },
    { name: 'websearch', description: 'x', input_schema: {} },
    { name: 'Read', description: 'r', input_schema: {} },
    { name: 'Bash', description: 'b', input_schema: {} },
  ];
  assert.deepStrictEqual(names(anthropicToCW(tools)), ['Read', 'Bash']);
});

test('explicit excludeNames overrides the default', () => {
  const tools = [
    { name: 'web_search', description: 'x', input_schema: {} },
    { name: 'Read', description: 'r', input_schema: {} },
  ];
  // With an explicit exclude of just 'Read', web_search is now kept.
  assert.deepStrictEqual(
    names(anthropicToCW(tools, { excludeNames: ['Read'] })),
    ['web_search'],
  );
  // Array and Set forms are equivalent.
  assert.deepStrictEqual(
    names(anthropicToCW(tools, { excludeNames: new Set(['Read']) })),
    ['web_search'],
  );
});

test('default Set is a shared module constant (hoisted, not per-call)', () => {
  // The exported constant is a Set with the expected membership.
  assert.ok(_DEFAULT_CW_EXCLUDE instanceof Set);
  assert.strictEqual(_DEFAULT_CW_EXCLUDE.has('web_search'), true);
  assert.strictEqual(_DEFAULT_CW_EXCLUDE.has('websearch'), true);
  assert.strictEqual(_DEFAULT_CW_EXCLUDE.size, 2);
  // Re-requiring the module yields the same instance (module-scope const).
  const again = require('../src/services/gateway/adapters/_toolSchemaConverter.js');
  assert.strictEqual(again._DEFAULT_CW_EXCLUDE, _DEFAULT_CW_EXCLUDE);
});

test('conversion does not mutate the shared default Set', () => {
  const before = [..._DEFAULT_CW_EXCLUDE].sort();
  anthropicToCW([
    { name: 'web_search', description: 'x', input_schema: {} },
    { name: 'Read', description: 'r', input_schema: {} },
  ]);
  anthropicToCW([{ name: 'Bash', description: 'b', input_schema: {} }]);
  const after = [..._DEFAULT_CW_EXCLUDE].sort();
  assert.deepStrictEqual(after, before);
  assert.strictEqual(_DEFAULT_CW_EXCLUDE.size, 2);
});

test('output shape carries no Set reference', () => {
  const out = anthropicToCW([{ name: 'Read', description: 'r', input_schema: { type: 'object' } }]);
  assert.strictEqual(out.length, 1);
  const spec = out[0].toolSpecification;
  assert.strictEqual(spec.name, 'Read');
  assert.deepStrictEqual(spec.inputSchema.json, { type: 'object' });
});
