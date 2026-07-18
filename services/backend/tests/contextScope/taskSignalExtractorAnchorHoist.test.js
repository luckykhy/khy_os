'use strict';

/**
 * taskSignalExtractorAnchorHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the per-anchor word-boundary
 * RegExps out of extractSignals(). Previously the body compiled ~22 fresh
 * `\b<anchor>\b` RegExp objects on every call; they are now precompiled once
 * at module load into _DIR_ANCHOR_MATCHERS. Behavior must be byte-identical:
 * dirHints must still surface recognised anchors and preserve DIR_ANCHORS
 * order, whole-word only (no substring false positives), stable across calls.
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractSignals } = require('../../src/services/contextScope/taskSignalExtractor');

test('recognises anchor dir names as whole words', () => {
  const sig = extractSignals('please fix the services backend layer');
  assert.ok(sig.dirHints.includes('services'));
  assert.ok(sig.dirHints.includes('backend'));
});

test('word-boundary only — no substring false positives', () => {
  // 'libraries' contains 'lib' but \blib\b must not match inside it;
  // 'testing' contains 'test' but \btest\b must not match inside it.
  const sig = extractSignals('reviewing libraries and testing frameworks');
  assert.ok(!sig.dirHints.includes('lib'));
  assert.ok(!sig.dirHints.includes('test'));
});

test('anchor dirHints preserve DIR_ANCHORS declaration order', () => {
  // 'tools' precedes 'src' in DIR_ANCHORS; even if the text mentions src first,
  // the filter walks the anchor list in order, so 'tools' comes before 'src'.
  const sig = extractSignals('look in src then tools');
  const ti = sig.dirHints.indexOf('tools');
  const si = sig.dirHints.indexOf('src');
  assert.ok(ti !== -1 && si !== -1);
  assert.ok(ti < si);
});

test('slash segments and anchors combine, deduped', () => {
  const sig = extractSignals('open services/gateway/adapters and the backend');
  assert.ok(sig.dirHints.includes('services'));
  assert.ok(sig.dirHints.includes('gateway'));
  assert.ok(sig.dirHints.includes('adapters'));
  assert.ok(sig.dirHints.includes('backend'));
  // deduped — no duplicate 'services' from slash + anchor
  assert.strictEqual(sig.dirHints.filter((d) => d === 'services').length, 1);
});

test('repeated calls are stable (shared matchers not corrupted by lastIndex)', () => {
  const a = extractSignals('scan the services and tools dirs').dirHints;
  const b = extractSignals('scan the services and tools dirs').dirHints;
  assert.deepStrictEqual(a, b);
});

test('no anchors / empty input is safe', () => {
  assert.deepStrictEqual(extractSignals('').dirHints, []);
  assert.deepStrictEqual(extractSignals(null).dirHints, []);
  const none = extractSignals('quantum entanglement discussion');
  assert.deepStrictEqual(none.dirHints, []);
});
