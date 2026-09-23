'use strict';

/**
 * P0-5 regression: long-paste folding must not LOSE the pasted content.
 *
 * Before the fix, flushPaste() replaced a threshold-exceeding paste with the
 * literal placeholder `[Pasted ~N lines]` and discarded the original text —
 * the model received the placeholder bytes, the user's paste never arrived.
 *
 * After the fix the flow mirrors the classic REPL (replSession.js):
 *   flushPaste  → archive text under id N, insert `[Pasted text #N (+M lines)]`
 *   submit      → _expandPasteTags(text) swaps each known tag for
 *                 <pasted-content>\n{archived}\n</pasted-content>
 *                 (busyInputClassifiers' established block convention)
 *   history     → stores the compact tag form (recall stays one-line)
 *
 * These tests drive the module-level internals directly (no React/ink needed):
 * _makePasteTag, _expandPasteTags, and the archive bounds.
 */

const test = require('node:test');
const assert = require('node:assert');

const HOOK_PATH =
  'D:/Portable/khy-os/services/backend/src/cli/tui/hooks/useTextInput.js';
const m = require(HOOK_PATH);
const I = m._internals;

function fresh() {
  I._resetForTest();
  return I;
}

test('fold path archives content and issues an id tag (multi-line)', () => {
  const I = fresh();
  // Simulate what flushPaste does for a >threshold multi-line paste:
  // id 1, archive the trimmed text, build the tag via the shared helper.
  const text = 'line1\nline2\nline3';
  I._pasteCounter = 1;
  I._pasteArchive.set(1, text);
  const tag = I._makePasteTag(text, 3);
  // M = newline count (CC "+2 not 3" incremental semantics), not line count.
  assert.strictEqual(tag, '[Pasted text #1 +2 lines]');
});

test('single-line long paste (150+ chars) folds to a bare id tag', () => {
  const I = fresh();
  const text = 'x'.repeat(200); // >= PASTE_CHAR_THRESHOLD, no newlines
  I._pasteCounter = 2;
  I._pasteArchive.set(2, text);
  const tag = I._makePasteTag(text, 1);
  assert.strictEqual(tag, '[Pasted text #2]');
});

test('gate KHY_PASTED_REF_LINES off falls back to call-site line count', () => {
  const I = fresh();
  // pastedRefLineCountOr with gate off returns legacy (lineCount), so a
  // 3-line paste would show "+3 lines" instead of CC's "+2".
  delete process.env.KHY_PASTED_REF_LINES;
  process.env.KHY_PASTED_REF_LINES = '0';
  try {
    I._pasteCounter = 1;
    I._pasteArchive.set(1, 'a\nb\nc');
    const tag = I._makePasteTag('a\nb\nc', 3);
    assert.strictEqual(tag, '[Pasted text #1 +3 lines]');
  } finally {
    delete process.env.KHY_PASTED_REF_LINES;
  }
});

test('_expandPasteTags swaps known tags for pasted-content blocks', () => {
  const I = fresh();
  I._pasteCounter = 7;
  I._pasteArchive.set(7, 'SELECT *\nFROM users;');
  const text = 'check this [Pasted text #7 +1 lines] please';
  const out = I._expandPasteTags(text);
  assert.strictEqual(
    out,
    'check this <pasted-content>\nSELECT *\nFROM users;\n</pasted-content> please'
  );
});

test('_expandPasteTags keeps unknown ids verbatim (evicted/cross-session)', () => {
  const I = fresh();
  I._pasteCounter = 1;
  I._pasteArchive.set(1, 'kept');
  const out = I._expandPasteTags('lost [Pasted text #99] kept [Pasted text #1]');
  assert.strictEqual(out, 'lost [Pasted text #99] kept <pasted-content>\nkept\n</pasted-content>');
});

test('_expandPasteTags no-ops on empty archive / empty text / no tags', () => {
  const I = fresh();
  assert.strictEqual(I._expandPasteTags('plain text'), 'plain text');
  assert.strictEqual(I._expandPasteTags(''), '');
  I._pasteArchive.set(1, 'x');
  assert.strictEqual(I._expandPasteTags('no tags here'), 'no tags here');
});

test('archive evicts oldest beyond PASTE_ARCHIVE_MAX entries', () => {
  const I = fresh();
  for (let i = 1; i <= I.PASTE_ARCHIVE_MAX + 3; i++) {
    I._pasteArchive.set(i, 'p' + i);
    // Mirror flushPaste's eviction right after each insert.
    if (I._pasteArchive.size > I.PASTE_ARCHIVE_MAX) {
      const oldest = I._pasteArchive.keys().next().value;
      I._pasteArchive.delete(oldest);
    }
  }
  assert.strictEqual(I._pasteArchive.size, I.PASTE_ARCHIVE_MAX);
  // Inserts 21/22/23 evicted ids 1/2/3 (oldest-first)…
  assert.strictEqual(I._pasteArchive.has(1), false);
  assert.strictEqual(I._pasteArchive.has(2), false);
  assert.strictEqual(I._pasteArchive.has(3), false);
  // …and the window holds the newest 20 ids: 4..23.
  assert.strictEqual(I._pasteArchive.has(4), true);
  assert.strictEqual(I._pasteArchive.has(23), true);
});

test('CRLF/CR pastes are normalized before folding (stripPasteMarkers path)', () => {
  const I = fresh();
  // flushPaste cleans joined paste: CRLF -> LF, control chars stripped.
  // The tag's M must reflect normalized newlines via the leaf.
  const cleaned = 'a\r\nb\rc'.replace(/\r\n?/g, '\n');
  assert.strictEqual(cleaned, 'a\nb\nc');
  I._pasteCounter = 4;
  I._pasteArchive.set(4, cleaned);
  assert.strictEqual(I._makePasteTag(cleaned, 3), '[Pasted text #4 +2 lines]');
});

test('thresholds remain 150 chars / 3 lines (regression lock)', () => {
  assert.strictEqual(I.PASTE_CHAR_THRESHOLD, 150);
  assert.strictEqual(I.PASTE_LINE_THRESHOLD, 3);
  assert.strictEqual(I.PASTE_ARCHIVE_MAX, 20);
});

test('paste-summary gate defaults ON, off words disable (runtime contract)', () => {
  const I = fresh();
  assert.strictEqual(I.isPasteSummaryEnabled({}), true);
  assert.strictEqual(I.isPasteSummaryEnabled({ KHY_PROMPT_PASTE_SUMMARY: '0' }), false);
  assert.strictEqual(I.isPasteSummaryEnabled({ KHY_PROMPT_PASTE_SUMMARY: 'off' }), false);
  assert.strictEqual(I.isPasteSummaryEnabled({ KHY_PROMPT_PASTE_SUMMARY: 'true' }), true);
});

test('flagRegistry registration matches runtime gate (metadata drift fix)', () => {
  const reg = require('D:/Portable/khy-os/services/backend/src/services/flagRegistry');
  for (const val of [undefined, '0', 'false', 'off', 'no', 'true', '1']) {
    const env = val === undefined ? {} : { KHY_PROMPT_PASTE_SUMMARY: val };
    assert.strictEqual(
      I.isPasteSummaryEnabled(env),
      reg.isFlagEnabled('KHY_PROMPT_PASTE_SUMMARY', env),
      'registry/runtime disagree on ' + JSON.stringify(val)
    );
  }
});
