'use strict';

/**
 * queryBridgeTimeline — pure, React-free turn-timeline + tool-narration helpers
 * extracted from useQueryBridge (god-file split · DESIGN-ARCH-051 lineage, same
 * paradigm as localBrainCalc/localBrainProviderConfig). A turn is modeled as an
 * ordered [{type:'text'|'thinking'|'tool', ...}] timeline; these functions derive
 * the committed/live split and the per-tool + task-level narration beats. They
 * touch NO React state — every input is explicit — so they are unit-testable
 * without mounting the hook, and useQueryBridge re-imports them by the SAME names
 * to keep its contract byte-identical (见宿主下方 re-export 段)。fail-soft to plain
 * behavior when an optional voice/format leaf is unavailable.
 */
const { summarizeToolResult } = require('../../toolResultSummary');
const _timelineAppendMerge = require('../timelineAppendMerge');
let _toolPrefaceVoice;
try { _toolPrefaceVoice = require('../../toolPrefaceVoice'); } catch { _toolPrefaceVoice = null; }

// ── Ordered turn timeline helpers ──
// A turn is modeled as an ordered list of segments preserving the REAL
// interleaving of streamed text and tool steps:
//   { type:'text', text }  |  { type:'tool', tool }
// This is the source of truth for both the live preview (StreamingBlock tail)
// and the committed transcript (MessageBlock), so a multi-iteration tool loop
// keeps text↔tool order instead of being flattened to "all text, then all
// tools". The parallel `text`/`tools` fields are kept for finalText fallback,
// the shell-peek view, and the LAN bridge.

// Append streamed text: extend the trailing text segment, or open a new one if
// the last segment is a tool (so post-tool text starts a fresh, correctly
// ordered block).
function tlAppendText(timeline, text) {
  // 尾部同型合并经纯叶子单次分配(门控关 → 历史双分配,逐字节回退)。
  return _timelineAppendMerge.appendMergingLast(timeline, text, 'text', process.env);
}

function tlPushTool(timeline, tool) {
  return [...timeline, { type: 'tool', tool }];
}

// Split an OPEN (still-streaming) text segment into a committed-safe `sealed`
// prefix and the in-flight `live` remainder, cutting ONLY at a markdown
// structure boundary so a fragment is never committed mid-structure.
//
// The single safe cut point is a BLANK line that is not inside a fenced code
// block. This also covers tables and lists for free: a markdown table/loose
// list is terminated by a blank line and never CONTAINS one, so cutting at a
// blank line can never split a table row or a fence. Fenced code blocks DO
// contain blank lines, so they are tracked and their interior blanks are
// excluded as boundaries. An unterminated/last line is never a boundary (it is
// still streaming). Char-offset based so `sealed + live === text` exactly — the
// no-loss invariant the finalize drain relies on.
//
// Returns { sealed:'', live:text } when there is no safe boundary yet (the
// whole segment stays live), so callers can no-op cheaply on every newline.
//
// ── J1 软封边界(门控 KHY_TUI_SOFT_SEAL,默认开)────────────────────────────
// 病根(TUI 卡顿):一个持续增长、**内部没有空行**的开放文本段(长段落 / 长列表 / 无空行
// 的长内容)永远整段是 `live`,每帧被全量重规范化(markdown → 可视行)→ O(n²) 卡顿;
// lazy-norm 只冻结已封存前缀,救不了这个不封存的长尾。
// 修复:同一遍扫描里额外记录「软边界」——**两行都是纯散文行**(非 fence / 表格 / 列表 /
// 引用 / 标题 / 缩进码 / 分隔线)之间的终止换行。在这种边界切割最多把一个 markdown 段落
// 拆成两段(视觉上尾部回流,纯外观),**绝不**劈开表格行 / 列表项 / 代码围栏等多行结构。
// 仅当空行边界缺失(或空行后的活跃尾部仍超阈值)且段长 > KHY_TUI_SOFT_SEAL_CHARS(默认 2000)
// 时才回退到软边界;门关 / 未超阈值 → 与旧逻辑逐字节等价(sealed + live === text 恒成立)。
// 诚实边界:纯粹的巨型代码围栏(内部无空行)无法安全切割 → 软边界只封到围栏起点,围栏本体
// 仍整段 live(markdown 不允许把围栏劈成两个代码块)。绝大多数卡顿是长散文/混排,已覆盖。
const _SOFT_SEAL_OFF = new Set(['0', 'false', 'off', 'no']);
const _SOFT_SEAL_DEFAULT_CHARS = 2000;

