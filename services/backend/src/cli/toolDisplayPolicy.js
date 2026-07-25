/**
 * Tool Display Policy Registry — data-driven display rules per tool type.
 * Replaces if/else chains in printToolCallStart/printToolCallResult.
 *
 * Each policy controls how a tool call is rendered in the CLI:
 *   showIntent  — show the conversational intent line (e.g. "Reading file...")
 *   boxPreview  — render a bordered box preview of the command/content
 *   resultStyle — how to render the result output:
 *     'tree'      — standard ⎿-prefixed lines (bash, grep, glob)
 *     'collapsed' — minimal output, fold aggressively (read, websearch)
 *     'diff'      — inline diff rendering (write, edit)
 *     'delegate'  — result handled by a sub-tracker (agent)
 *     'inline'    — compact single-section output (todowrite)
 *   maxLines   — max output lines before folding kicks in
 *   foldHead   — lines to keep at the top when folded
 *   foldTail   — lines to keep at the bottom when folded
 */

'use strict';

// ── Policy Registry ─────────────────────────────────────────────────

const POLICIES = {
  bash:       { showIntent: true,  boxPreview: true,  resultStyle: 'tree',      maxLines: 6,  foldHead: 3, foldTail: 3 },
  read:       { showIntent: true,  boxPreview: false, resultStyle: 'collapsed', maxLines: 3,  foldHead: 2, foldTail: 1 },
  write:      { showIntent: true,  boxPreview: false, resultStyle: 'diff',      maxLines: 10, foldHead: 5, foldTail: 5 },
  edit:       { showIntent: true,  boxPreview: false, resultStyle: 'diff',      maxLines: 10, foldHead: 5, foldTail: 5 },
  grep:       { showIntent: true,  boxPreview: false, resultStyle: 'tree',      maxLines: 8,  foldHead: 4, foldTail: 4 },
  glob:       { showIntent: true,  boxPreview: false, resultStyle: 'tree',      maxLines: 8,  foldHead: 4, foldTail: 4 },
  agent:      { showIntent: false, boxPreview: false, resultStyle: 'delegate',  maxLines: 0,  foldHead: 0, foldTail: 0 },
  websearch:  { showIntent: true,  boxPreview: false, resultStyle: 'collapsed', maxLines: 4,  foldHead: 2, foldTail: 2 },
  webfetch:   { showIntent: true,  boxPreview: false, resultStyle: 'collapsed', maxLines: 4,  foldHead: 2, foldTail: 2 },
  todowrite:  { showIntent: true,  boxPreview: false, resultStyle: 'inline',    maxLines: 3,  foldHead: 2, foldTail: 1 },
};

// Aliases — multiple raw tool names map to the same canonical policy key.
const ALIASES = {
  shell: 'bash', shellcommand: 'bash', command: 'bash',
  readfile: 'read', notebookread: 'read',
  writefile: 'write', createfile: 'write',
  editfile: 'edit', multiedit: 'edit', notebookedit: 'edit',
  search: 'grep', searchcontent: 'grep',
  find: 'glob', findfiles: 'glob', ls: 'glob',
  task: 'agent', spawnworker: 'agent', subagent: 'agent',
};

