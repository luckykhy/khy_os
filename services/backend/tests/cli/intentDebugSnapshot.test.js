'use strict';

/**
 * intentDebugSnapshot.test.js — pure intent-assurance snapshot builder.
 *
 * These helpers were extracted verbatim from the cli/repl.js god file as part of
 * the behavior-preserving split. They had NO direct test coverage while buried
 * in the REPL closure (the one reachable test, repl.intentAssuranceDebug, is on
 * a separately-broken branch); this pins their contracts as an importable, pure
 * module (no closure state, no chalk, no I/O).
 */

const {
  trimIntentDebugItem,
  normalizeIntentDebugList,
  buildIntentAssuranceDebugSnapshot,
} = require('../../src/cli/repl/intentDebugSnapshot');

describe('trimIntentDebugItem', () => {
  test('collapses internal whitespace and trims edges', () => {
    expect(trimIntentDebugItem('  a   b\tc \n')).toBe('a b c');
  });

  test('returns empty string for empty / whitespace / nullish input', () => {
    expect(trimIntentDebugItem('')).toBe('');
    expect(trimIntentDebugItem('   ')).toBe('');
    expect(trimIntentDebugItem(undefined)).toBe('');
    expect(trimIntentDebugItem(null)).toBe('');
  });

  test('returns input untouched when at or below maxLen', () => {
    expect(trimIntentDebugItem('short', 100)).toBe('short');
  });

  test('clamps to maxLen-1 chars plus ellipsis when over the limit', () => {
    const out = trimIntentDebugItem('x'.repeat(50), 20);
    expect(out).toBe('x'.repeat(19) + '…');
    expect(out).toHaveLength(20); // 19 chars + 1 ellipsis
  });

  test('keeps at least 16 leading chars even for tiny maxLen', () => {
    const out = trimIntentDebugItem('y'.repeat(50), 5);
    expect(out).toBe('y'.repeat(16) + '…');
  });
});

describe('normalizeIntentDebugList', () => {
  test('returns empty array for non-array input', () => {
    expect(normalizeIntentDebugList(null)).toEqual([]);
    expect(normalizeIntentDebugList('nope')).toEqual([]);
    expect(normalizeIntentDebugList(undefined)).toEqual([]);
  });

  test('trims each entry, drops empties, and caps to limit', () => {
    const out = normalizeIntentDebugList(['  a ', '', '   ', 'b', 'c', 'd'], 2);
    expect(out).toEqual(['a', 'b']);
  });

  test('defaults to a cap of six entries', () => {
    const out = normalizeIntentDebugList(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(out).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('buildIntentAssuranceDebugSnapshot', () => {
  test('returns null for non-object payloads', () => {
    expect(buildIntentAssuranceDebugSnapshot(null)).toBeNull();
    expect(buildIntentAssuranceDebugSnapshot('x')).toBeNull();
    expect(buildIntentAssuranceDebugSnapshot(42)).toBeNull();
  });

  test('derives defaults for an empty payload', () => {
    expect(buildIntentAssuranceDebugSnapshot({})).toEqual({
      source: 'runtime',
      shouldInject: true,
      requestClass: '',
      primaryObjective: '',
      summary: '',
      constraints: [],
      detailAnchors: [],
      tailDetails: [],
      constraintCount: 0,
      detailCount: 0,
      tailDetailCount: 0,
    });
  });

  test('falls back primaryObjective through summary then message', () => {
    expect(buildIntentAssuranceDebugSnapshot({ summary: 'sum' }).primaryObjective).toBe('sum');
    expect(buildIntentAssuranceDebugSnapshot({ message: 'msg' }).primaryObjective).toBe('msg');
  });

  test('honors shouldInject=false but defaults truthy otherwise', () => {
    expect(buildIntentAssuranceDebugSnapshot({ shouldInject: false }).shouldInject).toBe(false);
    expect(buildIntentAssuranceDebugSnapshot({ shouldInject: undefined }).shouldInject).toBe(true);
  });

  test('normalizes lists and takes max(list length, explicit count)', () => {
    const snap = buildIntentAssuranceDebugSnapshot({
      constraints: ['a', 'b'],
      detailAnchors: ['x'],
      tailDetails: [],
      constraintCount: 1, // smaller than actual list -> list wins
      detailCount: 5, // larger than list -> explicit wins
    });
    expect(snap.constraints).toEqual(['a', 'b']);
    expect(snap.constraintCount).toBe(2);
    expect(snap.detailCount).toBe(5);
    expect(snap.tailDetailCount).toBe(0);
  });

  test('caps list fields at their per-field limits (constraints 5 / anchors 8 / tails 4)', () => {
    const snap = buildIntentAssuranceDebugSnapshot({
      constraints: Array.from({ length: 9 }, (_, i) => `c${i}`),
      detailAnchors: Array.from({ length: 12 }, (_, i) => `d${i}`),
      tailDetails: Array.from({ length: 9 }, (_, i) => `t${i}`),
    });
    expect(snap.constraints).toHaveLength(5);
    expect(snap.detailAnchors).toHaveLength(8);
    expect(snap.tailDetails).toHaveLength(4);
  });

  test('normalizes a blank source back to runtime', () => {
    expect(buildIntentAssuranceDebugSnapshot({ source: '   ' }).source).toBe('runtime');
    expect(buildIntentAssuranceDebugSnapshot({ source: 'external' }).source).toBe('external');
  });
});
