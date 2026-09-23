'use strict';

/**
 * foldModel — the unified collapsible element model (DESIGN-ARCH-103 P1 / H5).
 *
 * Every foldable thing in the TUI (tool card, long line, thinking block, task
 * item, completed-task group) is described by ONE shape, and its line-height
 * signature MUST include the expanded state — the single regression that turns
 * "expand then resize" into ghosting (dsh-TUI evidence). If the signature
 * changes, the layout must recompute; the test asserts that property.
 *
 * Pure leaf: zero IO, never throws.
 */

const { visualRows } = require('./wrapCell');

/**
 * @param {{id: string, kind: string, text: string, width: number}} p
 * @returns {{id: string, kind: string, collapsedRows: number, expandedRows: number,
 *   expanded: boolean, text: string}}
 */
function makeFoldItem(p) {
  const text = String(p.text == null ? '' : p.text);
  const width = Math.max(0, Math.floor(Number(p.width) || 0));
  return {
    id: p.id,
    kind: p.kind, // 'tool' | 'longline' | 'thinking' | 'task' | 'message'
    collapsedRows: 1,
    expandedRows: Math.max(1, visualRows(text, width)),
    expanded: false,
    text,
  };
}

/**
 * H5: the line-height signature. Two items differ only in `expanded` →
 * different signatures → layout recompute. Kind + expandedRows + expanded are
 * the inputs; a hash is unnecessary (string concatenation is cheaper and the
 * value only needs to change when any input changes).
 * @param {object} item
 * @returns {string}
 */
function lineHeightSignature(item) {
  if (!item) {
    return '';
  }
  return [item.kind, item.expandedRows, item.expanded ? 1 : 0].join(':');
}

/** Flip the user-controlled expanded state. @returns {boolean} new state */
function toggle(item) {
  if (!item) {
    return false;
  }
  item.expanded = !item.expanded;
  return item.expanded;
}

/** Rows the element currently occupies (collapsed = 1, expanded = its body). */
function currentRows(item) {
  if (!item) {
    return 0;
  }
  return item.expanded ? item.expandedRows : item.collapsedRows;
}

module.exports = { makeFoldItem, lineHeightSignature, toggle, currentRows };
