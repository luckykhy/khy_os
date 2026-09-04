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
 *   recent     — optional [{ model, adapter }] recent models to show at top.
 *
 * Navigation: ↑/↓ move (skipping disabled rows), 1-9 jump+select, Enter selects
 * the highlighted row, Esc cancels. A scroll window keeps the cursor visible
 * when the list is longer than the viewport. Type to fuzzy-filter; Backspace
 * clears the last char; the filter resets when it matches nothing.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

const MARKER = '❯';
const RECENT_MARKER = '★';
const PAGE_SIZE = 12;

function sameValue(v, target) {
  if (!v || !target) {
    return false;
  }
  return v.adapter === target.adapter && String(v.model || '') === String(target.model || '');
}

function scoreMatch(query, text) {
  if (!text) return 0;
  const lower = String(text).toLowerCase();
  const q = String(query).toLowerCase();
  if (!q) return 1;
  if (lower === q) return 100;
  if (lower.startsWith(q)) return 80;
  if (lower.includes(q)) return 60;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const c of q) {
    const idx = lower.indexOf(c, ti);
    if (idx === -1) return 0;
    streak = idx === ti ? streak + 1 : 1;
    score += streak * 2;
    ti = idx + 1;
  }
  return Math.max(1, score);
}

function filterChoices(list, query) {
  if (!query) return list;
  const q = query.trim();
  if (!q) return list;
  return list
    .map((c) => {
      const label = (c && c.name) || (c && c.value && c.value.model) || '';
      const modelId = c && c.value && c.value.model ? String(c.value.model) : '';
      const adapterId = c && c.value && c.value.adapter ? String(c.value.adapter) : '';
      const score = Math.max(scoreMatch(q, label), scoreMatch(q, modelId), scoreMatch(q, adapterId));
      return score > 0 ? { item: c, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

function ModelPicker({ choices = [], onResolve, title, defaultValue, recent = [] }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(choices) ? choices : [];
  const firstEnabled = list.findIndex((c) => c && !c.disabled);
  const initialCursor = (() => {
    if (defaultValue) {
      const i = list.findIndex((c) => c && !c.disabled && sameValue(c.value, defaultValue));
      if (i >= 0) {
        return i;
      }
    }
    return firstEnabled >= 0 ? firstEnabled : 0;
  })();

  const [cursor, setCursor] = React.useState(initialCursor);
  const [query, setQuery] = React.useState('');

  // Nothing selectable → resolve null so the caller is not left hanging.
  React.useEffect(() => {
    if (list.length === 0) {
      onResolve(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  // Reset cursor when filter changes
  React.useEffect(() => {
    setCursor(0);
  }, [query]);

  const filtered = React.useMemo(() => filterChoices(list, query), [list, query]);

  const moveCursor = (dir) => {
    if (filtered.length === 0) {
      return;
    }
    setCursor((c) => {
      let next = c;
      for (let i = 0; i < filtered.length; i++) {
        next = (next + dir + filtered.length) % filtered.length;
        if (filtered[next] && !filtered[next].disabled) {
          return next;
        }
      }
      return c;
    });
  };

  const choose = (idx) => {
    const c = filtered[idx];
    if (!c || c.disabled) {
      return;
    }
    onResolve(c.value);
  };

  useInput((ch, key) => {
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
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9' && !query) {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < filtered.length) {
        setCursor(idx);
        choose(idx);
      }
      return;
    }
    if (key.return) {
      choose(cursor);
      return;
    }
    // Printable single char → append to query
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch.charCodeAt(0) >= 32) {
      setQuery((q) => q + ch);
    }
  });

  if (list.length === 0) {
    return null;
  }

  // Compute the visible window so the cursor stays in view.
  const pageSize = Math.min(PAGE_SIZE, filtered.length);
  let start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), filtered.length - pageSize));
  if (start < 0) {
    start = 0;
  }
  const end = Math.min(filtered.length, start + pageSize);

  const recentKeys = new Set(recent.map((r) => `${r.adapter}/${r.model}`));

  const rows = [];
  for (let i = start; i < end; i++) {
    const c = filtered[i];
    const active = i === cursor;
    const marker = active ? MARKER : ' ';
    const numberLabel = i < 9 ? `${i + 1}.` : '  ';
    const label = (c && c.name) || (c && c.value && c.value.model) || `${i + 1}`;
    const disabledTag = c && c.disabled ? ' (不可选)' : '';
    const isRecent =
      c && c.value && recentKeys.has(`${c.value.adapter}/${c.value.model}`);
    const recentTag = isRecent ? RECENT_MARKER : ' ';
    rows.push(
      h(
        Text,
        {
          key: `m-${i}`,
          color: active ? 'cyan' : undefined,
          bold: active,
          dimColor: c && c.disabled ? true : undefined,
        },
        `   ${marker} ${numberLabel} ${recentTag}${label}${disabledTag}`
      )
    );
  }

  const scrollHint =
    filtered.length > pageSize
      ? `  （${cursor + 1}/${filtered.length}${start > 0 ? ' · ↑更多' : ''}${end < filtered.length ? ' · ↓更多' : ''}）`
      : '';

  const queryHint = query ? `  搜索: ${query}` : '';
  const recentCount = recent.length ? ` · ★最近` : '';

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan', bold: true }, `? ${title || '选择模型（↑/↓ 选择，回车确认）'}`),
    queryHint ? h(Text, { color: 'yellow' }, queryHint) : null,
    h(Box, { flexDirection: 'column' }, rows),
    h(
      Text,
      { dimColor: true },
      `  Enter 选择 · ↑/↓ 导航 · 打字搜索 · Esc 取消${recentCount}${scrollHint}`
    )
  );
}

module.exports = ModelPicker;
