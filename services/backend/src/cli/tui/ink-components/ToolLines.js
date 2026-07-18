'use strict';

/**
 * ToolLines — renders a list of tool calls as an ink tree, Claude-Code style:
 *   ◆ name(arg-summary)            (pending)
 *   ✓ name(arg-summary)            (done)
 *   ✗ name(arg-summary)            (error)
 * When `expanded` is true, the tool result preview is shown indented beneath.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
// Single source of truth for fold rules — shared with the classic REPL renderer
// (toolDisplay.js). Reused here so command output folds identically in both UIs.
const { foldOutput, collapseConsecutiveDuplicates } = require('../../toolDisplayPolicy');
// Live parallel sub-agent tree (├│└). Attached to an agent tool row as
// `_agentTree` by the bridge (useQueryBridge.reduceAgentTree); rendered here in
// place of the single agent(...) line once at least one child has spawned.
const AgentTree = require('./AgentTree');
// 已完成工具的 diff 行按输入对象身份 WeakMap 记忆(消每帧重跑 computeStructuredDiffHunks/splitDiffLines)。
// 门控 KHY_TOOL_DIFF_ROWS_MEMO 关 → 直接构造(逐字节回退)。见 toolDiffRowsMemo.js 头注释。
const _toolDiffRowsMemo = require('./toolDiffRowsMemo');
// 已完成工具的 LITERAL(非 diff)输出体按 result 身份记忆:preview(formatShellOutputJson)+
// 折叠行 shownLines(split+collapse+fold),消每帧对整份 stdout 的 JSON 美化尝试与全量折叠。
// 门控 KHY_TOOL_LITERAL_OUTPUT_MEMO 关 → 直接构造(逐字节回退)。见 toolLiteralOutputMemo.js 头注释。
const _toolLiteralOutputMemo = require('./toolLiteralOutputMemo');
// 已完成/运行中工具的头行(显示名 resolveToolHeaderName + 入参摘要 summarizeArgs)按 (tool, cwd)
// 身份记忆:消每帧对每工具的 2×require+主题查表、JSON.parse 大入参、以及 summarizeArgs 内的
// process.cwd() 系统调用。门控 KHY_TOOL_HEADER_SUMMARY_MEMO 关 → 直接构造(逐字节回退)。
const _toolHeaderSummaryMemo = require('./toolHeaderSummaryMemo');
// Single source for stripping internal [SYSTEM:…]/[STOP]/[Loop…] control text from
// the visible ✗ line — shared with the classic REPL renderer (displayFormatters).
const { stripInternalControlText } = require('../../repl/displayFormatters');
// 工具结果透明化(纯叶子 SSOT):非命令类工具若携带真实输出体,也像 CC 一样在 ⎿ 下
// 透明显示其真实结果。门控 KHY_TOOL_RESULT_TRANSPARENT 默认开;关 → 回退「✓ 摘要」。
const { shouldRenderTransparentBody } = require('../../toolResultTransparency');
// 命令输出 JSON 行美化(纯叶子 SSOT):对齐 CC OutputLine,把输出里压扁成一坨的 JSON
// 行逐行缩进展开(带精度守卫)。门控 KHY_SHELL_OUTPUT_JSON 默认开;关 → 原样字节回退。
const { formatShellOutputJson } = require('../../shellOutputJson');
// ±diff 行号化(纯叶子 SSOT):给命令/`git diff` 的 unified-diff 行补 CC 那样的行号
// gutter(参考 Image#2)。门控 KHY_DIFF_LINE_NUMBERS 默认开;关 → 不赋 num 字节回退。
const { diffLineNumbersEnabled, parseUnifiedHunkHeader } = require('../../diffLineNumbers');
// 结果/摘要行起首字形(纯叶子 SSOT):把结果行从绿色 `✓ 摘要` 统一成 CC 的暗色 `⎿ 摘要`
// elbow,与命令正文同一视觉语言。门控 KHY_RESULT_ELBOW 默认开;关 → 回退 `✓` 绿色。
const { resultLineLead } = require('../../resultLineGlyph');
// 工具头行路径中间截断(纯叶子 SSOT):read/write/edit 的 file_path 放不下时,像 CC 的
// truncate.ts `truncatePathMiddle` 那样从**中间**塞 `…` 保住文件名(末尾截断会把文件名
// 截没)。门控 KHY_TOOL_PATH_MIDDLE_TRUNCATE 默认开;关 → 末尾截断字节回退。
const { pathMiddleTruncateEnabled, truncatePathMiddle } = require('../../toolParamPath');
// 工具头行 arg-summary「长度上限」单一真源(纯叶子):对齐 CC 的**按工具**头展示——
// Bash 命令头按 `MAX_COMMAND_DISPLAY_CHARS=160`(BashTool/UI.tsx)、grep pattern 按
// 50(toolLimits.ts)。Khy 历史对**每个** key 一律 `truncate(...,60)`:多数 key 的 60 ≥ CC
// 的 per-tool 上限(如 grep pattern 60>50,显得更多非更差)故保留;唯独 Bash `command` 的 60
// 远低于 CC 的 160,而 Ink TUI 里命令**只**出现在这条头行(不像经典 REPL 另有整命令 box)→
// 61–160 字命令被截断且无处可寻=明显比 CC 差。门控 KHY_TOOL_HEADER_CAP 默认开;关 → 每个 key
// 恒 60 字节回退。只对齐**字符**上限,不引入 CC 的 2 行多行头(Khy 刻意单行折叠见刀17)。
const { argDisplayCap } = require('../../toolHeaderCap');
// diff 内容列「裁切宽度」单一真源(纯叶子):对齐 CC StructuredDiff Fallback.tsx 的
// `availableContentWidth = max(1, width - maxWidth - 1 - diffPrefixWidth)` + wrapText('wrap')。
// 此前 diff 行恒按固定 100 字 `clip(text,100)` 硬截——无视终端宽度、且**展开(Ctrl+O)后仍截**,
// 把列 100 之后的代码静默吞掉,违背本文件自述的「Ctrl+O 真正显示全貌」诚实原则。改:折叠态按
// 终端列宽算单行预算裁切;展开态返回 Infinity(=不裁,交 ink 像 CC 一样自动换行,绝不丢内容)。
// 门控 KHY_DIFF_CONTENT_WIDTH 默认开;关 → 恒 100 字裁切,逐字节回退。
const { diffClipWidth } = require('../../diffContentWidth');

// Tools whose result IS literal command / third-party-app stdout. Only these
// get the "few lines + fold + Ctrl+O expand" treatment; the agent's own prose
// and structured results are rendered in full elsewhere and never folded here.
const SHELL_FAMILY = new Set(['bash', 'shell', 'shellcommand', 'command', 'terminal', 'pty']);
function isShellResult(name) {
  return SHELL_FAMILY.has(String(name).toLowerCase().replace(/[\s_-]/g, ''));
}

// Most-descriptive common arg keys, in preference order. Hoisted to a module
// constant so summarizeArgs() iterates one shared array instead of rebuilding
// the literal each header render. Read-only iterand; never mutated.
const _ARG_SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description'];

function summarizeArgs(tool) {
  const raw = tool.input ?? tool.args ?? tool.parameters ?? tool.arguments;
  if (raw == null) return '';
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return truncate(raw, 60); }
  }
  if (typeof obj !== 'object') return truncate(String(obj), 60);
  // Prefer the most descriptive common keys.
  for (const key of _ARG_SUMMARY_KEYS) {
    if (obj[key]) {
      // Path-like params (file_path / path): first RELATIVIZE to cwd (CC
      // toRelativePath — saves columns / readability; paths outside cwd stay
      // absolute to remain unambiguous), THEN middle-truncate so the basename
      // survives (CC truncatePathMiddle). Others keep the legacy end-truncate.
      // KHY_TOOL_RELATIVE_PATH off → relativizeToolPath returns the value
      // unchanged → byte-identical to the legacy absolute-path behavior.
      if (key === 'file_path' || key === 'path') {
        const relPath = require('../../ccRelativePath')
          .relativizeToolPath(String(obj[key]), process.cwd(), process.env);
        // CC FileReadTool/UI.tsx: Read headers append the line-range
        // (offset/limit → `第 X-Y 行` / `从第 X 行起`) AFTER the path. Only
        // for read tools (write/edit/grep don't carry offset/limit); gate
        // KHY_READ_RANGE_SUFFIX off → '' → byte-identical to the bare path.
        const _rr = require('../../readRangeSuffix');
        const suffix = _rr.isReadToolName(tool.name || tool.toolName || tool.tool)
          ? _rr.buildReadRangeSuffix(obj, process.env)
          : '';
        if (pathMiddleTruncateEnabled()) {
          const raw = relPath.replace(/\s+/g, ' ').trim();
          // truncatePathMiddle 按显示宽度判断「放得下就原样返回」,故无需 `raw.length > 60`
          // 的 code-unit 预判(那会对 CJK 路径误判「放得下」而漏截,列宽撑破工具头行)。
          // 宽度门控关时策略退化 code-unit → 与旧 `>60?…:raw` 逐字节一致。
          return truncatePathMiddle(raw, 60) + suffix;
        }
        return truncate(relPath, 60) + suffix;
      }
      // Non-path descriptive keys keep the legacy end-truncate, but route the
      // CAP through the per-key SSOT: the Bash `command` key rises to CC's 160
      // (gate KHY_TOOL_HEADER_CAP on), every other key stays at the legacy 60;
      // gate off → 60 for all, byte-identical.
      return truncate(String(obj[key]), argDisplayCap(key, process.env));
    }
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  return truncate(keys.map((k) => `${k}=${shorten(obj[k])}`).join(', '), 60);
}

function shorten(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 24 ? s.slice(0, 23) + '…' : s;
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Length-only clip that PRESERVES whitespace — diff lines must keep their
// indentation (collapsing it would mangle code), unlike the arg-summary path.
function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Claude Code's exact diff backgrounds (mirrors src/cli/diffRenderer.js + the
// classic REPL maybeRenderWriteDiff). White foreground on green add / red remove.
const DIFF_ADD_BG = '#225C2B';
const DIFF_DEL_BG = '#7A2936';
// Brighter word-level highlight backgrounds (mirror themeRegistry diffAddedWord /
// diffRemovedWord). Painted on the specific changed sub-spans within a paired
// remove/add line, exactly as CC's StructuredDiffFallback does.
const DIFF_ADD_WORD_BG = '#38A660';
const DIFF_DEL_WORD_BG = '#B3596B';
const DIFF_CONTEXT = 3;
// Inline-view caps. The COLLAPSED preview is deliberately short (a glance, with a
// truthful "ctrl+o to expand" promise); EXPANDED raises the ceiling to a generous
// safety cap so pressing Ctrl+O actually reveals the full change. Honesty rule:
// the "ctrl+o to expand" hint appears ONLY when collapsed and truncated — once
// expanded, an absolute-cap overflow is reported plainly (no false promise).
const PREVIEW_ROWS_COLLAPSED = 10;
const PREVIEW_ROWS_EXPANDED = 400;
const MAX_DIFF_ROWS_COLLAPSED = 60; // inline-view safety cap when folded
const MAX_DIFF_ROWS_EXPANDED = 1000; // generous cap once the user opts to expand

// Shell / third-party-app stdout fold rule (TUI). Deliberately MORE generous than
// the shared `bash` policy (maxLines:6): a command result that is "not too long"
// should show in FULL — folding kicks in only past SHELL_MAX_LINES, keeping a
// head+tail window. The user reads command output as a unit, so a 6-line cap felt
// over-eager; 20 lines is the "not too long" threshold before we fold.
const SHELL_COLLAPSED_POLICY = { maxLines: 20, foldHead: 12, foldTail: 6 };
// Claude Code result connector: a "⎿" elbow on the FIRST output line, with
// continuation lines aligned beneath it. Marks the block as LITERAL command /
// third-party-app output — distinct from the user's prompt (❯), the user's own
// `!` command (!), and the AI's prose (no connector). Mirrors the classic REPL
// (toolDisplay.js) so both renderers speak the same CC visual language.
const SHELL_ELBOW = '⎿ ';
const SHELL_CONT = '  ';

function splitDiffLines(text) {
  const arr = String(text ?? '').split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/**
 * Build structured ±diff rows from a tool result's _khyWriteDiff context.
 * Pure (no ink) so it is unit-testable. Mirrors the classic REPL behaviour:
 *   - new file (no before)     → green + preview
 *   - deleted file (no after)  → red − preview
 *   - existing file            → structured line diff with 3 context lines
 * `expanded` raises the row caps so Ctrl+O genuinely shows more (expansion
 * honesty): when collapsed a "ctrl+o to expand" hint is appended on overflow;
 * when expanded, overflow past the safety cap is reported without that promise.
 * Returns null when there is no renderable change.
 * @returns {Array<{kind:'add'|'del'|'ctx'|'more'|'stat', num?:number, text:string}>|null}
 */
