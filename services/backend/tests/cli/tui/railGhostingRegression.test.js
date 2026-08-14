'use strict';

// Regression tests for the board ghosting / flicker root cause (task #1).
//
// These lock the SINGLE-SOURCE geometry contract that ties together:
//   - railLayout.contentCols  (what ink narrows the tree to)
//   - railLayout.railActive   (whether the rail claims columns)
//   - railLayout.railGeometry  (where the out-of-band painter draws)
//   - sidebarLayout.stickyDim  (how a conpty size oscillation is absorbed)
//   - sidebarLayout.nextSessionMax (monotonic fullscreen baseline)
//
// The invariant under test: for one resolved size, the in-tree narrowing
// verdict, the rail activation verdict and the painter's geometry.on MUST
// agree — otherwise the two render paths draw over each other (ghosting).
// The DEFAULT_RAIL_TOP_OFFSET=6 lift is a VERTICAL translation only; it must
// never change the horizontal activation verdict.
//
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const railLayout = require('../../../src/cli/tui/railLayout');
const sidebarLayout = require('../../../src/cli/tui/sidebarLayout');

/** Run `fn` with env vars temporarily set, restoring them afterwards. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// Base env: rail gate ON, all sizing knobs at their single-source defaults so
// the tests exercise the shipped thresholds (minCols 120, fallback 80, etc.).
const BASE = { KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR: '1' };

// ── A. Path consistency: one size → one verdict across all three consumers ───
test('path consistency: contentCols>0 ⇔ railActive ⇔ railGeometry().on (wide + narrow)', () => {
  withEnv(BASE, () => {
    const rows = 40;
    for (const cols of [40, 80, 100, 119, 120, 121, 150, 240]) {
      // App's actual narrowing predicate (_railContentCols): the tree is
      // narrowed ONLY when contentCols is STRICTLY less than the full width —
      // for an inactive rail contentCols returns the full width unchanged.
      const narrowed = railLayout.contentCols(cols, process.env) < cols;
      const active = railLayout.railActive(cols, process.env);
      const geomFill = railLayout.railGeometry(cols, rows, process.env, { bottomChrome: 2 }).on;
      const geomLegacy = railLayout.railGeometry(cols, rows, process.env).on;
      assert.equal(narrowed, active, `contentCols vs railActive @${cols}`);
      assert.equal(active, geomFill, `railActive vs railGeometry(chrome) @${cols}`);
      assert.equal(active, geomLegacy, `railActive vs railGeometry(legacy) @${cols}`);
    }
  });
});

test('path consistency: DEFAULT_RAIL_TOP_OFFSET=6 is vertical-only — activation identical to offset=0', () => {
  const rows = 40;
  const cols = 150;
  // Default offset (6) vs an explicit 0: the horizontal verdict and gutter
  // width/left must be byte-identical; only top/height may shift.
  const def = withEnv(BASE, () =>
    railLayout.railGeometry(cols, rows, process.env, { bottomChrome: 2, contentRows: 10 }));
  const zero = withEnv({ ...BASE, KHY_SIDEBAR_RAIL_TOP_OFFSET: '0' }, () =>
    railLayout.railGeometry(cols, rows, process.env, { bottomChrome: 2, contentRows: 10 }));
  assert.equal(railLayout.railTopOffset({ KHY_SIDEBAR_RAIL_TOP_OFFSET: undefined }), 6,
    'offset default must remain 6 (user requirement)');
  assert.equal(def.on, zero.on, 'activation unaffected by offset');
  assert.equal(def.width, zero.width, 'width unaffected by offset');
  assert.equal(def.left, zero.left, 'left unaffected by offset');
  // The offset=6 board sits 6 rows higher than the offset=0 board.
  assert.equal(zero.top - def.top, 6, 'offset=6 lifts the block by exactly 6 rows');
});

test('path consistency @offset=6: contentCols narrowing matches painter left column', () => {
  withEnv({ ...BASE, KHY_SIDEBAR_RAIL_TOP_OFFSET: '6' }, () => {
    const cols = 150;
    const rows = 40;
    const g = railLayout.railGeometry(cols, rows, process.env, { bottomChrome: 2 });
    assert.equal(g.on, true, 'wide terminal → rail on at offset=6');
    // The ink tree renders into `contentCols` columns; the painter reserves the
    // gutter starting at `left`. They must partition the row without overlap or
    // gap: contentCols + gutterWidth === cols, and left === contentCols + 1.
    const narrowed = railLayout.contentCols(cols, process.env);
    assert.equal(narrowed + g.width, cols, 'narrowed tree + gutter == full width');
    assert.equal(g.left, narrowed + 1, 'painter left starts right after the narrowed tree');
  });
});

// ── B. Oscillation: 120 → undefined → 120 keeps the board visible & stable ───
test('oscillation 120→undefined→120: sticky holds size, geometry stable, session-max monotonic', () => {
  withEnv(BASE, () => {
    const rows = 40;
    const raws = [120, undefined, 120, undefined, undefined, 120];
    let prev = null;                 // last sticky-resolved COLS (App's _stickyCols cache)
    let max = { cols: sidebarLayout.fallbackCols(process.env), rows: sidebarLayout.fallbackRows(process.env) };
    let prevMaxCols = max.cols;
    let firstGeom = null;
    for (const raw of raws) {
      const cols = sidebarLayout.stickyDim(raw, prev, process.env);
      if (typeof cols === 'number' && cols > 0) prev = cols; // cache valid readings only
      // Sticky must hold 120 straight through the undefined frames.
      assert.equal(cols, 120, `sticky cols stays 120 (raw=${String(raw)})`);
      const dimsKnown = Number(cols) > 0;
      assert.equal(railLayout.railActive(cols, process.env), true, 'board stays visible across oscillation');
      const g = railLayout.railGeometry(cols, rows, process.env, { bottomChrome: 2 });
      assert.equal(g.on, true, 'painter geometry stays on');
      if (firstGeom) {
        assert.equal(g.width, firstGeom.width, 'gutter width never jitters');
        assert.equal(g.left, firstGeom.left, 'gutter left never jitters');
      } else { firstGeom = g; }
      max = sidebarLayout.nextSessionMax(dimsKnown, cols, rows, max.cols, max.rows);
      assert.ok(max.cols >= prevMaxCols, 'session-max is monotonic non-decreasing');
      prevMaxCols = max.cols;
    }
    assert.equal(max.cols, 120, 'session-max settled at the real measured width');
  });
});

test('oscillation: a genuinely-unknown first frame never grows/shrinks the session max', () => {
  withEnv(BASE, () => {
    const seedCols = sidebarLayout.fallbackCols(process.env);
    const seedRows = sidebarLayout.fallbackRows(process.env);
    // raw=undefined with NO prior valid value → stickyDim=null → dimsKnown=false.
    const cols = sidebarLayout.stickyDim(undefined, null, process.env);
    assert.equal(cols, null, 'unknown with no prior → null');
    const dimsKnown = Number(cols) > 0;
    assert.equal(dimsKnown, false);
    const max = sidebarLayout.nextSessionMax(dimsKnown, cols, 40, seedCols, seedRows);
    assert.deepEqual(max, { cols: seedCols, rows: seedRows },
      'unknown frame must leave the seeded session-max untouched (no flicker source)');
  });
});

// ── C. Sticky trichotomy: valid / null / undefined / NaN / 0 / negative ──────
test('stickyDim trichotomy: finite positive → floor, unknown → sticky reuse, garbage → 0', () => {
  const env = { ...BASE };
  // finite positive → floor
  assert.equal(sidebarLayout.stickyDim(120, null, env), 120);
  assert.equal(sidebarLayout.stickyDim(120.9, null, env), 120, 'floors fractional');
  // unknown (null/undefined) with a prior valid value → reuse it (sticky)
  assert.equal(sidebarLayout.stickyDim(null, 100, env), 100);
  assert.equal(sidebarLayout.stickyDim(undefined, 100, env), 100);
  // unknown with no prior → null
  assert.equal(sidebarLayout.stickyDim(null, null, env), null);
  assert.equal(sidebarLayout.stickyDim(undefined, undefined, env), null);
  // garbage (NaN/0/negative) → 0, and it must NOT be treated as sticky
  assert.equal(sidebarLayout.stickyDim(NaN, 100, env), 0);
  assert.equal(sidebarLayout.stickyDim(0, 100, env), 0);
  assert.equal(sidebarLayout.stickyDim(-5, 100, env), 0);
});

test('stickyDim: a valid value that appears AFTER an unknown first frame is usable (cacheable)', () => {
  const env = { ...BASE };
  // Frame 1: unknown, no prior → null (caller does NOT cache null).
  const f1 = sidebarLayout.stickyDim(undefined, null, env);
  assert.equal(f1, null);
  // Frame 2: the first REAL reading arrives → returns the floored value so the
  // caller can write it into its sticky cache (this is the "unknown first frame
  // then valid value" path that a Number(x)>0-style implicit check would drop).
  const f2 = sidebarLayout.stickyDim(150, f1 /* still null */, env);
  assert.equal(f2, 150, 'first real value after an unknown frame must be returned for caching');
});

