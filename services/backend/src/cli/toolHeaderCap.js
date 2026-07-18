'use strict';

/**
 * toolHeaderCap.js — single source of truth for the tool-use header arg-summary
 * length cap (the `name(arg-summary)` line in the live tool tree).
 *
 * Background logic (CC alignment): CC renders each tool's header through a
 * tool-SPECIFIC `renderToolUseMessage`. The Bash family caps its command at
 * `MAX_COMMAND_DISPLAY_CHARS = 160`
 * (`packages/builtin-tools/src/tools/BashTool/UI.tsx`); Grep caps its pattern at
 * `TOOL_SUMMARY_MAX_LENGTH = 50` (`src/constants/toolLimits.ts`). Khy's
 * `ToolLines.summarizeArgs` instead applies one UNIFORM magic cap of 60 to every
 * descriptive key. For most keys that 60 is >= CC's per-tool cap (e.g. grep
 * pattern 60 > 50 — Khy shows MORE, not worse), so it is left untouched; but for
 * the Bash COMMAND key 60 is far below CC's 160, and in the Ink TUI the command
 * appears ONLY in this header (unlike the classic REPL there is no full-command
 * box), so a 61–160 char command is truncated and unrecoverable — visibly worse
 * than CC, which shows it in full.
 *
 * This leaf provides CC's `MAX_COMMAND_DISPLAY_CHARS` constant and a per-key cap
 * resolver so the divergence is fixed at exactly one place. Only the CHAR cap is
 * mirrored: CC's MAX_COMMAND_DISPLAY_LINES=2 (a multi-line command head) is NOT
 * adopted — Khy deliberately collapses the command to a single-line space-join
 * head (adjudicated in 刀17), so the line rule stays Khy's.
 *
 * Gate `KHY_TOOL_HEADER_CAP` (default on). Off (=0/false/off/no) → every key
 * resolves to the legacy 60, byte-identical to the historical behavior.
 *
 * Pure leaf: zero IO, zero business requires, reads process.env only for gating.
 */

// CC `BashTool/UI.tsx::MAX_COMMAND_DISPLAY_CHARS` — char cap for the command in
// the tool-use header.
const MAX_COMMAND_DISPLAY_CHARS = 160;

// The uniform cap Khy historically applied to every arg-summary key.
const LEGACY_ARG_CAP = 60;

// Arg keys whose value is a shell command (Bash family routes its command here).
// Only these rise to CC's 160; all other keys keep the legacy 60.
const COMMAND_KEYS = new Set(['command', 'cmd']);

function toolHeaderCapEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_HEADER_CAP) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Resolve the display cap for a given arg-summary key.
 * Gate on  → command-family keys get CC's MAX_COMMAND_DISPLAY_CHARS (160),
 *            every other key keeps the legacy 60.
 * Gate off → every key gets the legacy 60 (byte-identical fallback).
 */
function argDisplayCap(key, env = process.env) {
  if (!toolHeaderCapEnabled(env)) return LEGACY_ARG_CAP;
  return COMMAND_KEYS.has(String(key)) ? MAX_COMMAND_DISPLAY_CHARS : LEGACY_ARG_CAP;
}

module.exports = {
  MAX_COMMAND_DISPLAY_CHARS,
  LEGACY_ARG_CAP,
  COMMAND_KEYS,
  toolHeaderCapEnabled,
  argDisplayCap,
};