function buildWriteDiffRows(diffCtx, expanded = false) {
  if (!diffCtx) return null;
  const before = typeof diffCtx.beforeContent === 'string' ? diffCtx.beforeContent : '';
  const after = typeof diffCtx.afterContent === 'string' ? diffCtx.afterContent : '';
  if (before === after) return null;

  const previewMax = expanded ? PREVIEW_ROWS_EXPANDED : PREVIEW_ROWS_COLLAPSED;
  const maxRows = expanded ? MAX_DIFF_ROWS_EXPANDED : MAX_DIFF_ROWS_COLLAPSED;
  // Collapsed overflow promises Ctrl+O; expanded overflow states the fact only.
  // Marker text + plural guard live in the previewOverflowMarker SSOT (shared
  // with the classic REPL's toolOutputRender so "+1 line" never reads "+1 lines").
  const _overflow = require('../../previewOverflowMarker');
  const moreText = (n, sign) => _overflow.buildLinesOverflow(n, sign, expanded, process.env);

  const rows = [];

  if (!before && after) {
    const lines = splitDiffLines(after);
    const { keep, hidden } = _overflow.resolveFold(lines.length, previewMax, process.env);
    lines.slice(0, keep).forEach((ln, i) => rows.push({ kind: 'add', num: i + 1, text: ln }));
    if (hidden > 0) rows.push({ kind: 'more', text: moreText(hidden, '+') });
    return rows;
  }
  if (before && !after) {
    const lines = splitDiffLines(before);
    const { keep, hidden } = _overflow.resolveFold(lines.length, previewMax, process.env);
    lines.slice(0, keep).forEach((ln, i) => rows.push({ kind: 'del', num: i + 1, text: ln }));
    if (hidden > 0) rows.push({ kind: 'more', text: moreText(hidden, '-') });
    return rows;
  }

  let diff;
  try { diff = require('../../diffRenderer').computeStructuredDiffHunks(before, after, { context: DIFF_CONTEXT }); }
  catch { return null; }
  const { added, removed, hunks } = diff;
  if ((added === 0 && removed === 0) || !hunks.length) return null;

  // Flatten hunks into rows, inserting a dim "⋯ N unchanged lines" separator
  // between non-adjacent hunks so multi-spot edits read honestly instead of one
  // miscounted mega-block.
  for (const hunk of hunks) {
    if (hunk.gapBefore > 0) {
      rows.push({ kind: 'gap', text: `⋯ ${hunk.gapBefore} unchanged line${hunk.gapBefore !== 1 ? 's' : ''}` });
    } else if (hunk.gapBefore === 0) {
      rows.push({ kind: 'gap', text: '⋯' });
    }
    for (const r of hunk.rows) rows.push(r);
  }

  if (rows.length > maxRows) {
    const dropped = rows.length - maxRows;
    const kept = rows.slice(0, maxRows);
    kept.push({ kind: 'more', text: _overflow.buildRowsOverflow(dropped, expanded, process.env) });
    rows.length = 0;
    rows.push(...kept);
  }

  // 摘要串构造收敛到单一真源 cli/editStatLine.js(含 CC 句首 "Removed" 大写规则)。
  const statLine = require('../../editStatLine').buildEditStatLine(added, removed, process.env);
  if (statLine) rows.push({ kind: 'stat', text: `└ ${statLine}` });

  return rows;
}

