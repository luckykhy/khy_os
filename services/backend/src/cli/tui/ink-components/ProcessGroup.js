'use strict';

/**
 * ProcessGroup — renders a run of consecutive tool calls as ONE collapsible
 * "过程组" (process group), Companion-style:
 *
 *   ▸ 过程组 · 3 个步骤  ✓2 ✗1            (collapsed — Ctrl+O 展开)
 *   ▾ 过程组 · 3 个步骤  ✓2 ✗1            (expanded — full tool output below)
 *
 * The group header brackets the steps as one unit; the steps themselves are
 * delegated to ToolLines (so the ◆/✓/✗ styling, the always-on failure reason,
 * and the success "完成" / expanded preview are identical to a lone tool).
 *
 * Collapse/expand is driven by the global `expanded` flag (App.js Ctrl+O), which
 * is the only viable toggle for the committed <Static> transcript region —
 * Static rows do not re-render, so per-row interactive toggles are not possible
 * there. A single tool is NOT wrapped in group chrome (a "1 个步骤" header would
 * be noise) — it renders as a plain ToolLines block.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const ToolLines = require('./ToolLines');
// 按 tool 对象身份记忆 toolTarget 输出(消每帧对已完成工具 input 的重复 JSON.parse)。纯叶子,
// fail-soft require:缺失/抛错 → 直接算(逐字节回退)。门控 KHY_TOOL_TARGET_MEMO。
let _toolTargetMemo = null;
try { _toolTargetMemo = require('./toolTargetMemo'); } catch { _toolTargetMemo = null; }
// 按 tool 对象身份记忆 classifyTool 输出(消每帧对分组内每个工具重跑 ~13 条正则的分类电池)。纯叶子,
// fail-soft require:缺失/抛错 → 直接算(逐字节回退)。门控 KHY_PROCESS_GROUP_CLASSIFY_MEMO。
let _classifyMemo = null;
try { _classifyMemo = require('./processGroupClassifyMemo'); } catch { _classifyMemo = null; }
// Same shell-family rule ToolLines uses to fold command/third-party-app stdout —
// reused so the collapse decision and the per-step fold stay in lockstep.
const { isShellResult } = ToolLines;

// True when a finished tool result represents a failure. Mirrors ToolLines'
// isErr rule so the header counts match the per-step icons.
function isToolError(result) {
  return !!(result && (result.isError || result.is_error || result.error || result.success === false));
}

// Map a tool name to a semantic action label so the group header reads as what
// the steps actually DID ("读取 · 编辑") instead of a generic "过程组". Matched on
// the lowercased, alnum-only name so canonical (Read/Edit/Bash) and Khy-specific
// (readFile/editFile/shellCommand/executeCode/webSearch/...) names both resolve.
//
// EXPLICIT_CATEGORY is consulted FIRST and pins known tools deterministically.
// The substring CATEGORY_RULES below are a fallback for unknown names only — they
// misroute several real tools by accident of substring order: `findAndReplace`
// (an edit) hits /find/ → 搜索; `save_as_docx` / `propose_code_change` match no
// rule at all → null. Pinning them here keeps the header honest.
const EXPLICIT_CATEGORY_SRC = {
  读取: ['Read', 'readFile', 'NotebookRead', 'cat', 'open', 'local_knowledge'],
  写入: ['Write', 'writeFile', 'save_as_file', 'save_as_docx', 'create_document', 'renderDocument', 'scaffoldFiles', 'scaffold'],
  编辑: ['Edit', 'MultiEdit', 'editFile', 'NotebookEdit', 'findAndReplace', 'propose_code_change', 'patch'],
  搜索: ['Grep', 'Glob', 'search', 'find', 'explore', 'toolSearch', 'tool_search'],
  联网检索: ['WebSearch', 'WebFetch', 'webSearch', 'web_search', 'fetch', 'browse'],
  执行命令: ['Bash', 'shellCommand', 'shell_command', 'execute_shell', 'executeShell', 'executeCode', 'run_tests', 'runTests'],
  子任务: ['Task', 'spawn_agent', 'resume_agent', 'wait_agent', 'chain_run'],
  规划: ['TodoWrite', 'ExitPlanMode', 'plan'],
  '浏览目录': ['list', 'ls', 'dir', 'tree', 'listDir'],
  删除: ['delete', 'remove', 'rm', 'deleteFile'],
  移动: ['move', 'rename', 'mv'],
  提问: ['AskUserQuestion', 'ask', 'question'],
};
const _normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const EXPLICIT_CATEGORY = (() => {
  const m = new Map();
  for (const [label, names] of Object.entries(EXPLICIT_CATEGORY_SRC)) {
    for (const name of names) {
      const k = _normName(name);
      if (k && !m.has(k)) m.set(k, label);
    }
  }
  return m;
})();

// Order matters: more specific rules first (web before search; edit before read
// /write) so e.g. webSearch → 联网检索, not 搜索.
const CATEGORY_RULES = [
  [/web|fetch|news|http|url|browse|crawl/, '联网检索'],
  [/grep|glob|search|find|explore/, '搜索'],
  [/plan|todo/, '规划'],
  [/git|commit|diff/, 'Git 操作'],
  [/agent|task|spawn|chain|resume|wait/, '子任务'],
  [/multiedit|notebookedit|edit|patch|modify|replace/, '编辑'],
  [/write|create|scaffold|template|document/, '写入'],
  [/read|notebookread|^cat$|^open$/, '读取'],
  [/bash|shell|exec|runtests|^run|command|terminal|deploy|build|lint|coverage|backtest|^test/, '执行命令'],
  [/list|^ls$|^dir$|tree/, '浏览目录'],
  [/delete|remove|^rm$/, '删除'],
  [/move|rename|^mv$/, '移动'],
  [/ask|question/, '提问'],
];

function classifyTool(name) {
  const n = _normName(name);
  if (!n) return null;
  const pinned = EXPLICIT_CATEGORY.get(n);
  if (pinned) return pinned;
  for (const [re, label] of CATEGORY_RULES) {
    if (re.test(n)) return label;
  }
  return null;
}

function truncateTitle(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Best-effort "what was operated on" for a single step: a command, a file, a
// query, etc. Used to enrich a single-category title (e.g. "读取 server.js").
function toolTarget(t) {
  const raw = t && (t.input ?? t.args ?? t.parameters ?? t.arguments);
  if (raw == null) return '';
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return raw.trim(); }
  }
  if (!obj || typeof obj !== 'object') return String(obj);
  if (obj.command) return String(obj.command);
  for (const k of ['file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    if (obj[k]) return String(obj[k]);
  }
  return '';
}

// Reduce a target to a compact token: path-like → basename, else as-is.
function condenseTarget(s) {
  s = String(s).trim();
  if (!s) return '';
  if (/[/\\]/.test(s)) {
    const parts = s.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || s;
  }
  return s;
}

// A target hint only when all steps share ONE distinct target (otherwise the
// "N 个步骤" count in the header already conveys the multiplicity).
function representativeTarget(tools) {
  // 每工具的 toolTarget 按 tool 对象身份记忆(冻结工具跳过 JSON.parse)。缺叶子/门控关 → 直接算。
  const _target = (t) => (_toolTargetMemo
    ? _toolTargetMemo.memoToolTarget(t, () => toolTarget(t), process.env)
    : toolTarget(t));
  // 压缩目标(basename 抽取)同按 tool 对象身份记忆(冻结工具连 condense 的 split/正则/数组分配也跳过);
  // 缺 memoCondensedTarget(旧叶子无此函数)/门控关 → 直接 condenseTarget(逐字节回退)。computeFn 内复用
  // 已算 target,故每工具 _target 恰调一次(不在回退路径重复 JSON.parse)。
  const condensed = [];
  for (const t of tools) {
    const target = _target(t);
    if (!target) continue; // 与旧 raw.filter(Boolean) 等价:无目标工具跳过
    const c = ((_toolTargetMemo && typeof _toolTargetMemo.memoCondensedTarget === 'function')
      ? _toolTargetMemo.memoCondensedTarget(t, () => condenseTarget(target), process.env)
      : condenseTarget(target));
    condensed.push(c);
  }
  if (condensed.length === 0) return '';
  const distinct = [...new Set(condensed)];
  return distinct.length === 1 ? truncateTitle(distinct[0], 40) : '';
}

// Derive the group's display name from its actual contents:
//   - distinct action labels in first-appearance order, joined with " · "
//   - append the shared target when all steps operated on ONE thing, whether the
//     group is single-category ("读取 server.js") or multi-category
//     ("读取 · 编辑 server.js") — the target is the most useful disambiguator
//   - unknown tools fall back to their raw names, then "过程组"
function groupTitle(tools) {
  const cats = [];
  for (const t of tools) {
    // classifyTool 按 tool 对象身份记忆(已到达工具跳过 ~13 条正则;缺叶子/门控关 → 直接算)。
    const c = _classifyMemo
      ? _classifyMemo.memoClassify(t, () => classifyTool(t && (t.name || t.toolName || t.tool)), process.env)
      : classifyTool(t && (t.name || t.toolName || t.tool));
    if (c && !cats.includes(c)) cats.push(c);
  }
  if (cats.length === 0) {
    const names = [...new Set(
      tools.map((t) => t && (t.name || t.toolName || t.tool)).filter(Boolean)
    )];
    return names.length ? truncateTitle(names.slice(0, 3).join(' · '), 48) : '过程组';
  }
  const base = cats.slice(0, 3).join(' · ');
  const target = representativeTarget(tools);
  return target ? `${base} ${target}` : base;
}

// Short status summary for the header: ✓ ok, ✗ failed, ◆ still running.
function statusSummary(tools) {
  let ok = 0, err = 0, pending = 0;
  for (const t of tools) {
    if (!t || !t.result) { pending += 1; continue; }
    if (isToolError(t.result)) err += 1; else ok += 1;
  }
  const parts = [];
  if (ok) parts.push(`✓${ok}`);
  if (err) parts.push(`✗${err}`);
  if (pending) parts.push(`◆${pending}`);
  return parts.join(' ');
}

/**
 * Coalesce a turn timeline into renderable segments, merging runs of
 * consecutive tool steps into a single group:
 *   { type:'text', text }            → unchanged
 *   { type:'tool', tool } (a run)    → { type:'tools', tools:[tool, ...] }
 * Preserves order, so the real text↔tool interleaving is kept (text explanation
 * first, the tool run after).
 * @param {Array<{type:string,text?:string,tool?:object}>} timeline
 * @returns {Array<{type:'text',text:string}|{type:'tools',tools:object[]}>}
 */
