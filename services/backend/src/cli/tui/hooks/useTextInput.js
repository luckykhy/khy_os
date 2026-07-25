'use strict';

/**
 * useTextInput — owns the editable buffer for the prompt, modelled on Claude
 * Code's hooks/useTextInput.ts + BaseTextInput.
 *
 * Exposes a single `onInput(input, key)` handler (the shape ink's useInput
 * delivers) plus the current value/offset for rendering. All editing goes
 * through the immutable Cursor value object.
 *
 * Critical ink quirk handled here: a real Backspace key emits \x7f which ink
 * reports as `key.delete` (NOT `key.backspace`). We therefore treat BOTH
 * key.backspace and key.delete as "delete backward" — matching ink-text-input
 * and fixing the "cannot delete" regression. (Dedicated forward-delete is rare
 * in a single prompt and is intentionally not bound.)
 */
const { useState, useRef, useCallback, useEffect } = require('react');
const { Cursor } = require('../utils/Cursor');
const { isPersistEnabled, mergeHistory } = require('./historyPersist');
const backslashContinuation = require('../../../services/backslashContinuation');

// A return arriving within this window after a paste burst is treated as part
// of the paste (insert newline) rather than a submit.
const PASTE_NEWLINE_GUARD_MS = 110;
// Quiet period after the last paste chunk before the accumulated paste is
// committed as one edit. ink (no bracketed-paste support) can split a large
// paste across several stdin frames microseconds apart; accumulating avoids
// dropping newlines that fall on a frame boundary.
const PASTE_FLUSH_MS = 30;

