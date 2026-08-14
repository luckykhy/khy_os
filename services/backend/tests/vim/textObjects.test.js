'use strict';

/**
 * vim/textObjects resolveBracketObject — interior-cursor bracket text objects.
 *
 * Regression: the interior branch (cursor not on a bracket — the normal ci(/di(
 * case) called `findMatchingBracket(line, cursor, closeCh, openCh, false)` with
 * the open/close args SWAPPED. findMatchingBracket only returns on depth===0,
 * a convention that assumes the scan STARTS on a bracket (so depth pre-increments
 * to 1); with the cursor in the interior it never returned, so resolveTextObject
 * yielded null and ci(/di(/yi( in the classic REPL (src/cli/repl.js → src/vim)
 * silently did nothing. The fix scans backward for the nearest enclosing opening
 * bracket with proper nesting. The two on-bracket branches are unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveTextObject } = require('../../src/vim/textObjects');

// "a(bcd)e":  a0 (1 b2 c3 d4 )5 e6
const L = 'a(bcd)e';

test('ci( with cursor in the interior selects the inner text (was null)', () => {
  assert.deepStrictEqual(resolveTextObject('(', 'i', L, 3), { start: 2, end: 4 });
  assert.deepStrictEqual(resolveTextObject('(', 'i', L, 2), { start: 2, end: 4 });
});

test('ca( with cursor in the interior selects the whole bracketed span (was null)', () => {
  assert.deepStrictEqual(resolveTextObject('(', 'a', L, 3), { start: 1, end: 5 });
});

test('on-bracket cursors are unchanged (byte-identical)', () => {
  assert.deepStrictEqual(resolveTextObject('(', 'i', L, 1), { start: 2, end: 4 }); // on '('
  assert.deepStrictEqual(resolveTextObject('(', 'i', L, 5), { start: 2, end: 4 }); // on ')'
});

test('nested brackets resolve to the correct enclosing pair', () => {
  // "a(b(c)d)e":  a0 (1 b2 (3 c4 )5 d6 )7 e8
  const N = 'a(b(c)d)e';
  assert.deepStrictEqual(resolveTextObject('(', 'i', N, 4), { start: 4, end: 4 }); // inner, on 'c'
  assert.deepStrictEqual(resolveTextObject('(', 'i', N, 6), { start: 2, end: 6 }); // outer, on 'd'
  assert.deepStrictEqual(resolveTextObject('(', 'i', N, 2), { start: 2, end: 6 }); // outer, on 'b'
});

test('other bracket types (braces, square) work from the interior', () => {
  // "x{a[b]c}y":  x0 {1 a2 [3 b4 ]5 c6 }7 y8
  const B = 'x{a[b]c}y';
  assert.deepStrictEqual(resolveTextObject('{', 'i', B, 6), { start: 2, end: 6 }); // brace, on 'c'
  assert.deepStrictEqual(resolveTextObject('[', 'i', B, 4), { start: 4, end: 4 }); // square, on 'b'
});

test('no enclosing bracket returns null', () => {
  assert.strictEqual(resolveTextObject('(', 'i', 'abc', 0), null);
});
