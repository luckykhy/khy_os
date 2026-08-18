'use strict';

// startupAnchor.test — the bottom-anchor startup anchor (KHY_TUI_ANCHOR_BOTTOM).
// Pure leaf: no IO, so tests just assert the returned bytes. Covers: default-off
// gate, explicit on-writings, unknown/garbage rows → fallbackRows single source,
// non-TTY skip, and the >= 2 row clamp on degenerate terminals.
// 2026-08-07: the anchor switched from a '\n'.repeat(rows-1) newline pad to a
// Cursor Position escape (\x1b[<rows>;1H) so it no longer leaves blank lines
// in native scrollback between the pre-TUI output and the welcome banner.

const test = require('node:test');
const assert = require('node:assert');

const { anchorBottomEnabled, anchorBottomPad } = require('../../../src/cli/tui/startupAnchor');
const sidebarLayout = require('../../../src/cli/tui/sidebarLayout');

// Expected ANSI bytes for a given row count.
const cup = (n) => `\x1b[${n};1H`;

test('gate: default OFF keeps the login and version output contiguous', () => {
  assert.equal(anchorBottomEnabled({}), false);
  assert.equal(anchorBottomPad({ isTTY: true, rows: 30 }, {}), '');
  assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: 'unexpected' }), false);
});

test('gate: explicit on-writings enable (1/true/on/yes, trimmed, case-insensitive)', () => {
  assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: '1' }), true);
  assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: 'yes' }), true);
  assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: ' ON ' }), true);
  assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: 'True' }), true);
});

test('gate: explicit off-writings disable (0/false/off/no, trimmed, case-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.equal(anchorBottomEnabled({ KHY_TUI_ANCHOR_BOTTOM: v }), false, `off-writing ${JSON.stringify(v)}`);
    assert.equal(anchorBottomPad({ isTTY: true, rows: 30 }, { KHY_TUI_ANCHOR_BOTTOM: v }), '');
  }
});

test('explicitly enabled: TTY with valid rows → CUP to the last row (no scrollback newlines)', () => {
  const env = { KHY_TUI_ANCHOR_BOTTOM: '1' };
  assert.equal(anchorBottomPad({ isTTY: true, rows: 30 }, env), cup(30));
  // Non-integer readings floor like stickyDim everywhere else.
  assert.equal(anchorBottomPad({ isTTY: true, rows: 24.9 }, env), cup(24));
});

test('unknown rows (null/undefined) → fallbackRows single source', () => {
  const env = { KHY_TUI_ANCHOR_BOTTOM: '1' };
  const expected = cup(sidebarLayout.fallbackRows(env));
  assert.equal(anchorBottomPad({ isTTY: true, rows: undefined }, env), expected);
  assert.equal(anchorBottomPad({ isTTY: true, rows: null }, env), expected);
  // KHY_TERM_FALLBACK_ROWS override rides the same single source.
  const env2 = { KHY_TUI_ANCHOR_BOTTOM: '1', KHY_TERM_FALLBACK_ROWS: '40' };
  assert.equal(anchorBottomPad({ isTTY: true, rows: undefined }, env2), cup(40));
});

test('garbage rows (NaN/0/negative) → fallbackRows, never a throw or row < 2', () => {
  const env = { KHY_TUI_ANCHOR_BOTTOM: '1' };
  const expected = cup(sidebarLayout.fallbackRows(env));
  assert.equal(anchorBottomPad({ isTTY: true, rows: 0 }, env), expected);
  assert.equal(anchorBottomPad({ isTTY: true, rows: -5 }, env), expected);
  assert.equal(anchorBottomPad({ isTTY: true, rows: NaN }, env), expected);
});

test('degenerate 1-row terminal → CUP to row 2 (clamped to >= 2)', () => {
  assert.equal(anchorBottomPad({ isTTY: true, rows: 1 }, { KHY_TUI_ANCHOR_BOTTOM: '1' }), cup(2));
});

test('non-TTY (pipes/CI) → always empty, even with valid rows', () => {
  assert.equal(anchorBottomPad({ isTTY: false, rows: 30 }, {}), '');
  assert.equal(anchorBottomPad({ rows: 30 }, {}), '');
  assert.equal(anchorBottomPad(null, {}), '');
  assert.equal(anchorBottomPad(undefined, {}), '');
});

test('the anchor bytes contain NO newline (never pollutes scrollback)', () => {
  const pad = anchorBottomPad(
    { isTTY: true, rows: 40 },
    { KHY_TUI_ANCHOR_BOTTOM: '1' }
  );
  assert.ok(!pad.includes('\n'), `anchor must not contain newlines: ${JSON.stringify(pad)}`);
  assert.ok(pad.startsWith('\x1b['), `anchor must be an ANSI escape: ${JSON.stringify(pad)}`);
});
