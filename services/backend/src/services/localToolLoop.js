'use strict';

/**
 * localToolLoop.js — a tool-calling loop for LOCAL mode.
 *
 * Goal "本地模式也要有自己的工具循环": local models (Ollama qwen3.5:4b, GGUF via
 * llama.cpp) have weak or no native function calling, so the main native
 * tool_use loop (toolUseLoop.js) does not fit them. This is a small, dedicated
 * driver built for weak models:
 *
 *   1. Build a compact system prompt: a CURATED low-risk tool list + a single
 *      text protocol the model can actually follow — <tool_call>{json}</tool_call>.
 *   2. Call the local model (injected `generate`) with system + running history.
 *   3. Parse tool calls from raw TEXT (reuse toolCallParser; extractFirstJson
 *      fallback). No native tool_use is assumed.
 *   4. Execute each call through the SAME guarded funnel as everything else
 *      (toolCalling.executeTool — permission/risk/audit intact).
 *   5. Append a plain-text tool-result turn and iterate, up to a hard cap.
 *   6. Stop when the model emits no tool call (that turn is the final answer).
 *
 * Everything heavy is reused; the genuinely new part is the weak-model prompt
 * and the text-feedback iteration. `generate` is dependency-injected so the
 * loop is unit-testable without a running model.
 *
 * NO-MODEL MODE ("无模型也要能用"): `generate` is OPTIONAL. When no local model
 * is available at all, the loop falls back to a deterministic, rule-based
 * planner (`makeDeterministicGenerator` → `planLocalToolCalls`) that maps the
 * user's natural-language request to curated tool calls WITHOUT any model, runs
 * them through the same guarded funnel, and presents the results directly. This
 * makes local mode genuinely usable with zero models loaded — the tool loop is
 * self-sufficient, the model is a smarter-synthesis upgrade, not a requirement.
 *
 * Constraints honored: no hardcoding (caps/allowlist via env), state honesty
 * (every tool step surfaced via onStep), bounded (iteration + per-tool timeout
 * inherited from executeTool).
 */

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_MAX_TOOLS_PER_TURN = 3;

// Text-protocol primitives now live in toolProtocolAdapter.js as the SINGLE
// SOURCE (shared with the unified main loop). Re-import them here so this
// module's deterministic no-model path keeps working and its public API stays
// stable for existing callers/tests.
const _protocolAdapter = require('./toolProtocolAdapter');
const {
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
} = _protocolAdapter;

// Ordered multi-step planning + read/write invariants (先读后写 / 先写再读).
const _planner = require('./localExecutionPlanner');
// Structured-output renderer (single source for tidy no-model output).
let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

// Curated tools that REQUIRE the network. When the caller knows it is offline,
// planning these just burns a connect timeout inside executeTool before failing,
// so the planner suppresses them and lets the request degrade immediately.
const _NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

function _intFromEnv(name, fallback, min, max) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v < min) return fallback;
  return max != null ? Math.min(v, max) : v;
}

// ── No-model deterministic planner ──────────────────────────────────────────
// Maps a natural-language request to a curated tool call using rules only — no
// model. This is what makes local mode work with zero models loaded. It is
// deliberately CONSERVATIVE: it returns a call only when an intent is clear, and
// returns [] otherwise so the caller can gracefully degrade (e.g. to web search)
// rather than firing a wrong tool. All names match the curated catalog (raw
// form); executeTool canonicalizes either form, and the loop's allowlist accepts
// both, so emitting raw names here is safe.

const _URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;

/** Pull the first path-looking token out of free text (has an extension or a separator). */
function _extractPathToken(text) {
  const m = String(text || '').match(/(~?[\w./\\@-]*[/\\][\w./\\@-]*|[\w@-]+\.[A-Za-z0-9]{1,12})/);
  return m ? m[1].replace(/[，。、,.;:]+$/, '') : null;
}

