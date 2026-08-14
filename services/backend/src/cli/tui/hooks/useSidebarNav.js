'use strict';

/**
 * useSidebarNav — pure UI-state hook for the right-rail task board's optional
 * keyboard navigation (阶段四 交互能力增强). It owns ONLY presentation state:
 * whether the board holds keyboard focus, which line is selected, the derived
 * scroll offset, and an expand toggle. It performs NO IO and reads NO env — the
 * caller (App) decides `enabled` from the sidebarLayout feature-flag getters
 * (focusEnabled / scrollEnabled) and feeds the current board geometry.
 *
 * Iron law (阶段四 铁律): when `enabled` is false the hook is INERT — `focused`
 * is always false, `scrollOffset` is 0, and every handler is a no-op. The hook
 * is still called UNCONDITIONALLY (React hooks rule), so wiring it in never
 * changes the render order; the flag-off path is byte-identical.
 *
 * Scroll strategy — center-follow: the selected line is kept near the middle of
 * the viewport, clamped so the window never scrolls past either end:
 *   scrollOffset = clamp(selectedIdx - floor(visibleRows / 2),
 *                        0, max(0, totalLines - visibleRows))
 *
 * Never throws: all numeric inputs are coerced defensively; malformed geometry
 * degrades to a still, offset-0 board rather than an exception.
 */

const React = require('react');

/** Coerce to a finite integer, falling back when the input is garbage. */
function _int(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp `n` into [lo, hi]; a collapsed range (hi < lo) resolves to `lo`. */
function _clamp(n, lo, hi) {
  if (hi < lo) {
    return lo;
  }
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.totalLines]  total board line count (content length)
 * @param {number} [opts.visibleRows] viewport height in rows
 * @param {boolean} [opts.enabled]    master gate — false ⇒ inert (see header)
 * @returns {{
 *   focused: boolean, scrollOffset: number, selectedIdx: number, expanded: boolean,
 *   onToggleFocus: () => void, onUp: () => void, onDown: () => void,
 *   onExpand: () => void, onEscape: () => void
 * }}
 */
function useSidebarNav(opts = {}) {
  const enabled = opts.enabled === true;
  const totalLines = Math.max(0, _int(opts.totalLines, 0));
  const visibleRows = Math.max(0, _int(opts.visibleRows, 0));

  const [focused, setFocused] = React.useState(false);
  const [selectedIdx, setSelectedIdx] = React.useState(0);
  const [expanded, setExpanded] = React.useState(false);

  // Derived (never stored): selection clamped to the current line range and the
  // center-follow scroll offset. Recomputed every render so a shrinking board
  // can never leave a stale out-of-range selection or offset behind.
  const maxIdx = Math.max(0, totalLines - 1);
  const sel = _clamp(selectedIdx, 0, maxIdx);
  const maxOffset = Math.max(0, totalLines - visibleRows);
  const scrollOffset = enabled ? _clamp(sel - Math.floor(visibleRows / 2), 0, maxOffset) : 0;

  const onToggleFocus = React.useCallback(() => {
    if (!enabled) {
      return;
    }
    setFocused((f) => !f);
  }, [enabled]);

  const onUp = React.useCallback(() => {
    if (!enabled) {
      return;
    }
    setSelectedIdx((i) => _clamp(i - 1, 0, Math.max(0, totalLines - 1)));
  }, [enabled, totalLines]);

  const onDown = React.useCallback(() => {
    if (!enabled) {
      return;
    }
    setSelectedIdx((i) => _clamp(i + 1, 0, Math.max(0, totalLines - 1)));
  }, [enabled, totalLines]);

  const onExpand = React.useCallback(() => {
    if (!enabled) {
      return;
    }
    setExpanded((e) => !e);
  }, [enabled]);

  const onEscape = React.useCallback(() => {
    if (!enabled) {
      return;
    }
    setFocused(false);
  }, [enabled]);

  return {
    focused: enabled ? focused : false,
    scrollOffset,
    selectedIdx: sel,
    expanded: enabled ? expanded : false,
    onToggleFocus,
    onUp,
    onDown,
    onExpand,
    onEscape,
  };
}

module.exports = { useSidebarNav };