function stripPasteMarkers(s) {
  return s.replace(/\[200~/g, '').replace(/\[201~/g, '');
}

function useTextInput({ onSubmit, onChange, onHistoryEmpty } = {}) {
  const [cursor, setCursor] = useState(() => new Cursor('', 0));
  const killRing = useRef([]);
  const history = useRef([]);
  const histIdx = useRef(-1);
  const draft = useRef(''); // stash current line while browsing history
  const pasteAt = useRef(0);
  // Paste accumulation across split stdin frames.
  const pasteBuf = useRef('');
  const pasteTimer = useRef(null);
  // Always-current cursor mirror, so a synchronous edit that follows a paste
  // flush within the same input tick operates on the post-flush value (the
  // `cursor` state closure is stale until React commits).
  const cursorRef = useRef(cursor);

  // Single funnel for every cursor mutation: updates the ref synchronously and
  // schedules the state/onChange update.
  const commit = useCallback((next, fireChange = true) => {
    cursorRef.current = next;
    setCursor(next);
    if (fireChange && onChange) onChange(next.text);
  }, [onChange]);

  const move = useCallback((next) => commit(next, false), [commit]);
  const edit = useCallback((next) => commit(next, true), [commit]);

  // Commit the accumulated paste buffer as a single edit and return the new
  // cursor. Cleaning and the single trailing-newline trim run on the JOINED
  // text so frame boundaries inside the paste cannot drop internal newlines.
  const flushPaste = useCallback(() => {
    if (pasteTimer.current) { clearTimeout(pasteTimer.current); pasteTimer.current = null; }
    const joined = pasteBuf.current;
    pasteBuf.current = '';
    if (!joined) return cursorRef.current;
    const clean = stripPasteMarkers(joined)
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (clean === '') return cursorRef.current;
    const trimmed = clean.replace(/\n$/, '');
    pasteAt.current = Date.now();
    const next = cursorRef.current.insert(trimmed);
    commit(next, true);
    return next;
  }, [commit]);

  // Flush any pending paste on unmount so it is not lost.
  useEffect(() => () => { if (pasteTimer.current) clearTimeout(pasteTimer.current); }, []);

  // Cross-session history persistence (Claude Code-style Up/Down recall).
  //
  // The Ink TUI's in-session history (`history.current`) already powers
  // historyPrev/historyNext below; the only gap vs. Claude is that it starts
  // empty each launch and is never written back. We close that by reusing the
  // EXISTING persistence single source — cli/repl/history.js (the same
  // ~/.khyquant_history file the classic REPL uses) — never a parallel store.
  //
  // Resolved lazily + cached: `undefined` = unresolved, `null` = disabled or
  // module unavailable, otherwise the loaded module. Gated by
  // KHY_TUI_HISTORY_PERSIST (default on; off → byte-identical legacy behaviour).
  // Every fs touch is fail-soft so it can never crash TUI mount.
  const historyStore = useRef(undefined);
  const getHistoryStore = useCallback(() => {
    if (historyStore.current !== undefined) return historyStore.current;
    if (!isPersistEnabled(process.env.KHY_TUI_HISTORY_PERSIST)) {
      historyStore.current = null;
      return null;
    }
    try {
      historyStore.current = require('../../repl/history');
    } catch (_e) {
      historyStore.current = null; // fail-soft: never block the prompt
    }
    return historyStore.current;
  }, []);

  // Pre-populate the session history from the persisted file once on mount, so
  // the first Up press recalls the previous session's prompts.
  useEffect(() => {
    const store = getHistoryStore();
    if (!store) return;
    try {
      const persisted = store.loadHistory();
      if (Array.isArray(persisted) && persisted.length) {
        history.current = mergeHistory(persisted, history.current, store.MAX_HISTORY);
      }
    } catch (_e) {
      /* fail-soft: a bad/locked history file must not break the TUI */
    }
  }, [getHistoryStore]);

  // Replace the whole buffer (used by completion accept / external clear).
  const setText = useCallback((text, offset) => {
    const c = new Cursor(text, offset === undefined ? text.length : offset);
    commit(c, true);
  }, [commit]);

  // Move the cursor to an absolute offset without changing the text or firing
  // onChange. Built on the live ref so it composes with a setText() that ran
  // earlier in the same tick (vim operators do setText → setOffset). Used by
  // the vim layer (useVimInput); harmless for plain text input.
  const setOffset = useCallback((n) => {
    const cur = cursorRef.current;
    const clamped = Math.max(0, Math.min(n, cur.text.length));
    move(new Cursor(cur.text, clamped));
  }, [move]);

  const onInput = useCallback((input, key) => {
    // Base every edit on the live ref, not the (possibly stale) `cursor` state
    // closure. If a paste is mid-accumulation and a non-paste event arrives
    // (any single key, including Enter), commit the paste first so ordering is
    // preserved; flushPaste returns the merged cursor we then build on. The
    // freshly-set pasteAt makes a trailing Enter insert a newline, not submit.
    let cur = cursorRef.current;
    if (pasteBuf.current && !(input && input.length > 1)) {
      cur = flushPaste();
    }

    // ── Submit / newline ────────────────────────────────────────────────
    if (key.return) {
      if (key.shift || key.meta || key.ctrl) { edit(cur.insert('\n')); return; }
      if (Date.now() - pasteAt.current < PASTE_NEWLINE_GUARD_MS) { edit(cur.insert('\n')); return; }
      // Claude Code parity: a bare unescaped trailing '\' before Enter is a
      // line continuation — drop the backslash, insert a newline instead of
      // submitting. Gated (KHY_BACKSLASH_NEWLINE, default on); off →
      // shouldContinue is always false → byte-identical legacy submit.
      if (backslashContinuation.shouldContinue(cur.text, cur.offset)) {
        edit(cur.backspace().insert('\n'));
        return;
      }
      const text = cur.text;
      if (text.trim()) {
        history.current.push(text);
        // Persist across sessions via the shared single source (fail-soft).
        // saveHistory already merges with the file + caps to MAX_HISTORY, so a
        // single-element array appends exactly one entry without duplication.
        const store = getHistoryStore();
        if (store) {
          try { store.saveHistory([text]); } catch (_e) { /* fail-soft */ }
        }
      }
      histIdx.current = -1;
      draft.current = '';
      commit(new Cursor('', 0), true);
      if (onSubmit) onSubmit(text);
      return;
    }

    // ── Delete backward (Backspace = \x7f → key.delete on most terminals) ─
    if (key.backspace || key.delete) {
      if (key.meta) {
        const { cursor: c, killed } = cur.deleteWordBefore();
        if (killed) killRing.current.push(killed);
        edit(c);
      } else {
        edit(cur.backspace());
      }
      return;
    }

    // ── Arrow / navigation keys ──────────────────────────────────────────
    if (key.leftArrow)  return move(key.meta ? cur.wordLeft()  : cur.left());
    if (key.rightArrow) return move(key.meta ? cur.wordRight() : cur.right());
    if (key.home)       return move(cur.startOfLine());
    if (key.end)        return move(cur.endOfLine());

    if (key.upArrow) {
      // Multi-line: move within buffer; single-line: browse history.
      if (cur.lines().length > 1 && cur.line() > 0) return move(cur.up());
      return historyPrev();
    }
    if (key.downArrow) {
      if (cur.lines().length > 1 && cur.line() < cur.lines().length - 1) return move(cur.down());
      return historyNext();
    }

    // ── Emacs control chords ─────────────────────────────────────────────
    if (key.ctrl) {
      switch (input) {
        case 'a': return move(cur.startOfLine());
        case 'e': return move(cur.endOfLine());
        case 'b': return move(cur.left());
        case 'f': return move(cur.right());
        case 'k': { const { cursor: c, killed } = cur.deleteToLineEnd(); if (killed) killRing.current.push(killed); return edit(c); }
        case 'u': { const { cursor: c, killed } = cur.deleteToLineStart(); if (killed) killRing.current.push(killed); return edit(c); }
        case 'w': { const { cursor: c, killed } = cur.deleteWordBefore(); if (killed) killRing.current.push(killed); return edit(c); }
        case 'd': return edit(cur.del());
        case 'y': { const last = killRing.current[killRing.current.length - 1]; return last ? edit(cur.insert(last)) : undefined; }
        default: return undefined;
      }
    }

    // ── Meta (Option/Alt) chords ─────────────────────────────────────────
    if (key.meta) {
      switch (input) {
        case 'b': return move(cur.wordLeft());
        case 'f': return move(cur.wordRight());
        case 'd': { const { cursor: c, killed } = cur.deleteWordAfter(); if (killed) killRing.current.push(killed); return edit(c); }
        default: return undefined;
      }
    }

    // ── Printable text / paste ───────────────────────────────────────────
    if (!input) return undefined;

    // Multi-char chunk = paste (ink batches a paste into one call), OR a burst
    // of repeated control keys (e.g. holding Backspace) that the terminal
    // coalesced into one chunk WITHOUT key flags. We must not insert the latter
    // as literal control characters — that silently corrupts the buffer and
    // looks like "Backspace does nothing".
    if (input.length > 1) {
      // Count backward-delete codes (\x7f Backspace, \x08 Ctrl-H) in the burst.
      const delCount = (input.match(/[\x7f\x08]/g) || []).length;
      // Probe whether this chunk carries any printable content (keep \n and \t).
      const probe = stripPasteMarkers(input)
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

      if (probe === '') {
        // Pure control burst → apply the deletions instead of inserting garbage.
        if (delCount > 0) {
          let c = cur;
          for (let i = 0; i < delCount; i++) c = c.backspace();
          edit(c);
        }
        return;
      }

      // Printable paste content: accumulate the RAW chunk and flush once after a
      // short quiet period. Cleaning/trailing-newline trimming happens on the
      // joined buffer in flushPaste(), so a newline on a frame boundary is kept.
      pasteBuf.current += input;
      pasteAt.current = Date.now();
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      pasteTimer.current = setTimeout(() => flushPaste(), PASTE_FLUSH_MS);
      return;
    }

    // Single char: ignore control codes (< 0x20) except handled above.
    if (input.charCodeAt(0) < 0x20) return undefined;
    edit(cur.insert(input));
    return undefined;

    function historyPrev() {
      const h = history.current;
      if (h.length === 0) return;
      if (histIdx.current === -1) { draft.current = cur.text; histIdx.current = h.length; }
      histIdx.current = Math.max(0, histIdx.current - 1);
      setText(h[histIdx.current]);
    }
    function historyNext() {
      const h = history.current;
      if (histIdx.current === -1) return;
      histIdx.current += 1;
      if (histIdx.current >= h.length) {
        histIdx.current = -1;
        setText(draft.current || '');
        if (onHistoryEmpty) onHistoryEmpty();
        return;
      }
      setText(h[histIdx.current]);
    }
  }, [commit, edit, move, onSubmit, onHistoryEmpty, setText, flushPaste, getHistoryStore]);

  return {
    value: cursor.text,
    offset: cursor.offset,
    cursor,
    onInput,
    setText,
    setOffset,
    clear: () => setText(''),
    // Read-only snapshot of the merged (persisted + session) command history,
    // oldest→newest, for consumers like the Ctrl+R reverse-search overlay. Never
    // mutate the returned array; it is the live ref's backing store.
    getHistory: () => history.current.slice(),
  };
}

module.exports = { useTextInput };
