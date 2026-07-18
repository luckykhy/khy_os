'use strict';

/**
 * ModelPicker — native Ink selection overlay for `/model`.
 *
 * Replaces the inquirer-driven prompt that the classic REPL uses for model
 * selection. inquirer cannot coexist with ink's managed raw-mode input (it
 * fights ink for stdin and the alternate frame), which is why `/model` exited
 * immediately inside the TUI. This component owns its own keystrokes via ink's
 * useInput, identical in spirit to QuestionPrompt, so no other input handler
 * competes while it is mounted (App.js yields its top-level useInput while a
 * picker is open).
 *
 * Props:
 *   choices    — [{ name, value:{adapter,model}, disabled }] as produced by
 *                gateway.buildGatewayModelChoices(). `name` is a pre-formatted
 *                (chalk-colored) label; it is rendered as-is.
 *   onResolve  — (value | null) => void. Called with the selected choice.value
 *                on Enter, or null on Esc/cancel.
 *   title      — optional heading (defaults to a generic prompt).
 *   defaultValue — optional { adapter, model } to start the cursor on.
 *
 * Navigation: ↑/↓ move (skipping disabled rows), 1-9 jump+select, Enter selects
 * the highlighted row, Esc cancels. A scroll window keeps the cursor visible
 * when the list is longer than the viewport.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

const MARKER = '❯';
const PAGE_SIZE = 12;

function sameValue(v, target) {
  if (!v || !target) return false;
  return v.adapter === target.adapter
    && String(v.model || '') === String(target.model || '');
}

function ModelPicker({ choices = [], onResolve, title, defaultValue }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(choices) ? choices : [];
  const firstEnabled = list.findIndex((c) => c && !c.disabled);
  const initialCursor = (() => {
    if (defaultValue) {
      const i = list.findIndex((c) => c && !c.disabled && sameValue(c.value, defaultValue));
      if (i >= 0) return i;
    }
    return firstEnabled >= 0 ? firstEnabled : 0;
  })();

  const [cursor, setCursor] = React.useState(initialCursor);

  // Nothing selectable → resolve null so the caller is not left hanging.
  React.useEffect(() => {
    if (list.length === 0) onResolve(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const moveCursor = (dir) => {
    if (list.length === 0) return;
    setCursor((c) => {
      let next = c;
      for (let i = 0; i < list.length; i++) {
        next = (next + dir + list.length) % list.length;
        if (list[next] && !list[next].disabled) return next;
      }
      return c;
    });
  };

  const choose = (idx) => {
    const c = list[idx];
    if (!c || c.disabled) return;
    onResolve(c.value);
  };

  useInput((ch, key) => {
    if (list.length === 0) return;
    if (key.escape) { onResolve(null); return; }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow || key.tab) { moveCursor(1); return; }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < list.length) { setCursor(idx); choose(idx); }
      return;
    }
    if (key.return) { choose(cursor); return; }
  });

  if (list.length === 0) return null;

  // Compute the visible window so the cursor stays in view.
  const pageSize = Math.min(PAGE_SIZE, list.length);
  let start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), list.length - pageSize));
  if (start < 0) start = 0;
  const end = Math.min(list.length, start + pageSize);

  const rows = [];
  for (let i = start; i < end; i++) {
    const c = list[i];
    const active = i === cursor;
    const marker = active ? MARKER : ' ';
    const numberLabel = i < 9 ? `${i + 1}.` : '  ';
    const label = (c && c.name) || (c && c.value && c.value.model) || `${i + 1}`;
    const disabledTag = c && c.disabled ? ' (不可选)' : '';
    rows.push(
      h(Text, {
        key: `m-${i}`,
        color: active ? 'cyan' : undefined,
        bold: active,
        dimColor: c && c.disabled ? true : undefined,
      }, `   ${marker} ${numberLabel} ${label}${disabledTag}`)
    );
  }

  const scrollHint = list.length > pageSize
    ? `  （${cursor + 1}/${list.length}${start > 0 ? ' · ↑更多' : ''}${end < list.length ? ' · ↓更多' : ''}）`
    : '';

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan', bold: true }, `? ${title || '选择模型（↑/↓ 选择，回车确认）'}`),
    h(Box, { flexDirection: 'column' }, rows),
    h(Text, { dimColor: true }, `  Enter 选择 · ↑/↓ 导航 · 数字键快选 · Esc 取消${scrollHint}`)
  );
}

module.exports = ModelPicker;
