'use strict';

/**
 * lenientResponseParserActionKeysHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the known-action-keys Set out of
 * normalizeAction. It was rebuilt inline on every action of every parse; now it
 * is built once at module load as KNOWN_ACTION_KEYS. The Set is consumed
 * read-only via `.has` inside a `.filter`, and only the derived unknownKeys
 * array escapes — so a single shared instance is byte-identical, and the
 * `_unknownKeys` order (Object.keys input order, unaffected by hoisting) and
 * repeated-call stability must be preserved.
 */

const test = require('node:test');
const assert = require('node:assert');

const parser = require('../../../src/services/dualTrack/lenientResponseParser');
const { parseModelResponse, normalizeAction } = parser;

test('normalizeAction captures unknown keys in Object.keys order, known keys omitted', () => {
  const warnings = [];
  const out = normalizeAction(
    { type: 'Read', file_path: '/x', foo: 1, bar: 2, params: {} },
    0, warnings, null,
  );
  // known keys (type, params) omitted; unknowns in declaration order.
  assert.deepStrictEqual(out._unknownKeys, ['file_path', 'foo', 'bar']);
  assert.strictEqual(out.type, 'Read');
  assert.ok(warnings.some((w) => w.includes('含未知键')));
});

test('all-known action produces no unknown keys and no warning', () => {
  const warnings = [];
  const out = normalizeAction(
    { type: 'Bash', name: 'x', tool: 'y', action: 'z', params: {}, input: {}, arguments: {}, args: {}, id: 'a1' },
    0, warnings, null,
  );
  assert.deepStrictEqual(out._unknownKeys, []);
  assert.strictEqual(warnings.length, 0);
});

test('repeated back-to-back parses yield identical _unknownKeys and warnings (shared Set does not leak)', () => {
  const payload = { actions: [{ type: 'Read', zzz: 1, aaa: 2, mmm: 3 }] };
  const a = parseModelResponse(payload);
  const b = parseModelResponse(payload);
  assert.deepStrictEqual(a.actions[0]._unknownKeys, ['zzz', 'aaa', 'mmm']);
  assert.deepStrictEqual(a.actions[0]._unknownKeys, b.actions[0]._unknownKeys);
  assert.deepStrictEqual(a.warnings, b.warnings);
});

test('multiple actions in one response each get independent unknownKeys', () => {
  const out = parseModelResponse({
    actions: [
      { type: 'Read', p1: 1 },
      { type: 'Write', q2: 2, r3: 3 },
    ],
  });
  assert.deepStrictEqual(out.actions[0]._unknownKeys, ['p1']);
  assert.deepStrictEqual(out.actions[1]._unknownKeys, ['q2', 'r3']);
});
