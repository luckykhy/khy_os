/**
 * "Live activity" derivation for the classic REPL busy spinner / status line.
 *
 * Split from cli/repl/statusLabels.js as a behavior-preserving leaf: the block
 * that turns the live turn state into a concrete one-liner — the running tool's
 * target, the current reasoning, or the gateway's own detail — so a frozen
 * spinner says WHAT it is stuck on. UI-agnostic: each frontend passes a
 * normalized shape and composes the result into its own label. statusLabels.js
 * re-exports these three symbols so its public surface stays byte-identical.
 */

// ── Live activity: "what is actually happening right now" ───────────────────
// The coarse phase word (思考中/执行工具中/等待响应) tells the user nothing about
// the REAL current event when a turn stalls. deriveLiveActivity turns the live
// turn state into a concrete one-liner — the running tool's target, the current
// reasoning, or the gateway's own detail — so a frozen spinner says WHAT it is
// stuck on. UI-agnostic: each frontend passes a normalized shape and composes
// the result into its own label.

// Lazily-loaded shared narration voice (single source for tool wording). Fault-
// isolated so a missing/broken module never breaks status rendering.
let _voice = null;
let _voiceTried = false;
function _getVoice() {
  if (!_voiceTried) {
    _voiceTried = true;
    try {
      _voice = require('../toolPrefaceVoice');
    } catch {
      _voice = null;
    }
  }
  return _voice;
}

/** Strip a trailing ellipsis (… or ...) so a narration can be recomposed. */
function stripTrailingEllipsis(s) {
  return String(s || '')
    .replace(/(?:…|\.{3})\s*$/, '')
    .trim();
}

/** Last meaningful clause of a reasoning tail, whitespace-collapsed, ≤ max chars. */
function thinkingClause(tail, max = 60) {
  const raw = String(tail || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) {
    return '';
  }
  // Take the last sentence-ish fragment so the label reflects the CURRENT thought,
  // not the opening of a long reasoning block.
  // Split on Chinese and English sentence-ending punctuation.
  const parts = raw
    .split(/(?<=[。．.!?！？；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Filter out very short fragments (like single punctuation or 1-2 chars)
  const meaningful = parts.filter((p) => p.length > 2);
  const last = meaningful.length ? meaningful[meaningful.length - 1] : (parts.length ? parts[parts.length - 1] : raw);
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

/**
 * Derive a concrete "what is happening right now" activity string for the busy
 * spinner / status line. UI-agnostic — each frontend passes a normalized shape:
 *   - status:       coarse phase id (thinking | tool | tool_progress | streaming
 *                   | summary | done | compacting | request | …)
 *   - runningTool:  { name, input } of the tool currently executing, or null
 *   - thinkingTail: the latest streamed reasoning text, or ''
 *   - statusDetail: the latest gateway status message ("等待模型响应中" …), or ''
 * Returns '' when nothing concrete can be added (caller keeps the base label).
 * Disabled outright via KHY_LIVE_ACTIVITY=0 (revert to the bare phase words).
 */
function deriveLiveActivity({ status, runningTool, thinkingTail, statusDetail, env } = {}) {
  const e = env || process.env;
  if (String(e.KHY_LIVE_ACTIVITY || '').trim() === '0') {
    return '';
  }
  const phase = String(status || '')
    .trim()
    .toLowerCase();
  const detail = String(statusDetail || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (phase === 'tool' || phase === 'tool_progress') {
    const name = runningTool && (runningTool.name || runningTool.toolName);
    const input = runningTool && (runningTool.input || runningTool.params || {});
    if (name) {
      // Prefer the shared running narration ("正在 … 里搜索 \"x\"") — the richer,
      // single-sourced wording the REPL/TUI already display under a running tool
      // row; it names the real event instead of a bare verb + target. Ellipsis is
      // stripped so callers can recompose their own suffix.
      const voice = _getVoice();
      if (voice && typeof voice.toolRunningNarration === 'function') {
        try {
          const narration = stripTrailingEllipsis(
            voice.toolRunningNarration(name, input)
          );
          if (narration) {
            return narration;
          }
        } catch {
          /* fall through */
        }
      }
      // Narration unavailable (voice module missing or silent) → local
      // verb + target, then the bare tool name.
      const target = _extractToolTarget(name, input);
      if (target) {
        return `${_verbForTool(name)} ${target}`;
      }
      return `运行 ${String(name).trim()}`;
    }
    return detail;
  }
  if (phase === 'thinking') {
    // Show what the AI is thinking about (the topic/context, not just the last sentence)
    const clause = thinkingClause(thinkingTail, 60);
    if (clause) {
      return `分析: ${clause}`;
    }
    return detail || '分析用户意图';
  }
  // streaming/generating already shows visible text → keep the bare base label.
  if (phase === 'streaming' || phase === 'generating') {
    return '';
  }
  // summary / done / compacting / request / init / local / unknown → gateway detail.
  return detail;
}

// Extract a human-readable target from tool input
function _extractToolTarget(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const name = String(toolName || '').toLowerCase();
  // For file-related tools, show the file path
  if (/read|readfile/.test(name)) {
    return input.file_path || input.path || '';
  }
  if (/write|writefile|createfile/.test(name)) {
    return input.file_path || input.path || '';
  }
  if (/edit|multiedit/.test(name)) {
    return input.file_path || input.path || '';
  }
  if (/bash|shell/.test(name)) {
    const cmd = input.command || '';
    return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
  }
  if (/grep|search/.test(name)) {
    return input.pattern || input.query || '';
  }
  if (/glob|find/.test(name)) {
    return input.pattern || '';
  }
  if (/websearch/.test(name)) {
    return input.query || '';
  }
  if (/webfetch/.test(name)) {
    const url = input.url || '';
    return url.length > 40 ? url.slice(0, 37) + '...' : url;
  }
  if (/agent|task/.test(name)) {
    return input.prompt || input.description || input.role || '';
  }
  return '';
}

// Map tool name to a concise verb
function _verbForTool(toolName) {
  const name = String(toolName || '').toLowerCase();
  if (/read|readfile/.test(name)) return '读取';
  if (/write|writefile/.test(name)) return '写入';
  if (/createfile/.test(name)) return '创建';
  if (/edit|multiedit/.test(name)) return '编辑';
  if (/bash|shell/.test(name)) return '执行';
  if (/grep/.test(name)) return '搜索';
  if (/glob|find/.test(name)) return '查找';
  if (/websearch/.test(name)) return '联网搜索';
  if (/webfetch/.test(name)) return '抓取';
  if (/agent|task/.test(name)) return '派发';
  if (/todowrite/.test(name)) return '更新';
  if (/notebookedit/.test(name)) return '编辑';
  if (/ls/.test(name)) return '列出';
  return '运行';
}

module.exports = {
  deriveLiveActivity,
  stripTrailingEllipsis,
  thinkingClause,
};