function _isSoftSealEnabled(env) {
  return !_SOFT_SEAL_OFF.has(String((env && env.KHY_TUI_SOFT_SEAL) || '').trim().toLowerCase());
}

function _softSealThreshold(env) {
  const n = Number.parseInt(String((env && env.KHY_TUI_SOFT_SEAL_CHARS) || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : _SOFT_SEAL_DEFAULT_CHARS;
}

// 一行是否是「纯散文行」:非空、且不带任何会跨行绑定的 markdown 结构标记。
// 保守取舍:只要疑似结构(表格竖线 / 列表 / 引用 / 标题 / 缩进码 / 分隔线)一律判非纯散文,
// 宁可不在此切割,也绝不劈开结构。
function _isPlainProseLine(rawLine) {
  if (rawLine == null) return false;
  const trimmed = rawLine.trim();
  if (trimmed === '') return false;                       // 空行走既有主路径
  if (/^\s{4,}/.test(rawLine) || rawLine.startsWith('\t')) return false; // 缩进码/续行
  if (rawLine.includes('|')) return false;                // 表格行(含转义竖线也保守排除)
  if (/^([-*+]\s|\d{1,9}[.)]\s)/.test(trimmed)) return false; // 无序/有序列表项
  if (trimmed.startsWith('>')) return false;              // 引用块
  if (/^#{1,6}\s/.test(trimmed)) return false;            // ATX 标题
  if (/^[-=_*]{2,}[\s]*$/.test(trimmed)) return false;    // 分隔线 / setext 下划线
  if (/^(`{3,}|~{3,})/.test(trimmed)) return false;       // fence 定界(另有 inFence 跟踪)
  return true;
}

function splitSealedText(text, env = process.env) {
  if (!text) return { sealed: '', live: text || '' };
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  let offset = -1; // char index just past the last safe blank-line boundary
  let softOffset = -1; // char index just past the last plain-prose↔plain-prose boundary
  let pos = 0; // running char index at the start of the current line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const hasNewline = i < lines.length - 1; // the last line has no trailing \n
    const lineEnd = pos + line.length + (hasNewline ? 1 : 0);
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar) { inFence = false; fenceChar = ''; }
    } else if (!inFence && trimmed === '' && hasNewline) {
      // A terminated blank line outside any fence — safe to seal up to here.
      offset = lineEnd;
    } else if (!inFence && hasNewline
      && _isPlainProseLine(line) && _isPlainProseLine(lines[i + 1])) {
      // 软边界:当前行与下一行都是纯散文行,且当前行已终止(有换行)、都在 fence 外。
      // 在此切割至多把一个段落拆成两段(外观级),绝不劈开任何多行结构。
      softOffset = lineEnd;
    }
    pos = lineEnd;
  }
  // 主路径:空行边界(历史行为,恒优先)。
  if (offset > 0) {
    // 软扩展:空行后的活跃尾部仍然过长且存在更靠后的软边界 → 进一步封存以封顶 live 段长度。
    if (_isSoftSealEnabled(env) && softOffset > offset
      && (text.length - offset) > _softSealThreshold(env)) {
      return { sealed: text.slice(0, softOffset), live: text.slice(softOffset) };
    }
    return { sealed: text.slice(0, offset), live: text.slice(offset) };
  }
  // 无空行边界:仅当门开、段长超阈值且存在软边界时,回退到软封存。
  if (_isSoftSealEnabled(env) && softOffset > 0 && text.length > _softSealThreshold(env)) {
    return { sealed: text.slice(0, softOffset), live: text.slice(softOffset) };
  }
  return { sealed: '', live: text };
}

// Pure planner for flushCompletedStages: decide how much of the live timeline
// to commit, with no side effects. Returns { k, sealed } where:
//   k      — number of leading WHOLE segments that are COMPLETED (a tool with a
//            result, or a text segment that is no longer the open tail) and can
//            be drained to scrollback. On `force`, the entire timeline.
//   sealed — a markdown-safe prefix of the OPEN trailing text segment to commit
//            progressively (Phase 1.1), '' when there is none. Only on a
//            non-force, non-paused flush whose stop point is the last text
//            segment; this is what lets long prose appear incrementally instead
//            of all at finalize.
// Extracted + exported so the drain decision is unit testable without mounting
// the React hook (the hook keeps the setMessages/liveRef side effects).
function planStageFlush(timeline, { force = false, sealTrailing = false } = {}) {
  const tl = Array.isArray(timeline) ? timeline : [];
  if (tl.length === 0) return { k: 0, sealed: '' };
  let k;
  if (force) {
    k = tl.length;
  } else {
    k = 0;
    while (k < tl.length) {
      const e = tl[k];
      const isLast = k === tl.length - 1;
      if (e.type === 'tool') {
        if (e.tool && e.tool.result) { k++; continue; }
        break; // pending tool: keep it and everything after in the live region
      } else {
        if (!isLast) { k++; continue; } // sealed text segment (a tool follows)
        // Open trailing text normally stays live; `sealTrailing` (turn paused on
        // a control request) commits it so it is not folded behind the overlay.
        if (sealTrailing) { k++; continue; }
        break;
      }
    }
  }
  let sealed = '';
  if (!force && !sealTrailing && k === tl.length - 1) {
    const e = tl[k];
    if (e && e.type === 'text') sealed = splitSealedText(e.text).sealed;
  }
  return { k, sealed };
}

// Format the real context-compaction result into a single scrollback line.
// Reads the {tokensBefore, tokensAfter, durationMs} the backend reports on the
// `compacted` status event. Returns '' when there is nothing meaningful to show
// (no numbers, or the "after" did not actually drop below "before").
function formatCompactionResult(evt) {
  const before = Number(evt && evt.tokensBefore) || 0;
  const after = Number(evt && evt.tokensAfter) || 0;
  if (before <= 0 || after <= 0 || after >= before) return '';
  // CC 后端口径对齐:已提交的压缩结果行 token 数走与进度条(CompactionProgress ⑦)同一个
  // ccFormatTokens SSOT(去尾随 ".0":24000→"24k")。门控 KHY_COMPACTION_CC_TOKENS(默认开,
  // 与进度条共用同一门控,因二者同属「压缩 token 显示」家族);关 → 逐字节回退旧 toFixed(1)。
  //   ccFormat require 包在 try 里,异常静默回退,绝不让结果行渲染抛错。
  const _ccTok = (() => {
    const v = String(process.env.KHY_COMPACTION_CC_TOKENS || '').trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
    try { const f = require('../../ccFormat').ccFormatTokens; return typeof f === 'function' ? f : null; }
    catch { return null; }
  })();
  const fmtK = (n) => (_ccTok ? _ccTok(n) : (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)));
  // CC 后端口径对齐:压缩结果行的「耗时」走与进度条(CompactionProgress formatElapsed)
  // 同一个 ccFormatDuration SSOT + 同一门控 KHY_COMPACTION_CC_FORMAT(二者同属「压缩时长
  // 显示」家族,与上方 token 侧的 KHY_COMPACTION_CC_TOKENS 对称)。此前本行裸 toFixed(1) 是
  // 漏接的孤儿:同一次压缩,进度条已显 "1m 5s" 而本结果行显 "65.0s"(同一事件两种时长格式)。
  //   门控开 → ccFormatDuration(带 h/m/s 进位);关 / require 异常 → 逐字节回退旧 toFixed(1)。
  const _ccDur = (() => {
    const v = String(process.env.KHY_COMPACTION_CC_FORMAT || '').trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return null;
    try { const f = require('../../ccFormat').ccFormatDuration; return typeof f === 'function' ? f : null; }
    catch { return null; }
  })();
  const saved = before - after;
  const durMs = Number(evt && evt.durationMs) || 0;
  const _durLegacy = `${(durMs / 1000).toFixed(1)}s`;
  const dur = durMs > 0 ? ` · ${_ccDur ? (_ccDur(durMs) || _durLegacy) : _durLegacy}` : '';
  return `✻ 已压缩上下文：${fmtK(before)} → ${fmtK(after)} tokens（节省 ${fmtK(saved)}${dur}）`;
}

// Append streamed thinking as its OWN segment so the committed transcript can
// preserve it (folded) in real interleaved order. The live preview shows the
// aggregate `streaming.thinking` tail separately, so StreamingBlock ignores
// these timeline entries — they exist purely so thinking survives in scrollback
// instead of being discarded when the turn finalizes.
function tlAppendThinking(timeline, text) {
  // 尾部同型合并经纯叶子单次分配(门控关 → 历史双分配,逐字节回退)。
  return _timelineAppendMerge.appendMergingLast(timeline, text, 'thinking', process.env);
}

// Submit busy gate (pure helper): the visible status is React state and the
// statusRef mirror only updates on the next commit/effect. A duplicated Enter can
// therefore arrive while statusRef still reads 'idle' even though _runSubmit has
// already started synchronously. `inFlight` is the immediate, non-React lock for
// that gap. Once the turn has settled, `inFlight` drops and `done` keeps the
// historical affordance that a follow-up can be sent immediately.
function submitGateBusy(status, inFlight) {
  if (inFlight) return true;
  const s = String(status || '');
  return s !== 'idle' && s !== 'done';
}

// Stamp the REAL thinking duration onto the most recent (just-ended) thinking run
// so the committed transcript can show "💭 思考 Ns" (CC's "Thought for Ns"). The
// duration is the wall-clock between the run's first thinking chunk and the first
// non-thinking chunk that ended it — captured in onChunk, never fabricated. Only
// the last un-stamped thinking entry is touched, so interleaved thinking runs each
// keep their own duration. No-op when there is no thinking entry or it is stamped.
function tlStampThinkingDuration(timeline, durationMs) {
  if (!Array.isArray(timeline) || !(Number(durationMs) > 0)) return timeline;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === 'thinking') {
      if (timeline[i].durationMs != null) return timeline; // already stamped
      const copy = timeline.slice();
      copy[i] = { ...copy[i], durationMs: Number(durationMs) };
      return copy;
    }
  }
  return timeline;
}

// Resolve whether the CURRENTLY active model should self-render (T0/T1 strong
// models, trusted to format their own output → no structural normalization) or
// be assisted (T2/T3 small/unknown models → output normalized to a uniform shape
// so messy small-model streams display cleanly). Resolved once per turn and
// stamped onto the streaming state + each committed message, so every message
// renders according to the model that produced it. Defaults to false (assist)
// when the model can't be determined — the safe choice, since normalization only
// cleans and never alters well-formed markdown.
function resolveSelfRender() {
  try {
    const { shouldSelfRender } = require('../../../services/modelTier');
    let model = process.env.GATEWAY_PREFERRED_MODEL || '';
    try {
      const gw = require('../../../services/gateway/aiGateway');
      const adapter = typeof gw.getActiveAdapter === 'function' ? gw.getActiveAdapter() : null;
      if (adapter && adapter.activeModel) model = adapter.activeModel;
    } catch { /* gateway not ready: fall back to env / empty */ }
    return shouldSelfRender(model);
  } catch {
    return false;
  }
}

// Brief one-line summary of a tool's input for the decision history entry.
function summarizeControlInput(input) {
  if (input == null) return '';
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { return String(input).replace(/\s+/g, ' ').trim().slice(0, 60); }
  }
  if (typeof obj !== 'object') return String(obj).slice(0, 60);
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    if (obj[k]) return String(obj[k]).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  const keys = Object.keys(obj);
  return keys.length ? keys.join(', ').slice(0, 60) : '';
}

// Build a committed-history record from a settled control request so the
// decision (approve/deny) or the question + chosen answer stays visible in
// scrollback after the overlay clears. Returns null when there is nothing to
// record. Pure helper — no React state access.
function buildDecisionRecord(req, answer, now) {
  if (!req) return null;
  const r = (req && req.request) ? req.request : req;
  const tool = (r && (r.tool_name || r.tool)) || 'tool';
  const isQuestion = String((r && r.subtype) || '').toLowerCase() === 'can_use_tool'
    && String(tool).toLowerCase().replace(/[\s_-]/g, '') === 'askuserquestion';

  if (isQuestion) {
    const answers = answer && answer.behavior === 'allow'
      && answer.updatedInput && answer.updatedInput.answers;
    if (answers && typeof answers === 'object') {
      const qa = Object.entries(answers).map(([question, choice]) => ({
        question: String(question),
        choice: Array.isArray(choice) ? choice.join(', ') : String(choice),
      }));
      if (qa.length) return { role: 'qa', qa, timestamp: now };
    }
    return { role: 'qa', cancelled: true, timestamp: now };
  }

  // Permission decision: answer is true | false | 'always' | {behavior:'discuss'}.
  const behavior = answer && typeof answer === 'object' ? String(answer.behavior || '').toLowerCase() : '';
  const decision = behavior === 'discuss' ? 'discuss'
    : answer === false ? 'deny'
    : (answer === 'always' ? 'always' : 'allow');
  return {
    role: 'decision',
    decision,
    tool: String(tool),
    argSummary: summarizeControlInput(r && r.input),
    timestamp: now,
  };
}

// Attach a result to the FIRST unresolved tool entry matching `predicate`
// (mirrors the de-dupe rule used for the flat `tools` array).
function tlResolveTool(timeline, predicate, result) {
  let done = false;
  return timeline.map((e) => {
    if (!done && e.type === 'tool' && !e.tool.result && predicate(e.tool)) {
      done = true;
      return { type: 'tool', tool: { ...e.tool, result } };
    }
    return e;
  });
}

// Pure preface decision (Issue B「先说要做什么，再执行」), extracted from the hook
// closure so the gating is unit-testable without mounting React. Returns the
// narration to inject AHEAD of a tool, or '' to stay silent. Silent when:
//   - disabled via KHY_TOOL_PREFACE=0
//   - the model's OWN segment text already names THIS tool's action (批2: when
//     `segmentText` is supplied we use segmentMentionsTool — a specific check —
//     so a generic "好的，我来看看" no longer silences every downstream preface;
//     only a segment that actually mentions this tool does. Falls back to the
//     coarse `segmentNarrated` boolean when no segment text is available.)
//   - the shared voice module is unavailable
//   - the tool yields no narration for the given params
function computeToolPreface({ name, params, segmentNarrated, segmentText, occurrence, env } = {}) {
  const e = env || process.env;
  if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return '';
  if (typeof segmentText === 'string' && segmentText.trim()) {
    // Relaxed gating: silence ONLY when the model already named this tool.
    if (_toolPrefaceVoice && typeof _toolPrefaceVoice.segmentMentionsTool === 'function') {
      try {
        if (_toolPrefaceVoice.segmentMentionsTool(segmentText, name, params || {})) return '';
      } catch { /* fall through — a detection error must not suppress narration */ }
    } else if (segmentNarrated) {
      return '';
    }
  } else if (segmentNarrated) {
    return '';
  }
  if (!_toolPrefaceVoice) return '';
  try {
    return _toolPrefaceVoice.toolProgressReason(name, params || {}, { mode: 'lite', occurrence }) || '';
  } catch { return ''; }
}

// Pure "执行中" narration decision (staged transparency). Returns the present-
// continuous line ("正在列出 Desktop 的条目…") attached to a tool object so the
// view can render it live UNDER the running ◆ row. It still shows when only a
// SYNTHETIC intent preface ran above it (that is the silent-model path Stage C
// added) — but stands down when `modelNarrated` is true, i.e. the MODEL ITSELF
// is reasoning in this segment ("模型推理优先"): the developer's natural-prose
// plan should not be undercut by a mechanical status line. Disabled outright by
// the master KHY_TOOL_PREFACE=0 or the dedicated KHY_TOOL_PROGRESS=0.
function computeToolProgress({ name, params, env, modelNarrated, occurrence } = {}) {
  const e = env || process.env;
  if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return '';
  if (String(e.KHY_TOOL_PROGRESS || '').trim() === '0') return '';
  if (modelNarrated) return '';
  if (!_toolPrefaceVoice || typeof _toolPrefaceVoice.toolRunningNarration !== 'function') return '';
  try {
    return _toolPrefaceVoice.toolRunningNarration(name, params || {}, { occurrence }) || '';
  } catch { return ''; }
}

// Pure "结果 + 行动" decision (Issue「完成一个小任务就给一段结果+下一步的自然说明」).
// Returns the completion reflection to inject AFTER a tool resolves — derived
// from the STRUCTURED result (counts, lines, exit code), so it reads like a
// person reacting to what came back and naming the next move, not a mechanical
// "✓ 完成". Unlike the preface this is computed from the RAW result object (the
// view projection strips the heavy count/lines/entries fields it needs), so
// callers must pass `res`, not projectToolResultForView(res). Silent when:
//   - disabled via KHY_TOOL_PREFACE=0 (master) or KHY_TOOL_OUTCOME=0 (dedicated)
//   - the shared voice module is unavailable
//   - the step failed, or nothing concrete can be said (voice returns '')
function computeToolOutcome({ name, result, params, env, occurrence } = {}) {
  const e = env || process.env;
  if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return '';
  if (String(e.KHY_TOOL_OUTCOME || '').trim() === '0') return '';
  if (!_toolPrefaceVoice || typeof _toolPrefaceVoice.toolOutcomeNarration !== 'function') return '';
  try {
    return _toolPrefaceVoice.toolOutcomeNarration(name, result || {}, params || {}, { occurrence }) || '';
  } catch { return ''; }
}

// Honesty gate for the TERMINAL outcome flush ("此路不通不换一条" follow-up). The
// deferred "结果+行动" line carries forward-looking phrasing ("…接着往下走/挑关键
// 的看") that only reads as true when a deliverable actually followed. At the end
// of a turn that produced NO model text (sawText=false) or whose answer was a raw
// salvage dump (salvaged=true), there is no follow-up — so emitting the line would
// claim progress that never happened. Suppress it there. Inter-tool flushes are
// unaffected (a tool genuinely DID follow). Pure + total: returns a boolean.
function shouldFlushTerminalOutcome({ sawText, salvaged, env } = {}) {
  const e = env || process.env;
  // Dedicated opt-out keeps the old (always-flush) behavior if ever needed.
  if (String(e.KHY_OUTCOME_TERMINAL_HONEST || '').trim() === '0') return true;
  if (salvaged) return false;
  return !!sawText;
}

// Pure task-level plan-announcement gate ("主动讲清整件事怎么做"). The before/
// during/after gates above are PER-TOOL; this is the missing TASK-LEVEL beat:
// the model's parsed <execution_plan> (otherwise stripped from the visible text)
// is surfaced as ONE upfront proactive statement before the first tool runs.
// Silent when: disabled via master KHY_TOOL_PREFACE=0 or the dedicated
// KHY_PLAN_ANNOUNCE=0; the MODEL already narrated this segment in prose
// (模型推理优先 — don't double the developer's own plan); the voice is missing; or
// the plan is absent/single-step (composePlanAnnouncement returns '').
function computePlanAnnouncement({ plan, segmentModelNarrated, env } = {}) {
  const e = env || process.env;
  if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return '';
  if (String(e.KHY_PLAN_ANNOUNCE || '').trim() === '0') return '';
  if (segmentModelNarrated) return '';
  if (!_toolPrefaceVoice || typeof _toolPrefaceVoice.composePlanAnnouncement !== 'function') return '';
  try {
    return _toolPrefaceVoice.composePlanAnnouncement(plan) || '';
  } catch { return ''; }
}

// Pure plan step-transition gate — task-level companion of computeToolOutcome.
// 批2: flipped to DEFAULT-ON (opt-out via KHY_PLAN_PROGRESS=0). For a multi-step
// parsed plan, narrating "第 N 步：…" as each step starts adds the task-level
// forward-motion beat the per-tool outcome line cannot (it only knows the tool,
// not the plan). composePlanProgress already returns '' for an absent/single-step
// plan and for every transition except a step BECOMING in_progress, so the default
// stays quiet on trivial turns. Stands down on the master kill-switch and when the
// model narrated this segment.
function computePlanProgress({ plan, stepIndex, status, segmentModelNarrated, env } = {}) {
  const e = env || process.env;
  if (String(e.KHY_TOOL_PREFACE || '').trim() === '0') return '';
  if (String(e.KHY_PLAN_PROGRESS || '').trim() === '0') return '';
  if (segmentModelNarrated) return '';
  if (!_toolPrefaceVoice || typeof _toolPrefaceVoice.composePlanProgress !== 'function') return '';
  try {
    return _toolPrefaceVoice.composePlanProgress(plan, stepIndex, status) || '';
  } catch { return ''; }
}

// Pure reducers for pairing the native loop's tool callbacks onto the streaming
// {tools,timeline} state. Extracted from the bridge closures so the id-pairing
// invariant ("two same-name tools in one turn never cross results") is unit
// testable without mounting the React hook. Both are no-op-safe on null state.
//
// reduceToolPush: append a tool row, de-duping against an adapter-emitted chunk
// for the SAME call. With a real id we match exactly (id-bearing calls never
// collapse together); without one we fall back to first-unresolved-same-name.
function reduceToolPush(s, { name, params, id, toolId, progress }) {
  if (!s) return s;
  const already = toolId
    ? s.tools.some((t) => t.id === toolId)
    : s.tools.some((t) => (t.name || t.toolName) === name && !t.result);
  if (already) return s;
  // `progress` is the live "正在…" narration shown under the running row; carried
  // on the tool object so the view stays pure (no voice logic in the renderer).
  const tool = progress ? { name, input: params, id, progress } : { name, input: params, id };
  return { ...s, tools: [...s.tools, tool], timeline: tlPushTool(s.timeline || [], tool) };
}

// reduceToolResult: attach a result to its row, pairing by id first
// (authoritative) and name only as a fallback. If an id was supplied but
// matched nothing (result raced ahead of its push), fall back to the first
// unresolved same-name row so the result is never dropped.
function reduceToolResult(s, { name, result, toolId }) {
  if (!s) return s;
  const sameName = (t) => (t.name || t.toolName) === name;
  const match = toolId ? (t) => t.id === toolId : sameName;
  let marked = false;
  const tools = s.tools.map((t) => {
    if (!marked && match(t) && !t.result) { marked = true; return { ...t, result }; }
    return t;
  });
  if (toolId && !marked) {
    let fb = false;
    const tools2 = tools.map((t) => {
      if (!fb && sameName(t) && !t.result) { fb = true; return { ...t, result }; }
      return t;
    });
    if (fb) return { ...s, tools: tools2, timeline: tlResolveTool(s.timeline || [], sameName, result) };
  }
  return { ...s, tools, timeline: tlResolveTool(s.timeline || [], match, result) };
}

// reduceAgentTree: attach/refresh the live agent-tree state onto the agent tool
// row identified by `toolId`, in BOTH the flat tools[] and the ordered timeline
// (so the live tail and the committed transcript both see it). The tree lives ON
// the tool object (`_agentTree`) so ToolLines can render the ├│└ branches in
// place of the generic agent(...) summary without a new timeline segment type.
// Pure + no-op-safe on null state; exported for unit testing.
function reduceAgentTree(s, { toolId, agents }) {
  if (!s) return s;
  const patch = (t) => (t && t.id === toolId ? { ...t, _agentTree: agents } : t);
  const tools = Array.isArray(s.tools) ? s.tools.map(patch) : s.tools;
  const timeline = Array.isArray(s.timeline)
    ? s.timeline.map((seg) => (seg && seg.type === 'tool' && seg.tool && seg.tool.id === toolId
      ? { ...seg, tool: patch(seg.tool) }
      : seg))
    : s.timeline;
  return { ...s, tools, timeline };
}

// Project a raw tool result (the rich object toolUseLoop emits via
// onToolResult) into the minimal shape the ink TUI renders. Historically this
// kept only {text,isError}, which silently STRIPPED every other field: the ink
// renderer (ToolLines) is written to surface the failure REASON
// (error/reason/message) and the permission-DENIED flag, but never received
// them — so failed/denied tools showed a bare ✗ with no explanation in the
// default UI (the same class of bug as the dropped _khyWriteDiff). Carry the
// display-relevant fields through. Pure + exported for unit testing. Large
// payloads (results/matches/files arrays) are intentionally NOT copied — `text`
// already holds the rendered output and React state must stay light.
function projectToolResultForView(res, toolName, params) {
  const text = (res && (res.text || res.output || res.content)) || '';
  const result = { text, isError: !(res && res.success) };
  if (!res || typeof res !== 'object') return result;
  // Failure reason (HIGH #1): string OR structured {code,message,hint,...}.
  if (res.error != null) result.error = res.error;
  if (res.reason != null) result.reason = res.reason;
  if (res.message != null) result.message = res.message;
  // 干净的、给用户看的失败/跳过说明(绝不含 [SYSTEM:…] 内部转向指令)。ToolLines.errorText
  // 优先渲染它,避免模型专属的 nudge 文本泄漏到可见的工具结果行。
  if (res._displayHint != null) result._displayHint = res._displayHint;
  // Permission-gate denial (HIGH #2): lets ToolLines label it "权限被拒绝".
  if (res.denied) result.denied = true;
  // Goal7 red/green ±diff context.
  if (res._khyWriteDiff) result._khyWriteDiff = res._khyWriteDiff;
  // Shell exit code: a `success:true, exitCode:2` command must not render as a
  // clean run — carry the code so ToolLines can annotate the (folded) stdout
  // with "↳ 退出码 N". Without this it is stripped like the field family above.
  if (typeof res.exitCode === 'number') result.exitCode = res.exitCode;
  // DESIGN-ARCH-047 P1: trajectory provenance envelope — carry it through like
  // _khyWriteDiff so ToolLines can prefix the trust glyph (✓/⟳/⚠) and surface
  // quarantined / unverified-claim labels for relayed tool calls.
  if (res._khyTrace) result._khyTrace = res._khyTrace;
  // Success summary ("已读取 N 行" / "找到 N 个匹配" / "已在后台运行"…): collapse the
  // rich result (whose heavy arrays we deliberately do NOT carry into React
  // state) into one display string HERE, where the full result is still
  // available. Mirrors the classic REPL's _formatToolResult via the shared
  // single-source summarizer. Only for successful tools and only when the
  // caller supplies the tool name (the projection is also called name-less in
  // unit tests, which must keep the minimal {text,isError} shape).
  if (toolName && res.success) {
    try {
      const summary = summarizeToolResult(toolName, res, params);
      if (summary) result.summary = summary;
    } catch { /* summary is best-effort; never block the result */ }
  }
  return result;
}

module.exports = {
  tlAppendText,
  tlPushTool,
  splitSealedText,
  planStageFlush,
  formatCompactionResult,
  tlAppendThinking,
  submitGateBusy,
  tlStampThinkingDuration,
  resolveSelfRender,
  summarizeControlInput,
  buildDecisionRecord,
  tlResolveTool,
  computeToolPreface,
  computeToolProgress,
  computeToolOutcome,
  shouldFlushTerminalOutcome,
  computePlanAnnouncement,
  computePlanProgress,
  reduceToolPush,
  reduceToolResult,
  reduceAgentTree,
  projectToolResultForView,
};
