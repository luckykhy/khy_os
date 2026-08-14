'use strict';

// sectionGap.js — pure leaf (zero IO, deterministic, never throws).
//
// Single source for the "blank-line section separation" gate shared by
// StreamingBlock (live turn) and Transcript (committed turn): the thinking
// section, tool-group section(s) and answer section are separated by EXACTLY
// ONE blank row — inserted only BETWEEN two sections that both render, never
// leading/trailing and never doubled. Blank rows only: horizontal rule
// sequences (─/━) are forbidden by the repo typography rules.
//
// In the live region the caller must charge every separator row against its
// liveHeightClamp height budget (anti-staircase); this leaf only owns the gate
// so both renderers flip together.
//
// Gate KHY_TUI_SECTION_GAP (default on); =0/false/off/no → off → byte-identical
// legacy rendering (sections flush against each other).

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function sectionGapEnabled(env = process.env) {
  const raw = env && env.KHY_TUI_SECTION_GAP;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

module.exports = { sectionGapEnabled, OFF_VALUES };
