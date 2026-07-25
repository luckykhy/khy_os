'use strict';

/**
 * toolProtocolAdapter.js — the tool-call PROTOCOL seam, single-sourced.
 *
 * KHY-OS used to maintain two tool loops: the main `toolUseLoop` (cloud models,
 * native `tool_use` blocks) and `localToolLoop` (weak local models, a text
 * `<tool_call>{json}</tool_call>` protocol). Keeping both drifted — a fix in one
 * silently missed the other. This module collapses the protocol difference into
 * a single pluggable axis so ONE loop can serve both:
 *
 *   - `nativeAdapter` — native function-calling: parse `aiResult.toolUseBlocks`,
 *     format results as structured Anthropic tool_result blocks. Pure extraction
 *     of the main loop's existing behavior (byte-for-byte intent).
 *   - `textAdapter`   — the weak-model text protocol: parse `<tool_call>` JSON
 *     from raw model text, advertise a curated tool catalog + protocol in the
 *     system prompt, feed results back as plain text. These text primitives are
 *     PHYSICALLY OWNED HERE as the single source; `localToolLoop` re-imports them
 *     for its deterministic no-model path, so there is zero duplication.
 *
 * Both adapters share one shape so the loop can treat protocol as a parameter:
 *
 *   { protocol, capabilities:{ toolCallProtocol },
 *     parseToolCalls(aiResult)                  -> [{ name, params, _toolUseId?, _structured? }]
 *     formatToolResults(toolResults, opts)      -> { text, structuredBlocks, structuredToolResults }
 *     buildSystemAddendum(defs, { writeEnabled }) -> string|null
 *     selectTools(allDefs, { writeEnabled })    -> Array|null }
 *
 * `nativeAdapter` returns null from buildSystemAddendum/selectTools (native uses
 * the loop's existing tool pool + low-tier trimming, no extra injection); the
 * loop keeps its native parse/format inline and only ROUTES through the text
 * adapter when protocol==='text', minimizing risk to the cloud path.
 */

const TEXT_PROTOCOL = 'text';
const NATIVE_PROTOCOL = 'native';

// ── Curated tool whitelists (single source; localToolLoop re-exports) ────────

// READ-ONLY BASE TIER — always available. Deliberately small: dumping 100+ tool
// schemas would blow a 4B context and invite hallucinated calls. Read / search /
// web only. Override via KHY_LOCAL_TOOLS (comma-separated tool names).
const DEFAULT_LOCAL_TOOLS = [
  'Read', 'readFile',
  'Glob', 'Grep', 'LS',
  'search', 'WebSearch', 'WebFetch',
  'gitStatus', 'gitDiff',
  'local_knowledge', 'list_models',
];

// OPT-IN DELIVERY TIER — file authoring + shell so a weak model can actually
// BUILD, not just read. Deliberately narrow; EXCLUDES the over-powered ones
// (deploy / executeCode). Merged in only when write mode is active; every call
// still routes through executeTool's approval gate. Override via
// KHY_LOCAL_WRITE_TOOLS.
const DEFAULT_LOCAL_WRITE_TOOLS = [
  'Write', 'writeFile',
  'Edit', 'editFile', 'MultiEdit',
  'Bash', 'shellCommand',
];

function _resolveAllowedToolNames() {
  const raw = String(process.env.KHY_LOCAL_TOOLS || '').trim();
  if (!raw) return DEFAULT_LOCAL_TOOLS.slice();
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  return names.length ? names : DEFAULT_LOCAL_TOOLS.slice();
}

function _resolveWriteToolNames() {
  const raw = String(process.env.KHY_LOCAL_WRITE_TOOLS || '').trim();
  if (!raw) return DEFAULT_LOCAL_WRITE_TOOLS.slice();
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  return names.length ? names : DEFAULT_LOCAL_WRITE_TOOLS.slice();
}

/**
 * Decide whether the opt-in write/shell delivery tier is active. "Controlled" by
 * design — the control is the approval gate, not a blanket on/off:
 *
 *   KHY_LOCAL_WRITE = 'on'/'1'/'true'  → force enable (caller owns the risk).
 *                     'off'/'0'/'false' → force read-only (never write).
 *                     unset (AUTO)      → enable IFF an interactive approval
 *                                        channel is wired (every write human-gated).
 *                                        Without a channel (CI / headless) stay
 *                                        read-only = fail-closed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.hasApprovalChannel=false]
 * @returns {boolean}
 */
