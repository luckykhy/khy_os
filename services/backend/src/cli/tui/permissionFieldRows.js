'use strict';

/**
 * permissionFieldRows — wrap a `label + value` field so continuation rows hang
 * **under the value**, not back at the field's left edge.
 *
 * Why a leaf and not `Box flexGrow`: the approval overlay must keep its row count
 * stable. A row Box with a `flexGrow` column does produce the hanging indent, but
 * ink wraps inside that column itself, and wrap-ansi (`trim:false`) emits an extra
 * all-space row whenever the text exactly fills the box — measured on a 151-column
 * command at cols=80: 12 rows before, 13 after, the extra row whitespace-only.
 * Pre-wrapping here means every row ink receives is already ≤ the content width, so
 * ink never wraps it and never invents a row.
 *
 * Units are **display columns** (CJK/full-width = 2) via `wrapCell`/`visWidth`, not
 * UTF-16 code units — the family invariant behind BUG-7/11/40/46/47.
 *
 * Pure: no IO, no env, no closure state. Returns `null` whenever it cannot prove a
 * safe budget, so callers fall back to their previous single-row rendering verbatim.
 */

const { wrapCell, visWidth } = require('./wrapCell');

/** A value column narrower than this is not worth splitting — the rows would be unreadable. */
const MIN_VALUE_COLS = 8;

/**
 * @param {object} field
 * @param {string} field.label   prefix of the first row, e.g. `'资源：'` or `'$ '`
 * @param {string} field.value   the text to wrap, e.g. a command or a resource path
 * @param {number} field.width   display columns available to the WHOLE row
 * @returns {string[]|null} rows whose display width never exceeds `width`,
 *                          or null → caller keeps its own single-row rendering
 */
function fieldRows({ label, value, width } = {}) {
  const cap = Math.floor(Number(width));
  if (!Number.isFinite(cap) || cap <= 0) return null;

  const head = String(label == null ? '' : label);
  const text = String(value == null ? '' : value);
  const labelCols = visWidth(head);
  const valueCols = cap - labelCols;
  if (valueCols < MIN_VALUE_COLS) return null;

  const out = [];
  // Split on explicit newlines first: wrapCell would break the row anyway, but
  // doing it here keeps the indent choice per source line and keeps this loop flat.
  const segments = text.split('\n');
  for (const seg of segments) {
    const lines = wrapCell(seg, valueCols);
    for (let i = 0; i < lines.length; i += 1) {
      out.push((out.length === 0 ? head : ' '.repeat(labelCols)) + lines[i]);
    }
  }
  // `wrapCell` always pushes its accumulator, so a value ending in '\n' yields a
  // trailing blank row. In a fixed-height frame that row costs a real line.
  while (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

module.exports = { fieldRows, MIN_VALUE_COLS };