// Does a shell/command tool's stdout look like a unified diff (e.g. `git diff`,
// `diff -u`)? Mirrors the classic REPL's maybeRenderInlineDiffFromToolOutput
// gate so the TUI can colour the same output the REPL has always coloured.
function looksLikeUnifiedDiff(text) {
  return /(^|\n)(\+\+\+ |--- |@@ |\+[^+]|-[^-])/m.test(String(text ?? ''));
}

/**
 * Parse unified-diff-looking command output into structured ±rows for the same
 * red/green renderer used for write/edit diffs. Pure (no ink), unit-testable.
 * File/hunk headers (+++/---/@@/diff/index) render dim; +lines green, -lines red,
 * context dim. Bounded by MAX_DIFF_ROWS. Returns null when nothing renderable.
 *
 * Line numbers (CC-style, Image#2): when KHY_DIFF_LINE_NUMBERS is on (default), each
 * `@@ -a,b +c,d @@` hunk header seeds old/new cursors; add rows get the new-file line
 * number, del rows the old-file line, ctx rows the new-file line (single gutter, each
 * row its own file's 1-based number) — identical convention to write-diffs'
 * computeStructuredDiffHunks, so both diff paths render the same gutter. renderDiffRows
 * already prints `num` when present. Gate off → no `num` assigned → byte-identical.
 * @returns {Array<{kind:'add'|'del'|'ctx'|'meta'|'more',text:string,num?:number}>|null}
 */