function _resolveWriteMode(opts = {}) {
  // 布尔解析走 parseBoolean 单一真源（base tier）。未显式设值时回落到
  // hasApprovalChannel（auto：仅当写操作有人闸时才放行）——正好由 fallback 参数承接。
  const _parseBoolean = require('../utils/parseBoolean');
  return _parseBoolean(process.env.KHY_LOCAL_WRITE, !!opts.hasApprovalChannel, { extended: false });
}

/**
 * Select the curated tool definitions, intersecting the allowlist with what the
 * registry actually exposes (so a renamed/removed tool never reaches the model).
 */
function selectLocalTools(allDefs, allowed) {
  const byName = new Map();
  for (const d of Array.isArray(allDefs) ? allDefs : []) {
    if (d && d.name) byName.set(d.name, d);
  }
  const out = [];
  for (const name of allowed) {
    if (byName.has(name)) out.push(byName.get(name));
  }
  return out;
}

/**
 * Render a compact tool catalog for the prompt: name + description + required
 * params. Avoids dumping full JSON Schema (too heavy for small models).
 */
function _renderToolCatalog(defs) {
  return defs.map(d => {
    const props = (d.parameters && d.parameters.properties) || {};
    const required = (d.parameters && d.parameters.required) || [];
    const keys = Object.keys(props);
    const paramHint = keys.length
      ? keys.map(k => (required.includes(k) ? `${k}*` : k)).join(', ')
      : '无参数';
    const desc = String(d.description || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return `- ${d.name}(${paramHint})：${desc}`;
  }).join('\n');
}

/**
 * Build the weak-model system prompt: persona + tool catalog + the single text
 * protocol. Kept in Chinese to match the KHY-OS local-mode UX.
 *
 * @param {Array} defs curated tool definitions to advertise.
 * @param {object} [opts]
 * @param {boolean} [opts.writeEnabled=false] switch from read-only assistant to
 *        delivery persona (may author files / run shell, those steps need user
 *        approval, verify after writing). The write tools are added to `defs` by
 *        the caller; this only flips the guidance.
 */
function buildSystemPrompt(defs, opts = {}) {
  const writeEnabled = opts.writeEnabled === true;
  const catalog = _renderToolCatalog(defs);
  const persona = writeEnabled
    ? '你是 KHY-OS 的本地助手，运行在离线/本地模型上。你可以调用下列工具读取信息，也可以创建/修改文件、执行命令来真正完成项目。'
    : '你是 KHY-OS 的本地助手，运行在离线/本地模型上。你可以调用下列工具来获取信息后再回答。';
  const lines = [
    persona,
    '',
    '可用工具（带 * 的参数为必填）：',
    catalog,
    '',
    '调用工具时，只输出一行如下格式（可在一条回复中输出多行以调用多个工具）：',
    '<tool_call>{"name": "工具名", "params": {"参数名": "值"}}</tool_call>',
    '',
    '规则：',
    '1. 需要读取文件、搜索代码或联网时，先调用工具，不要凭空编造结果。',
    '2. 拿到工具结果后，如果信息足够就直接用自然语言回答，不要再调用工具。',
    '3. 如果不需要任何工具就能回答，直接回答即可。',
    '4. 工具结果会以「工具结果」的形式回传给你。',
  ];
  if (writeEnabled) {
    lines.push(
      '5. 需要落地代码/文件时，先写文件再用 Read 核对，确保内容真正写入。',
      '6. 写文件、执行命令等高风险操作会先征求用户批准；若被拒绝，换一种方式或说明原因，不要反复重试同一操作。',
      '7. 完成后用一句话说明你做了什么、改动了哪些文件。',
      '',
      '权限分级（系统会按下列规则自动放行或拦截，你无需自己判断，但应据此安排步骤）：',
      '- 自动放行：读取/搜索/列目录/联网读取（如 Read、Glob、Grep、LS、WebFetch）——随时调用，不会打断。',
      '- 需批准一次：在项目目录内写/改文件、执行普通命令（Write、Edit、Bash 等）——会弹窗，批准后即放行。请把改动限制在当前项目目录内的相对路径。',
      '- 会被硬拦截（不要尝试）：删除文件、结束进程、改环境变量、安装依赖、执行任意代码、写系统级路径（如 /tmp、/etc、/usr）。这些需用户手动键入确认，自动批准无效；遇到此类需求请改用项目内的方式，或直接说明该步骤需要用户手工执行。',
    );
  }
  return lines.join('\n');
}

/**
 * Format a single executeTool result into a plain-text block to feed back to the
 * model. Truncated so a large file read can't blow the context window.
 */
function formatToolResult(name, result, maxLen) {
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 2000;
  let body;
  if (result == null) {
    body = '(无返回)';
  } else if (result.denied) {
    body = `已被拒绝：${result.error || '权限不足'}`;
  } else if (result.success === false) {
    body = `失败：${result.error || '未知错误'}`;
  } else {
    const out = result.output != null ? result.output : result;
    body = typeof out === 'string' ? out : JSON.stringify(out);
  }
  body = String(body);
  if (body.length > cap) body = body.slice(0, cap - 1) + '…';
  return `工具结果 [${name}]：\n${body}`;
}

/**
 * Extract tool calls from raw model text. Primary path = toolCallParser's
 * 7-format parser; fallback = a lone JSON object with a name/params shape that
 * the parser's tag-oriented formats may miss.
 * @returns {Array<{name:string, params:object}>}
 */
function extractToolCalls(text) {
  if (!text) return [];
  let calls = [];
  try {
    const { parseToolCalls } = require('./toolCallParser');
    calls = parseToolCalls(text) || [];
  } catch { /* fall through to JSON recovery */ }
  if (calls.length) return calls;

  // Fallback: a bare {"name": "...", "params": {...}} the model emitted without
  // the <tool_call> wrapper. Canonicalize to match the parser path's behavior.
  try {
    const { extractFirstJson } = require('./gateway/safeJsonParse');
    const obj = extractFirstJson(text, null);
    if (obj && typeof obj.name === 'string') {
      const rawParams = obj.params || obj.arguments || obj.input || {};
      try {
        const norm = require('./claudeCompat').normalizeToolCall(obj.name, rawParams);
        if (norm && norm.name) return [{ name: norm.name, params: norm.params || rawParams }];
      } catch { /* fall back to raw */ }
      return [{ name: obj.name, params: rawParams }];
    }
  } catch { /* none */ }
  return [];
}

/**
 * Build the set of tool names the loop will accept. Includes each curated def's
 * raw name AND its canonical form (toolCallParser canonicalizes Read→readFile,
 * etc.), so a canonicalized parsed call still passes the allowlist.
 * @param {Array<{name:string}>} defs
 * @returns {Set<string>}
 */
function _buildAllowedNameSet(defs) {
  const set = new Set();
  let canonicalize = null;
  try { canonicalize = require('./claudeCompat').normalizeToolCall; } catch { /* none */ }
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d || !d.name) continue;
    set.add(d.name);
    if (typeof canonicalize === 'function') {
      try {
        const norm = canonicalize(d.name, {});
        if (norm && norm.name) set.add(norm.name);
      } catch { /* keep raw */ }
    }
  }
  return set;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/**
 * Native function-calling adapter. `parseToolCalls` mirrors the main loop's
 * existing native block mapping as a pure function (for the parity test); the
 * loop itself keeps its native parse/format inline (byte-identical), so this
 * adapter's parse is a faithful twin rather than the live cloud path.
 */
