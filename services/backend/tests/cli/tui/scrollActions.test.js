'use strict';

/**
 * scrollActions leaf tests (node:test).
 *
 * Rewritten 2026-09-16 against the current `src/cli/tui/scrollActions.js`.
 * The previous jest-`describe` version stopped parsing after encoding
 * corruption and was replaced by a QUARANTINE stub (see tests/DEBT.md §六).
 * The assertions below are recovered from that original — the corruption only
 * ate `)` in `expect(f(x).toBe(y)` and the CJK strings, so the intent survived.
 *
 * Covers:
 *   - CC action-name parity (bare + `scroll:` prefixed), unknown → no-op
 *   - line / half-page / full-page / top / bottom arithmetic (less conventions)
 *   - clamping at both ends; non-scrollable content (total <= viewport)
 *   - defensive: missing args, NaN/Infinity/negative dims, viewport 1
 *
 * Run: `node --test tests/cli/tui/scrollActions.test.js`
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  SCROLL_ACTIONS,
  normalizeAction,
  maxOffset,
  clampOffset,
  applyScroll,
} = require('../../../src/cli/tui/scrollActions');

// Standard fixture: 100 lines of content in a 10-line viewport → max offset 90.
const D = { viewport: 10, total: 100 };

// ── action-name parity with the CC registry ────────────────────────────────

test('SCROLL_ACTIONS covers exactly the CC scroll:* family', () => {
  assert.deepStrictEqual(SCROLL_ACTIONS.slice(), [
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

test('SCROLL_ACTIONS is frozen (no accidental mutation of the registry)', () => {
  assert.ok(Object.isFrozen(SCROLL_ACTIONS));
});

test('normalizeAction: accepts bare and scroll:-prefixed names', () => {
  for (const a of SCROLL_ACTIONS) {
    assert.equal(normalizeAction(a), a);
    assert.equal(normalizeAction('scroll:' + a), a);
  }
});

test('normalizeAction: unknown / non-string → null', () => {
  for (const a of ['', 'nope', 'scroll:nope', 'LINEUP', 'scroll:', null, undefined, 7, {}]) {
    assert.equal(normalizeAction(a), null, `normalizeAction(${JSON.stringify(a)}) must be null`);
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
    assert.equal(applyScroll(a, { ...D, offset: 0 }), 0, `${a} at the top edge`);
  }
});

test('clamps at the bottom edge (never past total - viewport)', () => {
  for (const a of ['lineDown', 'halfPageDown', 'fullPageDown', 'bottom']) {
    assert.equal(applyScroll(a, { ...D, offset: 90 }), 90, `${a} at the bottom edge`);
  }
});

test('content shorter than viewport is not scrollable', () => {
  const tiny = { viewport: 10, total: 3, offset: 0 };
  assert.equal(maxOffset(tiny), 0);
  for (const a of SCROLL_ACTIONS) {
    assert.equal(applyScroll(a, tiny), 0, `${a} on non-scrollable content`);
  }
});

test('an out-of-range incoming offset is clamped before stepping', () => {
  assert.equal(applyScroll('lineDown', { ...D, offset: 999 }), 90);
  assert.equal(applyScroll('lineUp', { ...D, offset: -5 }), 0);
});

test('unknown action returns the clamped current offset unchanged', () => {
  assert.equal(applyScroll('nope', { ...D, offset: 7 }), 7);
  assert.equal(applyScroll('nope', { ...D, offset: 999 }), 90);
});

// ── defensive ──────────────────────────────────────────────────────────────

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
    assert.equal(got, 0, `dims=${String(bad)} must degrade to 0`);
    assert.ok(Number.isFinite(got), `dims=${String(bad)} must stay finite`);
  }
});

test('viewport 1: half/full page still advance at least one line', () => {
  const d = { viewport: 1, total: 10, offset: 0 };
  assert.equal(applyScroll('halfPageDown', d), 1);
  assert.equal(applyScroll('fullPageDown', d), 1);
});

test('clampOffset: floors fractional offsets and rejects non-finite', () => {
  assert.equal(clampOffset(3.9, D), 3);
  assert.equal(clampOffset(NaN, D), 0);
  assert.equal(clampOffset(Infinity, D), 0);
  assert.equal(clampOffset(-1, D), 0);
  assert.equal(clampOffset(200, D), 90);
});

// ── cross-check against the Viewport leaf's own offset rules ───────────────
// `Viewport.resolveViewportOffset` treats a NEGATIVE offset as "stick to the
// bottom"; `applyScroll` here treats it as "clamp to the top". They are two
// different leaves with two different contracts — pin both so a future
// refactor cannot silently merge them.
test('契约对照: 本叶子把负 offset 归零(与 Viewport 的贴底哨兵语义不同)', () => {
  assert.equal(clampOffset(-5, D), 0);
  // 负 offset 先被 clamp 到 0,再按动作步进 —— 不是「跳到最底」。
  assert.equal(applyScroll('lineUp', { ...D, offset: -5 }), 0);
  assert.equal(applyScroll('lineDown', { ...D, offset: -5 }), 1);
});