test('stickyDim: KHY_TERM_STICKY_DIMS off → unknown resolves to null (legacy, no reuse)', () => {
  const env = { ...BASE, KHY_TERM_STICKY_DIMS: '0' };
  assert.equal(sidebarLayout.stickyDim(null, 100, env), null, 'stickiness disabled → no reuse');
  assert.equal(sidebarLayout.stickyDim(120, 100, env), 120, 'a real reading still resolves');
});

// ── D. setDims normalization semantics (runtime painter mirrors stickyDim) ───
test('setDims normalization: geometry follows pushed dims with the stickyDim trichotomy', () => {
  const RAIL = require.resolve('../../../src/cli/tui/runtime/sidebarRail');
  delete require.cache[RAIL];
  const rail = require(RAIL);
  const { Writable } = require('stream');
  const out = new Writable({ write(c, e, cb) { cb(); } });
  out.isTTY = true; out.columns = 150; out.rows = 40;
  withEnv(BASE, () => {
    rail.enable(out);
    // Valid push → geometry active at that width.
    rail.setDims(150, 40);
    assert.equal(rail.isActive(), true, 'valid dims → active');
    // Unknown push (null) → sticky reuse of the last valid width → still active.
    rail.setDims(null, null);
    assert.equal(rail.isActive(), true, 'unknown dims reuse last valid (sticky) → still active');
    // Garbage push (0) → rejected, and NOT cached; geometry goes off this frame.
    rail.setDims(0, 0);
    assert.equal(rail.isActive(), false, 'garbage dims → geometry off, not cached');
    // A fresh unknown frame must fall back to sticky last-VALID (150), not the
    // rejected garbage → active again.
    rail.setDims(null, null);
    assert.equal(rail.isActive(), true, 'sticky ignored the garbage frame and kept 150');
    rail.disable();
  });
});