const nativeAdapter = Object.freeze({
  protocol: NATIVE_PROTOCOL,
  capabilities: Object.freeze({ toolCallProtocol: NATIVE_PROTOCOL }),

  parseToolCalls(aiResult) {
    const blocks = aiResult && Array.isArray(aiResult.toolUseBlocks) ? aiResult.toolUseBlocks : [];
    if (!blocks.length) return [];
    let normalizeToolCall = null;
    try { normalizeToolCall = require('./claudeCompat').normalizeToolCall; } catch { /* none */ }
    const out = [];
    for (const block of blocks) {
      if (!block) continue;
      const rawName = block.name || (block.function && block.function.name);
      if (!rawName) continue;
      let rawParams = block.input != null ? block.input
        : (block.params != null ? block.params
          : (block.function && block.function.arguments));
      if (typeof rawParams === 'string') {
        try { rawParams = JSON.parse(rawParams); } catch { rawParams = {}; }
      }
      if (!rawParams || typeof rawParams !== 'object') rawParams = {};
      let name = rawName;
      let params = rawParams;
      if (typeof normalizeToolCall === 'function') {
        try {
          const norm = normalizeToolCall(rawName, rawParams);
          if (norm && norm.name) { name = norm.name; params = norm.params || rawParams; }
        } catch { /* keep raw */ }
      }
      out.push({
        name,
        params,
        _toolUseId: block.id || block.tool_use_id || undefined,
        _structured: true,
      });
    }
    return out;
  },

  // Native result formatting is owned inline by toolUseLoop._buildToolResultMessage
  // (structured Anthropic blocks). Returning null signals "use the loop's native
  // path" — kept here so the adapter shape is uniform without duplicating that
  // 140-line builder.
  formatToolResults() { return null; },

  // Native uses the loop's existing tool pool + low-tier trimming; no extra
  // system addendum and no curated whitelist.
  buildSystemAddendum() { return null; },
  selectTools() { return null; },
});

