'use strict';

/**
 * RewindPicker — native Ink selection overlay for the double-ESC 回溯 (Phase 2).
 *
 * Phase 1 jumps straight to the most recent user turn. Phase 2 lets the user
 * pick *which* earlier turn to rewind to: this overlay lists every user turn
 * newest-first (as produced by rewindControl.listUserTargets) and, on Enter,
 * hands the chosen target back to App.js's performRewind — the exact same
 * rewind pipeline Phase 1 uses (model-history truncation + optional code
 * restore + UI slice + text reload). Esc cancels and leaves everything intact.
 *
 * Owns its own keystrokes via ink's useInput, identical in spirit to ModelPicker
 * (App.js yields its top-level useInput while a picker is mounted), so no other
 * handler competes while it is open.
 *
 * Props:
 *   targets   — [{ idx, content, preview, checkpointId, rankFromEnd }] newest-first.
 *   onResolve — (target | null, scope?) => void. The chosen target on Enter, null on
 *               Esc. When the target carries a code checkpoint (and KHY_REWIND_SCOPE is
 *               on) a second stage lets the user pick the restore scope (both /
 *               conversation / code), passed as the 2nd arg. Otherwise resolves with
 *               just the target (byte-identical to the single-stage flow).
 *   title     — optional heading.
 *   cols      — terminal/overlay columns; when given, every list row is clipped
 *               to one visual row (BUG-54). Absent → rows render uncapped.
 *   rows      — terminal rows; when given together with `cols`, the page shrinks
 *               so the whole frame fits the screen and the Enter/Esc hint stays
 *               visible (BUG-55). Absent → the page keeps the PAGE_SIZE cap.
 *   cols      — overlay width in terminal columns. When given, every list row is
 *               clipped to one visual row (BUG-54); when absent the picker
 *               renders exactly as it did before and ink wraps long previews.
 *
 * Navigation: ↑/↓ move, 1-9 jump+select, Enter selects the highlighted row,
 * Esc cancels. A scroll window keeps the cursor visible for long histories.
 * In the scope stage: ↑/↓ move, 1-3 quick-select, Enter confirms, Esc goes back.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
const {
  clipCell,
  pickerRowBudget,
  pickerPageRows,
  PICKER_BOX_CHROME_COLS,
  PICKER_PAGE_SIZE,
} = require('../wrapCell');

const MARKER = '❯';

function RewindPicker({ targets = [], onResolve, title, cols, rows }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(targets) ? targets : [];
  const [cursor, setCursor] = React.useState(0);
  // Scope stage: null = choosing a target; non-null = { target, choices } awaiting
  // a restore-scope pick. Only entered when the chosen target has a code checkpoint.
  const [scopeStage, setScopeStage] = React.useState(null);
  const [scopeCursor, setScopeCursor] = React.useState(0);

  // Nothing to rewind to → resolve null so the caller is not left hanging.
  React.useEffect(() => {
    if (list.length === 0) {
      onResolve(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const moveCursor = (dir) => {
    if (list.length === 0) {
      return;
    }
    setCursor((c) => (c + dir + list.length) % list.length);
  };

  const choose = (idx) => {
    const t = list[idx];
    if (!t) {
      return;
    }
    // If this target has a code checkpoint and the scope feature is on, enter the
    // scope stage; otherwise resolve immediately (single-stage, today's behavior).
    let choices = null;
    try {
      choices = require('../rewindScope').buildRewindScopeChoices(t, process.env);
    } catch {
      choices = null;
    }
    if (choices && choices.length) {
      setScopeStage({ target: t, choices });
      setScopeCursor(0);
      return;
    }
    onResolve(t);
  };

  useInput((ch, key) => {
    // ── Scope stage ────────────────────────────────────────────────
    if (scopeStage) {
      const choices = scopeStage.choices;
      if (key.escape) {
        setScopeStage(null);
        return;
      } // back to target list
      if (key.upArrow) {
        setScopeCursor((c) => (c - 1 + choices.length) % choices.length);
        return;
      }
      if (key.downArrow || key.tab) {
        setScopeCursor((c) => (c + 1) % choices.length);
        return;
      }
      const scopeCh = require('../../fullWidthInput').foldDigits(ch, process.env);
      if (scopeCh && scopeCh >= '1' && scopeCh <= String(choices.length)) {
        const idx = parseInt(scopeCh, 10) - 1;
        if (idx >= 0 && idx < choices.length) {
          onResolve(scopeStage.target, choices[idx].value);
        }
        return;
      }
      if (key.return) {
        onResolve(scopeStage.target, choices[scopeCursor].value);
        return;
      }
      return;
    }
    // ── Target stage ───────────────────────────────────────────────
    if (list.length === 0) {
      return;
    }
    if (key.escape) {
      onResolve(null);
      return;
    }
    if (key.upArrow) {
      moveCursor(-1);
      return;
    }
    if (key.downArrow || key.tab) {
      moveCursor(1);
      return;
    }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < list.length) {
        setCursor(idx);
        choose(idx);
      }
      return;
    }
    if (key.return) {
      choose(cursor);
      return;
    }
  });

  if (list.length === 0) {
    return null;
  }

  // ── Scope stage render ───────────────────────────────────────────
  if (scopeStage) {
    const choices = scopeStage.choices;
    const scopeRows = choices.map((c, i) => {
      const active = i === scopeCursor;
      const marker = active ? MARKER : ' ';
      const prefix = `   ${marker} ${i + 1}. `;
      const body = `${c.label}  —  ${c.hint}`;
      const budget = pickerRowBudget(cols, prefix, '');
      return h(
        Text,
        { key: `s-${i}`, color: active ? 'cyan' : undefined, bold: active },
        `${prefix}${budget > 0 ? clipCell(body, budget) : body}`
      );
    });
    return h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { color: 'cyan', bold: true }, '? 恢复范围（↑/↓ 选择，回车确认）'),
      h(Box, { flexDirection: 'column' }, scopeRows),
      h(Text, { dimColor: true }, '  Enter 确认 · ↑/↓ 导航 · 数字键快选 · Esc 返回')
    );
  }

  // Compute the visible window so the cursor stays in view.
  const headerText = `? ${title || '回溯到哪条消息（↑/↓ 选择，回车确认）'}`;
  const footerText = '  Enter 回溯 · ↑/↓ 导航 · 数字键快选 · Esc 取消';
  const pageSize = Math.min(
    pickerPageRows(rows, cols, headerText, footerText),
    list.length
  );
  let start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), list.length - pageSize));
  if (start < 0) {
    start = 0;
  }
  const end = Math.min(list.length, start + pageSize);

  const rowNodes = [];
  for (let i = start; i < end; i++) {
    const t = list[i];
    const active = i === cursor;
    const marker = active ? MARKER : ' ';
    const numberLabel = i < 9 ? `${i + 1}.` : '  ';
    const codeTag = t && t.checkpointId ? ' ⮌代码' : '';
    const rawPreview = (t && t.preview) || '(空消息)';
    // The row must stay ONE visual row: an uncapped CJK preview wrapped to 2-3
    // rows and the picker's own 12-row page overflowed a 24-row terminal,
    // pushing the Enter/Esc hint off screen (BUG-54). Budget is measured from
    // the real prefix rather than assumed, and without `cols` we render exactly
    // as before.
    const prefix = `   ${marker} ${numberLabel} `;
    const budget = pickerRowBudget(cols, prefix, codeTag);
    const preview = budget > 0 ? clipCell(rawPreview, budget) : rawPreview;
    rowNodes.push(
      h(
        Text,
        { key: `r-${i}`, color: active ? 'cyan' : undefined, bold: active },
        `${prefix}${preview}${codeTag}`
      )
    );
  }

  const scrollHint =
    list.length > pageSize
      ? `  （${cursor + 1}/${list.length}${start > 0 ? ' · ↑更多' : ''}${end < list.length ? ' · ↓更多' : ''}）`
      : '';

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan', bold: true }, headerText),
    h(Box, { flexDirection: 'column' }, rowNodes),
    h(Text, { dimColor: true }, `${footerText}${scrollHint}`)
  );
}

module.exports = RewindPicker;
