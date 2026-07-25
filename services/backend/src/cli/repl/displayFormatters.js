/**
 * Tool/prompt display formatters for the classic REPL.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. The single home for "inputs → display string / descriptor"
 * derivation shared by the classic REPL and the ink TUI. Pure (no module state,
 * no I/O, no chalk); the thin wrappers below forward to the shared, equally pure
 * summarizer/preface modules so both UIs derive from one source.
 */
const os = require('os');
const path = require('path');
const { summarizeToolResult } = require('../toolResultSummary');
const {
  toolProgressReason: sharedToolProgressReason,
  buildStreamingToolPreface: sharedBuildStreamingToolPreface,
} = require('../toolPrefaceVoice');

/** Normalize a tool name to its lookup key: lowercase, strip spaces/_/-. */
function normalizeToolName(toolName) {
  return String(toolName).toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Collapse the current working directory to a `~`-relative short form for the
 * prompt frame. Reads process.cwd()/os.homedir() at call time (no caching) so
 * it tracks `cd` within the session.
 */
function formatShortCwd() {
  const cwd = process.cwd();
  const home = os.homedir();
  if (cwd === home) return '~';
  if (cwd.startsWith(home + path.sep)) return '~' + cwd.slice(home.length);
  return cwd;
}

/**
 * Shorten a (already `~`-collapsed) path for the prompt: when it has more than
 * three segments, collapse every intermediate directory to its first character,
 * keeping the first and last segments intact. Pure; segments split on path.sep.
 */
function shortenPromptPath(display) {
  const parts = String(display).split(path.sep);
  if (parts.length > 3) {
    const last = parts.pop();
    const first = parts.shift();
    return first + path.sep + parts.map((p) => p[0] || p).join(path.sep) + path.sep + last;
  }
  return display;
}

/**
 * Render a one-line tool-call summary (call count · elapsed · file-op tallies)
 * from a structured summary object. Returns '' for malformed input so callers
 * can suppress the line entirely.
 */
function formatToolSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const totalCalls = Number(summary.totalCalls || 0);
  const totalDurationMs = Number(summary.totalDurationMs || 0);
  if (!Number.isFinite(totalCalls) || !Number.isFinite(totalDurationMs)) return '';
  const fileOps = Array.isArray(summary.fileOps) ? summary.fileOps : [];
  const opCounts = {
    create: fileOps.filter((op) => op?.operation === 'create' || op?.operation === 'scaffold').length,
    modify: fileOps.filter((op) => op?.operation === 'modify').length,
    rename: fileOps.filter((op) => op?.operation === 'rename').length,
    move: fileOps.filter((op) => op?.operation === 'move').length,
    delete: fileOps.filter((op) => op?.operation === 'delete').length,
  };
  const opParts = [];
  if (opCounts.modify > 0) opParts.push(`修改 ${opCounts.modify}`);
  if (opCounts.create > 0) opParts.push(`新建 ${opCounts.create}`);
  if (opCounts.rename > 0) opParts.push(`重命名 ${opCounts.rename}`);
  if (opCounts.move > 0) opParts.push(`移动 ${opCounts.move}`);
  if (opCounts.delete > 0) opParts.push(`删除 ${opCounts.delete}`);
  const durStr = _formatToolSummaryDuration(Math.max(0, totalDurationMs));
  return `工具摘要: ${Math.max(0, totalCalls)} 次调用 · ${durStr}${opParts.length > 0 ? ` · ${opParts.join(' · ')}` : ''}`;
}

// CC 后端口径对齐:工具摘要行的「已耗时」与 TUI 回合统计行(turnStats.js,走 ccFormatDuration)
// 同属一个概念——「这一回合用了多久」——但本经典/共享渲染器原来一律 `toFixed(1)s`,
// 在 ≥60s 时给 "90.0s",而 CC formatDuration 与 Khy 自己的 TUI 统计行都给 "1m 30s"
// (Khy 内部两处同义行不一致本身就是后端口径未统一的味道)。这里只对 **≥60s** 改走
// ccFormatDuration SSOT;**<60s 保留 `toFixed(1)` 的十分之一秒精度**(与 formatCompactionResult
// 同一刻意取舍:工具摘要绝大多数 <60s,亚秒精度更有信息量,且保持既有逐字节输出不变)。
//   门控复用共享 KHY_CC_FORMAT(与 turnStats/thinkingDuration 同一 ccFormat 总开关);
//   关 → 一律逐字节回退旧 `toFixed(1)s`。ccFormat require 包在 try 里,异常静默回退,绝不抛。
function _formatToolSummaryDuration(durationMs, env = process.env) {
  const legacy = `${(durationMs / 1000).toFixed(1)}s`;
  if (durationMs < 60000) return legacy; // <60s: keep tenths precision (byte-identical to before)
  try {
    const { ccFormatEnabled, ccFormatDuration } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatDuration(durationMs);
      if (out) return out;
    }
  } catch { /* fall through to the legacy form below */ }
  return legacy;
}

/**
 * Map a tool name + params to a streaming-progress activity descriptor
 * `{ label, target }`, or null when the tool has no dedicated progress line.
 * Pure: classifies by normalized tool name and reads well-known param keys.
 */