/**
 * Weak-model text protocol adapter. Owns the `<tool_call>` parse, the curated
 * catalog + protocol system prompt, the read-only/delivery tool selection, and
 * the plain-text result feedback.
 */
const textAdapter = Object.freeze({
  protocol: TEXT_PROTOCOL,
  capabilities: Object.freeze({ toolCallProtocol: TEXT_PROTOCOL }),

  parseToolCalls(aiResult) {
    const text = aiResult && aiResult.reply != null ? String(aiResult.reply)
      : (typeof aiResult === 'string' ? aiResult : '');
    return extractToolCalls(text);
  },

  /**
   * Format executeTool results as a single plain-text turn. No structured
   * blocks — a weak model consumes the text directly.
   * @param {Array<{tool:string, result:object}>} toolResults
   * @param {object} [opts] { maxLen }
   * @returns {{text:string, structuredBlocks:null, structuredToolResults:null}}
   */
  formatToolResults(toolResults, opts = {}) {
    const list = Array.isArray(toolResults) ? toolResults : [];
    const cap = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : 2000;
    const text = list
      .filter(tr => tr && tr.tool !== '_legacy_cmd')
      .map(tr => formatToolResult(tr.tool, tr.result, cap))
      .join('\n\n');
    return { text, structuredBlocks: null, structuredToolResults: null };
  },

  buildSystemAddendum(defs, opts = {}) {
    return buildSystemPrompt(Array.isArray(defs) ? defs : [], { writeEnabled: opts.writeEnabled === true });
  },

  /**
   * Curated read-only base tier (+ opt-in write tier when writeEnabled),
   * intersected with what the registry exposes.
   * @param {Array} allDefs
   * @param {object} [opts] { writeEnabled }
   */
  selectTools(allDefs, opts = {}) {
    const allowed = _resolveAllowedToolNames();
    if (opts.writeEnabled === true) {
      for (const n of _resolveWriteToolNames()) {
        if (!allowed.includes(n)) allowed.push(n);
      }
    }
    return selectLocalTools(allDefs, allowed);
  },
});

/**
 * Resolve the active adapter from a protocol string. Unknown / falsy → native
 * (the safe default for cloud models with real function calling).
 * @param {string} protocol
 * @returns {typeof nativeAdapter | typeof textAdapter}
 */
function resolveAdapter(protocol) {
  return protocol === TEXT_PROTOCOL ? textAdapter : nativeAdapter;
}

module.exports = {
  TEXT_PROTOCOL,
  NATIVE_PROTOCOL,
  nativeAdapter,
  textAdapter,
  resolveAdapter,
  // Text-protocol primitives — SINGLE SOURCE. localToolLoop re-imports these.
  DEFAULT_LOCAL_TOOLS,
  DEFAULT_LOCAL_WRITE_TOOLS,
  _resolveAllowedToolNames,
  _resolveWriteToolNames,
  _resolveWriteMode,
  selectLocalTools,
  buildSystemPrompt,
  formatToolResult,
  extractToolCalls,
  _buildAllowedNameSet,
};