function groupConsecutiveTools(timeline) {
  const out = [];
  if (!Array.isArray(timeline)) return out;
  let run = null;
  for (const e of timeline) {
    if (e && e.type === 'tool' && e.tool) {
      if (!run) { run = { type: 'tools', tools: [] }; out.push(run); }
      run.tools.push(e.tool);
    } else {
      run = null;
      if (e && e.type === 'text') out.push({ type: 'text', text: e.text });
      else out.push(e);
    }
  }
  return out;
}

/**
 * groupTimeline — render-grouping that keeps the answer body CONTIGUOUS.
 *
 * Like groupConsecutiveTools, but additionally coalesces thinking so it never
 * fragments the delivered answer. The timeline is split into "phases" delimited
 * by tool runs. Within each phase, all thinking segments are merged into ONE
 * folded block (emitted first) and all text segments are concatenated into ONE
 * contiguous answer block (emitted after). Tool runs are still merged into a
 * single collapsible group, and the text↔tool ordering across phases is kept
 * (explain → execute → explain).
 *
 * Why: reasoning models interleave thinking mid-answer (text → thinking → text).
 * Rendered verbatim, the folded "💭 思考" line splits the answer in two and the
 * body reads as truncated ("displayed then hidden"). Merging per phase guarantees
 * the deliverable shows as one block while thinking stays folded above it.
 *
 * @param {Array<{type:string,text?:string,tool?:object}>} timeline
 * @returns {Array<{type:'thinking',text:string}|{type:'text',text:string}|{type:'tools',tools:object[]}>}
 */