const DEFAULT_POLICY = {
  showIntent: true,
  boxPreview: false,
  resultStyle: 'tree',
  maxLines: 6,
  foldHead: 3,
  foldTail: 3,
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Normalize a raw tool name and return the matching display policy.
 * Falls back to DEFAULT_POLICY for unknown tools.
 *
 * @param {string} toolName — raw tool name from the model
 * @returns {{ showIntent: boolean, boxPreview: boolean, resultStyle: string, maxLines: number, foldHead: number, foldTail: number }}
 */
function getToolPolicy(toolName) {
  const key = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  const canonical = ALIASES[key] || key;
  return POLICIES[canonical] || DEFAULT_POLICY;
}

/**
 * Collapse RUNS of consecutive identical lines into the first occurrence + a
 * dim "+N 行相同" marker. A command like `dir /s` (or anything piped through
 * `findstr`) can emit the same line hundreds of times — "0 File(s) 0 bytes"
 * over and over — which floods the preview and buries the one line that differs.
 * Showing the first occurrence once, with a count for the rest, keeps the
 * signal visible; the FULL, un-collapsed output stays reachable via Ctrl+O
 * (callers feed the raw lines to the expansion path, the collapsed lines only
 * to the inline preview).
 *
 * Pure & UI-agnostic — the single source shared by the ink TUI (ToolLines) and
 * the classic REPL (toolDisplay) so both collapse identically. Only runs of
 * `minRun` or longer collapse; a stray pair stays verbatim (a marker would save
 * nothing). Order and structure are preserved — this is `uniq`-like, never a
 * global de-dup, so non-adjacent repeats are left untouched.
 *
 * @param {string[]} lines
 * @param {{ minRun?: number, marker?: (repeats:number, sample:string)=>string }} [opts]
 * @returns {{ lines: string[], collapsed: boolean, hiddenCount: number }}
 */
function collapseConsecutiveDuplicates(lines, opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { lines: lines || [], collapsed: false, hiddenCount: 0 };
  }
  // A run must reach this length before it collapses: at 2 the marker would
  // replace a single duplicate (2 lines → 2 lines, no gain), so start at 3.
  const minRun = Math.max(3, Number(opts.minRun) || 3);
  const marker = typeof opts.marker === 'function'
    ? opts.marker
    : (repeats) => `… +${repeats} 行相同（ctrl+o 展开）`;

  const out = [];
  let hiddenCount = 0;
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    let end = i + 1;
    while (end < lines.length && lines[end] === cur) end++;
    const runLen = end - i;
    out.push(cur);
    if (runLen >= minRun) {
      const repeats = runLen - 1; // lines hidden behind the first occurrence
      out.push(marker(repeats, cur));
      hiddenCount += repeats;
    } else {
      // Short run — keep the remaining duplicate(s) verbatim; not worth a marker.
      for (let k = i + 1; k < end; k++) out.push(lines[k]);
    }
    i = end;
  }
  return { lines: out, collapsed: hiddenCount > 0, hiddenCount };
}

/**
 * Fold an array of output lines according to a policy.
 * If lines.length <= policy.maxLines, returns the array unchanged.
 * Otherwise returns head + fold-indicator + tail.
 *
 * @param {string[]} lines   — full output lines
 * @param {{ maxLines: number, foldHead: number, foldTail: number }} policy
 * @returns {{ lines: string[], folded: boolean, hiddenCount: number }}
 */
function foldOutput(lines, policy) {
  if (!Array.isArray(lines) || !policy) {
    return { lines: lines || [], folded: false, hiddenCount: 0 };
  }
  const max = Number(policy.maxLines) || 0;
  if (max <= 0 || lines.length <= max) {
    return { lines, folded: false, hiddenCount: 0 };
  }

  const head = Math.max(0, Number(policy.foldHead) || 0);
  const tail = Math.max(0, Number(policy.foldTail) || 0);

  // Guard: if head+tail >= lines.length, no folding needed
  if (head + tail >= lines.length) {
    return { lines, folded: false, hiddenCount: 0 };
  }

  const headLines = lines.slice(0, head);
  const tailLines = tail > 0 ? lines.slice(-tail) : [];
  const hiddenCount = lines.length - head - tail;

  return {
    lines: [
      ...headLines,
      // Claude Code-style fold marker: single "…" ellipsis + "+N" + "(ctrl+o 展开)".
      `… +${hiddenCount} 行 (ctrl+o 展开)`,
      ...tailLines,
    ],
    folded: true,
    hiddenCount,
  };
}

module.exports = {
  POLICIES,
  DEFAULT_POLICY,
  getToolPolicy,
  foldOutput,
  collapseConsecutiveDuplicates,
};
