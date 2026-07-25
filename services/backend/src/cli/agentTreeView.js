'use strict';

/**
 * agentTreeView — the SINGLE SOURCE of truth for how a parallel sub-agent fan-out
 * is laid out as a tree, shared by BOTH front-ends:
 *   - the classic readline REPL (cli/agentRenderer.js → chalk + console.log)
 *   - the ink TUI (cli/tui/ink-components/AgentTree.js → Box/Text)
 *
 * It is deliberately PURE — no chalk, no ink, no Date.now — so the layout, the
 * tree glyphs, the stats wording and the progress state-machine cannot drift
 * between the two renderers and stay unit-testable. Each medium maps the
 * returned semantic rows onto its own colours/elements.
 *
 * Visual contract (Claude-Code style):
 *   ● Running 2 agents…            ← header (buildAgentHeader)
 *     ├ 基本面分析师 · 5 tool uses · 2.1s
 *     │ └ Reading server.js        ← running detail sub-line
 *     └ 风控经理 · Done
 */

// Agent lifecycle status vocabulary (shared so neither side invents its own).
const STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERROR: 'error',
});

// 统计行三分段(N tool uses · X tokens · 时长)的构造收敛到同族纯叶子
// cli/agentStatLine.js(对齐 CC AgentTool/UI.tsx;门控 KHY_CC_FORMAT 默认开,
// 关 → 各 call-site 传入 legacy 逐字节回退)。仍是纯叶子链:本叶子→agentStatLine→ccFormat。
const _stat = require('./agentStatLine');

