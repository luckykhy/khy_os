'use strict';

/**
 * imeCommitGuard — IME commit Enter recency guard (shared leaf).
 *
 * CJK IMEs (Chinese / Japanese / Korean, plus emoji pickers) confirm a
 * composition by sending the composed text (and often a trailing Enter) as
 * one atomic stdin burst. ink splits that burst into two useInput events:
 * first the text insert, then a bare key.return. Without a guard, that
 * second event is misread as the user pressing Enter — prematurely
 * submitting a half-typed prompt (useTextInput), instantly executing the
 * highlighted slash command (App.js completion menu, destructive), or
 * accepting the match and closing (App.js revSearch).
 *
 * Fix: every fullwidth-only insert (single char or phrase chunk) stamps a
 * module-level recency marker; a bare Enter arriving within
 * IME_COMMIT_ENTER_GUARD_MS of the stamp is the IME's own confirm key and
 * is swallowed (the composed text is already in the buffer — the user's
 * next Enter is the real submit). Consumers requiring the leaf: useTextInput
 * (note + consult), CcPromptInput (note + consult), App.js revSearch (note +
 * consult) and completion menu (consult). App.js overlays never fall
 * through to textInput, so they must stamp locally.
 *
 * Gate: KHY_IME_ENTER_GUARD (default on, registered in flagRegistry);
 * off → shouldSwallowBareEnter() is always false → byte-identical legacy
 * behaviour (the IME Enter submits, as it does today).
 *
 * Bare-ness (no shift/ctrl/meta) is enforced by callers — the leaf only
 * answers "is a fresh IME commit pending?".
 */

const IME_COMMIT_ENTER_GUARD_MS = 120;
const OFF_VALUES = ['0', 'false', 'off', 'no'];

const { isFullwidth } = require('./runtime/textMeasure');

function isEnabled(env = process.env) {
  return !OFF_VALUES.includes(
    String((env && env.KHY_IME_ENTER_GUARD) || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * True when EVERY code point of the chunk is fullwidth (CJK ideographs,
 * kana, Hangul, fullwidth punctuation, most emoji) — the signature of an
 * IME composition commit. Raw ASCII typing, mixed-script input and pastes
 * containing newlines all fail this test and stay unguarded.
 */
function isImeCommitChunk(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return false;
  }
  for (const ch of input) {
    if (!isFullwidth(ch.codePointAt(0))) {
      return false;
    }
  }
  return true;
}

// Module-level (process-global) recency marker: the classic prompt and the
// CC prompt are never mounted together, but App.js overlays consult the
// same marker stamped inside useTextInput — one leaf, one truth.
let _lastCommitAt = 0;

/** Stamp the marker when `input` looks like an IME composition commit. */
function noteImeCommit(input, now = Date.now()) {
  if (isImeCommitChunk(input)) {
    _lastCommitAt = now;
  }
}

/** True when a fresh IME commit is pending (bare Enter should be swallowed). */
function shouldSwallowBareEnter(now = Date.now(), env = process.env) {
  if (!isEnabled(env)) {
    return false;
  }
  return now - _lastCommitAt < IME_COMMIT_ENTER_GUARD_MS;
}

// Test-only: reset the process-global marker between cases.
function _resetForTest() {
  _lastCommitAt = 0;
}

module.exports = {
  isEnabled,
  isImeCommitChunk,
  noteImeCommit,
  shouldSwallowBareEnter,
  IME_COMMIT_ENTER_GUARD_MS,
  _resetForTest,
};
