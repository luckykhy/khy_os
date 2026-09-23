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
 *   cols       — overlay width in display columns (App passes `_overlayCols`).
 *                When present, each row is clipped to one visual row (BUG-56).
 *                Absent → rows render as before, i.e. no width cap.
 *   rows       — terminal height in lines (App passes `_resRows`). When present
 *                the page size shrinks so the whole frame, including the
 *                「Esc 取消」 footer, fits on screen (BUG-56). Absent → the
 *                historical 12-rows-per-page cap is used.
 *
 * Navigation: ↑/↓ move (skipping disabled rows), 1-9 jump+select, Enter selects
 * the highlighted row, Esc cancels. A scroll window keeps the cursor visible
 * when the list is longer than the viewport. Type to fuzzy-filter; Backspace
 * clears the last char; the filter resets when it matches nothing.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
const {
  clipCell,
  pickerRowBudget,
  pickerPageRows,
} = require('../wrapCell');

const MARKER = '❯';
const RECENT_MARKER = '★';

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

function ModelPicker({ choices = [], onResolve, title, defaultValue, recent = [], cols, rows }) {
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
    // 数字跳转必须映射到**屏幕上标注的那一行**:行号标签按窗口位置编号(见下方 numberLabel),
    // 故目标 filtered 下标 = 窗口起点 + (n-1),而不是 n-1。用 n-1 会出现「列表滚动后按 3 选中的
    // 是另一行」(用户报的「莫名跳到别的模型」)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9' && !query) {
      const windowSize = Math.max(0, end - start);
      const offset = parseInt(navCh, 10) - 1;
      if (windowSize > 0 && offset >= 0 && offset < windowSize) {
        const idx = start + offset;
        if (idx >= 0 && idx < filtered.length && filtered[idx] && !filtered[idx].disabled) {
          setCursor(idx);
          choose(idx);
        }
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
  const headerText = `? ${title || '选择模型（↑/↓ 选择，回车确认）'}`;
  const footerText = `  Enter 选择 · ↑/↓ 导航 · 打字搜索 · Esc 取消${recent.length ? ' · ★最近' : ''}`;
  // The search echo is this picker's own extra chrome row — bill it here, where
  // it is known, on top of the shared frame-chrome accounting.
  const pageSize = Math.max(
    1,
    Math.min(
      pickerPageRows(rows, cols, headerText, footerText) - (query ? 1 : 0),
      filtered.length
    )
  );
  let start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), filtered.length - pageSize));
  if (start < 0) {
    start = 0;
  }
  const end = Math.min(filtered.length, start + pageSize);

  const recentKeys = new Set(recent.map((r) => `${r.adapter}/${r.model}`));

  const rowNodes = [];
  for (let i = start; i < end; i++) {
    const c = filtered[i];
    const active = i === cursor;
    const marker = active ? MARKER : ' ';
    // 行号按**窗口位置**编号(1..9),与数字键跳转(见 useInput 的 start + offset)严格同源:
    // 屏幕上写「1.」的那一行,按 1 就选中它。此前用全局下标 `i + 1`,列表一滚动标签就与
    // 实际选中的行脱节(用户报的「按数字跳到别的模型」)。
    const windowPos = i - start;
    const numberLabel = windowPos < 9 ? `${windowPos + 1}.` : '  ';
    const label = (c && c.name) || (c && c.value && c.value.model) || `${i + 1}`;
    const disabledTag = c && c.disabled ? ' (不可选)' : '';
    const isRecent =
      c && c.value && recentKeys.has(`${c.value.adapter}/${c.value.model}`);
    const recentTag = isRecent ? RECENT_MARKER : ' ';
    const prefix = `   ${marker} ${numberLabel} ${recentTag}`;
    // One model = one visual row. A gateway model ID is an external string
    // (40+ chars is normal), and an uncapped row wrapped to 2 lines on a
    // narrow terminal, inflating the frame until the 「Esc 取消」 hint fell off
    // the bottom — same defect as BUG-54/BUG-55, measured in AK.
    const budget = pickerRowBudget(cols, prefix, disabledTag);
    const shown = budget > 0 ? clipCell(label, budget) : label;
    rowNodes.push(
      h(
        Text,
        {
          key: `m-${i}`,
          color: active ? 'cyan' : undefined,
          bold: active,
          dimColor: c && c.disabled ? true : undefined,
        },
        `${prefix}${shown}${disabledTag}`
      )
    );
  }

  const scrollHint =
    filtered.length > pageSize
      ? `  （${cursor + 1}/${filtered.length}${start > 0 ? ' · ↑更多' : ''}${end < filtered.length ? ' · ↓更多' : ''}）`
      : '';

  const queryHint = query ? `  搜索: ${query}` : '';

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan', bold: true }, headerText),
    queryHint ? h(Text, { color: 'yellow' }, queryHint) : null,
    h(Box, { flexDirection: 'column' }, rowNodes),
    h(Text, { dimColor: true }, `${footerText}${scrollHint}`)
  );
}

module.exports = ModelPicker;
