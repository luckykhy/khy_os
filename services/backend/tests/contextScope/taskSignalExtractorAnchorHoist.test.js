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
const { extractSignals } = require('../../src/services/contextScope/taskSignalExtractor');

describe('Task Signal Extractor Anchor Hoist', () => {
  test('recognises anchor dir names as whole words', () => {
      const sig = extractSignals('please fix the services backend layer');
      expect(sig.dirHints).toContain('services');
      expect(sig.dirHints).toContain('backend');
  });

  test('word-boundary only — no substring false positives', () => {
      // 'libraries' contains 'lib' but \blib\b must not match inside it;
      // 'testing' contains 'test' but \btest\b must not match inside it.
      const sig = extractSignals('reviewing libraries and testing frameworks');
      expect(!sig.dirHints).toContain('lib');
      expect(!sig.dirHints).toContain('test');
  });

  test('anchor dirHints preserve DIR_ANCHORS declaration order', () => {
      // 'tools' precedes 'src' in DIR_ANCHORS; even if the text mentions src first,
      // the filter walks the anchor list in order, so 'tools' comes before 'src'.
      const sig = extractSignals('look in src then tools');
      const ti = sig.dirHints.indexOf('tools');
      const si = sig.dirHints.indexOf('src');
      expect(ti !== -1 && si !== -1).toBeTruthy();
      expect(ti < si).toBeTruthy();
  });

  test('slash segments and anchors combine, deduped', () => {
      const sig = extractSignals('open services/gateway/adapters and the backend');
      expect(sig.dirHints).toContain('services');
      expect(sig.dirHints).toContain('gateway');
      expect(sig.dirHints).toContain('adapters');
      expect(sig.dirHints).toContain('backend');
      // deduped — no duplicate 'services' from slash + anchor
      expect(sig.dirHints.filter((d) => d === 'services').length).toBe(1);
  });

  test('repeated calls are stable (shared matchers not corrupted by lastIndex)', () => {
      const a = extractSignals('scan the services and tools dirs').dirHints;
      const b = extractSignals('scan the services and tools dirs').dirHints;
      expect(a).toEqual(b);
  });

  test('no anchors / empty input is safe', () => {
      expect(extractSignals('').dirHints).toEqual([]);
      expect(extractSignals(null).dirHints).toEqual([]);
      const none = extractSignals('quantum entanglement discussion');
      expect(none.dirHints).toEqual([]);
  });

});
