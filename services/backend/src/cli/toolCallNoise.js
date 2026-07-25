'use strict';

// Inline tool-call NOISE stripper — pure leaf (zero IO, zero business require,
// deterministic, env-gated).
//
// WHY THIS EXISTS (the real defect it fixes):
//   When a model speaks the "text tool protocol" (rather than emitting native
//   tool_use blocks) it writes the tool invocation as ORDINARY TEXT in its
//   answer stream. Two forms leak verbatim into the rendered transcript:
//     1. a bare JSON object line:  {"name":"open_app","params":{"name":"夸克"}}
//     2. XML-ish function tags:    <function=shell_command> … </function>
//   These are redundant with the structured tool-call lines the UI already
//   renders from real tool_use events (the pretty `⏺ ToolName(...)` /
//   `✓ 已批准: shellCommand(...)` rows). Left in, they are pure visual noise —
//   the user asked for a clean transcript "类似 CC 这样".
//
//   The existing `deliveryFormatter.stripToolCalls` recognizes neither form, and
//   the streaming render path strips nothing at all. This leaf is the single
//   source of truth for "what is inline tool-call noise"; it is applied at the
//   common render funnel (`_renderMarkdownLiteInner`) so all four render paths
//   (classic final / classic streaming / TUI committed / TUI live tail) get a
//   clean transcript, and is reused by `stripToolCalls` for stored replies.
//
// Display-only / non-destructive: storage keeps the verbatim stream (the TUI
// deliberately treats `live.text` as truth). We only strip on the way to screen.
//
// Gate: KHY_TOOLCALL_NOISE_STRIP (default ON). Off → byte-identical passthrough.

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_TOOLCALL_NOISE_STRIP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// A fenced-code-block delimiter line (``` or ~~~, optional info string). Content
// inside fences is SACRED — a user/model legitimately showing such JSON in a
// code block must be preserved (load-bearing false-positive guard).
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

// A line that is ONLY an opening `<function=NAME>` tag (whitespace allowed).
const FUNC_OPEN_LINE_RE = /^\s*<function\s*=\s*[^>\n]+>\s*$/i;
// A line that is ONLY a closing `</function>` tag.
const FUNC_CLOSE_LINE_RE = /^\s*<\/function\s*>\s*$/i;

// A standalone bare tool-call JSON object: the ENTIRE trimmed line is
// `{"name":"<tool>", "params"|"arguments"|"input": …}`. Whole-line anchored +
// the two-key shape keeps this from eating prose that merely contains braces.
const BARE_JSON_RE = /^\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:params|arguments|input)"\s*:[\s\S]*\}$/;

// An inline same-line `<function=NAME> … </function>` pair (defensive: the
// observed leak puts the tags on their own lines, but a single-line pair should
// also vanish).
const FUNC_INLINE_PAIR_RE = /<function\s*=\s*[^>\n]+>[\s\S]*?<\/function\s*>/gi;

/**
 * Strip inline tool-call protocol noise from a block of assistant text.
 *
 * Gate off / non-string / empty → returned unchanged (byte-identical fallback).
 *
 * Fence-aware line scan: never touches lines inside a ``` / ~~~ fenced block.
 * Outside fences it drops (a) whole `<function=…>…</function>` blocks including
 * inner lines, (b) standalone bare tool-call JSON object lines.
 *
 * Blank runs left behind by removed lines are NOT collapsed here: both consumers
 * already collapse fence-awarely downstream (the markdown renderer's own tighten
 * pass; deliveryFormatter.stripToolCalls' trailing `\n{3,}→\n\n`). Collapsing in
 * this leaf would be fence-unaware and would eat intentional blank rows inside
 * code blocks — so we leave blank-run normalization to the caller. The block is
 * not globally trimmed either, preserving leading/trailing whitespace semantics.
 */
function stripInlineToolCallNoise(text, env) {
  if (!isEnabled(env)) return text;
  if (typeof text !== 'string' || text === '') return text;

  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let inFunc = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // A fence delimiter ends any stray function block we were dropping.
      inFunc = false;
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (inFunc) {
      // Inside a <function=…> … </function> block: drop everything until close.
      if (FUNC_CLOSE_LINE_RE.test(line)) inFunc = false;
      continue;
    }
    if (FUNC_OPEN_LINE_RE.test(line)) { inFunc = true; continue; }
    if (FUNC_CLOSE_LINE_RE.test(line)) { continue; } // stray close without open
    const trimmed = line.trim();
    if (BARE_JSON_RE.test(trimmed)) continue;
    // Defensive: a single line carrying an inline `<function=…>…</function>`
    // pair plus other text → strip just the pair, keep the rest if non-empty.
    const depaired = line.replace(FUNC_INLINE_PAIR_RE, '');
    if (depaired !== line) {
      const cleaned = depaired.trim();
      if (cleaned === '') continue;
      out.push(cleaned);
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

module.exports = {
  isEnabled,
  stripInlineToolCallNoise,
};