// Search-term extraction for "搜索 X" / "查找 X" / "grep X". A weak local model
// or a CJK user often glues the term directly to the verb ("搜索runLocalToolLoop",
// "查找handleClick") — the space-separated form misses those. Try, in order:
//   a) verb + whitespace + term (the canonical form),
//   b) verb + quoted term (handles spaces inside the term),
//   c) verb glued directly to an ASCII identifier.
// Deliberately NO "verb glued to CJK" form: it would falsely capture "搜索一下"
// → "一下" (a stopword), so glued matches are restricted to ASCII identifiers
// and quoted strings only.
const _SEARCH_SPACED_RE = /(?:搜索|查找|找一下|找|search|grep)\s+["'“”‘’]?([^\s"'“”‘’]{2,})/i;
const _SEARCH_GLUED_QUOTED_RE = /(?:搜索|查找|搜|找|grep|search)["'“”‘’]([^"'“”‘’]{2,})["'“”‘’]/i;
const _SEARCH_GLUED_ASCII_RE = /(?:搜索|查找|搜|找|grep|search)([A-Za-z_][\w.$/-]{1,})/i;

/** Extract a search term from a request, tolerating glued (no-space) forms. */
function _extractSearchTerm(text) {
  const m = String(text || '').match(_SEARCH_SPACED_RE)
    || String(text || '').match(_SEARCH_GLUED_QUOTED_RE)
    || String(text || '').match(_SEARCH_GLUED_ASCII_RE);
  return m ? m[1] : null;
}

/**
 * Deterministically plan curated tool calls from a user request. No model.
 * @param {string} userInput
 * @param {object} [opts]
 * @param {Set<string>} [opts.allowedSet]  if given, only emit tools in this set.
 * @param {boolean} [opts.networkUp=true]  when false, network-only tools
 *        (WebFetch/WebSearch) are suppressed — firing them while offline just
 *        burns a connect timeout before failing. Permissive default: only the
 *        caller that KNOWS it is offline should pass false.
 * @returns {Array<{name:string, params:object}>}  0..1 calls.
 */
function planLocalToolCalls(userInput, opts = {}) {
  const text = String(userInput || '').trim();
  if (!text) return [];
  const allowed = opts.allowedSet instanceof Set ? opts.allowedSet : null;
  const networkUp = opts.networkUp !== false;
  // A tool is usable iff it is in the allowlist AND (if it needs the network) we
  // are not in a known-offline state.
  const has = (n) => (!allowed || allowed.has(n)) && (networkUp || !_NETWORK_TOOLS.has(n));

  // 1. An explicit URL → fetch it. A URL is an unambiguous web intent: if
  // WebFetch is unusable (offline / not allowed), return empty rather than fall
  // through — otherwise a later rule could misread the URL as a local file path.
  const url = (text.match(_URL_RE) || [])[0];
  if (url) {
    if (!has('WebFetch')) return [];
    const prompt = text.replace(url, '').replace(/(请|帮我|总结|看看|打开|获取|内容)/g, '').trim();
    return [{ name: 'WebFetch', params: { url, prompt: prompt || '总结这个页面的主要内容' } }];
  }

  // 2. git working-tree status.
  if (has('gitStatus') &&
      ((/\bgit\b/i.test(text) && /(status|状态|未提交|工作区|暂存|staged)/i.test(text)) ||
       /(改了哪些文件|工作区状态|有哪些改动|未提交的更改|当前改动)/.test(text))) {
    return [{ name: 'gitStatus', params: {} }];
  }

  // 3. git diff.
  if (has('gitDiff') && /(git\s*diff|改动了什么|改了什么|代码差异|看.*diff|\bdiff\b)/i.test(text)) {
    return [{ name: 'gitDiff', params: {} }];
  }

  // 4. list available models.
  if (has('list_models') && /(模型列表|有哪些模型|可用模型|list\s*models|当前.*模型|支持哪些模型)/i.test(text)) {
    return [{ name: 'list_models', params: {} }];
  }

  // 5. read / view a specific file.
  if (/(看看|查看|显示|打开|读取|读一下|读下|cat\b|show\b|read\b|view\b|内容)/i.test(text)) {
    const p = _extractPathToken(text);
    if (p && (/\.[A-Za-z0-9]{1,12}$/.test(p) || /[/\\]/.test(p))) {
      if (has('Read')) return [{ name: 'Read', params: { file_path: p } }];
      if (has('readFile')) return [{ name: 'readFile', params: { path: p } }];
    }
  }

  // 6. glob: an explicit wildcard file pattern.
  const glob = (text.match(/(\*\*\/[\w./*-]+|[\w./-]*\*\.[A-Za-z0-9]{1,12}|\*\.[A-Za-z0-9]{1,12})/) || [])[0];
  if (glob && has('Glob') && /(找|查找|列出|列一下|有哪些|find|list|glob|匹配)/i.test(text)) {
    return [{ name: 'Glob', params: { pattern: glob } }];
  }

  // 7. code search ("搜索 X" / "grep X") referring to the codebase.
  const searchTerm = _extractSearchTerm(text);
  if (searchTerm && /(代码|项目|文件|代码库|源码|code|函数|定义|class|function|哪里用)/i.test(text)) {
    if (has('Grep')) return [{ name: 'Grep', params: { pattern: searchTerm, output_mode: 'files_with_matches' } }];
    if (has('search')) return [{ name: 'search', params: { keyword: searchTerm } }];
  }

  // 8. list a directory.
  if (has('LS') && /(列出目录|目录下|有哪些文件|文件列表|列一下.*文件|\bls\b)/i.test(text)) {
    const p = _extractPathToken(text);
    return [{ name: 'LS', params: p ? { path: p } : {} }];
  }

  // 9. generic codebase keyword search (no explicit "in code" qualifier).
  if (searchTerm && has('search')) {
    return [{ name: 'search', params: { keyword: searchTerm } }];
  }

  // 10. explicit online lookup. Tighten the query by segmentation ("切词"):
  // drop command/stopword noise and keep salient terms so a weak local search
  // gets a focused query instead of the whole sentence.
  if (has('WebSearch') && /(上网|联网|网上|web|网络|百度|谷歌|google|搜一下|搜索一下|查一下)/i.test(text)) {
    let q = text.replace(/(请|帮我|上网|联网|网上|搜索一下|搜一下|查一下|帮忙|一下)/g, '').trim();
    try {
      const kw = require('./localNlp').extractKeywords(q || text, { limit: 6 });
      if (kw.length) q = kw.join(' ');
    } catch { /* keep cleaned q */ }
    return [{ name: 'WebSearch', params: { query: q || text } }];
  }

  // 11. knowledge lookup.
  if (has('local_knowledge') && /(什么是|介绍一下|解释一下|是什么|相关知识|科普)/.test(text)) {
    return [{ name: 'local_knowledge', params: { query: text } }];
  }

  return [];
}

const _TOOL_RESULT_RE = /^工具结果 \[/;
const _TOOL_RESULT_HEAD_RE = /^(工具结果 \[[^\]]+\]：)\n([\s\S]*)$/;
// A tool-result body that carried no usable output: a failure, a denial, or an
// empty return. formatToolResult() is the single source of these prefixes.
const _RESULT_FAILURE_RE = /^(失败：|已被拒绝：|\(无返回\)\s*$)/;

/**
 * Strip the <tool_call>…</tool_call> protocol syntax from model text. A weak
 * model that exhausts the loop (max_iterations / no_progress) often leaves its
 * last turn as a raw, unparsed tool-call directive; without this the repl would
 * print that protocol noise verbatim to the user. Removes both well-formed
 * blocks and stray opening/closing tags, then trims.
 * @param {string} text
 * @returns {string}
 */
function stripToolCallSyntax(text) {
  if (!text) return '';
  return String(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Stable de-dup signature for a tool call. Sorts param keys so a weak model that
 * re-emits the same call with reordered keys still collapses to one signature
 * (a naive JSON.stringify would treat {a,b} and {b,a} as distinct and let the
 * loop spin). Falls back to plain stringify on any structural oddity.
 */
function _stableCallSignature(name, params) {
  const p = params && typeof params === 'object' ? params : {};
  let body;
  try {
    body = JSON.stringify(p, Object.keys(p).sort());
  } catch {
    try { body = JSON.stringify(p); } catch { body = String(p); }
  }
  return `${name}:${body}`;
}

/**
 * Compose a deterministic final answer from the tool-result turns already in the
 * running history. No model — but NOT a raw dump: each tool body is condensed
 * with extractive, query-focused summarization (localNlp), and the query's
 * segmentation is surfaced for transparency. This is the "无 AI 也能切词/总结/智能
 * 处理" path. Any <tool_call> syntax is stripped so the loop terminates instead
 * of re-firing.
 * @param {Array<{role:string,content:string}>} messages
 * @param {string} [userQuery]
 */
function _composeDeterministicAnswer(messages, userQuery) {
  const list = Array.isArray(messages) ? messages : [];
  const blocks = list
    .filter(m => m && m.role === 'user' && _TOOL_RESULT_RE.test(String(m.content || '')))
    .map(m => String(m.content));
  if (!blocks.length) return '';

  // Honesty gate: if EVERY tool result was a failure/denial/empty return, there
  // is no real content to present. Returning a confident-looking header over a
  // "失败：…" body would dress a failure up as an answer (and the repl renders it
  // as a success step). Return '' instead so the caller degrades gracefully
  // (web search → capability menu). A single usable result is enough to proceed.
  const anyUsable = blocks.some(raw => {
    const m = raw.match(_TOOL_RESULT_HEAD_RE);
    const body = (m ? m[2] : raw).replace(/<\/?tool_call>/gi, '').trim();
    return body && !_RESULT_FAILURE_RE.test(body);
  });
  if (!anyUsable) return '';

  // The query is the first non-tool-result user turn (the original request).
  const query = String(userQuery
    || (list.find(m => m && m.role === 'user' && !_TOOL_RESULT_RE.test(String(m.content || '')))?.content)
    || '');

  let nlp = null;
  try { nlp = require('./localNlp'); } catch { /* degrade to raw */ }

  const maxChars = _intFromEnv('KHY_LOCAL_DIGEST_MAXLEN', 600, 120);
  const maxSentences = _intFromEnv('KHY_LOCAL_DIGEST_SENTENCES', 3, 1, 10);

  const parts = ['（本地确定性工具循环 · 无模型）'];
  if (nlp && query) {
    const kw = nlp.extractKeywords(query, { limit: 6 });
    if (kw.length) parts.push(`切词: ${kw.join(' / ')}`);
  }
  parts.push('');

  for (const raw of blocks) {
    const clean = raw.replace(/<\/?tool_call>/gi, '');
    const m = clean.match(_TOOL_RESULT_HEAD_RE);
    if (!m || !nlp) { parts.push(clean, ''); continue; }
    const header = m[1];
    const digest = nlp.summarize(m[2], { query, maxSentences, maxChars });
    parts.push(header, digest, '');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Build a model-free `generate`-shaped function that drives the loop
 * deterministically. Two planning modes:
 *
 *   • ORDERED multi-step (先读后写 / 先写再读): when the request is an explicit
 *     compound op (edit-with-replacement, create/write-with-content[+verify]),
 *     localExecutionPlanner emits an ordered step list whose read/write order is
 *     ENFORCED (a missing prior-Read is spliced in; a verify-read stays after its
 *     write). The generator walks that queue ONE step per turn, indexed by how
 *     many tool-result turns have already accrued — so ordering is strict and
 *     each step sees the previous step's result.
 *
 *   • SINGLE call: otherwise fall back to planLocalToolCalls (0..1 call), the
 *     original conservative behavior.
 *
 * The synthesis turn presents collected results (structured when possible).
 * Drop-in replacement for a real model so the loop machinery is reused verbatim.
 *
 * @param {object} [opts]
 * @param {Set<string>} [opts.allowedSet]
 * @param {boolean} [opts.networkUp=true]  forwarded to planLocalToolCalls.
 * @param {boolean} [opts.writeEnabled=false]  when false, ordered plans that
 *        contain a write/edit step are suppressed (the no-model path stays
 *        read-only unless the write tier is explicitly active upstream).
 * @param {(absFile:string)=>boolean} [opts.fileExists]  injected for the planner.
 * @returns {(prompt:string, genOpts:object)=>Promise<{success:boolean, content:string}>}
 */
function makeDeterministicGenerator(opts = {}) {
  const allowedSet = opts.allowedSet instanceof Set ? opts.allowedSet : null;
  const networkUp = opts.networkUp !== false;
  const writeEnabled = !!opts.writeEnabled;
  const fileExists = typeof opts.fileExists === 'function' ? opts.fileExists : undefined;

  // Plan the ordered queue once, lazily, on the first turn (the prompt is stable
  // across turns). Cached in closure so step indexing is consistent.
  let orderedQueue = null;   // Array<step> once resolved; [] = not an ordered intent.
  let planned = false;

  const resolveQueue = (prompt) => {
    if (planned) return orderedQueue;
    planned = true;
    orderedQueue = [];
    try {
      const plan = _planner.planOrderedSteps(prompt, { allowedSet });
      if (plan && Array.isArray(plan.steps) && plan.steps.length > 1) {
        const enforced = _planner.enforceReadWriteOrder(plan.steps, {
          fileExists,
          canonicalReadName: !!(allowedSet && !allowedSet.has('Read') && allowedSet.has('readFile')),
        });
        let steps = enforced.steps;
        // Write tier gate: if writes aren't enabled, drop the whole ordered plan
        // (a half-plan that reads but never writes would mislead). Fall back to
        // the single-call read-only planner instead.
        const hasMutation = steps.some(s => _planner._isMutation(s.name));
        if (hasMutation && !writeEnabled) {
          orderedQueue = [];
        } else {
          orderedQueue = steps;
        }
      }
    } catch { orderedQueue = []; }
    return orderedQueue;
  };

  return async function deterministicGenerate(prompt, genOpts = {}) {
    const messages = Array.isArray(genOpts.messages) ? genOpts.messages : [];
    const resultTurns = messages.filter(m => m && m.role === 'user' && _TOOL_RESULT_RE.test(String(m.content || ''))).length;

    const queue = resolveQueue(prompt);

    // ORDERED path: emit the step at index = number of results gathered so far.
    if (queue.length) {
      if (resultTurns < queue.length) {
        const step = queue[resultTurns];
        return { success: true, content: `<tool_call>${JSON.stringify({ name: step.name, params: step.params })}</tool_call>` };
      }
      // All ordered steps done → synthesize.
      return { success: true, content: _composeDeterministicAnswer(messages, prompt) };
    }

    // SINGLE-call path (original behavior).
    if (resultTurns === 0) {
      const calls = planLocalToolCalls(prompt, { allowedSet, networkUp });
      if (calls.length) {
        return { success: true, content: calls.map(c => `<tool_call>${JSON.stringify(c)}</tool_call>`).join('\n') };
      }
      return { success: true, content: '' };
    }
    return { success: true, content: _composeDeterministicAnswer(messages, prompt) };
  };
}

/**
 * Resolve the final text for a loop that exited WITHOUT a clean final answer
 * (max_iterations / no_progress / generate_error). The model's last turn is
 * often raw <tool_call> syntax or an empty string — never show that. Prefer a
 * deterministic synthesis from the tool results already gathered this run; if
 * none were gathered, fall back to the last model text with protocol syntax
 * stripped. Applies in BOTH modes (deterministic already produces clean text,
 * but model mode is where the leak happens).
 * @param {Array<{role:string,content:string}>} messages
 * @param {string} lastText
 * @param {string} userInput
 */
function _resolveExhaustedFinalText(messages, lastText, userInput) {
  const hasResults = (Array.isArray(messages) ? messages : [])
    .some(m => m && m.role === 'user' && _TOOL_RESULT_RE.test(String(m.content || '')));
  if (hasResults) {
    const synth = _composeDeterministicAnswer(messages, userInput);
    if (synth) return synth;
  }
  return stripToolCallSyntax(lastText);
}

/**
 * Classify a tool into an execution PHASE for structured rendering. Mirrors the
 * planner's phase vocabulary so rule-planned and model-emitted calls render under
 * consistent section headings.
 */
function _phaseForTool(name) {
  if (_planner._isRead(name)) return 'read';
  if (_planner._isMutation(name)) return 'write';
  if (/^(Grep|grep|Glob|glob|LS|search|local_knowledge|list_models)$/.test(name)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'fetch';
  if (/^git/i.test(name)) return 'search';
  return 'tool';
}

const _PHASE_LABEL = {
  read: '读取',
  search: '搜索',
  fetch: '联网',
  write: '写入',
  verify: '验证',
  tool: '执行',
};

/** Collapse one tool result to a compact, query-focused digest for a section body. */
function _digestStructured(name, result, query) {
  if (result == null) return '（无返回）';
  if (result.denied) return `已被拒绝：${result.error || '权限不足'}`;
  if (result.success === false) return `失败：${result.error || '未知错误'}`;

  // Known structured shapes from the curated read/search tools.
  if (Array.isArray(result.files)) {
    if (!result.files.length) return '无匹配文件';
    return result.files.slice(0, 12).map(f => `- ${f}`).join('\n')
      + (result.truncated ? '\n- …（已截断）' : '');
  }
  if (Array.isArray(result.matches)) {
    if (!result.matches.length) return '无匹配';
    return result.matches.slice(0, 12).map(m =>
      typeof m === 'string' ? `- ${m}` : `- ${m.file || ''}${m.line != null ? ':' + m.line : ''}  ${String(m.content || '').trim()}`
    ).join('\n') + (result.truncated ? '\n- …（已截断）' : '');
  }
  if (Array.isArray(result.counts)) {
    return result.counts.slice(0, 12).map(c => `- ${c.file}: ${c.count}`).join('\n');
  }

  const out = result.output != null ? result.output : result.content;
  if (out == null) {
    // Success with no payload (typical for a write/edit): report the effect, not raw JSON.
    const bits = [];
    if (result.path || result.file) bits.push(String(result.path || result.file));
    if (result.bytesWritten != null) bits.push(`${result.bytesWritten} 字节`);
    if (result.changed != null) bits.push(result.changed ? '内容已变更' : '内容未变化');
    return bits.length ? `已完成：${bits.join(' · ')}` : '已完成';
  }
  let body = typeof out === 'string' ? out : JSON.stringify(out);
  body = String(body);
  // Query-focused extractive condense for long prose bodies.
  if (body.length > 400) {
    try {
      const nlp = require('./localNlp');
      const d = nlp.summarize(body, { query: query || '', maxSentences: 3, maxChars: 400 });
      if (d) body = d;
    } catch { body = body.slice(0, 400) + '…'; }
  }
  return body;
}

/**
 * Render the captured ordered structured steps into the unified localFormat
 * structure (# 标题 + per-step ## 阶段 section + meta). This is "获取结构化数据再
 * 渲染": each step's raw structured result is condensed under a phase-labelled
 * heading, in execution order, so the read→write→verify story is legible. Returns
 * '' when localFormat is unavailable/disabled or there is nothing usable.
 * @param {Array<{name,params,phase,result}>} steps
 * @param {string} query
 */
function renderStructuredSteps(steps, query) {
  if (!_fmt || !_fmt.isEnabled()) return '';
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  if (!list.length) return '';

  const usable = list.some(s => s.result && s.result.denied !== true && s.result.success !== false);
  if (!usable) return '';

  const sections = list.map((s, i) => {
    const phase = s.phase || _phaseForTool(s.name);
    const label = _PHASE_LABEL[phase] || '执行';
    const file = _planner._stepFile(s);
    const target = file ? ` ${file}` : (s.params && s.params.pattern ? ` "${s.params.pattern}"` : '');
    return {
      heading: `第 ${i + 1} 步 · ${label} · ${s.name}${target}`,
      body: _digestStructured(s.name, s.result, query),
    };
  });

  const okCount = list.filter(s => s.result && s.result.success !== false && !s.result.denied).length;
  return _fmt.compose({
    title: '本地顺序执行结果',
    sections,
    meta: [`${list.length} 步`, `成功 ${okCount}`, '确定性工具循环'],
    footer: '步骤按依赖顺序执行（先读后写 / 先写再读），结果为工具原始结构化数据，未经模型改写。',
  });
}

/**
 * Run the local tool loop.
 *
 * @param {string} userInput            the user's request
 * @param {object} opts
 * @param {(prompt:string, options:object) => Promise<{success:boolean, content:string, tokenUsage?:object}>} [opts.generate]
 *        injected local-model generation (e.g. a wrapper over
 *        gateway.generateWithSubModel). MUST accept { system, messages }.
 *        OPTIONAL: when omitted, a deterministic no-model planner drives the
 *        loop instead ("无模型也要能用").
 * @param {Array} [opts.toolDefinitions] full tool defs (defaults to
 *        toolCalling.getToolDefinitions()).
 * @param {(name:string, params:object, traceContext:object)=>Promise<object>} [opts.executeTool]
 *        defaults to toolCalling.executeTool.
 * @param {object} [opts.traceContext]  forwarded to executeTool (sessionId, onControlRequest…).
 * @param {number} [opts.maxIterations]
 * @param {(ev:object)=>void} [opts.onStep] state-transparency hook:
 *        {type:'model'|'tool'|'final', ...}.
 * @param {boolean} [opts.networkUp=true] when false, the deterministic planner
 *        suppresses network-only tools (WebFetch/WebSearch) so an offline
 *        request degrades immediately instead of burning a connect timeout.
 *        Ignored in model mode (the model decides). Permissive default.
 * @returns {Promise<{finalText:string, iterations:number, toolCalls:Array, stopReason:string, mode:string}>}
 */
async function runLocalToolLoop(userInput, opts = {}) {
  const execTool = typeof opts.executeTool === 'function'
    ? opts.executeTool
    : (name, params, tc) => require('./toolCalling').executeTool(name, params, tc);
  const allDefs = Array.isArray(opts.toolDefinitions)
    ? opts.toolDefinitions
    : (() => { try { return require('./toolCalling').getToolDefinitions(); } catch { return []; } })();

  // generate is OPTIONAL: with no model, drive the loop deterministically.
  const mode = typeof opts.generate === 'function' ? 'model' : 'deterministic';

  // Opt-in write/shell delivery tier. Authoring arbitrary file content from a
  // free-text instruction requires a model — so MODEL mode keeps the original
  // gate (write tier on only when _resolveWriteMode says so). DETERMINISTIC mode
  // never *infers* content, but the ordered planner can emit a write whose
  // content is EXPLICIT in the request (e.g. 「创建 a.txt 内容为 …」 / 「把 X 改成 Y」);
  // that is deterministic, not authoring, so the write tier is allowed in no-model
  // mode under the SAME _resolveWriteMode gate. Every write still passes
  // executeTool's approval gate downstream.
  const hasApprovalChannel = typeof (opts.traceContext && opts.traceContext.onControlRequest) === 'function';
  const writeEnabled = _resolveWriteMode({ hasApprovalChannel });

  const allowed = _resolveAllowedToolNames();
  if (writeEnabled) {
    for (const n of _resolveWriteToolNames()) {
      if (!allowed.includes(n)) allowed.push(n);
    }
  }
  const defs = selectLocalTools(allDefs, allowed);
  const system = buildSystemPrompt(defs, { writeEnabled });
  // The catalog uses raw registry names (Read, Grep), but extractToolCalls runs
  // text through toolCallParser which CANONICALIZES (Read→readFile, Grep→grep).
  // Build the allowlist from both forms so a canonical parsed call still matches
  // its raw catalog entry. executeTool resolves either form, so this is safe.
  const allowedSet = _buildAllowedNameSet(defs);
  const generate = mode === 'model'
    ? opts.generate
    : makeDeterministicGenerator({
        allowedSet,
        networkUp: opts.networkUp !== false,
        writeEnabled,
        fileExists: typeof opts.fileExists === 'function' ? opts.fileExists : undefined,
      });

  const maxIterations = Number.isFinite(opts.maxIterations) && opts.maxIterations > 0
    ? opts.maxIterations
    : _intFromEnv('KHY_LOCAL_LOOP_MAX_ITERATIONS', DEFAULT_MAX_ITERATIONS, 1, 20);
  const maxToolsPerTurn = _intFromEnv('KHY_LOCAL_LOOP_MAX_TOOLS_PER_TURN', DEFAULT_MAX_TOOLS_PER_TURN, 1, 10);
  const resultCap = _intFromEnv('KHY_LOCAL_LOOP_RESULT_MAXLEN', 2000, 200);
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const traceContext = opts.traceContext || {};

  const messages = [{ role: 'user', content: String(userInput || '') }];
  const allToolCalls = [];
  // Ordered structured capture: every executed tool's raw structured result with
  // its phase tag, in execution order. This is the "结构化数据" the renderer turns
  // into the unified localFormat output. A read that lands AFTER a write of the
  // same file is re-tagged 'verify' (先写再读) rather than 'read'.
  const structuredSteps = [];
  const _writtenFiles = new Set();
  let lastText = '';
  // De-dup guard: a weak model can loop on the same call forever.
  const seenCalls = new Set();

  // In deterministic (no-model) mode, the unified structured render of the ordered
  // steps is the authoritative answer when available; the synthesized prose stays
  // as the fallback. In model mode we never override the model's own final text.
  const _finalize = (text) => {
    if (mode !== 'model') {
      const structured = renderStructuredSteps(structuredSteps, userInput);
      if (structured) return structured;
    }
    return text;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    onStep({ type: 'model', iteration });
    let res;
    try {
      res = await generate(String(userInput || ''), { system, messages, _localToolLoop: true });
    } catch (e) {
      return { finalText: _resolveExhaustedFinalText(messages, lastText, userInput), iterations: iteration - 1, toolCalls: allToolCalls, stopReason: `generate_error:${e.message}`, mode };
    }
    const text = res && res.content != null ? String(res.content) : '';
    lastText = text || lastText;
    messages.push({ role: 'assistant', content: text });

    const parsed = extractToolCalls(text);
    // Keep only allowed tools; an out-of-allowlist call is treated as no call
    // (the text becomes the answer) rather than silently executed.
    const calls = parsed
      .filter(c => c && allowedSet.has(c.name))
      .slice(0, maxToolsPerTurn);

    if (calls.length === 0) {
      const out = _finalize(text);
      onStep({ type: 'final', iteration, text: out });
      return { finalText: out, iterations: iteration, toolCalls: allToolCalls, stopReason: 'final_answer', mode };
    }

    let progressed = false;
    for (const call of calls) {
      const sig = _stableCallSignature(call.name, call.params);
      if (seenCalls.has(sig)) {
        messages.push({ role: 'user', content: formatToolResult(call.name, { success: false, error: '重复调用同一工具，请改用已获得的结果作答。' }, resultCap) });
        continue;
      }
      seenCalls.add(sig);
      progressed = true;
      onStep({ type: 'tool', iteration, name: call.name, params: call.params });
      let result;
      try {
        result = await execTool(call.name, call.params || {}, traceContext);
      } catch (e) {
        result = { success: false, error: e.message };
      }
      allToolCalls.push({ name: call.name, params: call.params, success: !!(result && result.success !== false && !result.denied) });
      onStep({ type: 'tool_result', iteration, name: call.name, result });
      // Capture structured result + phase. A read of a file already written this
      // session is a verify-read (先写再读), not a prior-read.
      let phase = _phaseForTool(call.name);
      const stepFile = _planner._stepFile({ name: call.name, params: call.params || {} });
      if (phase === 'read' && stepFile && _writtenFiles.has(_planner._normFile(stepFile))) {
        phase = 'verify';
      }
      if (phase === 'write' && stepFile) _writtenFiles.add(_planner._normFile(stepFile));
      structuredSteps.push({ name: call.name, params: call.params || {}, phase, result });
      messages.push({ role: 'user', content: formatToolResult(call.name, result, resultCap) });
    }

    // Every call this turn was a repeat → stop to avoid burning iterations.
    if (!progressed) {
      const out = _finalize(_resolveExhaustedFinalText(messages, lastText, userInput));
      onStep({ type: 'final', iteration, text: out });
      return { finalText: out, iterations: iteration, toolCalls: allToolCalls, stopReason: 'no_progress', mode };
    }
  }

  const exhausted = _finalize(_resolveExhaustedFinalText(messages, lastText, userInput));
  return { finalText: exhausted, iterations: maxIterations, toolCalls: allToolCalls, stopReason: 'max_iterations', mode };
}

module.exports = {
  runLocalToolLoop,
  buildSystemPrompt,
  selectLocalTools,
  extractToolCalls,
  formatToolResult,
  planLocalToolCalls,
  makeDeterministicGenerator,
  stripToolCallSyntax,
  renderStructuredSteps,
  _phaseForTool,
  _digestStructured,
  DEFAULT_LOCAL_TOOLS,
  DEFAULT_LOCAL_WRITE_TOOLS,
  _resolveAllowedToolNames,
  _resolveWriteToolNames,
  _resolveWriteMode,
};