function toolProgressStart(toolName, params = {}) {
  const name = normalizeToolName(toolName);
  if (name === 'websearch') return { label: '正在搜索', target: params.query || params.q || '' };
  if (name === 'scaffoldfiles') {
    const fileCount = Array.isArray(params.files) ? params.files.length : 0;
    const dirCount = Array.isArray(params.directories) ? params.directories.length : 0;
    return { label: `正在批量创建结构(${dirCount}目录/${fileCount}文件)`, target: params.root || '.' };
  }
  if (name === 'webfetch') return { label: 'Fetching URL', target: params.url || '' };
  if (name === 'grep' || name === 'glob' || name === 'find' || name === 'search' || name === 'ls') {
    return { label: 'Exploring workspace', target: params.path || params.pattern || '' };
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    // Relativize the file target to cwd + middle-truncate when too long so the
    // basename survives (CC toRelativePath + truncatePathMiddle). SSOT
    // toolParamPath.formatToolHeaderPath; both gates off → byte-identical raw.
    const t = params.path || params.file_path || '';
    return { label: 'Reading file', target: require('../toolParamPath').formatToolHeaderPath(String(t), process.cwd(), process.env) };
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile' || name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    const t = params.file_path || params.filePath || params.path || '';
    return { label: 'Updating file', target: require('../toolParamPath').formatToolHeaderPath(String(t), process.cwd(), process.env) };
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    return { label: 'Running command', target: (params.command || '').slice(0, 80) };
  }
  if (name === 'agent' || name === 'task') {
    return { label: 'Delegating to agent', target: params.role || params.subagent_type || 'general' };
  }
  return null;
}

/**
 * Map a completed tool call to a finish descriptor `{ status, label, detail }`.
 * The pure sibling of toolProgressStart: classifies by normalized tool name and
 * picks success/failure phrasing. Always returns a descriptor (generic fallback).
 */
function toolProgressDone(toolName, success, detail = '') {
  const name = normalizeToolName(toolName);
  const status = success ? 'success' : 'error';
  if (name === 'websearch') return { status, label: success ? 'Searched' : 'Web search failed', detail };
  if (name === 'webfetch') return { status, label: success ? 'Fetched URL' : 'URL fetch failed', detail };
  if (name === 'scaffoldfiles') return { status, label: success ? 'Scaffolded' : 'Scaffold failed', detail };
  if (name === 'grep' || name === 'glob' || name === 'find' || name === 'search' || name === 'ls') {
    return { status, label: success ? 'Explored' : 'Explore failed', detail };
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    return { status, label: success ? 'Read' : 'Read failed', detail };
  }
  if (name === 'write' || name === 'writefile' || name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    return { status, label: success ? 'Updated' : 'Update failed', detail };
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    return { status, label: success ? 'Ran command' : 'Command failed', detail };
  }
  if (name === 'agent' || name === 'task') {
    return { status, label: success ? 'Agent completed' : 'Agent failed', detail };
  }
  return { status, label: success ? 'Completed' : 'Failed', detail };
}

/**
 * Format a completed tool result into a ⎿ display line (per tool type), e.g.
 *   Read → "Read N lines", Bash → output summary, Grep → "Found N matches".
 * Thin forward to the shared pure summarizer so the classic REPL and the ink
 * TUI derive success summaries from one source.
 */
function formatToolResult(toolName, result, params) {
  return summarizeToolResult(toolName, result, params);
}

/**
 * Streaming-progress reason line for a tool call (shared module, full mode).
 * `occurrence` (0-based count of prior same-category tools this turn) lets the
 * shared voice rotate continuation phrasing so consecutive same-type calls don't
 * repeat verbatim ("我先补一下…再回来收口" ×N). Omitted → 0 → legacy first phrasing.
 */
function toolProgressReason(toolName, params = {}, occurrence) {
  return sharedToolProgressReason(toolName, params, { mode: 'full', occurrence });
}

/** Streaming tool preface ("about to run X") (shared module, full mode). */
function buildStreamingToolPreface(toolName, inputHint = '', occurrence) {
  return sharedBuildStreamingToolPreface(toolName, inputHint, { mode: 'full', occurrence });
}

/**
 * Strip INTERNAL control text meant for the model, never the user. Several guards
 * (cross-turn repeat, loop detector, loop warning) inject a steer message AS the
 * blocked tool's `error`/result so the model reads it next turn — but that same
 * field also feeds the visible ✗ line, leaking "[SYSTEM: 你在本次对话中已经成功
 * 运行过…]" verbatim (系统提示词泄漏). This drops the bracketed control markers from
 * the DISPLAY only; the model-facing copy is built separately and untouched.
 * Single source shared by the ink TUI (ToolLines) and the classic REPL. Pure.
 */
function stripInternalControlText(s, opts) {
  if (typeof s !== 'string' || !s) return s || '';
  let out = s;
  // Whole model-only nudge blocks → drop entirely (no internal `]` before close).
  out = out.replace(/\[SYSTEM:[\s\S]*?\]/g, '');
  // Tag-only markers → drop the tag, keep any human-readable text that follows.
  out = out.replace(/\[(?:STOP|LoopDetector:[^\]]*|LoopWarning:[^\]]*)\]/g, '');
  // 刀18:preserveNewlines —— 保留 `\n` 换行,让多行工具错误(栈回溯 / 构建输出 /
  // 多行 stderr)按行铺开渲染,而不是塌成一行 space-join(历史默认会把 4 行栈回溯
  // 折成一句,使下游 flexDirection:column + slice 的多行机件形同虚设)。逐行折叠
  // 空格/制表符并 trim、丢弃空行(含被剥掉的 [SYSTEM:…] 块留下的空行),保留行间结构。
  // 不传 opts → 逐字节回退旧行为(所有换行折成空格),repl.js 的单行摘要消费者不受影响。
  if (opts && opts.preserveNewlines) {
    return out
      .split('\n')
      .map((ln) => ln.replace(/[ \t]+/g, ' ').trim())
      .filter((ln) => ln !== '')
      .join('\n')
      .trim();
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

module.exports = {
  normalizeToolName,
  formatShortCwd,
  shortenPromptPath,
  formatToolSummary,
  toolProgressStart,
  toolProgressDone,
  formatToolResult,
  toolProgressReason,
  buildStreamingToolPreface,
  stripInternalControlText,
};