function groupTimeline(timeline) {
  const out = [];
  if (!Array.isArray(timeline)) return out;
  let think = '';
  let thinkMs = 0; // sum of REAL durations of thinking entries merged this phase
  let text = '';
  let toolRun = null;
  const flushPhase = () => {
    if (think) {
      out.push(thinkMs > 0 ? { type: 'thinking', text: think, durationMs: thinkMs } : { type: 'thinking', text: think });
      think = ''; thinkMs = 0;
    }
    if (text) { out.push({ type: 'text', text }); text = ''; }
  };
  for (const e of timeline) {
    if (e && e.type === 'tool' && e.tool) {
      // A tool closes the current text/thinking phase before the tool run.
      flushPhase();
      if (!toolRun) { toolRun = { type: 'tools', tools: [] }; out.push(toolRun); }
      toolRun.tools.push(e.tool);
    } else {
      toolRun = null;
      if (e && e.type === 'thinking' && e.text) {
        think += e.text;
        if (Number(e.durationMs) > 0) thinkMs += Number(e.durationMs); // carry real elapsed
      } else if (e && e.type === 'text' && e.text) text += e.text;
      // empty / unknown segments are dropped
    }
  }
  flushPhase();
  return out;
}

function ProcessGroup({ tools = [], expanded = false, live = false }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!tools || tools.length === 0) return null;

  // A single step does not warrant group chrome — render it as a lone tool.
  if (tools.length === 1) {
    return h(ToolLines, { tools, expanded, live });
  }

  // `live` (the in-flight preview) always lists its steps so the user watches
  // activity as it happens; the committed transcript folds by the global Ctrl+O
  // `expanded` flag. When folded, the group is TRULY folded — successful steps
  // collapse into the header's ✓ count instead of printing one line each. Two
  // exceptions stay visible even folded:
  //   1. a FAILED step (codebase red line: the user must see what broke), and
  //   2. a SHELL/command/third-party-app step — its stdout IS the result the user
  //      ran (`ls`, `claude`, …), so it keeps a folded few-line preview by default
  //      (ToolLines applies the "几行 + ctrl+o 展开" treatment per step).
  // The agent's own prose and structured tool results are NOT shell steps, so they
  // still fold into the ✓ count when collapsed — only literal command output peeks.
  const showAll = expanded || live;
  const caret = showAll ? '▾' : '▸';
  const summary = statusSummary(tools);
  const title = groupTitle(tools);
  const isStepVisibleWhenFolded = (t) =>
    t && (isToolError(t.result) || isShellResult(t.name || t.toolName || t.tool || ''));
  const stepTools = showAll ? tools : tools.filter(isStepVisibleWhenFolded);
  const header = h(Box, { key: 'hdr' },
    h(Text, { color: 'cyan', bold: true }, `${caret} ${title}`),
    h(Text, { dimColor: true }, ` · ${tools.length} 个步骤`),
    summary ? h(Text, { dimColor: true }, `  ${summary}`) : null,
    showAll ? null : h(Text, { dimColor: true }, '   (Ctrl+O 展开)')
  );

  if (stepTools.length === 0) {
    // Folded with no failures: header alone is the whole record.
    return h(Box, { flexDirection: 'column' }, header);
  }
  return h(Box, { flexDirection: 'column' },
    header,
    // Previews stay gated by the REAL expanded flag (live shows the step list but
    // not success previews — keeping the live region within its height budget).
    // `live` is forwarded so a running step in the group shows its 执行中 line.
    h(ToolLines, { key: 'steps', tools: stepTools, expanded, live })
  );
}

ProcessGroup.groupConsecutiveTools = groupConsecutiveTools;
ProcessGroup.groupTimeline = groupTimeline;
ProcessGroup.statusSummary = statusSummary;
ProcessGroup.groupTitle = groupTitle;
ProcessGroup.classifyTool = classifyTool;
module.exports = ProcessGroup;
