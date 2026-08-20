'use strict';

/**
 * scrollActions leaf tests (node:test).
 *
 * Covers:
 *   - CC action-name parity (bare + `scroll:` prefixed), unknown → no-op
 *   - line / half-page / full-page / top / bottom arithmetic (less conventions)
 *   - clamping at both ends; non-scrollable content (total <= viewport)
 *   - defensive: missing args, NaN/Infinity/negative dims, viewport 1
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  SCROLL_ACTIONS,
  normalizeAction,
  maxOffset,
  clampOffset,
  applyScroll,
} = require('./scrollActions');

// Standard fixture: 100 lines of content in a 10-line viewport → max offset 90.
const D = { viewport: 10, total: 100 };

// ── action-name parity with the CC registry ────────────────────────────────
test('SCROLL_ACTIONS covers exactly the CC scroll:* family', () => {
  assert.deepEqual(SCROLL_ACTIONS.slice(), [
    'lineUp',
    'lineDown',
    'halfPageUp',
    'halfPageDown',
    'fullPageUp',
    'fullPageDown',
    'top',
    'bottom',
  ]);
});

test('normalizeAction: accepts bare and scroll:-prefixed names', () => {
  for (const a of SCROLL_ACTIONS) {
    assert.equal(normalizeAction(a), a);
    assert.equal(normalizeAction('scroll:' + a), a);
  }
});

test('normalizeAction: unknown / non-string → null', () => {
  for (const a of ['', 'nope', 'scroll:nope', 'LINEUP', 'scroll:', null, undefined, 7, {}]) {
    assert.equal(normalizeAction(a), null, `${JSON.stringify(a)} should not normalize`);
  }
});

// ── arithmetic ─────────────────────────────────────────────────────────────
test('line steps move exactly one line', () => {
  assert.equal(applyScroll('lineDown', { ...D, offset: 4 }), 5);
  assert.equal(applyScroll('lineUp', { ...D, offset: 4 }), 3);
});

test('half page = floor(viewport/2), full page = viewport', () => {
  assert.equal(applyScroll('halfPageDown', { ...D, offset: 0 }), 5);
  assert.equal(applyScroll('halfPageUp', { ...D, offset: 20 }), 15);
  assert.equal(applyScroll('fullPageDown', { ...D, offset: 0 }), 10);
  assert.equal(applyScroll('fullPageUp', { ...D, offset: 20 }), 10);
  // odd viewport floors
  assert.equal(applyScroll('halfPageDown', { viewport: 7, total: 100, offset: 0 }), 3);
});

test('top / bottom jump to the ends', () => {
  assert.equal(applyScroll('top', { ...D, offset: 42 }), 0);
  assert.equal(applyScroll('bottom', { ...D, offset: 0 }), 90);
});

// ── clamping ───────────────────────────────────────────────────────────────
test('clamps at the top edge (never negative)', () => {
  for (const a of ['lineUp', 'halfPageUp', 'fullPageUp']) {
    assert.equal(applyScroll(a, { ...D, offset: 0 }), 0, a);
  }
});

test('clamps at the bottom edge (never past total - viewport)', () => {
  for (const a of ['lineDown', 'halfPageDown', 'fullPageDown', 'bottom']) {
    assert.equal(applyScroll(a, { ...D, offset: 90 }), 90, a);
  }
});

test('content shorter than viewport is not scrollable', () => {
  const tiny = { viewport: 10, total: 3, offset: 0 };
  assert.equal(maxOffset(tiny), 0);
  for (const a of SCROLL_ACTIONS) {
    assert.equal(applyScroll(a, tiny), 0, a);
  }
});

test('an out-of-range incoming offset is clamped before stepping', () => {
  assert.equal(applyScroll('lineDown', { ...D, offset: 999 }), 90);
  assert.equal(applyScroll('lineUp', { ...D, offset: -5 }), 0);
});

// ── defensive ──────────────────────────────────────────────────────────────
test('unknown action returns the clamped current offset unchanged', () => {
  assert.equal(applyScroll('nope', { ...D, offset: 7 }), 7);
  assert.equal(applyScroll('nope', { ...D, offset: 999 }), 90);
});

test('missing args never throw', () => {
  assert.equal(applyScroll(), 0);
  assert.equal(applyScroll('lineDown'), 0);
  assert.equal(applyScroll('lineDown', null), 0);
  assert.equal(maxOffset(), 0);
  assert.equal(clampOffset(5), 0);
});

test('non-finite / negative dims degrade to zero rather than NaN', () => {
  for (const bad of [NaN, Infinity, -Infinity, -3, 'x', null, undefined]) {
    const got = applyScroll('lineDown', { viewport: bad, total: bad, offset: bad });
    assert.equal(got, 0, `dims ${String(bad)} → 0`);
    assert.ok(Number.isFinite(got));
  }
});

test('viewport 1: half/full page still advance at least one line', () => {
  const d = { viewport: 1, total: 10, offset: 0 };
  assert.equal(applyScroll('halfPageDown', d), 1);
  assert.equal(applyScroll('fullPageDown', d), 1);
});