// 运行中但尚未起任一工具、也未吐出任何 prose 的子 agent 仍须**看起来在活动**:
// 对齐 CC `src/components/AgentProgressLine.tsx` 的 `getStatusText()`——任何
// **未完成**(!isResolved)的 agent 一律 `lastToolInfo || 'Initializing…'`,父级
// 绝不会看到一个**只有名字、下面空一片**的行(误读成卡死)。khy 历史在此返回
// '' → 无 detail 子行(裸名)。门控 KHY_AGENT_INIT_STATUS 默认开;关 → 逐字节回退
// 到历史「裸名无子行」。`…` 用 U+2026(与 CC 逐字节一致)。
const INITIALIZING_LABEL = 'Initializing…';
function agentInitStatusEnabled(env = process.env) {
  const flag = String((env && env.KHY_AGENT_INIT_STATUS) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// Tree-drawing glyphs. BRANCH on the agent line, CONT under it for the detail
// sub-line (space when the agent is the last branch, so nothing dangles).
const BRANCH_MID = '├';
const BRANCH_END = '└';
const CONT_MID = '│';
const CONT_END = ' ';

/**
 * Fresh agent state record. Callers own timing (startedAt/elapsed) so this stays
 * pure — the ink bridge and the classic controller both stamp their own clock.
 * @param {{id?:string, name?:string, status?:string, depth?:number}} [init]
 */
function makeAgentState(init = {}) {
  return {
    id: init.id,
    name: init.name || 'agent',
    depth: init.depth || 0,
    status: init.status || STATUS.RUNNING,
    toolCalls: 0,
    currentTool: null,
    currentTarget: null,
    // The command/description a command tool (Bash/shell) is executing RIGHT NOW.
    // Set from a tool_start event's `command`; preferred over currentTarget in the
    // detail sub-line so a parallel agent shows what it is running, not a blank.
    currentCommand: null,
    // A compact directory-tree preview (array of glyph lines) from the agent's
    // most recent listing tool (LS/Glob/tree). Rendered as extra sub-lines so a
    // parallel agent can surface the directory tree it explored. Persists until a
    // newer listing replaces it (NOT cleared by intervening non-listing tools).
    detailLines: [],
    detail: null,
    // The latest one-line preview of the sub-agent's streamed prose (正文), set
    // from an `agent_text` event (see subAgentTextStream). Shown in the detail
    // sub-line ONLY while running and no tool is active (a running tool line wins,
    // since "doing X now" is more informative than the prose tail). Null until the
    // sub-agent emits text; cleared on terminal states.
    currentText: null,
    tokens: 0,
    elapsed: 0,
  };
}

/**
 * Classify a tool by what it DOES, so the parallel tree can surface the right
 * affordance (command line for shells, a directory tree for listings). Pure;
 * name is normalised (lowercase, strip spaces/_/-) so 'read_file'/'ReadFile' and
 * 'Bash'/'shell' classify identically. Shared by the producer (AgentTool, which
 * decides what extra data to forward) and this view.
 * @param {string} name
 * @returns {'command'|'listing'|'read'|'edit'|'search'|'agent'|'other'}
 */
function classifyAgentTool(name) {
  const n = String(name || '').toLowerCase().replace(/[\s_-]/g, '');
  if (isAgentFamilyTool(name)) return 'agent';
  if (/^(bash|shell|sh|zsh|cmd|powershell|pwsh|run|runcommand|exec|execute|executecommand|executecode|terminal)$/.test(n)) return 'command';
  if (/^(ls|list|listfiles|listdir|listdirectory|readdirectory|readdir|dir|tree|glob|find)$/.test(n)) return 'listing';
  if (/^(read|readfile|cat|open|view)$/.test(n)) return 'read';
  if (/^(edit|editfile|write|writefile|multiedit|applypatch|str_replace|strreplace)$/.test(n)) return 'edit';
  if (/^(grep|search|rg|ripgrep|websearch|searchcode)$/.test(n)) return 'search';
  return 'other';
}

/**
 * Format a directory listing into a compact, bounded tree preview (array of
 * ├/└ glyph lines). Pure — no fs, no colour. Directories get a trailing '/'; when
 * the listing exceeds `max`, the last line is a "… +N more" tail so nothing is
 * silently dropped. Accepts entries shaped `{name|path, type}` or bare strings.
 * @param {Array<{name?:string,path?:string,type?:string,isDirectory?:boolean}|string>} entries
 * @param {{max?:number}} [opts]
 * @returns {string[]}
 */
function formatTreePreview(entries, { max = 6 } = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e != null) : [];
  if (list.length === 0) return [];
  const cap = Math.max(2, max | 0);
  const overflow = list.length > cap;
  const shown = overflow ? cap - 1 : list.length; // reserve a row for the tail
  const lines = [];
  for (let i = 0; i < shown; i++) {
    const e = list[i];
    const nm = typeof e === 'string'
      ? e
      : String((e && (e.name || e.path)) || '?');
    const isDir = typeof e !== 'string'
      && (e.type === 'directory' || e.type === 'dir' || e.isDirectory === true);
    const isLast = !overflow && i === shown - 1;
    lines.push(`${isLast ? '└' : '├'} ${nm}${isDir ? '/' : ''}`);
  }
  if (overflow) lines.push(`└ … +${list.length - shown} more`);
  return lines;
}

/** Truncate a one-line detail target so a long command/path never wraps the box. */
function _clip(s, n = 72) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * Status → dot glyph. Filled ● for any active/terminal state, hollow ○ for
 * pending. Colour is applied by the medium; this only picks the shape.
 */
function statusDot(status) {
  return status === STATUS.PENDING ? '○' : '●';
}

/**
 * Agent-family tool detector — whose parallel fan-out renders as a live ├│└
 * tree instead of a single `agent(...)` row. Single source shared by the ink
 * bridge (useQueryBridge), the ink renderer (ToolLines) and the classic REPL,
 * so all three classify the same names identically (strip spaces/_/-).
 */
function isAgentFamilyTool(name) {
  const n = String(name || '').toLowerCase().replace(/[\s_-]/g, '');
  return n === 'agent' || n === 'spawnworker' || n === 'subagent';
}

/**
 * Build the `· N tool uses · X.Xk tokens · X.Xs` stat parts for one agent.
 * `elapsed` is accepted both as a number (ms, the renderer-native shape) and as
 * a pre-formatted string ("2.1s", the controller shape) so neither caller has to
 * pre-convert. Returns an array of strings (joined by the medium).
 */
function formatStats(agent, env = process.env) {
  const parts = [];
  if (agent && agent.toolCalls > 0) {
    parts.push(_stat.agentToolUsesLabelOr(agent.toolCalls, `${agent.toolCalls} tool uses`, env));
  }
  if (agent && agent.tokens > 0) {
    const legacyTok = agent.tokens >= 1000
      ? `${(agent.tokens / 1000).toFixed(1)}k tokens`
      : `${agent.tokens} tokens`;
    parts.push(_stat.agentTokensLabelOr(agent.tokens, legacyTok, env));
  }
  const el = agent && agent.elapsed;
  if (typeof el === 'number' && el > 0) {
    parts.push(_stat.agentDurationLabelOr(el, `${(el / 1000).toFixed(1)}s`, env));
  } else if (typeof el === 'string' && el.trim()) parts.push(el.trim());
  return parts;
}

/**
 * The detail sub-line text: a running agent shows what it is doing RIGHT NOW
 * (currentTool [+ target]); a finished agent shows its outcome (detail, e.g.
 * "Done" / the failure reason). Empty string → no sub-line.
 */
function detailText(agent, env = process.env) {
  if (!agent) return '';
  if (agent.status === STATUS.RUNNING && agent.currentTool) {
    // A command tool surfaces what it is executing (命令); other tools surface
    // their target (path/pattern). currentCommand wins when present so a Bash row
    // reads "Bash python3 setup.py build" instead of a bare "Bash".
    const tgt = agent.currentCommand || agent.currentTarget;
    return `${agent.currentTool}${tgt ? ` ${_clip(tgt)}` : ''}`;
  }
  // No tool active but the sub-agent is streaming prose → show its latest text
  // tail so the parent sees what the child is "saying" right now (对齐 Claude
  // Code 流式 prose). A running tool always wins above.
  if (agent.status === STATUS.RUNNING && agent.currentText) {
    return _clip(agent.currentText);
  }
  // Still running but no tool / no prose yet → surface CC's liveness placeholder
  // so the row never reads as a stalled bare name (gated; off → historical '').
  if (agent.status === STATUS.RUNNING && !agent.detail && agentInitStatusEnabled(env)) {
    return INITIALIZING_LABEL;
  }
  return agent.detail || '';
}

/**
 * Lay out the agent list as semantic rows. Pure — no colour, no ink.
 * @param {Array} agents
 * @returns {Array<
 *   {kind:'agent', isLast:boolean, branch:string, name:string, status:string, stats:string[]}
 * | {kind:'detail', cont:string, text:string}
 * | {kind:'preview', cont:string, text:string}>}
 */
function buildAgentTreeRows(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const rows = [];
  list.forEach((agent, i) => {
    const isLast = i === list.length - 1;
    const cont = isLast ? CONT_END : CONT_MID;
    rows.push({
      kind: 'agent',
      isLast,
      branch: isLast ? BRANCH_END : BRANCH_MID,
      name: (agent && agent.name) || 'agent',
      status: (agent && agent.status) || STATUS.PENDING,
      stats: formatStats(agent),
    });
    const detail = detailText(agent);
    if (detail) {
      rows.push({ kind: 'detail', cont, text: detail });
    }
    // Directory-tree preview sub-lines (目录树) from the agent's latest listing.
    // Each is its own indented row so both front-ends render the tree generically;
    // bounded defensively even though formatTreePreview already caps the source.
    const preview = Array.isArray(agent && agent.detailLines) ? agent.detailLines : [];
    for (let p = 0; p < preview.length && p < 6; p++) {
      if (preview[p]) rows.push({ kind: 'preview', cont, text: String(preview[p]) });
    }
  });
  return rows;
}

/**
 * Header descriptor. allDone is true only when every agent reached a terminal
 * state (and there is at least one agent). The medium picks the dot colour and
 * appends its own "(ctrl+o 展开)" hint.
 * @returns {{count:number, allDone:boolean, dot:string, label:string}}
 */
function buildAgentHeader(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const allDone = list.length > 0
    && list.every((a) => a && (a.status === STATUS.COMPLETED || a.status === STATUS.ERROR));
  // Pluralize "agent(s)" via the shared ccPlural SSOT so a single-agent
  // fan-out reads "Running 1 agent…" / "1 agent finished" instead of the
  // ungrammatical "1 agents" (gate KHY_CC_PLURAL off → plural form → byte-revert).
  const agentWord = require('./ccPlural').pluralOr(list.length, 'agent', 'agents', process.env);
  return {
    count: list.length,
    allDone,
    dot: '●',
    label: allDone ? `${list.length} ${agentWord} finished` : `Running ${list.length} ${agentWord}…`,
  };
}

/**
 * Pure progress reducer: given an agent state and a progress event, return the
 * NEXT state (never mutates the input). Covers the classic leaf-agent vocabulary
 * (tool_start/tool_end/iteration/done) AND the orchestrator-forwarded lifecycle
 * events (agent_spawned/started/completed/failed). Unknown events pass through.
 * @param {object} agent
 * @param {object} event
 */
function applyProgressEvent(agent, event) {
  if (!agent || !event) return agent;
  const next = { ...agent };
  switch (event.type) {
    case 'agent_spawned':
    case 'agent_started':
      // A spawn/start only (re)affirms running — never clobber a terminal state
      // that may have arrived out of order.
      if (next.status !== STATUS.COMPLETED && next.status !== STATUS.ERROR) {
        next.status = STATUS.RUNNING;
      }
      if (event.name && (!next.name || next.name === 'agent')) next.name = event.name;
      break;
    case 'tool_start':
      next.toolCalls = (next.toolCalls || 0) + 1;
      next.currentTool = event.tool || null;
      next.currentTarget = event.target || null;
      // A command tool forwards the line it is running; null for everything else.
      next.currentCommand = event.command || null;
      break;
    case 'tool_end':
      next.currentTool = null;
      next.currentTarget = null;
      next.currentCommand = null;
      // A listing tool (LS/Glob/tree) forwards its entries → keep a compact
      // directory-tree preview under the agent. Persist it through later
      // non-listing tools (only a newer listing replaces it).
      if (Array.isArray(event.entries) && event.entries.length) {
        next.detailLines = formatTreePreview(event.entries);
      }
      break;
    case 'agent_text':
      // A coalesced one-line preview of the sub-agent's streamed prose. Only
      // meaningful while running; never resurrect a terminal agent.
      if (next.status !== STATUS.COMPLETED && next.status !== STATUS.ERROR) {
        next.currentText = event.text || null;
      }
      break;
    case 'iteration':
      // Liveness tick only — elapsed is recomputed by the medium's clock.
      break;
    case 'agent_completed':
      next.status = STATUS.COMPLETED;
      next.currentTool = null;
      next.currentTarget = null;
      next.currentText = null;
      if (!next.detail) next.detail = 'Done';
      if (typeof event.elapsed === 'number') next.elapsed = event.elapsed;
      break;
    case 'agent_failed':
      next.status = STATUS.ERROR;
      next.currentTool = null;
      next.currentTarget = null;
      next.currentText = null;
      next.detail = event.error || next.detail || 'Failed';
      if (typeof event.elapsed === 'number') next.elapsed = event.elapsed;
      break;
    case 'done':
      next.status = event.success ? STATUS.COMPLETED : STATUS.ERROR;
      next.currentTool = null;
      next.currentTarget = null;
      next.currentText = null;
      next.detail = event.success ? 'Done' : (event.error || 'Failed');
      if (typeof event.elapsed === 'number') next.elapsed = event.elapsed;
      if (typeof event.toolCalls === 'number') next.toolCalls = event.toolCalls;
      break;
    default:
      break;
  }
  return next;
}

module.exports = {
  STATUS,
  BRANCH_MID,
  BRANCH_END,
  CONT_MID,
  CONT_END,
  makeAgentState,
  statusDot,
  isAgentFamilyTool,
  classifyAgentTool,
  formatTreePreview,
  formatStats,
  detailText,
  buildAgentTreeRows,
  buildAgentHeader,
  applyProgressEvent,
};