function buildShellDiffRows(text, expanded = false) {
  const lines = splitDiffLines(text);
  if (!lines.length) return null;
  const numbersOn = diffLineNumbersEnabled();
  const maxRows = expanded ? MAX_DIFF_ROWS_EXPANDED : MAX_DIFF_ROWS_COLLAPSED;
  const rows = [];
  // null until the first @@ hunk header is seen; bare ±diffs without a header
  // (non-git) stay unnumbered, matching prior behaviour for that shape.
  let oldLine = null;
  let newLine = null;
  for (const ln of lines) {
    if (rows.length >= maxRows) {
      rows.push({ kind: 'more', text: expanded
        ? '... (diff truncated, capped)'
        : '... (diff truncated, ctrl+o for full output)' });
      break;
    }
    // Meta lines carry no gutter number and advance no cursor. The `\ No newline
    // at end of file` marker (git emits it when a changed region touches a
    // newline-less last line) is NOT file content: route it here so it renders
    // dim without a line number, instead of falling through to the ctx branch
    // where it would get a bogus number and shift every following row by one.
    // `\ ` (backslash-space) is unambiguous — diff body lines start with space
    // (ctx), `+` (add) or `-` (del), never backslash-space.
    if (/^(\+\+\+|---|@@|diff |index |\\ )/.test(ln)) {
      if (numbersOn && /^@@/.test(ln)) {
        const hh = parseUnifiedHunkHeader(ln);
        if (hh) { oldLine = hh.oldStart; newLine = hh.newStart; }
      }
      rows.push({ kind: 'meta', text: ln });
    } else if (/^\+/.test(ln)) {
      const row = { kind: 'add', text: ln.slice(1) };
      if (numbersOn && newLine != null) { row.num = newLine; newLine++; }
      rows.push(row);
    } else if (/^-/.test(ln)) {
      const row = { kind: 'del', text: ln.slice(1) };
      if (numbersOn && oldLine != null) { row.num = oldLine; oldLine++; }
      rows.push(row);
    } else {
      const row = { kind: 'ctx', text: ln.replace(/^ /, '') };
      if (numbersOn && newLine != null) { row.num = newLine; }
      if (numbersOn && oldLine != null) { oldLine++; }
      if (numbersOn && newLine != null) { newLine++; }
      rows.push(row);
    }
  }
  return rows.length ? rows : null;
}

