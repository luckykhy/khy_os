'use strict';
/**
 * scrollActions leaf tests (node:test).
 *
 * Covers:
 *   - CC action-name parity (bare + `scroll:` prefixed), unknown �?no-op
 *   - line / half-page / full-page / top / bottom arithmetic (less conventions)
 *   - clamping at both ends; non-scrollable content (total <= viewport)
 *   - defensive: missing args, NaN/Infinity/negative dims, viewport 1
 */
const {
  SCROLL_ACTIONS,
  normalizeAction,
  maxOffset,
  clampOffset,
  applyScroll,
} = require('./scrollActions');
// Standard fixture: 100 lines of content in a 10-line viewport �?max offset 90.
const D = { viewport: 10, total: 100 };
// ── action-name parity with the CC registry ────────────────────────────────
// ── arithmetic ─────────────────────────────────────────────────────────────
// ── clamping ───────────────────────────────────────────────────────────────
// ── defensive ──────────────────────────────────────────────────────────────

describe('Scroll Actions', () => {
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
        expect(normalizeAction(a).toBe(a);
        expect(normalizeAction('scroll:' + a).toBe(a);
      }
  });

  test('normalizeAction: unknown / non-string �?null', () => {
      for (const a of ['', 'nope', 'scroll:nope', 'LINEUP', 'scroll:', null, undefined, 7, {}]) {
        expect(normalizeAction(a).toBe(null);
      }
  });

  test('line steps move exactly one line', () => {
      expect(applyScroll('lineDown', { ...D, offset: 4 }).toBe(5);
      expect(applyScroll('lineUp', { ...D, offset: 4 }).toBe(3);
  });

  test('half page = floor(viewport/2), full page = viewport', () => {
      expect(applyScroll('halfPageDown', { ...D, offset: 0 }).toBe(5);
      expect(applyScroll('halfPageUp', { ...D, offset: 20 }).toBe(15);
      expect(applyScroll('fullPageDown', { ...D, offset: 0 }).toBe(10);
      expect(applyScroll('fullPageUp', { ...D, offset: 20 }).toBe(10);
      // odd viewport floors
      expect(applyScroll('halfPageDown', { viewport: 7, total: 100, offset: 0 }).toBe(3);
  });

  test('top / bottom jump to the ends', () => {
      expect(applyScroll('top', { ...D, offset: 42 }).toBe(0);
      expect(applyScroll('bottom', { ...D, offset: 0 }).toBe(90);
  });

  test('clamps at the top edge (never negative)', () => {
      for (const a of ['lineUp', 'halfPageUp', 'fullPageUp']) {
        expect(applyScroll(a, { ...D, offset: 0 }).toBe(0);
      }
  });

  test('clamps at the bottom edge (never past total - viewport)', () => {
      for (const a of ['lineDown', 'halfPageDown', 'fullPageDown', 'bottom']) {
        expect(applyScroll(a, { ...D, offset: 90 }).toBe(90);
      }
  });

  test('content shorter than viewport is not scrollable', () => {
      const tiny = { viewport: 10, total: 3, offset: 0 };
      expect(maxOffset(tiny).toBe(0);
      for (const a of SCROLL_ACTIONS) {
        expect(applyScroll(a)).toBe(tiny);
      }
  });

  test('an out-of-range incoming offset is clamped before stepping', () => {
      expect(applyScroll('lineDown', { ...D, offset: 999 }).toBe(90);
      expect(applyScroll('lineUp', { ...D, offset: -5 }).toBe(0);
  });

  test('unknown action returns the clamped current offset unchanged', () => {
      expect(applyScroll('nope', { ...D, offset: 7 }).toBe(7);
      expect(applyScroll('nope', { ...D, offset: 999 }).toBe(90);
  });

  test('missing args never throw', () => {
      expect(applyScroll().toBe(0);
      expect(applyScroll('lineDown').toBe(0);
      expect(applyScroll('lineDown')).toBe(null);
      expect(maxOffset().toBe(0);
      expect(clampOffset(5).toBe(0);
  });

  test('non-finite / negative dims degrade to zero rather than NaN', () => {
      for (const bad of [NaN, Infinity, -Infinity, -3, 'x', null, undefined]) {
        const got = applyScroll('lineDown', { viewport: bad, total: bad, offset: bad });
        expect(got).toBe(0);
        expect(Number.isFinite(got).toBeTruthy());
      }
  });

  test('viewport 1: half/full page still advance at least one line', () => {
      const d = { viewport: 1, total: 10, offset: 0 };
      expect(applyScroll('halfPageDown')).toBe(d);
      expect(applyScroll('fullPageDown')).toBe(d);
  });

});