// Word-level (intra-line) diff highlighting in the TUI. The classic ANSI diff
// paths (diffRenderer.renderDiff / renderStructuredDiff) already paint only the
// changed sub-spans via wordDiff.renderWordDiffLine, but the ink TUI — the
// default UI — only ever coloured whole ±lines. This gate brings the TUI to
// parity with CC's StructuredDiffFallback (pair a removed line with its added
// counterpart, token-diff, highlight changed words). Gate KHY_TUI_WORD_DIFF
// (default on). =0/false/off/no → off → byte-identical whole-line rendering.
function tuiWordDiffEnabled(env = process.env) {
  const flag = String((env && env.KHY_TUI_WORD_DIFF) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Plan which paired remove/add rows get word-level segment highlighting. Mirrors
 * CC's processAdjacentLines: a maximal run of consecutive `del` rows immediately
 * followed by a run of consecutive `add` rows is paired 1:1; each pair is offered
 * to wordDiff and only kept when it returns word-level segments (changeRatio at or
 * below threshold). Unpaired extras, and pairs that fall back to whole-line, get
 * no plan entry → the renderer keeps their original solid-line rendering.
 *
 * Pure (no ink). `wd` is injected (wordDiff module) for testability; `clip` is
 * applied first so segments stay within the same width bound as the legacy path.
 * `clipW` is the per-cell content width (default 100 = legacy fixed cut, kept so
 * direct callers/tests stay byte-identical; renderDiffRows passes the live
 * terminal-derived budget, or Infinity when expanded so segments aren't truncated).
 * @returns {Map<number, {side:'del'|'add', segs: Array<{text:string,changed:boolean}>}>}
 */
function planWordDiffPairs(rows, wd, clipW = 100) {
  const plan = new Map();
  if (!wd || typeof wd.computeWordDiffSegments !== 'function' || !Array.isArray(rows)) return plan;
  let i = 0;
  while (i < rows.length) {
    if (!rows[i] || rows[i].kind !== 'del') { i++; continue; }
    const dels = [];
    while (i < rows.length && rows[i] && rows[i].kind === 'del') { dels.push(i); i++; }
    const adds = [];
    while (i < rows.length && rows[i] && rows[i].kind === 'add') { adds.push(i); i++; }
    if (!adds.length) continue; // dels with no following adds → no pairing
    const pairCount = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      const di = dels[k];
      const ai = adds[k];
      const segs = wd.computeWordDiffSegments(clip(rows[di].text, clipW), clip(rows[ai].text, clipW));
      if (segs && segs.wordLevel) {
        plan.set(di, { side: 'del', segs: segs.old });
        plan.set(ai, { side: 'add', segs: segs.new });
      }
    }
  }
  return plan;
}

// Render structured diff rows as an ink column. Keeps indentation intact (clip,
// not truncate) so code lines read correctly. `expanded` (Ctrl+O) widens the
// per-cell content budget to Infinity so ink wraps the full line instead of
// truncating (CC parity); collapsed clips to a terminal-width-aware single row.
function renderDiffRows(rows, h, Box, Text, expanded = false) {
  let wd = null;
  if (tuiWordDiffEnabled()) {
    try { wd = require('../../wordDiff'); } catch { wd = null; }
  }
  // gutter 数字位宽收敛到单一真源 cli/diffGutter.js(对齐 CC 动态位宽,门控关→恒 4 位字节回退)。
  const gutter = require('../../diffGutter');
  const gw = gutter.computeDiffGutterWidth(rows, process.env);
  // 内容裁切宽度走 diffContentWidth 叶子:折叠→按终端列宽单行预算;展开→Infinity 不裁(ink 换行)。
  // 门控关 → 恒 100,逐字节回退到历史固定裁切。
  const clipW = diffClipWidth({
    columns: (process.stdout && process.stdout.columns) || undefined,
    gutterWidth: gw,
    expanded,
    env: process.env,
  });
  const plan = wd ? planWordDiffPairs(rows, wd, clipW) : null;
  return h(Box, { key: 'diff', flexDirection: 'column', marginLeft: 2 },
    ...rows.map((r, j) => {
      const num = gutter.formatDiffGutterNum(r.num, gw);
      // Paired remove/add lines with word-level segments: paint changed sub-spans
      // on the brighter word background, the rest on the line background.
      const seg = plan && plan.get(j);
      if (seg) {
        const lineBg = seg.side === 'add' ? DIFF_ADD_BG : DIFF_DEL_BG;
        const wordBg = seg.side === 'add' ? DIFF_ADD_WORD_BG : DIFF_DEL_WORD_BG;
        const sign = seg.side === 'add' ? '+' : '-';
        return h(Box, { key: j },
          h(Text, { color: '#FFFFFF', backgroundColor: lineBg }, `${num} ${sign} `),
          ...seg.segs.map((s, k) => h(Text, {
            key: k, color: '#FFFFFF', backgroundColor: s.changed ? wordBg : lineBg,
          }, s.text))
        );
      }
      if (r.kind === 'add') {
        return h(Text, { key: j, color: '#FFFFFF', backgroundColor: DIFF_ADD_BG }, `${num} + ${clip(r.text, clipW)}`);
      }
      if (r.kind === 'del') {
        return h(Text, { key: j, color: '#FFFFFF', backgroundColor: DIFF_DEL_BG }, `${num} - ${clip(r.text, clipW)}`);
      }
      if (r.kind === 'ctx') {
        return h(Text, { key: j, dimColor: true }, `${num}   ${clip(r.text, clipW)}`);
      }
      return h(Text, { key: j, dimColor: true }, clip(r.text, clipW));
    })
  );
}

function resultPreview(result) {
  if (!result) return '';
  const text = result.text || result.content || result.output || '';
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s;
}

/**
 * Render a tool result's LITERAL output body the Claude-Code way: a "⎿" elbow on
 * the first line, continuation lines aligned beneath, the whole block dim — folded
 * to a head+tail window with a "… +N 行 (ctrl+o 展开)" marker when collapsed, fully
 * revealed when expanded. `git diff`-shaped output keeps the red/green colouring.
 * A non-zero exit code is annotated beneath. Returns the ink children array, or
 * `null` when the result carries no real output body (caller then shows ✓ summary).
 *
 * This is the SINGLE source for literal-output rendering, shared by the shell-family
 * branch AND the (gated) transparency branch for other tools — so both render the
 * real command/result output identically, never a black box behind a "✓ 完成" line.
 */
function renderLiteralOutput(result, expanded, h, Box, Text) {
  // 对齐 CC:命令输出体在切行/折叠**之前**先逐行尝试 JSON 美化(CC OutputLine 的
  // tryJsonFormatContent 也是先美化再截断)。门控关/非 JSON → 逐字节原样。
  // preview 是 (result, env) 的确定性纯函数、与 expanded/列宽无关 → 按 result 身份记忆,
  // 消每帧对整份 stdout 的 JSON parse+pretty-print(diff 分支也先算 preview,故此记忆两分支共享)。
  const preview = _toolLiteralOutputMemo.memoPreview(
    result,
    () => formatShellOutputJson(resultPreview(result), process.env),
    process.env,
  );
  if (!preview || !preview.trim()) return null;
  const out = [];
  // `git diff`-shaped stdout keeps the classic red/green colouring. 行数据按 result 对象身份记忆
  // (已完成工具 result 冻结 → 消每帧 splitDiffLines 全量重切 + 逐行分类);门控关 → 直接构造。
  const shellDiffRows = _toolDiffRowsMemo.memoDiffRows(
    result, expanded,
    () => (looksLikeUnifiedDiff(preview) ? buildShellDiffRows(preview, expanded) : null),
  );
  if (shellDiffRows && shellDiffRows.length) {
    out.push(renderDiffRows(shellDiffRows, h, Box, Text, expanded));
  } else {
    // 折叠行 shownLines 依赖 (result, expanded)、不依赖列宽(列宽只在下游 truncate 阶段每帧
    // 现场施加)→ 按 result 身份 + expanded 档记忆,消每帧全量 split+collapse+fold。命中后
    // 每帧仅剩对**已折叠**(有界 maxLines)行的 truncate,byte-identical。门控关 → 直接构造。
    const shownLines = _toolLiteralOutputMemo.memoFoldedLines(result, expanded, () => {
      const allLines = preview.split('\n');
      // Drop trailing blank lines so the hidden-line count is honest.
      while (allLines.length && allLines[allLines.length - 1].trim() === '') allLines.pop();
      // Collapse consecutive duplicate lines when collapsed (Ctrl+O feeds raw lines so
      // expanded reveals the full output verbatim, repeats and all).
      const sourceLines = expanded
        ? allLines
        : collapseConsecutiveDuplicates(allLines).lines;
      // Collapsed → generous fold (short output shows in full); expanded → generous cap.
      const policy = expanded
        ? { maxLines: PREVIEW_ROWS_EXPANDED, foldHead: PREVIEW_ROWS_EXPANDED, foldTail: 0 }
        : SHELL_COLLAPSED_POLICY;
      return foldOutput(sourceLines, policy).lines;
    }, process.env);
    // 刀17:命令/三方应用 stdout 每行的裁切宽度走与 diff 行同一个 SSOT(`diffClipWidth`),
    // 而非历史的固定 100 字 `truncate(ln, 100)`。固定 100 与刀15 修掉的 diff 老缺口同病:
    //   ① 无视终端宽度(80 列 TTY 上裁到 100 仍宽于终端 → ink 二次换行 → 撑破 foldOutput
    //      的 maxLines 行预算);② **展开(Ctrl+O)后仍裁到 100** → 违背本文件注释自述的
    //      「Ctrl+O 真正显示全貌」诚实原则(刀15 已为 diff 分支修复,本刀补齐其姊妹的
    //      literal stdout 分支——它当时走 `truncate` 而非 `clip`,被刀15 漏过)。
    // gutterWidth=4 = 外层工具块 marginLeft(1) + 本 res 块 marginLeft(1) + 行首 `⎿ ` 字宽(2),
    // 故折叠态 clipW = cols - 10,逐字复刻 CC `renderTruncatedContent` 的
    // `wrapWidth = max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW(10), 10)`;展开态 → Infinity
    // (`clip(ln, Infinity) === ln`,整行交 ink 自然换行,Ctrl+O 真正全貌);门控关 → 100 字节回退。
    const litClipW = diffClipWidth({
      columns: (process.stdout && process.stdout.columns) || undefined,
      gutterWidth: 4,
      expanded,
      env: process.env,
    });
    out.push(
      h(Box, { key: 'res', flexDirection: 'column', marginLeft: 1 },
        // 命令 stdout 用**保留空格**的 clip(而非折叠 `\s+` 的 truncate):PowerShell / `ls -l` /
        // 任何列对齐输出靠成串空格排版,折叠空格会把表头塌成 `p n s` 这类单字母 + 空行。与上面
        // diff 分支同口径(见 clip 定义处注释:collapsing it would mangle code)。
        ...shownLines.map((ln, j) => h(Box, { key: j },
          h(Text, { dimColor: true }, j === 0 ? SHELL_ELBOW : SHELL_CONT),
          h(Text, { dimColor: true }, clip(ln, litClipW))
        ))
      )
    );
  }
  // A non-zero exit code is a result the stdout alone may not reveal — surface it.
  const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
  if (exitCode !== null && exitCode !== 0) {
    out.push(
      h(Box, { key: 'exit', marginLeft: 2 },
        h(Text, { color: 'yellow' }, `↳ 退出码 ${exitCode}`))
    );
  }
  return out;
}

// Extract a human-readable failure reason from a tool result so it can be shown
// proactively on the ✗ line — the user should never have to ask "why did it fail".
function errorText(result, env = process.env) {
  if (!result) return '';
  // A guard that blocked the tool supplies a clean, user-facing line separate
  // from its model-only steer message — always prefer it.
  if (result._displayHint) return String(result._displayHint);
  const cand =
    result.error ||
    result.reason ||
    result.message ||
    result.output ||
    result.content ||
    result.text;
  if (!cand) return '';
  // 刀18:折叠门控开时保留换行,让多行错误(栈回溯/构建输出/多行 stderr)按行铺开
  // 供下游 planErrorFold 折叠;关时 opts=undefined → stripInternalControlText 逐字节
  // 回退旧的「换行折空格→单行」,与历史 errorText 完全一致(单行 reason,slice(0,3)
  // 永不触发,无页脚)。门控复用 KHY_TOOL_ERROR_FOLD,折叠与换行同一开关。
  const opts = require('../../toolErrorFold').toolErrorFoldEnabled(env)
    ? { preserveNewlines: true }
    : undefined;
  if (typeof cand === 'string') return stripInternalControlText(cand, opts);
  // Structured ToolError shapes.
  if (typeof cand === 'object') {
    return stripInternalControlText(cand.message || cand.reason || JSON.stringify(cand), opts);
  }
  return stripInternalControlText(String(cand), opts);
}

function ToolLines({ tools = [], expanded = false, live = false }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!tools || tools.length === 0) return null;

  // 每帧只取一次工作目录,传给每行头部记忆做 cwd 守卫键——把「每工具一次 process.cwd()
  // 系统调用」降到「每帧一次」。summarizeArgs 内部仍在 miss 时读 process.cwd()(同步 render 内
  // 与此值恒等),故键一致性成立。
  const _cwd = (() => { try { return process.cwd(); } catch { return ''; } })();

  const blocks = tools.map((t, i) => {
    // Parallel sub-agent fan-out: once the orchestrator has spawned children the
    // bridge attaches their live state here. Render the ├│└ tree IN PLACE of the
    // generic agent(...) row (header + branches + status). Before any child
    // spawns (_agentTree empty) we fall through to the normal single-line row.
    const agentTree = Array.isArray(t._agentTree) && t._agentTree.length > 0 ? t._agentTree : null;
    if (agentTree) {
      return h(Box, { key: `tool-${i}`, flexDirection: 'column', marginLeft: 1 },
        h(AgentTree, { agents: agentTree, expanded, live }));
    }

    const done = !!t.result;
    // Treat any explicit failure signal as an error so the reason is surfaced —
    // tools fail with varied shapes: {isError}, {is_error}, {error}, or just
    // {success:false, reason}.
    const isErr = done && (
      t.result.isError ||
      t.result.is_error ||
      t.result.error ||
      t.result.success === false
    );
    const icon = !done ? '◆' : isErr ? '✗' : '✓';
    const color = !done ? 'yellow' : isErr ? 'red' : 'green';
    // 头行 { 显示名, 入参摘要 } 是 (tool, cwd) 的确定性纯函数(name/input 工具创建后不变)→
    // 按 (tool, cwd) 身份记忆,消每帧的 2×require+主题查表、JSON.parse 大入参、process.cwd() 系统
    // 调用。computeFn 内逐字节复刻原内联逻辑;门控关/异常/非对象 → 直接 computeFn(逐字节回退)。
    const _header = _toolHeaderSummaryMemo.memoHeader(t, _cwd, () => {
      // 头行显示名对齐 Claude Code:经典 REPL 早已过 getToolDisplayName 归一
      // (edit→Update / write→Write / read→Read …),但此前 TUI 头行直接用原始注册名
      // (Edit/Write/…),同一操作在 TUI 显示 `Edit(...)`、在 REPL/CC 却是 `Update(...)`。
      // 接回同一份 SSOT 消除漂移。门控 KHY_TUI_TOOL_DISPLAY_NAME(默认开);关 / 出错 →
      // 逐字节回退原始名。getToolDisplayName 对未收录工具本就返回原名,是安全超集。
      let nm = t.name || t.toolName || t.tool || 'tool';
      try {
        nm = require('../../toolHeaderDisplayName').resolveToolHeaderName(
          nm, process.env, require('../../renderTheme').getToolDisplayName
        );
      } catch { /* display-name alignment is additive; never block tool rendering */ }
      return { name: nm, argSummary: summarizeArgs(t) };
    }, process.env);
    const name = _header.name;
    const argSummary = _header.argSummary;

    // DESIGN-ARCH-047 P1: provenance label for relayed/quarantined tool calls.
    // Only shown when a non-local trust is present — local/verified tools stay
    // unadorned (fail-safe-to-ours keeps the common path visually unchanged).
    let provLabel = null;
    let provColor = 'cyan';
    const trace = t.result && t.result._khyTrace;
    if (trace && trace.trust && trace.trust !== 'verified') {
      try {
        const { inlineLabel } = require('../../../services/trajectoryProvenance').projection;
        provLabel = inlineLabel({ _khyTrace: trace });
        provColor = trace.trust === 'quarantined' ? 'red' : 'yellow';
      } catch { /* label is additive; never block tool rendering */ }
    }

    const children = [
      h(Box, { key: 'head' },
        h(Text, { color }, icon + ' '),
        h(Text, { bold: true }, name),
        argSummary ? h(Text, { dimColor: true }, `(${argSummary})`) : null,
        provLabel ? h(Text, { color: provColor }, `  ${provLabel}`) : null
      ),
    ];

    // 执行中阶段性说明（staged transparency）: while a tool is still running
    // (live preview only — committed rows always have results), render its
    // present-continuous narration under the ◆ row so the user sees what is
    // happening RIGHT NOW instead of a silent black box. Gone the moment the
    // result lands and the row flips to ✓/✗ with its summary.
    if (!done && live && t.progress) {
      children.push(
        h(Box, { key: 'progress', marginLeft: 2 },
          h(Text, { color: 'yellow' }, '↳ '),
          h(Text, { dimColor: true }, String(t.progress)))
      );
    }

    // On failure, ALWAYS surface the reason (independent of `expanded`) so the
    // user sees why without having to ask — never a bare ✗. A permission-gate
    // denial is labelled "权限被拒绝" (mirrors the classic REPL) so the user can
    // tell "blocked by approval" apart from a genuine tool error.
    if (isErr) {
      const denied = !!(t.result && t.result.denied);
      const rawReason = errorText(t.result, process.env);
      // 刀26:对齐 CC `FallbackToolUseErrorMessage` 的**受众拆分**——给**人**的折叠态把
      // **本仓自产的入参校验失败串**(面向模型的多行分组)收成单行 `Invalid tool parameters`;
      // **展开(Ctrl+O)** 仍显完整分组细节;模型侧 tool_result 不动(本处只在 display 层)。
      // 非校验类失败原样透传。门控 KHY_USER_FACING_TOOL_ERROR 默认开;关 / expanded → 原样回退。
      const reason = require('../../ccUserFacingToolError')
        .collapseValidationErrorForDisplay(rawReason, { expanded }, process.env);
      const rawLines = reason ? String(reason).split('\n') : [];
      // 刀18:错误详情按 CC `FallbackToolUseErrorMessage` 折叠——折叠态最多显
      // MAX_RENDERED_LINES(10)行,余下不再静默丢弃而是缀一条**独立 dim 页脚**
      // `… +N 行 (ctrl+o 展开)`(=CC 的 "… +N lines (ctrl+o to see all)"),且
      // **展开(Ctrl+O)时显示全部**。历史 `slice(0,3)` 既无视 expanded(Ctrl+O 永不
      // 显全)又静默丢尾(超 3 行的栈/构建错误用户看不出下面还有)——与刀17 修掉的
      // literal stdout「截断后 Ctrl+O 仍是空头支票」同病。折叠决策收敛到纯叶子
      // toolErrorFold(单一真源);着色(红行/dim 页脚)与 marginLeft 留本 call-site。
      // 门控 KHY_TOOL_ERROR_FOLD 默认开;关 → planErrorFold 逐字节回退旧 silent 3 行截断
      // ({shown: lines.slice(0,3), hidden:0},不受 expanded 影响)。
      const { shown: detailLines, hidden } = require('../../toolErrorFold')
        .planErrorFold(rawLines, expanded, process.env);
      // Guarantee at least one explanatory line even when no reason text exists.
      const headline = denied ? '权限被拒绝' : (detailLines.length ? null : '失败');
      const errChildren = [];
      if (headline) errChildren.push(h(Text, { key: 'h', color: 'red', bold: denied }, headline));
      // 刀40:错误详情每行的**裁切宽度**走 diffClipWidth SSOT,与姊妹 literal stdout 分支
      // (本文件 ~470 行)同口径——终端感知 + **展开(Ctrl+O)→Infinity 整行**——而非历史固定
      // `truncate(ln,120)`。固定 120 与刀15/刀17 修掉的 diff / literal 老缺口同病:① 无视终端宽
      // (80 列 TTY 上裁到 120 仍宽于终端 → ink 二次换行 → 撑破折叠行预算);② **展开后仍裁 120**
      // → 超长错误行(长路径 ENOENT / 长 JSON 校验行 / 长编译诊断)的尾部 Ctrl+O 永远看不到,
      // 是 toolErrorFold「诚实展开」自述原则的漏网之鱼(literal 姊妹被刀17 修了,error 这支当时漏过)。
      // 行内空白早由 stripInternalControlText(preserveNewlines)逐行折叠 + trim(刀18 刻意:保留行间
      // 结构、归一行内空白),多数情况下 clip/truncate 对空白等价;但为与 literal 姊妹**同口径**、且防
      // 某些错误输出(PowerShell ParserError / 编译诊断表格)靠成串空格列对齐被折成 `p n s` 单字母,
      // 此处改用**保留空格**的 clip(而非折叠 `\s+` 的 truncate)。已折叠内容下逐字节等价,是严格超集。
      // 复用门控 KHY_TOOL_ERROR_FOLD(整个「多行错误忠实渲染」特性同一开关):关 → 逐字节回退旧
      // `truncate(ln,120)`。gutterWidth=3 = 外层工具块 marginLeft(1)+本 err 块 marginLeft(2),错误行无 `⎿ ` 前缀。
      const _errFaithful = require('../../toolErrorFold').toolErrorFoldEnabled(process.env);
      const _errClipW = _errFaithful
        ? diffClipWidth({
            columns: (process.stdout && process.stdout.columns) || undefined,
            gutterWidth: 3,
            expanded,
            env: process.env,
          })
        : 120;
      detailLines.forEach((ln, j) =>
        errChildren.push(h(Text, { key: `d${j}`, color: 'red' }, clip(ln, _errClipW))));
      // Honest fold footer (dim, like CC) — never a silent drop. Gate-off /
      // expanded → hidden===0 → no footer, byte-identical to the legacy branch.
      if (hidden > 0) {
        errChildren.push(h(Text, { key: 'more', dimColor: true }, `… +${hidden} 行 (ctrl+o 展开)`));
      }
      children.push(
        h(Box, { key: 'err', flexDirection: 'column', marginLeft: 2 }, ...errChildren)
      );
    }

    // Red/green ±diff for Write/Edit/Delete (Goal7, _khyWriteDiff). The diff IS
    // the result the user wants to see, so render it inline regardless of
    // `expanded` — it takes the place of the generic "✓ 完成" / text preview.
    const diffRows = (done && !isErr && t.result && t.result._khyWriteDiff)
      ? _toolDiffRowsMemo.memoDiffRows(
          t.result._khyWriteDiff, expanded,
          () => buildWriteDiffRows(t.result._khyWriteDiff, expanded),
        )
      : null;

    if (diffRows && diffRows.length) {
      children.push(renderDiffRows(diffRows, h, Box, Text, expanded));
    } else if (done && !isErr && isShellResult(name)) {
      // Literal command / third-party-app stdout (e.g. `ls`, `claude`): show a
      // few head lines, fold the rest with a "… +N 行 (ctrl+o 展开)" marker (CC
      // style), and let Ctrl+O reveal the full body. Unlike other tools, command
      // output is shown (folded) even when collapsed — that IS the result the user ran.
      const body = renderLiteralOutput(t.result, expanded, h, Box, Text);
      if (body) {
        children.push(...body);
      } else {
        // Command produced no stdout — still confirm completion. The summary
        // carries a non-zero exit tag ("… [退出码 N]") when present, so it stays
        // the source of truth for the no-output case. Result-line lead unified to
        // CC's "⎿" elbow via resultLineGlyph (gate KHY_RESULT_ELBOW; off → "✓").
        const summary = t.result && t.result.summary;
        const lead = resultLineLead();
        children.push(
          h(Box, { key: 'ok', marginLeft: 2 },
            h(Text, { color: lead.color, dimColor: lead.dim }, lead.glyph + (summary || '完成')))
        );
      }
    } else if (done && !isErr && !expanded) {
      // 工具结果透明化(collapsed):保持 CC 风格的「摘要一瞥」(Read N lines / 找到 N 个
      // 匹配),但当结果确实携带真实输出体时,像 CC 那样补一个 (ctrl+o 展开) 提示,明确
      // 告诉用户「底下有真实输出可展开」——避免误以为只有这一行。collapsed 刻意不内联
      // 展开体(与 CC 一致:Read/Grep 的正文留到展开时看)。门控关 或 无真实输出体 →
      // 不加提示,逐字节回退到原「✓ 摘要 / ✓ 完成」行。
      const summary = t.result && t.result.summary;
      const lead = resultLineLead();
      const base = lead.glyph + (summary || '完成');
      const hint = shouldRenderTransparentBody(t.result) ? '  (ctrl+o 展开)' : '';
      children.push(
        h(Box, { key: 'ok', marginLeft: 2 },
          h(Text, { color: lead.color, dimColor: lead.dim }, base + hint))
      );
    } else if (!diffRows && expanded && done && !isErr) {
      // 工具结果透明化(expanded):门控开且有真实输出体 → 同一 ⎿ 透明体(更慷慨的展开
      // 上限,Ctrl+O 真正显示全貌);门控关 → 回退到原 12 行文本预览,逐字节等价。
      const body = shouldRenderTransparentBody(t.result)
        ? renderLiteralOutput(t.result, true, h, Box, Text)
        : null;
      if (body) {
        children.push(...body);
      } else {
        const preview = resultPreview(t.result);
        if (preview) {
          const lines = preview.split('\n').slice(0, 12);
          children.push(
            h(Box, { key: 'res', flexDirection: 'column', marginLeft: 2 },
              ...lines.map((ln, j) => h(Text, { key: j, dimColor: true }, clip(ln, 100)))
            )
          );
        }
      }
    }

    return h(Box, { key: `tool-${i}`, flexDirection: 'column', marginLeft: 1 }, ...children);
  });

  return h(Box, { flexDirection: 'column' }, ...blocks);
}

module.exports = ToolLines;
// Pure helpers exported for unit tests (no ink dependency).
module.exports.buildWriteDiffRows = buildWriteDiffRows;
module.exports.renderDiffRows = renderDiffRows;
module.exports.buildShellDiffRows = buildShellDiffRows;
module.exports.looksLikeUnifiedDiff = looksLikeUnifiedDiff;
// Word-level diff pairing planner + gate reader — exported so unit tests can pin
// the pairing/segment logic without rendering ink.
module.exports.planWordDiffPairs = planWordDiffPairs;
module.exports.tuiWordDiffEnabled = tuiWordDiffEnabled;
// Shell-family classifier — exported so ProcessGroup shares the SAME rule when
// deciding which steps stay visible (folded) in a collapsed group.
module.exports.isShellResult = isShellResult;
// Reason extractor (+ re-exported sanitizer) — exported so unit tests can assert
// that internal [SYSTEM:…]/[STOP]/[Loop…] control text never reaches the ✗ line.
module.exports.stripInternalControlText = stripInternalControlText;
module.exports.errorText = errorText;
// Arg-summary builder — exported so the path-middle-truncation routing (CC
// truncatePathMiddle) can be asserted without rendering ink.
module.exports.summarizeArgs = summarizeArgs;
