'use strict';

/**
 * useQueryBridge — bridges the AI query engine to React state.
 *
 * Wraps the callback-based `ai().chat(text, {onChunk, onStatus,
 * onControlRequest, onFallback, onWait, abortSignal})` contract and exposes
 * committed messages, the live streaming turn, status, and control requests as
 * React state. The backend streaming contract is reused unchanged — only the
 * presentation layer is new.
 */
const { useState, useCallback, useRef, useEffect } = require('react');
const { summarizeToolResult } = require('../../toolResultSummary');
// Adapter-status payload contract + footer identity equality (single source of
// truth, pure). `khy:adapter:status` carries a STRING; normalizing it here (and
// short-circuiting unchanged updates) kills the adapterInfo identity-thrash that
// drove a footer render storm. See footerStability.js header for the full root cause.
const { normalizeAdapterStatus } = require('../footerStability');
// Committed <Static> 包装数组按 messages 引用记忆(避免每 render O(messages) 重建 → 长会话 GC 卡顿)。
// 门控 KHY_STATIC_ITEMS_MEMO 关 → 每 render 重建(逐字节回退今日)。见 staticItemsMemo.js 头注释。
const _staticItemsMemo = require('../staticItemsMemo');
// Busy-input classifier (Hermes-style interrupt/steer/queue), shared verbatim
// with the classic REPL so a message typed while the agent is busy is routed the
// SAME way in both front-ends. Pure: classifyBusyInput(text) → { mode, text }.
const { routeBusyInput, summarizeQueuedInputForDisplay } = require('../../repl/busyInputClassifiers');
// Busy-interjection "new-topic" detection (pure leaf). Parity with the classic REPL:
// a `steer` interjection that overlaps the running topic very little is downgraded to
// `queue` rather than injected mid-flight. Gate off → decision returns false (byte-revert).
const _busyTopicShift = require('../../repl/busyTopicShift');
// Parallel sub-agent fan-out → live ├│└ tree. The layout glyphs/labels and the
// progress state-machine are the SAME single source the classic REPL uses
// (cli/agentTreeView), so a fan-out reads identically in both front-ends.
const { makeAgentState, applyProgressEvent, isAgentFamilyTool } = require('../../agentTreeView');
// Issue B「先说要做什么，再执行」narration source (single source of truth, shared
// with the REPL path). Optional — fail-soft to no preface if unavailable.
let _toolPrefaceVoice;
try { _toolPrefaceVoice = require('../../toolPrefaceVoice'); } catch { _toolPrefaceVoice = null; }

// turn 级即时确认「先回应用户,再干活」(2026-07-05 用户反馈)。单一真源 cli/turnAckVoice.js;
// 门控 KHY_TURN_ACK。fail-soft 到不注入(叶子缺失/异常 → 无 ack,逐字节回退历史)。
let _turnAckVoice;
try { _turnAckVoice = require('../../turnAckVoice'); } catch { _turnAckVoice = null; }

// 关键节点主动汇报：把 loop 发来的 finding（测试结果 / 根因 / 突破 / 受阻）渲成
// 可见文本段。单一真源在 cli/keyFindings.js；fail-soft 到不渲染。
let _keyFindings;
try { _keyFindings = require('../../keyFindings'); } catch { _keyFindings = null; }

// 退化 no-op prose echo 识别(单一真源 services/degenerateShellEcho.js)。派发层已在
// toolUseLoop 把这类调用滤掉;但 TUI adapter-native 流式 tool_use 路径独立发 preface/
// turn-ack,不经那道过滤 → 讲笑话轮仍会念「跑下 echo…核对现场」。这里复用同一识别谓词、
// 同一门控 KHY_DROP_DEGENERATE_ECHO,在流式路径上同样抑制对退化 echo 的叙述。fail-soft:
// 叶子缺失/异常 → 不抑制(照常叙述,逐字节回退历史)。
let _degenerateShellEcho;
try { _degenerateShellEcho = require('../../../services/degenerateShellEcho'); } catch { _degenerateShellEcho = null; }

// 双击 ESC 回溯(对齐 Claude Code)的单一真源:env 门控 + 纯判定。本 hook 用它的
// turnCheckpointEnabled() / patchUserCheckpointId() 做每轮前检查点登记。fail-soft 到不回溯。
let _rewindControl;
try { _rewindControl = require('../rewindControl'); } catch { _rewindControl = null; }

// 回合以可恢复错误失败时,给用户面错误行末追加一句「双击 Esc 回溯并编辑重试」提示
// (对齐 Claude Code errors.ts)。判定全在纯叶子 rewindControl.buildEscRewindHint:
// 仅交互式 TTY + 回溯 affordance 启用 + 可恢复类才追加。fail-soft 原样返回。
function _withEscHint(content) {
  try {
    if (!_rewindControl || typeof _rewindControl.buildEscRewindHint !== 'function') return content;
    const interactive = !!(typeof process !== 'undefined' && process.stdout && process.stdout.isTTY);
    const rewindEnabled = typeof _rewindControl.isRewindEnabled === 'function'
      ? _rewindControl.isRewindEnabled()
      : false;
    const hint = _rewindControl.buildEscRewindHint(content, { rewindEnabled, interactive });
    return hint ? `${content}\n${hint}` : content;
  } catch {
    return content;
  }
}

// 回合统计行(对齐 CC 回合收尾摘要)的单一真源:门控 + 确定性格式化。finalize 时用
// 真实后端态(startTime 墙钟 / result.toolCallLog / result.tokenUsage)拼一行
// `✓ 1m30s · 3 工具 · 1.2k tokens`。门控 KHY_TURN_STATS 默认开,关 → null 不追加(字节回退)。
const { buildTurnStatsLine } = require('../../turnStats');

// ── Ordered turn timeline helpers（已抽取为叶子 ./queryBridgeTimeline.js）──────────
// 完整实现(时间线段模型 + 已提交/在飞切分 + 每工具/任务级叙述 beat + 结果投影)见该叶子
// (降上帝文件·DESIGN-ARCH-051 lineage，范式同 localBrainCalc/localBrainProviderConfig)。
// 此处以 **同名别名 re-export** 接回:hook 体与 module.exports 按原名消费,契约字节不变。
// 三个 React 无关的纯函数簇——皆不触碰 React state,故可脱离 hook 单测。
const _qbt = require('./queryBridgeTimeline');
const tlAppendText = _qbt.tlAppendText;
const tlPushTool = _qbt.tlPushTool;
const splitSealedText = _qbt.splitSealedText;
const planStageFlush = _qbt.planStageFlush;
const formatCompactionResult = _qbt.formatCompactionResult;
const tlAppendThinking = _qbt.tlAppendThinking;
const submitGateBusy = _qbt.submitGateBusy;
const tlStampThinkingDuration = _qbt.tlStampThinkingDuration;
const resolveSelfRender = _qbt.resolveSelfRender;
const summarizeControlInput = _qbt.summarizeControlInput;
const buildDecisionRecord = _qbt.buildDecisionRecord;
const tlResolveTool = _qbt.tlResolveTool;
const computeToolPreface = _qbt.computeToolPreface;
const computeToolProgress = _qbt.computeToolProgress;
const computeToolOutcome = _qbt.computeToolOutcome;
const shouldFlushTerminalOutcome = _qbt.shouldFlushTerminalOutcome;
const computePlanAnnouncement = _qbt.computePlanAnnouncement;
const computePlanProgress = _qbt.computePlanProgress;
const reduceToolPush = _qbt.reduceToolPush;
const reduceToolResult = _qbt.reduceToolResult;
const reduceAgentTree = _qbt.reduceAgentTree;
const projectToolResultForView = _qbt.projectToolResultForView;

// ── Ctrl+O expand support (pure, React-free, exported for unit testing) ──
//
// A committed assistant turn is "foldable" when its persistent record carries a
// process group (tool steps) or folded thinking — the bits ToolLines/ProcessGroup
// collapse by default. `expanded` toggling cannot reveal them once they land in
// Ink's <Static>, so Ctrl+O instead appends an `expansion` message (see
// MessageBlock) rendering exactly these parts force-expanded.

function _entryIsFoldable(e) {
  return !!e && (
    (e.type === 'tools' && Array.isArray(e.tools) && e.tools.length > 0)
    || (e.type === 'thinking' && !!e.text)
  );
}

function _messageHasFoldable(m) {
  if (!m || m.role !== 'assistant') return false;
  if (Array.isArray(m.timeline) && m.timeline.some(_entryIsFoldable)) return true;
  return Array.isArray(m.tools) && m.tools.length > 0;
}

// Scan from the end for the most recent assistant turn with foldable detail.
// Synthetic `expansion` items (role !== 'assistant') are skipped, so repeated
// Ctrl+O always targets the same real turn rather than expanding an expansion.
function selectLastFoldableMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (_messageHasFoldable(messages[i])) return messages[i];
  }
  return null;
}

// Build the synthetic `expansion` message from a foldable target. Only the
// foldable timeline entries (tools/thinking) are carried — prose text is dropped
// so the expansion shows detail, not a re-print of the answer. Falls back to the
// legacy `tools` array for timeline-less (restored) messages. Returns null when
// the target yields nothing expandable. `timestamp` is injected by the caller so
// this stays pure (no Date.now()).
function buildExpansionMessage(target, timestamp) {
  if (!_messageHasFoldable(target)) return null;
  const msg = { role: 'expansion', timestamp: timestamp || 0 };
  if (Array.isArray(target.timeline) && target.timeline.some(_entryIsFoldable)) {
    msg.timeline = target.timeline.filter(_entryIsFoldable);
  } else {
    msg.tools = target.tools;
  }
  return msg;
}

// ── Completion bell (体感: 完成提醒) ─────────────────────────────────────────
// Opt-in terminal bell so a user who switched away hears a LONG turn finish.
// Pure decision (shouldRingCompletionBell) is unit-tested; the emit is a thin
// BEL byte to the TTY. Disabled unless KHY_BELL_ON_DONE is truthy, and only
// fires for turns ≥ KHY_BELL_MIN_MS (default 10s) so quick replies stay silent.
// Never fires on abort/error — only the two success-"done" paths call the emit.
function _bellEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.KHY_BELL_ON_DONE || '').trim());
}
function _bellMinMs() {
  const n = parseInt(String(process.env.KHY_BELL_MIN_MS || '10000'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
}
// Pure predicate: all inputs explicit so it is testable without env/Date/TTY.
function shouldRingCompletionBell({ enabled, elapsedMs, minMs, isTTY }) {
  return !!enabled && !!isTTY && Number(elapsedMs) >= Number(minMs);
}

// CC 后端口径对齐(纯助手):选回合统计行应显示的 token 数。CC 的回合收尾记录用
// `getTurnOutputTokens()`(REPL.tsx:3762 = getTotalOutputTokens − outputTokensAtTurnStart,
// 仅本回合**输出** token 增量),而非输入+输出总量——输入是每轮重发的上下文,会淹没
// 「这一轮真正产出了多少」这个信号。
//   门控 KHY_TURN_STATS_OUTPUT_TOKENS(默认开):返回 usage.outputTokens(仅输出);若适配器
//     未单独上报 outputTokens(只有总量)→ 返回 0,**诚实省略** token 段(buildTurnStatsLine
//     对 0 自动跳过),绝不把含输入的总量冒充成回合输出。
//   关(=0/false/off/no):逐字节回退到旧的总量口径(fallbackTotal,输入+输出)。
function pickTurnStatsTokens(usage, fallbackTotal, env = process.env) {
  const v = String((env && env.KHY_TURN_STATS_OUTPUT_TOKENS) || '').trim().toLowerCase();
  const ccOutputOnly = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (!ccOutputOnly) return Number(fallbackTotal) > 0 ? Number(fallbackTotal) : 0;
  const out = usage && typeof usage === 'object' ? Number(usage.outputTokens) : NaN;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

// CC 后端口径对齐(纯助手):选页脚「上下文占用」应基于的 token 数。CC 的
// `calculateContextPercentages`(src/utils/context.ts:123)用 **输入侧** 之和
// `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`(= 提示词/已发上下文
// 占了多少窗口),**不含 output**——本回合刚生成的输出还没被回灌为输入,不属于「当前占用」。
//   门控 KHY_CONTEXT_FILL_INPUT_ONLY(默认开):返回输入侧之和(Khy 适配器把提示侧统一归一成
//     `inputTokens`,缓存命中已并入;若适配器另列 cache 字段则一并相加)。
//   关(=0/false/off/no):逐字节回退到旧的输入+输出总量口径(fallbackTotal)。
// 返 0 表示无可用输入侧用量 → 调用方不更新占用(避免把 output-only 的回合误算成占用,
// 也与 CC「input 为 0 不闪 0%」的诚实取向一致——保留上一回合的真实占用值)。
function pickContextOccupancyTokens(usage, fallbackTotal, env = process.env) {
  const v = String((env && env.KHY_CONTEXT_FILL_INPUT_ONLY) || '').trim().toLowerCase();
  const ccInputOnly = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (!ccInputOnly) return Number(fallbackTotal) > 0 ? Number(fallbackTotal) : 0;
  if (!usage || typeof usage !== 'object') return 0;
  const input = Number(usage.inputTokens) || 0;
  const cacheCreate = Number(usage.cacheCreationTokens || usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens || usage.cache_read_input_tokens) || 0;
  const sum = input + cacheCreate + cacheRead;
  return sum > 0 ? sum : 0;
}
// Best-effort emit. `startTime` is the turn's Date.now() captured at dispatch;
// elapsed is computed here (the predicate stays pure). Any failure is swallowed
// so a bell can never disrupt a turn's terminal transition.
function _ringCompletionBellIfDue(startTime) {
  try {
    const due = shouldRingCompletionBell({
      enabled: _bellEnabled(),
      elapsedMs: Date.now() - Number(startTime || Date.now()),
      minMs: _bellMinMs(),
      isTTY: !!(process.stdout && process.stdout.isTTY),
    });
    if (due) process.stdout.write('\x07');
  } catch { /* bell is cosmetic; never throw from a completion path */ }
}

// Off-terminal completion push (对齐 Claude Code 的 turn-done 通知): when a LONG turn
// finishes and the user has configured a push target, fire a fire-and-forget push to
// their phone/desktop — parallel to the in-terminal BEL above. Decision + message are
// the single source of truth in completionPushPolicy; the send reuses the PushNotify
// tool's execute so the SSRF guard + target masking stay single-sourced. Opt-in
// (KHY_PUSH_ON_DONE, default off) and only when `khy notify set` was run. Never throws,
// never blocks the turn's terminal transition (best-effort, swallow all errors).
function _pushCompletionIfDue(startTime, info) {
  try {
    const policy = require('../../../services/completionPushPolicy');
    if (!policy.isEnabled()) return;
    let configured = false;
    try { configured = require('../../../services/pushConfigStore').isConfigured(); } catch { /* unconfigured */ }
    const due = policy.shouldPushOnCompletion({
      enabled: true,
      configured,
      elapsedMs: Date.now() - Number(startTime || Date.now()),
      minMs: policy.minMs(),
    });
    if (!due) return;
    const msg = policy.buildCompletionPushMessage({
      elapsedMs: Date.now() - Number(startTime || Date.now()),
      ok: !(info && info.ok === false),
      summary: info && info.summary,
    });
    const tool = require('../../../tools/PushNotify');
    // fire-and-forget: never await, never let a push failure surface in the turn.
    Promise.resolve(tool.execute({ title: msg.title, body: msg.body, priority: msg.priority }))
      .catch(() => { /* push is best-effort */ });
  } catch { /* completion push is cosmetic; never throw from a completion path */ }
}

// 提交后、下游可能阻塞事件循环的同步工作之前，是否主动让出一拍给 Ink 把「已发送」帧刷出来。
// 默认开，仅显式 0/false/off/no 关(kill-switch: KHY_SUBMIT_PAINT_YIELD)。纯判定，可单测。
function paintYieldEnabled() {
  const v = String(process.env.KHY_SUBMIT_PAINT_YIELD == null ? '' : process.env.KHY_SUBMIT_PAINT_YIELD)
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function useQueryBridge(hostHandlers = {}) {
  // CC 对齐计划模式:宿主(App)登记的 onExitPlanMode 回调经 ref 传入,循环拦到
  // ExitPlanMode(plan) 时回调宿主设 planPhase='reviewing' 并落 currentPlan。用 ref
  // 避免闭包捕获旧值,useEffect 每次渲染同步最新句柄。门关时宿主根本不传,自然 no-op。
  const hostOnExitPlanModeRef = useRef(null);
  useEffect(() => {
    hostOnExitPlanModeRef.current = (hostHandlers && hostHandlers.onExitPlanMode) || null;
  });
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | thinking | streaming | tool | compacting | done
  // Conversation-compaction progress, mirrored from ai.js onStatus({phase:'compacting',...}).
  // null when no compaction is in flight; the App renders a progress bar otherwise.
  const [compaction, setCompaction] = useState(null); // {active, pct, stage, tokensBefore, startedAt}
  const [controlRequest, setControlRequest] = useState(null);
  // Latest gateway status detail ("等待模型响应中" / "请求上游模型" / "预热中…").
  // ai.js emits onStatus({phase, message}); the coarse `status` keeps only the
  // phase, so the human-readable `message` was being discarded. We retain it here
  // so the spinner can show WHAT a stalled turn is actually waiting on.
  const [statusDetail, setStatusDetail] = useState('');
  const [turnStartedAt, setTurnStartedAt] = useState(null);
  const [adapterInfo, setAdapterInfo] = useState({});
  // Latest turn's reported token usage, used to show a TRUE context-window fill
  // in the footer (previously the footer pinned contextPct to 0 — a fake 0%).
  // totalTokens ≈ current window occupancy: inputTokens is the whole prompt
  // (system + full history) and outputTokens is the reply just appended to it.
  const [contextTokens, setContextTokens] = useState(0);

  // 久别重返轻提示（对齐 CC idle-return 的 'hint' 档，见 cli/idleReturnNudge）：
  // _lastCompletionMsRef 记上一回合完成的墙钟毫秒（成功/出错都记，缓存皆已凉），
  // _idleTokensRef 镜像最近一次上下文占用 token，供提交时判定是否浮现「离开很久 +
  // 上下文很大 → 建议 /clear」的一次性通知。提示后清零完成时钟以自限、不重复。
  const _lastCompletionMsRef = useRef(0);
  const _idleTokensRef = useRef(0);
  // 缓存命中率警告(对齐 CC cacheWarning.ts,见 cli/cacheWarning):记上一回合命中率
  // 以算趋势箭头。首观(null)只播种不警告。state 外置于此 ref(非 CC 模块级 Map)——
  // 消除无界增长面,叶子保持纯。
  const _lastCacheHitRateRef = useRef(null);
  // 会话累计命中率计数器(承 KHY_CACHE_SESSION_AGGREGATE)。比单轮稳:累计整会话 hit/miss。
  // ref 生命周期=一次 TUI 会话(与 _lastCacheHitRateRef 同口径)。null=尚无累计。
  const _sessionCacheRef = useRef(null);
  // 会话花费阈值一次性警告的「已警告」记忆(对齐 CC CostThresholdDialog 的
  // hasShownCostDialog:累计会话 API 花费首次越过阈值时提醒一次)。ref 生命周期=
  // 一次 TUI 会话(与 _lastCacheHitRateRef 同口径),false=尚未提醒。
  const _costThresholdWarnedRef = useRef(false);

  // /clear 对齐 CC「fresh start」:清后端历史后须把页脚上下文占用 % 立即归零。
  // contextTokens 是本 hook 的裸 useState,与 ai() 解耦(仅每轮结束由 tokenUsage 更新),
  // 故 ai().clearHistory() 不会自动归零——须显式复位 state 与 idle 镜像 ref。
  const resetContext = useCallback(() => {
    setContextTokens(0);
    _idleTokensRef.current = 0;
  }, []);

  const abortRef = useRef(null);
  // Mirror the in-flight control request so resolveControl can read it without
  // closing over state (avoids stale closures) and record the decision/answer
  // into history. Set when a request is shown; cleared on resolve.
  const controlRequestRef = useRef(null);
  // AUTHORITATIVE live-turn state, updated SYNCHRONOUSLY on every chunk (no
  // React). This is the single source of truth: finalize() reads it directly so
  // it is always complete regardless of render timing, and throttling the
  // projection to React state below can never drop content — it only merges
  // RENDER frequency. `setStreaming` is just a throttled VIEW of liveRef.
  const liveRef = useRef(null);
  // Coalescing timer: streamed text schedules a ~40ms flush; tool events and
  // clears flush immediately (see setStreamingBoth).
  const flushTimerRef = useRef(null);
  const doneTimerRef = useRef(null);
  // "Send while busy" queue (Claude Code useCommandQueue). Messages submitted
  // during a running turn are held FIFO and drained one-at-a-time when the turn
  // settles. queueRef holds the pending items; queueLen mirrors it for the UI.
  const queueRef = useRef([]);
  const [queueLen, setQueueLen] = useState(0);
  // queueItems mirrors the text of pending items so the UI can show each queued
  // message verbatim (not just a count) and let the user pull one back to edit.
  const [queueItems, setQueueItems] = useState([]);
  // Steer channel (Hermes-style mid-course correction), distinct from queueRef.
  // queueRef holds NEW topics drained at end-of-turn; steerQueueRef holds course
  // corrections the native loop pulls at TOOL boundaries (getSteerMessages) and
  // injects as 「方向修正」 into the next model turn — so guidance lands promptly
  // without derailing the running task. urgentSteerRef is the /s! preempt signal
  // (pull-clear): the loop cancels the in-flight model call and re-issues THIS
  // turn with the steer injected (consumeUrgentSteer). steerLen mirrors for UI.
  const steerQueueRef = useRef([]);
  const urgentSteerRef = useRef(false);
  // Text of the turn currently running — the topic baseline for busy-interjection
  // "new-topic" detection (busyTopicShift). Set at _runSubmit start; when a busy
  // interjection is classified `steer` but overlaps the running topic very little,
  // it is downgraded to `queue` (runs as its own fresh turn, not injected mid-flight).
  const runningTurnTextRef = useRef('');
  const [steerLen, setSteerLen] = useState(0);
  const _syncSteer = useCallback(() => { setSteerLen(steerQueueRef.current.length); }, []);
  // Decide whether a `steer`-classified busy interjection is actually a NEW topic
  // (its content barely appears in the running turn) → caller downgrades it to `queue`.
  // Tokens come from memdir's SSOT tokenizer, enriched with CJK bigrams (memoryRecallTokens)
  // to blunt single-char Chinese noise; the pure leaf does the overlap-coefficient compare.
  // Gate off / no baseline / memdir error → false (keep today's steer). Never throws.
  const _isBusyInterjectionNewTopic = useCallback((interjectionText) => {
    try {
      const baseline = runningTurnTextRef.current;
      if (!baseline) return false;
      const memdir = require('../../../memdir/memdir');
      let enrich = null;
      try { enrich = require('../../../services/memoryEngine/memoryRecallTokens'); } catch { /* enrichment optional */ }
      const tok = (t) => {
        const base = memdir._tokenizeForRecall(t);
        return enrich ? enrich.enrichTokens(base, t, process.env) : base;
      };
      return _busyTopicShift.isNewTopicInterjection(tok(interjectionText), tok(baseline), process.env);
    } catch {
      return false;
    }
  }, []);
  // Keep both the count and the visible item list in sync with queueRef.
  const _syncQueue = useCallback(() => {
    setQueueLen(queueRef.current.length);
    setQueueItems(queueRef.current.map((it) => (it && typeof it.text === 'string' ? it.text : String(it ?? ''))));
  }, []);
  // Latest status as a ref so the (stable) submit() closure can decide whether a
  // turn is in flight without capturing a stale `status` state value.
  const statusRef = useRef('idle');
  useEffect(() => { statusRef.current = status; }, [status]);
  // Synchronous submit lock for the tiny window before statusRef reflects the
  // new turn. Prevents a duplicated Enter on the first message from opening two
  // concurrent turns that both still see statusRef='idle'.
  const submitInFlightRef = useRef(false);
  // Holds the latest _runSubmit so the drain closure can re-enter it.
  const runSubmitRef = useRef(null);
  // Monotonic turn counter. Each _runSubmit captures its own value; status
  // writes from late/stray stream events (e.g. a trailing web-search `notice`
  // chunk after the summary streamed) are ignored once a newer turn has begun
  // or the turn has settled — this prevents the spinner being revived to
  // "思考中…" after the visible task already finished.
  const turnSeqRef = useRef(0);
  // turn 级即时确认「先回应用户」每轮至多一次的哨兵:本轮首个工具 push 时注入一句(或判空跳过),
  // 之后同轮任何工具都不再注入。turn-start 复位。见 maybeInjectTurnAck。
  const turnAckEmittedRef = useRef(false);
  // True once the current turn has streamed real answer text. Used so that a
  // trailing/inter-iteration status event with an empty phase no longer reverts
  // the spinner to "思考中…" while a completed-looking answer already sits in the
  // live region — once text has streamed, the honest fallback is "生成中…".
  const sawTextRef = useRef(false);
  // Wall-clock start of the CURRENT thinking run (set on the first thinking chunk,
  // cleared when the run ends at the first non-thinking chunk). Lets us stamp the
  // REAL thinking elapsed onto the committed timeline entry → "💭 思考 Ns".
  const thinkingRunStartRef = useRef(null);
  // Issue B: tracks whether the CURRENT segment (since turn start or the last
  // tool result) already carries narration — model-produced text OR an injected
  // tool preface. Gates auto-preface so we narrate only when the model jumped
  // straight to a tool without saying what it's about to do.
  const segmentNarratedRef = useRef(false);
  // "模型推理优先": tracks whether the MODEL ITSELF produced text in the current
  // segment (distinct from segmentNarratedRef, which a synthetic preface also
  // sets). When the model is narrating its own plan as prose, the mechanical
  // 执行中 running-line stands down so the middle region reads as the developer's
  // natural-prose reasoning — not model prose mixed with a "正在…" status line.
  // Reset per segment (turn start / each tool result) like segmentNarratedRef.
  const segmentModelNarratedRef = useRef(false);
  // 批2: accumulates the MODEL's own text for the current segment so the per-tool
  // preface gate can ask "did the model already name THIS tool?" (segmentMentionsTool)
  // rather than the coarse "did the model say anything at all?". Reset alongside
  // segmentNarratedRef at turn start and each tool result.
  const segmentTextRef = useRef('');
  // 过程叙述「不机械」:本回合内每类工具已出现的次数(occurrenceKey→count),用于让
  // toolPrefaceVoice 在连续同类调用时轮换续接句(occurrence 0=首发原句、≥1=续接变体),
  // 而非每次逐字复述「我先补一下…再回来收口」。回合开始清零(随 _runSubmit/turn-start
  // reset),纯 UI 计数器、绝不影响 loop 行为。
  const prefaceCountsRef = useRef(new Map());
  // 连续同类工具 preface 抑制(修「刷屏」):记本回合内**上一条已发出** preface 的工具类别键。
  // 当前工具与之同类 → 抑制(一串同类工具只在首个开口);出现不同类工具 → 更新为它。回合开始清空。
  // 详见 toolPrefaceVoice.suppressConsecutivePreface。
  const lastPrefaceKeyRef = useRef('');
  // "结果 + 行动" deferred reflection: when a tool resolves we stash its
  // completion narration here instead of injecting eagerly. It is flushed only
  // when the model stays SILENT about the result (the next event is another tool
  // or turn end) and discarded the moment the model narrates the result itself —
  // so the synthetic reflection fills black-box gaps without ever doubling the
  // model. Holds the pending text, or null.
  const pendingOutcomeRef = useRef(null);
  // Cross-turn repeat guard feed: a bounded ring (last ~8) of SUCCESSFUL tool-call
  // signatures harvested across recent turns. Persisted across turns via the ref
  // (each「继续」is a new runToolUseLoop with a fresh per-turn detector, which is
  // exactly why the ring must live one level up). Passed as recentToolSignatures
  // so the loop can steer a re-issued, already-answered call instead of re-running.
  const recentToolSigsRef = useRef([]);
  // True once at least one COMPLETED stage of the current turn has been drained
  // into the committed <Static> history (incremental commit). Gates the
  // finalize fallback so result.reply does not re-commit text already persisted
  // as fragments. Reset at the start of each turn.
  const committedTurnRef = useRef(false);
  // Per-turn render trust: true when the active model self-renders (T0/T1), so
  // the render layer trusts its output; false when it should be normalized
  // (T2/T3). Resolved at turn start, stamped on the streaming state + every
  // committed message so each row renders by the model that produced it.
  const selfRenderRef = useRef(false);
  // Live agent-tree state for parallel sub-agent fan-outs, keyed by the agent
  // tool's id → Map(childAgentId → state). The native loop hands each agent tool
  // call an onAgentProgress callback (below); orchestrator-forwarded lifecycle
  // events mutate this map and re-project the ├│└ tree onto that tool row. Reset
  // per turn. Same pure reducer as the classic REPL controller (agentTreeView).
  const agentTreesRef = useRef(new Map());

  // Update the authoritative liveRef and project it to React state. The
  // updater receives liveRef.current (fresh, never a stale closure). `flush`
  // (or a clear to null) renders immediately; otherwise the projection is
  // throttled to one frame per ~40ms so a burst of text chunks collapses into a
  // single re-render. liveRef itself is ALWAYS up to date — throttling merges
  // frames, it never drops text or tool steps.
  // Frame budget for the throttled projection. A paint cadence of ~25fps keeps
  // the live region smooth without the high-frequency re-render jank a
  // per-token paint would cause (hard constraint).
  const FRAME_MS = 40;
  // Wall-clock of the last actual paint. Lets a chunk that lands after an idle
  // gap (≥ one frame since the last paint — notably the FIRST chunk of a turn)
  // paint SYNCHRONOUSLY instead of waiting out a full frame on the coalescing
  // timer. This removes the perceived first-token latency ("无感知延迟") while
  // a dense burst still collapses to ≤1 paint per frame.
  const lastPaintAtRef = useRef(0);
  const projectStreaming = useCallback(() => {
    flushTimerRef.current = null;
    lastPaintAtRef.current = Date.now();
    const v = liveRef.current;
    setStreaming(v == null ? null : { ...v });
  }, []);
  const setStreamingBoth = useCallback((updater, flush = false) => {
    const next = typeof updater === 'function' ? updater(liveRef.current) : updater;
    liveRef.current = next;
    if (flush || next == null) {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      lastPaintAtRef.current = Date.now();
      setStreaming(next == null ? null : { ...next });
      return;
    }
    const sinceLast = Date.now() - lastPaintAtRef.current;
    if (sinceLast >= FRAME_MS) {
      // A full frame has elapsed since the last paint → render now so text
      // appears the instant it arrives, with no buffering on the coalescing
      // timer. Bounded by FRAME_MS, so this can fire at most ~25× per second.
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      lastPaintAtRef.current = Date.now();
      setStreaming({ ...next });
    } else if (!flushTimerRef.current) {
      // Within the current frame: defer to the trailing flush so a burst of
      // chunks coalesces into a single re-render at the frame boundary.
      flushTimerRef.current = setTimeout(projectStreaming, FRAME_MS - sinceLast);
    }
  }, [projectStreaming]);

  // ── Incremental stage commit ──────────────────────────────────────────────
  // Reference-doc principle: "过程步骤完成即作为持久行保留" — a completed step is
  // committed to the persistent layer immediately, not held in the transient
  // region until the whole turn ends. Without this, every intermediate stage of
  // a long multi-round turn lives only in the live region, where StreamingBlock
  // tails it to bound height — so earlier steps and feedback get FOLDED away
  // mid-turn. Here we drain the contiguous COMPLETED prefix of the live timeline
  // into committed <Static> messages, leaving only the still-in-flight tail
  // (the open text segment + any pending tool) in the transient region.
  //
  // "Completed" prefix (non-force): a tool entry WITH a result, or a text entry
  // that is no longer the last (sealed — streaming moved past it). We stop at the
  // first pending tool or the open trailing text. `force` (finalize) drains
  // everything that remains, including the now-sealed trailing text.
  const flushCompletedStages = useCallback((force, meta, sealTrailing) => {
    const live = liveRef.current;
    const tl = live && Array.isArray(live.timeline) ? live.timeline : null;
    if (!tl || tl.length === 0) {
      // Nothing in the timeline. On force, still attach metadata to a final
      // message only when the caller provides text (handled by the caller).
      return false;
    }
    const { k, sealed } = planStageFlush(tl, { force, sealTrailing });
    const sealedSeg = sealed ? { type: 'text', text: sealed } : null;

    if (k === 0 && !sealedSeg) return false;

    const drained = sealedSeg ? [...tl.slice(0, k), sealedSeg] : tl.slice(0, k);
    const continuation = committedTurnRef.current;
    committedTurnRef.current = true;
    setMessages((m) => [
      ...m,
      {
        role: 'assistant',
        // Plain-text projection kept for backward-compat consumers; MessageBlock
        // renders the timeline when present.
        content: drained.filter((e) => e.type === 'text').map((e) => e.text).join(''),
        timeline: drained,
        // Continuation fragments render flush against the previous one (no top
        // margin) so a multi-stage turn reads as a single contiguous block.
        continuation,
        // Render trust for this row: T0/T1 self-render, T2/T3 get normalized.
        selfRender: selfRenderRef.current,
        ...(meta || {}),
        timestamp: Date.now(),
      },
    ]);
    // Shrink the live region to the undrained tail (flush so it repaints now).
    // For a progressive seal, strip the committed prefix from the still-open
    // segment using the LATEST text (chunks may have appended since we computed
    // the split) — text is append-only, so the sealed prefix is always a stable
    // prefix and slicing it preserves any newly-arrived tail with no loss.
    setStreamingBoth((s) => {
      if (!s) return s;
      if (sealedSeg) {
        const segs = s.timeline || [];
        const cur = segs[k];
        let remainder = [];
        if (cur && cur.type === 'text' && cur.text.startsWith(sealedSeg.text)) {
          const rest = cur.text.slice(sealedSeg.text.length);
          remainder = rest ? [{ type: 'text', text: rest }] : [];
        } else if (cur) {
          remainder = [cur]; // defensive: prefix moved unexpectedly, keep as-is
        }
        return { ...s, timeline: [...remainder, ...segs.slice(k + 1)] };
      }
      return { ...s, timeline: s.timeline.slice(k) };
    }, true);
    return true;
  }, [setStreamingBoth]);

  // ── LAN collaboration bridge (mirror) ──
  // The bridge SERVER is started in startRepl before the TUI mounts. The
  // consumer side — wiring inbound device messages into the session and
  // mirroring the session's output back — was never connected (onBridgeEvent
  // had zero subscribers repo-wide), so paired devices could neither drive nor
  // observe the TUI. bridgeRef caches the module (false = unavailable);
  // broadcastOutput itself no-ops when the server isn't running, so every call
  // here is free when the bridge is unused.
  const bridgeRef = useRef(null); // null=untried, false=unavailable, object=module
  const getBridge = useCallback(() => {
    if (bridgeRef.current === null) {
      try { bridgeRef.current = require('../../../bridge/bridgeServer'); }
      catch { bridgeRef.current = false; }
    }
    return bridgeRef.current || null;
  }, []);
  const bcast = useCallback((data) => {
    const b = getBridge();
    if (b && typeof b.broadcastOutput === 'function') {
      try { b.broadcastOutput(data); } catch { /* best effort */ }
    }
  }, [getBridge]);

  // Pull the next queued message (if any) and run it. Called once a turn has
  // fully settled (idle), so the streaming refs are reset and re-entry is safe.
  const drainNext = useCallback(() => {
    if (queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    _syncQueue();
    if (runSubmitRef.current) runSubmitRef.current(next.text, next.options);
  }, [_syncQueue]);

  const _runSubmit = useCallback(async (text, options = {}) => {
    submitInFlightRef.current = true;
    runningTurnTextRef.current = typeof text === 'string' ? text : String(text ?? '');
    const ai = () => require('../../ai');
    // Speak the final assistant reply when voice mode (/voice) is enabled. The
    // persisted voiceService flag is the single source of truth; speak() spawns
    // a detached TTS process so this never blocks the turn. No-op on any error.
    const maybeSpeak = (txt) => {
      if (!txt) return;
      try {
        const voiceService = require('../../../services/voiceService');
        if (voiceService.getVoiceSettings().enabled) voiceService.speak(String(txt));
      } catch { /* voice unavailable */ }
    };
    const startTime = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    // Cancel any pending idle/drain timer from a just-finished ("done") turn so
    // it cannot fire mid-turn and drain the queue prematurely.
    clearTimeout(doneTimerRef.current);

    setTurnStartedAt(startTime);
    // Claim this turn. `settled` flips once the turn reaches a terminal state;
    // safeSetStatus then ignores any late/stray stream events (e.g. a trailing
    // web-search `notice` emitted after the promise resolved) so they cannot
    // revive the spinner to "思考中…" after the answer is already shown.
    const myTurn = ++turnSeqRef.current;
    let settled = false;
    const safeSetStatus = (s) => { if (!settled && turnSeqRef.current === myTurn) setStatus(s); };
    // Retain the latest non-empty gateway detail message for this turn; ignored
    // once the turn has settled so a late stray status can't revive stale text.
    const safeSetDetail = (d) => {
      const txt = String(d == null ? '' : d).replace(/\s+/g, ' ').trim();
      if (!txt) return;
      if (!settled && turnSeqRef.current === myTurn) setStatusDetail(txt);
    };
    // Honest fallback for empty/unknown phases: "思考中…" only before any text has
    // streamed this turn; "生成中…" afterwards (the agent loop is between
    // iterations, not idle-thinking under a finished-looking answer).
    const idlePhase = () => (sawTextRef.current ? 'streaming' : 'thinking');
    sawTextRef.current = false;
    thinkingRunStartRef.current = null;
    segmentNarratedRef.current = false;
    segmentModelNarratedRef.current = false;
    segmentTextRef.current = '';
    pendingOutcomeRef.current = null;
    committedTurnRef.current = false;
    agentTreesRef.current = new Map();
    // 过程叙述「不机械」:本回合每类工具的出现计数清零,使续接句轮换以回合为界
    // (新回合的首次同类工具重新走「首发原句」)。
    prefaceCountsRef.current = new Map();
    lastPrefaceKeyRef.current = '';
    // 每轮复位 turn-ack 哨兵:新回合的首个工具重新有资格注入一句即时确认。
    turnAckEmittedRef.current = false;
    // Resolve the active model's render trust ONCE for this turn.
    selfRenderRef.current = resolveSelfRender();
    setStatus('thinking');
    setStatusDetail('');
    setCompaction(null);
    setStreamingBoth({ text: '', tools: [], thinking: '', timeline: [], selfRender: selfRenderRef.current }, true);
    const imageCount = Array.isArray(options.images) ? options.images.length : 0;
    setMessages((m) => [...m, { role: 'user', content: text, imageCount, timestamp: startTime }]);
    // Mirror the turn to paired LAN devices. `input` lets a remote echo the
    // prompt; the device that sent it suppresses its own echo by text match.
    bcast({ type: 'turn_start', input: text });

    // 让出事件循环一拍，先把上面刚 push 的「已发送的用户消息 + thinking spinner」刷到屏幕，
    // 再去做下游可能冻住事件循环的同步工作:网关 preflight/getStatus/re-detect 里的
    // `<cli> --version` spawnSync 探测,以及首次提交对 8786 行 toolUseLoop 的冷 require ——
    // 它们都跑在本函数 push 之后、首个真正 await 之前的同步窗口里。Ink 6 的 onRender 是
    // leading-edge 节流(只要事件循环不被占住,首帧立刻刷出),所以症状「回车几秒才显示发送」
    // 的根因正是同步风暴抢在刷帧前把循环冻住(详见 _commandAvailability.js 头注 +
    // [[project_enter_freeze_spawn_coalesce]])。让出一个宏任务即可让 React 提交 + Ink 刷帧
    // 落地;之后即便 spinner 仍被同步探测短暂卡住,用户也已看到「已发送」。kill: KHY_SUBMIT_PAINT_YIELD=0。
    if (paintYieldEnabled()) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // 每轮前工作区检查点(双击 ESC「对话+代码回溯」的代码侧前提)。务必放在 paintYield
    // *之后*:saveCheckpoint 内含 git 的 spawnSync,若放在乐观 push 之前会重现 paintYield
    // 专门修掉的首帧冻结。放这里既不阻塞首帧,又赶在任何工具写盘前(工具在下游首个真 await
    // 后才跑),故捕获的是「本轮动手前」的纯净工作区。把返回的 checkpoint id 回填到刚 push 的
    // user 消息上,供 query.rewind() 按 id 恢复。全程 fail-soft:本轮不可代码回溯而已。
    // kill: KHY_TUI_TURN_CHECKPOINT=0(大非 git 目录可关,避免整目录 tar)。
    if (_rewindControl && _rewindControl.turnCheckpointEnabled() && !options.forceLocal) {
      try {
        const ckCwd = process.env.KHYQUANT_CWD || process.cwd();
        const ck = require('../../../services/workspace/checkpointService')
          .saveCheckpoint(ckCwd, { message: `auto: TUI 轮次前 @${startTime}`, mode: 'auto' });
        if (ck && ck.id) {
          setMessages((m) => _rewindControl.patchUserCheckpointId(m, startTime, ck.id));
        }
      } catch { /* fail-soft: 本轮无法代码回溯,对话回溯不受影响 */ }
    }

    // ── Local mode (/local): skip the AI model, answer from the Tier 1 + Tier 2
    // local brain (forceLocal). Short-circuits before the tool-use loop.
    if (options.forceLocal) {
      // Honest status: the local brain may hit weather/dictionary/web APIs for a
      // few seconds. 'thinking' implies the AI model is running — say 'local'.
      setStatus('local');

      // In /local mode the user HAS a model and chose local on purpose, so strip
      // the local brain's "no AI model / configure a model" notes — here they are
      // factually wrong and the main source of the cluttered, contradictory text.
      const cleanLocal = (t) => String(t || '')
        .replace(/\n*[（(][^（）()]*(?:无可用\s*AI\s*模型|配置\s*(?:AI\s*)?模型)[^（）()]*[)）]/g, '')
        .replace(/\n*⚠[^\n]*无可用\s*AI\s*模型[^\n]*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const finishLocal = (spoken) => {
        setStreamingBoth(null);
        setCompaction(null);
        settled = true;
        setStatus('done');
        if (spoken) maybeSpeak(spoken);
        bcast({ type: 'turn_complete' });
        _ringCompletionBellIfDue(startTime);
        _pushCompletionIfDue(startTime, { ok: true, summary: spoken });
        clearTimeout(doneTimerRef.current);
        const hasQueued = queueRef.current.length > 0;
        doneTimerRef.current = setTimeout(() => {
          setStatus('idle');
          drainNext();
        }, hasQueued ? 250 : 2000);
        return { reply: spoken, provider: 'khy-local-forced' };
      };

      // Commit the answer with a subtle source tag (本地 · <category>) so the user
      // knows how it was produced; the tag is display-only — speech gets the body.
      // Rendered as a markdown blockquote (the lite renderer shows it as "│ …";
      // it does not support underscore italics for CJK).
      const commitLocal = (body, category) => {
        committedTurnRef.current = true;
        const tag = category ? `> 本地 · ${category}\n\n` : '';
        const display = tag + body;
        setMessages((m) => [...m, {
          role: 'assistant',
          content: display,
          timeline: [{ type: 'text', text: display }],
          selfRender: false,
          provider: 'khy-local-forced',
          category,
          timestamp: Date.now(),
        }]);
        return finishLocal(body);
      };

      try {
        const localBrain = require('../../../services/localBrainService');
        const fallback = await localBrain.tryFallback(text, { cwd: process.cwd(), forceLocal: true });
        if (fallback && fallback.handled) {
          return commitLocal(cleanLocal(fallback.response) || '（本地未返回内容）', fallback.category);
        }
        // tryFallback already runs its own internal web-search fallback, so
        // reaching here means it genuinely could not help (e.g. very short input,
        // or network + search both failed). Show one concise capability hint —
        // no duplicate search pass.
        const caps = typeof localBrain.listCapabilities === 'function'
          ? localBrain.listCapabilities().join('\n')
          : '';
        setMessages((m) => [...m, {
          role: 'notice',
          content: `本地模式无法处理这个请求（可能是网络不可用）。\n\n本地可直接处理：\n${caps}\n\n输入 /local 关闭本地模式，改用 AI 模型回答。`,
          timestamp: Date.now(),
        }]);
        return finishLocal(null);
      } catch (err) {
        setMessages((m) => [...m, { role: 'error', content: _withEscHint(`本地模式处理失败：${err.message}`), timestamp: Date.now() }]);
        return finishLocal(null);
      }
    }

    // ── Shared streaming handlers ──
    // Used by BOTH the native tool-use loop path (chatFn below) and the legacy
    // direct-chat fallback, so streaming/thinking/tool rendering is identical
    // regardless of which path runs the turn.
    const onChunk = (chunk) => {
      if (chunk.type === 'text') {
        // The model is narrating (possibly reacting to the just-finished tool) →
        // drop any pending synthetic "结果+行动" so we never double the model.
        if (chunk.text) {
          sawTextRef.current = true;
          segmentNarratedRef.current = true;
          segmentModelNarratedRef.current = true;
          segmentTextRef.current += chunk.text;
          pendingOutcomeRef.current = null;
        }
        safeSetStatus('streaming');
        // A thinking run (if any) ends the moment real answer text arrives → stamp
        // its REAL elapsed onto the committed timeline thinking entry.
        let _thinkDur = 0;
        if (thinkingRunStartRef.current != null) {
          _thinkDur = Date.now() - thinkingRunStartRef.current;
          thinkingRunStartRef.current = null;
        }
        setStreamingBoth((s) => {
          if (!s) return s;
          const tl0 = _thinkDur > 0 ? tlStampThinkingDuration(s.timeline || [], _thinkDur) : (s.timeline || []);
          return { ...s, text: s.text + (chunk.text || ''), timeline: tlAppendText(tl0, chunk.text || '') };
        });
        // Progressive commit (Phase 1.1): only worth attempting when the chunk
        // introduced a line break — splitSealedText can only seal at a blank
        // line, so a chunk with no '\n' can never create a new boundary. This
        // keeps the common per-token path free of an extra setMessages.
        if (chunk.text && chunk.text.indexOf('\n') !== -1) flushCompletedStages(false);
        bcast({ type: 'chunk_text', content: chunk.text || '' });
      } else if (chunk.type === 'thinking') {
        // Mark the start of a thinking run on its first chunk (real wall-clock),
        // so the duration stamped when the run ends reflects actual elapsed time.
        if (thinkingRunStartRef.current == null && (chunk.text || '')) {
          thinkingRunStartRef.current = Date.now();
        }
        setStreamingBoth((s) => (s ? {
          ...s,
          thinking: s.thinking + (chunk.text || ''),
          // Also record into the timeline so the thinking is committed to
          // scrollback (rendered folded by the transcript), not lost on finalize.
          timeline: tlAppendThinking(s.timeline || [], chunk.text || ''),
        } : s));
        bcast({ type: 'chunk_thinking', content: chunk.text || '' });
      } else if (chunk.type === 'tool_use') {
        safeSetStatus('tool');
        // 退化 no-op prose echo(如讲笑话轮的 `echo "好的…"`):派发层已在 native loop 滤掉,
        // 但本 adapter-native 流式路径不经那道过滤,echo 仍会跑。这里只抑制**围绕它的叙述**
        // (turn-ack / preface / progress)——不动工具行本身(它确实在执行,移除会与真实运行脱节)。
        // 门控与派发层同一个 KHY_DROP_DEGENERATE_ECHO;叶子缺失/异常/门控关 → 照常叙述。
        let _isDegenEcho = false;
        try {
          const _cmd = String((chunk.input && (chunk.input.command ?? chunk.input.cmd)) || '');
          // Prefer the broadened union predicate (prose echo + bare no-ops like
          // `true`/`:`/`cat`); fall back to the prose-echo predicate if an older
          // leaf build lacks it. Either way, same KHY_DROP_DEGENERATE_ECHO gate.
          const _degenFn = _degenerateShellEcho
            && (typeof _degenerateShellEcho.isDegenerateNoOp === 'function'
              ? _degenerateShellEcho.isDegenerateNoOp
              : (typeof _degenerateShellEcho.isDegenerateProseEcho === 'function'
                ? _degenerateShellEcho.isDegenerateProseEcho
                : null));
          _isDegenEcho = !!(_degenFn
            && typeof _degenerateShellEcho.degenerateEchoFilterEnabled === 'function'
            && _degenerateShellEcho.degenerateEchoFilterEnabled(process.env)
            && _degenFn(_cmd));
        } catch { _isDegenEcho = false; }
        // turn 级即时确认:adapter-native tool_use 路径同样先甩一句回应(与 native loop 对齐,
        // 每轮至多一次·模型已出文本则跳过)。退化 echo 不值得一句招呼 → 跳过。
        if (!_isDegenEcho) maybeInjectTurnAck();
        // Flush the previous tool's deferred "结果+行动" if the model stayed silent.
        flushPendingOutcome();
        // Issue B: narrate intent ahead of an adapter-native tool_use too, so the
        // legacy direct-chat path matches the native loop. Gated identically.
        if (!_isDegenEcho) maybeInjectToolPreface(chunk.name || chunk.toolName, chunk.input);
        // Attach the live "正在…" progress narration so it renders under the row.
        // Model-first: stand down when the model itself narrated this segment.
        const _prog = _isDegenEcho ? null : computeToolProgress({
          name: chunk.name || chunk.toolName,
          params: chunk.input,
          modelNarrated: segmentModelNarratedRef.current,
          occurrence: _occRead(chunk.name || chunk.toolName),
        });
        const _toolChunk = _prog ? { ...chunk, progress: _prog } : chunk;
        // A thinking run can also end at a tool call (model thought, then acted).
        let _thinkDurTool = 0;
        if (thinkingRunStartRef.current != null) {
          _thinkDurTool = Date.now() - thinkingRunStartRef.current;
          thinkingRunStartRef.current = null;
        }
        setStreamingBoth((s) => {
          if (!s) return s;
          const tl0 = _thinkDurTool > 0 ? tlStampThinkingDuration(s.timeline || [], _thinkDurTool) : (s.timeline || []);
          return { ...s, tools: [...s.tools, _toolChunk], timeline: tlPushTool(tl0, _toolChunk) };
        }, true);
        // The new tool seals the preceding text segment → commit it to history.
        flushCompletedStages(false);
        bcast({ type: 'chunk_tool_use', tool: chunk.name || chunk.toolName || 'tool', input: chunk.input, toolId: chunk.id });
      } else if (chunk.type === 'tool_result') {
        setStreamingBoth((s) => {
          if (!s) return s;
          const matchId = (t) => t.id === chunk.toolUseId || t.id === chunk.toolUseID;
          // Adapter-native tool_result chunks keep their full shape (no field
          // stripping here, unlike the loop's markToolResult). The only parity
          // gap with the loop path was the per-tool success SUMMARY, so attach it
          // ADDITIVELY — derived from the matched tool's name/input — without
          // touching any existing chunk field, so is_error/error rendering can
          // never regress. This makes the summary appear regardless of which
          // path (loop callback vs native chunk) delivered the result.
          const isErr = !!(chunk.is_error || chunk.isError || chunk.success === false || chunk.error);
          const decorate = (t) => {
            if (isErr || chunk.summary) return chunk;
            try {
              const summary = summarizeToolResult(t.name || t.toolName || t.tool, chunk, t.input);
              return summary ? { ...chunk, summary } : chunk;
            } catch { return chunk; }
          };
          const tools = s.tools.map((t) => (matchId(t) ? { ...t, result: decorate(t) } : t));
          // Timeline resolution reuses the loop's match-by-name path; decorate the
          // result there too so a native chunk shows the same summary line.
          const decoratedForTimeline = (() => {
            const t = s.tools.find(matchId);
            return t ? decorate(t) : chunk;
          })();
          return { ...s, tools, timeline: tlResolveTool(s.timeline || [], matchId, decoratedForTimeline) };
        }, true);
        // The tool just completed → drain it (and any sealed text before it).
        flushCompletedStages(false);
        // New segment after the result → allow the next silent tool to narrate.
        segmentNarratedRef.current = false;
        segmentModelNarratedRef.current = false;
        segmentTextRef.current = '';
        // Stash the "结果+行动" reflection. setStreamingBoth updated liveRef
        // synchronously above, so the matched row (with name+input) is available
        // to attribute the chunk's structured result to the right tool.
        {
          const liveTools = (liveRef.current && liveRef.current.tools) || [];
          const m = liveTools.find((t) => t.id === chunk.toolUseId || t.id === chunk.toolUseID);
          const tname = m && (m.name || m.toolName || m.tool);
          pendingOutcomeRef.current = computeToolOutcome({ name: tname, result: chunk, params: m && m.input, occurrence: _occRead(tname) }) || null;
          _occBump(tname);
        }
        bcast({ type: 'chunk_tool_result', content: chunk.text || chunk.content || '' });
      } else if (chunk.type === 'notice' || chunk.type === 'status') {
        safeSetStatus(chunk.phase || idlePhase());
        safeSetDetail(chunk.message || chunk.text || chunk.content);
      } else if (chunk.type === 'assistant_message') {
        // 用户可见的中间消息(如视觉路由说明:文本模型先说明「我无法识别图片,正在调用视觉模型」)。
        // 这是 khy 在回合中对用户说的一句话 → 提交为一条独立的 assistant 消息行,渲染进 scrollback,
        // 后续流式最终答复自然出现在其下方。与 error 分支同法(setMessages 提交),但角色为 assistant。
        const msgText = String(chunk.content || chunk.text || '').trim();
        if (msgText) {
          setMessages((m) => [...m, { role: 'assistant', content: msgText, timestamp: Date.now(), intermediate: true }]);
        }
      } else if (chunk.type === 'error') {
        setMessages((m) => [...m, { role: 'error', content: _withEscHint(chunk.text || chunk.message || '错误'), timestamp: Date.now() }]);
      }
    };
    const onStatus = (evt) => {
      // ai.js may pass either a bare phase string or a structured object
      // ({phase, message, stage, pct, tokensBefore, startedAt}). Normalize both.
      const phase = typeof evt === 'string' ? evt : (evt && evt.phase);
      // Retain the human-readable detail (message). A bare string that is itself a
      // coarse phase token is NOT a message — skip it so detail never becomes "tool".
      const detailText = typeof evt === 'string'
        ? (/^(init|request|thinking|generating|streaming|tool|tool_progress|plan|compacting|compacted|summary|done|local|idle)$/i.test(evt.trim()) ? '' : evt)
        : (evt && (evt.message || evt.detail || evt.text));
      safeSetDetail(detailText);
      if (phase === 'compacting') {
        const p = (typeof evt === 'object' && evt) ? evt : {};
        setCompaction((prev) => ({
          active: true,
          pct: typeof p.pct === 'number' ? p.pct : (prev ? prev.pct : 0),
          stage: p.stage || (prev ? prev.stage : 'starting'),
          tokensBefore: p.tokensBefore || (prev ? prev.tokensBefore : 0),
          startedAt: p.startedAt || (prev ? prev.startedAt : startTime),
        }));
        setStatus('compacting');
        return;
      }
      if (phase === 'compacted') {
        // Compaction finished; the turn continues into thinking/streaming.
        // Commit a one-line result to scrollback showing the REAL reduction
        // (before → after) so the user sees what compaction actually did, not
        // just that it happened. Skipped when the backend reports no usable
        // numbers (e.g. tool-result truncation with no token estimate).
        const p = (typeof evt === 'object' && evt) ? evt : {};
        const notice = formatCompactionResult(p);
        if (notice) {
          setMessages((m) => [...m, { role: 'notice', content: notice, timestamp: Date.now() }]);
        }
        setCompaction(null);
        safeSetStatus('thinking');
        return;
      }
      if (phase === 'tool') safeSetStatus('tool');
      else if (phase === 'streaming') safeSetStatus('streaming');
      else safeSetStatus(phase || idlePhase());
    };
    const onControlRequest = (req) =>
      new Promise((resolve) => {
        // Mirror permission prompts to paired devices so they can approve/deny
        // remotely. AskUserQuestion (selection menu) is left local-only — the
        // mobile approval card models y/n, not a multi-choice menu. The id lets
        // resolveControl emit a matching approval_resolved.
        const r = (req && req.request) ? req.request : req;
        const tool = r && (r.tool_name || r.tool);
        const isQuestion = String(r && r.subtype || '').toLowerCase() === 'can_use_tool'
          && String(tool || '').toLowerCase().replace(/[\s_-]/g, '') === 'askuserquestion';
        const bridgeRequestId = (req && req.requestId)
          || (r && r.requestId)
          || `ctrl-${Date.now()}-${Math.floor((startTime % 100000))}`;
        if (!isQuestion) {
          bcast({ type: 'approval_request', requestId: bridgeRequestId, tool: tool || 'tool', input: (r && r.input) || '' });
        }
        // The turn is about to pause for the user. Commit the model's preamble /
        // question text to history now so it is not folded behind the overlay
        // and remains in scrollback after the prompt resolves.
        flushCompletedStages(false, null, true);
        const ctrl = { ...req, resolve, _bridgeRequestId: isQuestion ? null : bridgeRequestId };
        controlRequestRef.current = ctrl;
        setControlRequest(ctrl);
      });

    // Issue B「过程是直接执行命令，而不是先说要做什么」: when the model jumps
    // straight to a tool with no narration for this segment, inject a short
    // first-person preface ("我先看下 …") AHEAD of the tool so the user sees the
    // intent before the command runs — mirroring the REPL path. Shared single
    // source of truth (toolPrefaceVoice). No-ops when the model already narrated
    // (segmentNarratedRef) or via KHY_TOOL_PREFACE=0. The injected text becomes
    // the tool's preceding segment, so the subsequent tool push seals & commits
    // it to scrollback like any model text. Returns nothing; best-effort.
    // 过程叙述「不机械」:本回合该类工具已出现几次(读 = 不自增,供 before/during/after
    // 三拍共用同一 occurrence;自增只在工具收尾后发生,让"下一次同类调用"轮换续接句)。
    const _occRead = (name) => {
      try {
        const key = (_toolPrefaceVoice && _toolPrefaceVoice.occurrenceKey)
          ? _toolPrefaceVoice.occurrenceKey(name) : String(name || '').toLowerCase();
        return prefaceCountsRef.current.get(key) || 0;
      } catch { return 0; }
    };
    const _occBump = (name) => {
      try {
        const key = (_toolPrefaceVoice && _toolPrefaceVoice.occurrenceKey)
          ? _toolPrefaceVoice.occurrenceKey(name) : String(name || '').toLowerCase();
        const m = prefaceCountsRef.current;
        m.set(key, (m.get(key) || 0) + 1);
      } catch { /* cosmetic counter — never disturb the turn */ }
    };

    const maybeInjectToolPreface = (name, params) => {
      // 连续同类工具抑制(修刷屏):上一条已发出 preface 的工具与本工具同类 → 静默。
      // 叶子不可用 / 门控关 → suppress 返 false,行为逐字节回退历史。
      try {
        if (_toolPrefaceVoice && typeof _toolPrefaceVoice.suppressConsecutivePreface === 'function'
          && _toolPrefaceVoice.suppressConsecutivePreface(name, lastPrefaceKeyRef.current, process.env)) {
          return;
        }
      } catch { /* 抑制判定出错绝不吞掉叙述 → 照常往下发 */ }
      const preface = computeToolPreface({
        name,
        params,
        segmentNarrated: segmentNarratedRef.current,
        segmentText: segmentTextRef.current,
        occurrence: _occRead(name),
      });
      if (!preface) return;
      const seg = preface + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
      segmentNarratedRef.current = true;
      // 记下本条已发出 preface 的工具类别,供下一次同类调用抑制。
      try {
        lastPrefaceKeyRef.current = (_toolPrefaceVoice && _toolPrefaceVoice.occurrenceKey)
          ? _toolPrefaceVoice.occurrenceKey(name) : String(name || '').toLowerCase();
      } catch { /* cosmetic tracker — never disturb the turn */ }
    };

    // turn 级即时确认「先回应用户,再干活」(2026-07-05 用户反馈):本轮首个工具即将派发时,若模型
    // 尚未自己吐出任何文本,注入一句确定性短确认(「收到,我来处理。」…),让用户在命令真正跑之前
    // 先看到 khy 的回应。每轮至多一次(turnAckEmittedRef);模型已出文本(sawTextRef)=用户已被回应
    // → 判空跳过(不叠加,避免模板领跑)。commit 机制镜像 maybeInjectToolPreface,但**不动**
    // segmentNarratedRef——ack 是 turn 级招呼、不代表某工具意图,首工具自己的 preface 仍应能出。
    // 叶子缺失/门控关/异常 → 无 ack,逐字节回退历史。best-effort,绝不打断本轮。
    const maybeInjectTurnAck = () => {
      if (turnAckEmittedRef.current) return;
      turnAckEmittedRef.current = true; // 判定前置位:无论产不产句,本轮不再进入。
      let line = '';
      try {
        if (_turnAckVoice && typeof _turnAckVoice.computeTurnAck === 'function') {
          line = _turnAckVoice.computeTurnAck({
            turnIndex: turnSeqRef.current,
            sawText: sawTextRef.current,
            env: process.env,
          });
        }
      } catch { line = ''; }
      if (!line) return;
      const seg = line + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
    };

    // Task-level proactive announcement: surface the model's parsed
    // <execution_plan> as ONE upfront "here's how I'll do this" segment before the
    // first tool runs. Mirrors maybeInjectToolPreface's commit mechanics and sets
    // segmentNarratedRef so the first tool's per-tool preface doesn't re-state the
    // framing. No-op when the gate stays silent (model already narrated this
    // segment, disabled, or a trivial single-step plan).
    const maybeInjectPlanAnnouncement = (plan) => {
      const text = computePlanAnnouncement({ plan, segmentModelNarrated: segmentModelNarratedRef.current });
      if (!text) return;
      const seg = text + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
      segmentNarratedRef.current = true;
    };

    // 关键节点主动汇报：把 loop 发来的 finding 渲成一个独立可见文本段。测试结果用
    // composeFindingReport，模型 finding（根因/突破/受阻）用 composeModelFinding。
    // 测试结果与 flushPendingOutcome 的逐工具兜底会对同一 bash 结果重复 → 注入时
    // 清掉 pendingOutcomeRef，避免双行。
    const maybeInjectKeyFinding = (finding) => {
      if (!_keyFindings || !finding) return;
      let text = '';
      try {
        text = finding.kind === 'test'
          ? _keyFindings.composeFindingReport(finding)
          : _keyFindings.composeModelFinding(finding);
      } catch { text = ''; }
      if (!text) return;
      if (finding.kind === 'test') pendingOutcomeRef.current = null; // 去重逐工具兜底
      const seg = text + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
    };

    // 批2: default-on (opt-out via KHY_PLAN_PROGRESS=0) plan-anchored step
    // transition committed as its own segment as each step starts. Does NOT touch
    // segmentNarratedRef (it narrates forward motion, not a tool's intent),
    // mirroring flushPendingOutcome.
    const maybeInjectPlanProgress = (plan, stepIndex, status) => {
      const text = computePlanProgress({ plan, stepIndex, status, segmentModelNarrated: segmentModelNarratedRef.current });
      if (!text) return;
      const seg = text + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
    };

    // "结果 + 行动": flush the previous tool's deferred completion reflection as
    // its own committed text segment. Called when the model stayed SILENT and the
    // turn is about to move on (next tool push, or finalize). Deliberately does
    // NOT touch segmentNarratedRef — the reflection narrates the PAST result, so
    // the NEXT tool's intent preface must still be free to fire after it. No-op
    // when nothing is pending or KHY_TOOL_OUTCOME=0 left it null.
    //
    // FALLBACK ROLE (goal 2026-06-24): the PRIMARY reflection path is now the
    // loop-side context reference (toolUseLoop._buildOutcomeReflectionHint) handed
    // to the model so it narrates the outcome in its own voice. This synthetic
    // render only fires when the model ignores that reference and stays silent —
    // the moment any model text arrives, the onChunk text branch clears
    // pendingOutcomeRef, so the two layers never double up.
    const flushPendingOutcome = (opts = {}) => {
      const text = pendingOutcomeRef.current;
      if (!text) return;
      // Terminal honesty gate: at end-of-turn, suppress the forward-looking
      // outcome line when nothing actually followed (model silent, or the answer
      // was a raw salvage dump). Inter-tool flushes pass no opts → always flush.
      if (opts.terminal && !shouldFlushTerminalOutcome({ sawText: sawTextRef.current, salvaged: opts.salvaged })) {
        pendingOutcomeRef.current = null; // consume without rendering the false line
        return;
      }
      pendingOutcomeRef.current = null;
      const seg = text + '\n';
      setStreamingBoth((s) => (s ? {
        ...s,
        text: s.text + seg,
        timeline: tlAppendText(s.timeline || [], seg),
      } : s));
    };

    // ── Native tool-use loop → tool-display bridges ──
    // In the native loop the OUTER loop (not the adapter) executes tools and
    // reports via onToolCall/onToolResult. Some adapters ALSO emit tool_use
    // chunks (handled above); we de-dupe by the loop's real tool_use_id when
    // present (Claude-Code AgentTool pattern) so each tool shows exactly once
    // and flips ◆ → ✓/✗ when it completes. The id is authoritative: two
    // same-name tools in one turn (two Reads, two Bashes) no longer cross
    // results. Name is only a fallback for legacy callers without an id.
    const pushToolFromLoop = (name, params, toolId) => {
      const id = toolId || `loop-${name}`;
      // turn 级即时确认「先回应用户」:本轮首个工具即将派发 → 先甩一句 khy 的回应,再往下走。
      // 每轮至多一次;模型已出文本时判空跳过。排在最前,时间线顺序:
      // turn-ack → 上一步结果 → 这一步意图 → tool。
      maybeInjectTurnAck();
      // The model stayed silent past the previous result → emit its deferred
      // "结果+行动" reflection first, then narrate this tool's intent. Order in the
      // timeline: 上一步结果 → 这一步意图 → tool.
      flushPendingOutcome();
      // Narrate intent BEFORE the tool push so the preface sits ahead of the
      // tool in the timeline and gets sealed with it.
      maybeInjectToolPreface(name, params);
      // Model-first: the running-line stands down if the model narrated this
      // segment itself (its prose plan is the transparency).
      const progress = computeToolProgress({ name, params, modelNarrated: segmentModelNarratedRef.current, occurrence: _occRead(name) });
      setStreamingBoth((s) => reduceToolPush(s, { name, params, id, toolId, progress }), true);
      // Seal + commit the text that preceded this tool call.
      flushCompletedStages(false);
      safeSetStatus('tool');
      bcast({ type: 'chunk_tool_use', tool: name, input: params, toolId: id });
      // Agent-family tool → hand the loop an onAgentProgress callback so the
      // orchestrator's per-child lifecycle events build a live ├│└ tree ON this
      // tool row (rendered by ToolLines in place of the single agent(...) line).
      // The loop merges this return into call._traceContext for EVERY call —
      // single and parallel alike — so no separate onParallelBatch is needed.
      // Escape hatch KHY_AGENT_TREE=0 falls back to the old single-line agent row.
      if (isAgentFamilyTool(name) && String(process.env.KHY_AGENT_TREE ?? '').trim() !== '0') {
        return { onAgentProgress: makeAgentProgress(id) };
      }
      return undefined;
    };
    // Build the per-tool onAgentProgress sink: each event (orchestrator-forwarded
    // agent_spawned/started/completed/failed, or a leaf agent's tool_start/
    // tool_end/done) is keyed by the child agentId (a standalone single agent
    // with no id falls back to one branch) and folded through the SHARED pure
    // reducer, then re-projected onto the tool row. Cosmetic — never throws back
    // into the loop.
    const makeAgentProgress = (batchId) => (event) => {
      if (!event) return;
      try {
        let perBatch = agentTreesRef.current.get(batchId);
        if (!perBatch) { perBatch = new Map(); agentTreesRef.current.set(batchId, perBatch); }
        const key = event.agentId != null ? String(event.agentId) : `solo-${batchId}`;
        const prev = perBatch.get(key) || makeAgentState({ id: key, name: event.name });
        perBatch.set(key, applyProgressEvent(prev, event));
        const agents = Array.from(perBatch.values());
        setStreamingBoth((s) => reduceAgentTree(s, { toolId: batchId, agents }), true);
      } catch { /* tree is cosmetic; never disturb the loop */ }
    };
    const markToolResult = (name, res, params, toolId) => {
      // Single source of truth for the view-result shape — carries text,
      // failure reason, denied flag, the ±diff context and the success summary
      // through to ink (see projectToolResultForView for why each field
      // matters). The tool name + params let it derive the per-tool summary.
      const result = projectToolResultForView(res, name, params);
      setStreamingBoth((s) => reduceToolResult(s, { name, result, toolId }), true);
      // The tool just completed → drain it (and any sealed text before it).
      flushCompletedStages(false);
      // A new segment begins after this result: the next silent tool may narrate
      // again (mirrors REPL's per-tool preface gating).
      segmentNarratedRef.current = false;
      segmentModelNarratedRef.current = false;
      segmentTextRef.current = '';
      // Stash the "结果+行动" reflection from the RAW result (the view projection
      // strips the counts/lines it needs). Flushed later only if the model stays
      // silent; cleared if the model narrates the result itself.
      pendingOutcomeRef.current = computeToolOutcome({ name, result: res, params, occurrence: _occRead(name) }) || null;
      _occBump(name);
      // Harvest this call's signature into the cross-turn ring iff it SUCCEEDED —
      // only a call that actually produced a result should suppress a future
      // re-run. Bounded to the last 8 so long sessions can't accumulate false
      // positives. Fail-soft: a harvest error never disturbs the result render.
      try {
        const ok = res && res.success !== false && !res.denied && !res.error;
        if (ok) {
          const sigFor = require('../../../services/toolUseLoop')._signatureForCall;
          const { sig, intentKey } = sigFor(name, params || {}, null);
          if (sig || intentKey) {
            recentToolSigsRef.current.push({ sig, intentKey });
            if (recentToolSigsRef.current.length > 8) recentToolSigsRef.current.shift();
          }
        }
      } catch { /* signature harvest is best-effort */ }
      bcast({ type: 'chunk_tool_result', content: (res && (res.text || res.output || res.content)) || '' });
    };

    // CC 对齐计划模式(KHY_PLAN_CC_RESEARCH):计划轮(permissionMode:'plan')走真·工具循环时,
    // 开 per-turn 只读窗口——使 toolCalling 只读闸在这一轮生效(只调研、不改动),finally 清零。
    // 门控随 planModeDirective:门关时 App 仍走旧单次 startPlan,计划轮不会抵达这里。
    let _planTurn = false;
    try {
      _planTurn = options.permissionMode === 'plan'
        && require('../../../services/planModeDirective').isPlanResearchEnabled(process.env);
    } catch { _planTurn = false; }
    if (_planTurn) {
      try { require('../../../services/planModeSink').setTurnReadOnly(true); } catch { /* fail-soft */ }
    }

    try {
      let result;
      // ── 确定性「贴 key 即配好」拦截(TUI 侧,承经典 REPL 的 detectQuickTask 拦截)──
      // 真源问题:ink TUI 的普通轮此前**完全没有**确定性快速任务拦截(只有 /local 强制
      // 本地模式才碰 localBrain)——所以用户在对话里直接粘一把裸 API key,会径直进模型,
      // 模型只会「分析这是什么 token」。经典 repl.js 早有此拦截,TUI 却漏了 → 补齐。
      //
      // 只拦截 key_update(裸 key 入池):这类由 keyUpdateFlow.looksLikeBareKey 按**形态**
      // 识别(hex32.secret→glm 等),alwaysDeterministic → 有模型也介入,全程无需模型、
      // 无网络、大小写保真写入对应 provider 池。裸 key 绝不是图注,故即便本轮带图也拦截。
      // 门控随 KHY_KEY_UPDATE_FLOW(默认开,由 looksLikeBareKey 内部判定);任何异常 fail-soft
      // 落回正常模型轮(逐字节回退)。仅普通轮生效:计划轮/禁工具轮不在此路径。
      if (!options.forceLocal && !options.disableNaturalToolLoop) {
        try {
          const _lb = require('../../../services/localBrainService');
          const _plan = _lb.detectDeterministic(text, { cwd: process.cwd() });
          if (_plan && _plan.type === 'key_update') {
            const _res = _lb.executeDeterministic(_plan, { cwd: process.cwd() });
            const _reply = _lb.formatDeterministicResult(_res);
            const _body = (typeof _reply === 'string' && _reply.trim())
              ? _reply
              : (_res && _res.success ? '已配置密钥。' : '密钥配置失败。');
            committedTurnRef.current = true;
            setMessages((m) => [...m, {
              role: 'assistant',
              content: _body,
              timeline: [{ type: 'text', text: _body }],
              selfRender: false,
              provider: 'khy-local-forced',
              category: '更新密钥',
              timestamp: Date.now(),
            }]);
            setStreamingBoth(null);
            setCompaction(null);
            settled = true;
            setStatus('done');
            bcast({ type: 'turn_complete' });
            _ringCompletionBellIfDue(startTime);
            clearTimeout(doneTimerRef.current);
            const _hasQueued = queueRef.current.length > 0;
            doneTimerRef.current = setTimeout(() => {
              setStatus('idle');
              drainNext();
            }, _hasQueued ? 250 : 2000);
            return { reply: _body, provider: 'khy-local-forced' };
          }
          // 「打造最佳环境」→ env_optimize:用户在输入框里说一句自然语言即触发
          // 自检 + 自愈流水线(baseSelfCheckService.runOnce)。executor 是**异步**的
          // (跑真实自检),故须 await;门控 KHY_ENV_OPTIMIZE(默认开,由 detect 内部判定)。
          // cooperative:false → 有模型也介入(这是确定性系统动作,不是问模型该怎么办)。
          if (_plan && _plan.type === 'env_optimize') {
            // 确保 plugin-doctor 已在中立 port 上注册:TUI 在 repl.js 的插件自动加载
            // 块(startInkApp 早返回)之前就分叉,plugin-dev 从未 self-register 过
            // doctor → 自检里 doctor 子项恒「hook unavailable」拖分。此处按需触发一次
            // plugin-dev 加载(cli→cli 合法方向,不碰 pluginDoctorPort 的零依赖叶子约束),
            // 让 baseSelfCheck 的 forcePluginDoctor 真正跑到。best-effort,失败 fail-soft
            // 落回原「skipped」降级(逐字节保留旧行为)。
            try { require('../../handlers/plugin-dev'); } catch { /* doctor 缺失 → 自检降级 skipped */ }
            const _res = await Promise.resolve(_lb.executeDeterministic(_plan, { cwd: process.cwd() }));
            const _reply = _lb.formatDeterministicResult(_res);
            const _body = (typeof _reply === 'string' && _reply.trim())
              ? _reply
              : (_res && _res.success ? '环境自检完成。' : '环境自检失败。');
            committedTurnRef.current = true;
            setMessages((m) => [...m, {
              role: 'assistant',
              content: _body,
              timeline: [{ type: 'text', text: _body }],
              selfRender: false,
              provider: 'khy-local-forced',
              category: '环境优化',
              timestamp: Date.now(),
            }]);
            setStreamingBoth(null);
            setCompaction(null);
            settled = true;
            setStatus('done');
            bcast({ type: 'turn_complete' });
            _ringCompletionBellIfDue(startTime);
            clearTimeout(doneTimerRef.current);
            const _hasQueued = queueRef.current.length > 0;
            doneTimerRef.current = setTimeout(() => {
              setStatus('idle');
              drainNext();
            }, _hasQueued ? 250 : 2000);
            return { reply: _body, provider: 'khy-local-forced' };
          }
        } catch { /* fail-soft: 拦截失败 → 照常走模型轮 */ }
      }
      // Whether the loop fell back to a raw tool-result salvage (no model
      // deliverable). Read at the terminal honesty gate below. Only the native
      // loop can salvage; the direct-chat path leaves it false.
      let _loopSalvaged = false;
      // Default turn path: route through the native tool-use loop — the SAME
      // engine the classic REPL uses (repl.js runToolUseLoop) — so native
      // tool_use blocks (Kiro etc.) actually execute. ai().chat() alone only has
      // the INNER natural-language loop, which can't run native tool_use and
      // leaks a "[模型请求执行工具: NAME]" placeholder as the reply. Opt out with
      // KHY_TUI_NATIVE_LOOP=0, or when the caller disables the loop (e.g. plan
      // generation). Falls back to direct chat if the loop module is unavailable.
      let useNativeLoop = !options.disableNaturalToolLoop
        && String(process.env.KHY_TUI_NATIVE_LOOP ?? '').trim() !== '0';
      let toolUseLoop = null;
      if (useNativeLoop) {
        try {
          toolUseLoop = require('../../../services/toolUseLoop');
          useNativeLoop = typeof toolUseLoop.runToolUseLoop === 'function' && toolUseLoop.isEnabled();
        } catch { useNativeLoop = false; }
      }

      if (useNativeLoop) {
        // chatFn: each model turn streams through the shared handlers above. The
        // INNER NL loop is disabled (disableNaturalToolLoop) because the OUTER
        // runToolUseLoop owns tool execution — exactly how AgentTool drives it.
        const chatFn = (message, chatOpts = {}) => ai().chat(message, {
          ...chatOpts,
          disableNaturalToolLoop: true,
          abortSignal: controller.signal,
          onChunk,
          onStatus,
          onControlRequest,
        });
        // Task-level proactive narration: the loop parses the model's
        // <execution_plan> and fires onPlanReady once / onPlanProgress per step.
        // Stash the plan from onPlanReady so onPlanProgress (which only carries an
        // index + status) can resolve the step description for its transition line.
        let _loopPlan = null;
        // ESC → 取消在途工具 + 迭代间断开本轮:把这条会话的 controller.signal(abort() 已由 ESC
        // 触发,见下方 abort 处理)交给 loop,使工具执行也认这次中断。门控 KHY_TOOL_ABORT_SIGNAL;
        // 关 → 不传 abortSignal,loop 不 cascade 到 parentAbort,逐字节回退今日行为。
        let _toolAbortWiring = true;
        try { _toolAbortWiring = require('../../../services/flagRegistry').isFlagEnabled('KHY_TOOL_ABORT_SIGNAL', process.env); }
        catch { _toolAbortWiring = true; }
        const loopResult = await toolUseLoop.runToolUseLoop(text, {
          chat: chatFn,
          chatOpts: { ...options },
          ...(_toolAbortWiring ? { abortSignal: controller.signal } : {}),
          // Cross-turn repeat guard: feed the recent successful signatures so a
          // call already answered in a prior turn is steered, not silently re-run.
          recentToolSignatures: {
            exact: recentToolSigsRef.current.map((e) => e.sig).filter(Boolean),
            intents: recentToolSigsRef.current.map((e) => e.intentKey).filter(Boolean),
          },
          onControlRequest,
          onToolCall: (name, params, _iteration, toolId) => pushToolFromLoop(name, params, toolId),
          onToolResult: (name, params, res, _iteration, _elapsed, toolId) => markToolResult(name, res, params, toolId),
          // 自维护顾问人面(§2 工具路径):AI 面已由 loop 注入 currentMessage,这里只把给人
          // 看的一行作为 notice 追加(闲时可见)。best-effort,绝不影响本轮。
          onSelfEditAdvisory: (adv) => {
            try {
              if (adv && adv.humanLine) setMessages((m) => [...m, { type: 'notice', content: adv.humanLine, timestamp: Date.now() }]);
            } catch { /* best-effort */ }
          },
          onPlanReady: (plan) => { _loopPlan = plan; maybeInjectPlanAnnouncement(plan); },
          onPlanProgress: (stepIndex, status) => maybeInjectPlanProgress(_loopPlan, stepIndex, status),
          onKeyFinding: (finding) => maybeInjectKeyFinding(finding),
          // CC 对齐计划模式:计划轮把真·循环切进「先调研、后计划」——loop 注入 research-first
          // 指令、只读闸只放 Read/Grep/Glob/... 实时渲染工具调用(无大方框),模型调 ExitPlanMode(plan)
          // 时 loop 回调这里,交宿主设 reviewing 态弹既有 PlanApproval。非计划轮 _planTurn=false,不挂。
          ...(_planTurn ? {
            planMode: true,
            onExitPlanMode: (p) => {
              const fn = hostOnExitPlanModeRef.current;
              if (typeof fn === 'function') { try { fn(p); } catch { /* fail-soft */ } }
            },
          } : {}),
          // Busy-input steer: pull-and-clear any 「方向修正」 typed while this turn
          // runs. The loop injects them at each tool boundary. With the drain
          // policy set to 'tool' (KHY_TUI_QUEUE_DRAIN=tool), plain FIFO queue items
          // are ALSO pulled inter-tool (CC-style immediacy); the default 'turn'
          // keeps new topics for end-of-turn so they never derail the active task.
          getSteerMessages: () => {
            const out = steerQueueRef.current.splice(0);
            if (String(process.env.KHY_TUI_QUEUE_DRAIN ?? '').trim() === 'tool'
                && queueRef.current.length > 0) {
              for (const it of queueRef.current.splice(0)) {
                out.push(it && typeof it.text === 'string' ? it.text : String(it ?? ''));
              }
              _syncQueue();
            }
            if (out.length) _syncSteer();
            return out;
          },
          // /s! urgent preempt: true exactly once after preemptForSteer fired, so
          // the loop re-issues this turn in place with the steer injected.
          consumeUrgentSteer: () => {
            const v = urgentSteerRef.current;
            urgentSteerRef.current = false;
            return v;
          },
        });
        _loopSalvaged = !!(loopResult && loopResult.salvaged);
        result = {
          reply: loopResult && loopResult.finalResponse,
          provider: loopResult && loopResult.provider,
          tokenUsage: loopResult && loopResult.tokenUsage,
        };
      } else {
        result = await ai().chat(text, {
          ...options,
          abortSignal: controller.signal,
          onChunk,
          onStatus,
          onControlRequest,
        });
      }

      // Finalize from fresh refs / the result payload (KHY returns {reply,...}).
      // Truth precedence: `live.text` (the verbatim accumulation of every text
      // chunk the user saw stream) is the complete superset and wins. The
      // backend `result.reply` may be stripped/trimmed, so it is only a fallback
      // for non-streaming adapters that return a reply without emitting text
      // chunks. This guarantees "what streamed is what is stored" — the tail is
      // never replaced/truncated at commit time.
      const live = liveRef.current || {};
      const meta = {
        provider: result?.provider,
        adapter: result?.adapter,
        tokenUsage: result?.tokenUsage,
      };
      // The turn ended with the model silent past the last result → emit its
      // "结果+行动" reflection as the closing line before the drain (no-op if the
      // model already narrated, which cleared it). Terminal honesty gate: a turn
      // that produced no deliverable (silent, or a raw salvage dump) must not
      // close on a forward-looking "我接着往下走" that never happened.
      flushPendingOutcome({ terminal: true, salvaged: _loopSalvaged });
      // Drain whatever remains of the turn (the final open text segment + any
      // still-pending tool) into history, carrying the turn's metadata. Most
      // stages were already committed incrementally as they completed.
      const committedRemainder = flushCompletedStages(true, meta);
      // Non-streaming-adapter fallback: nothing ever streamed (empty timeline,
      // no fragments committed) but the adapter returned a reply payload. Commit
      // it as the sole assistant message. Truth precedence still prefers the
      // verbatim streamed text (live.text) when present.
      if (!committedRemainder && !committedTurnRef.current) {
        const finalText = live.text || (result && (result.reply || result.text)) || '';
        if (finalText) {
          committedTurnRef.current = true;
          setMessages((m) => [
            ...m,
            {
              role: 'assistant',
              content: finalText,
              timeline: [{ type: 'text', text: finalText }],
              selfRender: selfRenderRef.current,
              ...meta,
              timestamp: Date.now(),
            },
          ]);
        }
      }
      // Record context occupancy from the turn's reported usage so the footer
      // shows a real fill percentage instead of a hardcoded 0%.
      const usage = result && result.tokenUsage;
      let _turnTokens = 0; // 总量(输入+输出)= 门控关时占用/统计行的回退口径
      if (usage && typeof usage === 'object') {
        const total = Number(usage.totalTokens)
          || (Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0));
        if (total > 0) _turnTokens = total;
        // 页脚 context-fill = 输入侧占用(CC calculateContextPercentages 口径,排除 output)。
        const occ = pickContextOccupancyTokens(usage, _turnTokens);
        if (occ > 0) {
          setContextTokens(occ);
          _idleTokensRef.current = occ; // 供久别重返判定用（最近上下文占用）
        }
      }
      // CC 后端口径对齐:回合统计行的 token 走 pickTurnStatsTokens —— CC REPL.tsx:3762 用
      // `getTurnOutputTokens()`(仅输出增量),不是输入+输出总量。门控见该纯助手。
      const _statsTokens = pickTurnStatsTokens(usage, _turnTokens);
      // CC 风格回合收尾统计行 `✓ 1m30s · 3 工具 · 1.2k tokens` — 全部绑真实后端态:
      // 墙钟 elapsed、后端权威 toolCallLog 长度、上报 tokenUsage。门控关 / trivial 抑噪
      // → buildTurnStatsLine 返 null → 不追加(逐字节回退)。display-only role,绝不回灌模型。
      try {
        const _statsLine = buildTurnStatsLine({
          elapsedMs: Date.now() - Number(startTime || Date.now()),
          tokens: _statsTokens,
          toolCount: Array.isArray(result && result.toolCallLog) ? result.toolCallLog.length : 0,
        });
        if (_statsLine) {
          setMessages((m) => [...m, { role: 'turn-stats', content: _statsLine, timestamp: Date.now() }]);
        }
      } catch { /* stats line is cosmetic; never disrupt a turn's terminal transition */ }
      // 缓存命中率警告(对齐 CC cacheWarning.ts 每回合一次性 system 警告):命中率
      // 跌破阈值(默认 80%)时浮现一行 dim 通知,并带 vs 上回合的趋势箭头。首观只播种
      // 不警告;无缓存数据(usage 无 read/write 段)→ null 不动 state。display-only,
      // 绝不回灌模型;门控关 / 任何错误 → no-op(逐字节回退)。
      try {
        // eslint-disable-next-line global-require
        const cacheWarn = require('../../cacheWarning');
        const cw = cacheWarn.cacheWarningFor(
          { usage, lastHitRate: _lastCacheHitRateRef.current },
          process.env,
        );
        if (cw) {
          _lastCacheHitRateRef.current = cw.hitRate;
          if (cw.text) {
            setMessages((m) => [...m, { role: 'notice', content: cw.text, timestamp: Date.now() }]);
          }
        }
        // 会话累计命中率(承 KHY_CACHE_SESSION_AGGREGATE)。经典 REPL 孪生同点接线,两面
        // 不 drift。比单轮稳;仅 ≥2 轮显示。门控关 / 任何错误 → null 不累计不追加(逐字节回退)。
        const agg = cacheWarn.sessionAggregateFor(
          { usage, session: _sessionCacheRef.current },
          process.env,
        );
        if (agg) {
          _sessionCacheRef.current = agg.session;
          if (agg.text) {
            setMessages((m) => [...m, { role: 'notice', content: agg.text, timestamp: Date.now() }]);
          }
        }
      } catch { /* cache warning is cosmetic; never disrupt a turn */ }
      // 会话花费阈值一次性警告(对齐 CC CostThresholdDialog:累计会话 API 花费首次
      // 越过阈值 —— CC 硬编码 $5 —— 时提醒一次)。一次性由 _costThresholdWarnedRef 守
      // (对齐 hasShownCostDialog),display-only 绝不阻断/回灌模型/碰预算权限。花费取
      // tokenUsageService 累计会话真值;门控 KHY_COST_THRESHOLD_WARNING 关 / 任何错误
      // → no-op(不追加通知,逐字节回退)。经典 REPL 孪生同点接线,两面不 drift。
      try {
        // eslint-disable-next-line global-require
        const costWarn = require('../../costThresholdWarning');
        // eslint-disable-next-line global-require
        const tokenSvc = require('../../../services/tokenUsageService');
        const sessionCostUSD = tokenSvc.getSessionCost().costUSD;
        const cw = costWarn.costThresholdFor(
          { sessionCostUSD, alreadyWarned: _costThresholdWarnedRef.current },
          process.env,
        );
        if (cw && cw.text) {
          _costThresholdWarnedRef.current = true;
          setMessages((m) => [...m, { role: 'notice', content: cw.text, timestamp: Date.now() }]);
        }
      } catch { /* cost warning is cosmetic; never disrupt a turn */ }
      setStreamingBoth(null);
      setCompaction(null);
      settled = true;
      setStatus('done');
      _lastCompletionMsRef.current = Date.now(); // 久别重返：记回合完成墙钟
      // Voice mode (/voice): speak the verbatim assistant reply (the same text
      // precedence used for commit — streamed text wins, reply payload backs it).
      maybeSpeak(live.text || (result && (result.reply || result.text)) || '');
      bcast({ type: 'turn_complete' });
      _ringCompletionBellIfDue(startTime);
      _pushCompletionIfDue(startTime, { ok: true, summary: live.text || (result && (result.reply || result.text)) || '' });
      clearTimeout(doneTimerRef.current);
      // If something is queued, drain quickly; otherwise hold the "done" glyph
      // briefly before returning to idle.
      const hasQueued = queueRef.current.length > 0;
      doneTimerRef.current = setTimeout(() => {
        setStatus('idle');
        drainNext();
      }, hasQueued ? 250 : 2000);
      return result;
    } catch (err) {
      // 刀105:中断前先抓取 liveRef 里的本轮部分回复(setStreamingBoth(null) 随即清空它),
      // 供 aborted 分支把「部分回复 + 中断标记」补进模型可见历史。
      const _partialAtAbort = (() => {
        try { return (liveRef.current && liveRef.current.text) || ''; } catch { return ''; }
      })();
      setStreamingBoth(null);
      setCompaction(null);
      const aborted = err?.name === 'AbortError' || controller.signal.aborted;
      settled = true;
      setStatus('idle');
      _lastCompletionMsRef.current = Date.now(); // 久别重返：出错/取消也算回合收尾（缓存同样凉）
      if (!aborted) {
        setMessages((m) => [...m, { role: 'error', content: _withEscHint(err.message), timestamp: Date.now() }]);
        bcast({ type: 'chunk_status', content: `错误: ${err.message}` });
      } else {
        // 刀105:把中断记进模型可见历史(ai._messages),对齐 CC [Request interrupted by user]——
        // 否则历史会停在悬空 user,下一句「改用 X」无从承接。fail-soft·门控 KHY_INTERRUPT_MARKER
        // 关时 ai.recordInterruption no-op → 逐字节回退今日行为(只留下方 UI notice)。
        try { require('../../ai').recordInterruption(_partialAtAbort); } catch { /* best effort */ }
        setMessages((m) => [...m, { role: 'notice', content: '已取消', timestamp: Date.now() }]);
        bcast({ type: 'chunk_status', content: '已取消' });
      }
      bcast({ type: 'turn_complete' });
      // Drain the next queued message even after a failed/aborted turn so the
      // queue cannot stall.
      clearTimeout(doneTimerRef.current);
      doneTimerRef.current = setTimeout(() => drainNext(), 0);
      if (aborted) return null;
      throw err;
    } finally {
      submitInFlightRef.current = false;
      abortRef.current = null;
      // CC 对齐计划模式:计划轮结束(成功/出错/中止皆经此)清 per-turn 只读窗口,
      // 使下一轮普通提交不被误锁进只读。fail-soft:清零绝不反噬回合收尾。
      if (_planTurn) {
        try { require('../../../services/planModeSink').setTurnReadOnly(false); } catch { /* fail-soft */ }
      }
      // Safety net: guarantee a terminal status for this turn. If neither the
      // success nor catch path settled it (e.g. an unexpected throw before the
      // 'done' transition), the spinner would otherwise spin forever because
      // App.js treats every non-idle/done status as "busy". Mirrors the classic
      // REPL's `finally { spinner.stop() }` (repl.js). Only acts while this turn
      // is still the active one, so it can't disturb a newer turn.
      if (!settled && turnSeqRef.current === myTurn) {
        settled = true;
        setStatus('idle');
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = setTimeout(() => drainNext(), 0);
      }
      settled = true;
    }
  }, [setStreamingBoth, drainNext]);

  useEffect(() => { runSubmitRef.current = _runSubmit; }, [_runSubmit]);

  // Backend cancel shared by abort()/preemptForSteer(). ai().chat() ignores
  // opts.abortSignal and drives gw.generate() through its OWN AbortController
  // (registered inside ai.js), so cancelling only the caller-side controller
  // leaves the stream flowing. Reach into the backend the SAME way the readline
  // REPL's _requestRelayCancel does — cancel the active gateway request AND the
  // relay adapter's pending passthrough. Best-effort: every branch is guarded.
  const _backendCancel = useCallback((reason) => {
    try {
      const aiMod = require('../../ai');
      if (aiMod && typeof aiMod.cancelActiveRequest === 'function') aiMod.cancelActiveRequest(reason);
    } catch { /* best effort */ }
    try {
      const gateway = require('../../../services/gateway/aiGateway');
      const relay = typeof gateway.getRelayAdapter === 'function' ? gateway.getRelayAdapter() : null;
      if (relay && typeof relay.cancelPending === 'function') relay.cancelPending(reason);
    } catch { /* best effort */ }
  }, []);

  // Interrupt a live turn (/i, ESC). Aborts BOTH the caller-side controller (so
  // _runSubmit's catch recognizes the unwind as 已取消) and the backend stream.
  const abort = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    _backendCancel('Interrupted by user');
  }, [_backendCancel]);

  // /s! urgent preempt — backend-ONLY cancel. CRITICAL: it must NOT abort the
  // caller-side controller. The native loop re-issues THIS turn in place, reusing
  // controller.signal; aborting it would make the re-issued call cancel
  // immediately. The in-flight model call returns errorType:'cancelled', the loop
  // checks consumeUrgentSteer()→true and re-runs with the steer injected.
  const preemptForSteer = useCallback(() => {
    _backendCancel('Urgent steer — preempt current turn');
  }, [_backendCancel]);

  // Surface a transient notice into committed history (steer/interrupt landing).
  const _noticeSteer = useCallback((content) => {
    setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);
  }, []);

  // Public submit. While a turn is in flight, route the input by intent
  // (KHY_TUI_STEER, default on): steer → injected at the next tool boundary;
  // /s! → urgent preempt + re-issue; interrupt → cancel + run next; queue → the
  // original end-of-turn FIFO. Idle → run immediately. KHY_TUI_STEER=0 falls back
  // to the blind FIFO queue (safe rollback).
  const submit = useCallback((text, options = {}) => {
    const busy = submitGateBusy(statusRef.current, submitInFlightRef.current);
    if (busy) {
      const steerEnabled = String(process.env.KHY_TUI_STEER ?? '').trim() !== '0';
      if (steerEnabled) {
        const route = routeBusyInput(text);
        if (route.action === 'urgent') {
          // /s! preempt-and-reissue: queue the steer, signal the loop, and cancel
          // the in-flight call WITHOUT aborting the caller controller.
          steerQueueRef.current.push(route.text);
          _syncSteer();
          urgentSteerRef.current = true;
          preemptForSteer();
          _noticeSteer(`⚡ 紧急方向修正 — 已抢占当前请求并重发: "${summarizeQueuedInputForDisplay(route.text, 40)}"`);
          return Promise.resolve(null);
        }
        if (route.action === 'steer') {
          if (_isBusyInterjectionNewTopic(route.text)) {
            // steer 命中方向词但与运行话题几乎无重叠 → 转向新话题 → 降级为排队(新 turn 跑,
            // 不中途注入)。门控 KHY_BUSY_STEER_TOPIC_GUARD 关时该判定恒 false → 逐字节回退。
            queueRef.current.push({ text, options });
            _syncQueue();
            _noticeSteer(`⤳ 检测到新话题,已改为排队(不打断当前任务): "${summarizeQueuedInputForDisplay(route.text, 40)}"`);
            return Promise.resolve(null);
          }
          steerQueueRef.current.push(route.text);
          _syncSteer();
          _noticeSteer(`⟳ 已注入方向修正: "${summarizeQueuedInputForDisplay(route.text, 40)}" · 将在下一个工具边界生效`);
          return Promise.resolve(null);
        }
        if (route.action === 'interrupt') {
          // Mirror the classic REPL: cancel now, run the input next (front of queue).
          queueRef.current.unshift({ text: route.text, options });
          _syncQueue();
          abort();
          _noticeSteer('⚡ 已发送中断信号，完成后优先处理新输入');
          return Promise.resolve(null);
        }
        // route.action === 'queue' → fall through to the FIFO queue.
      }
      queueRef.current.push({ text, options });
      _syncQueue();
      return Promise.resolve(null);
    }
    // 久别重返轻提示（对齐 CC idle-return 的 'hint' 档）：仅对真正执行的新提交判定，
    // 命中则在提交旁浮现一行一次性通知，**不阻塞、不改写、不拦截**提交本身。
    // 提示后清零完成时钟以自限——同一空闲窗口内的后续提交不重复提示，下一回合完成
    // 会重新盖章。全程 fail-soft：增益提示绝不阻断提交。
    try {
      // eslint-disable-next-line global-require
      const idleNudge = require('../../idleReturnNudge');
      const hint = idleNudge.idleReturnHintFor(
        {
          input: text,
          lastCompletionMs: _lastCompletionMsRef.current,
          nowMs: Date.now(),
          totalInputTokens: _idleTokensRef.current,
        },
        process.env,
      );
      if (hint) {
        setMessages((m) => [...m, { role: 'notice', content: hint, timestamp: Date.now() }]);
        _lastCompletionMsRef.current = 0;
      }
    } catch { /* 重返提示是增益，绝不阻断提交 */ }
    return _runSubmit(text, options);
  }, [_runSubmit, _syncQueue, _syncSteer, abort, preemptForSteer, _noticeSteer]);

  const clearQueue = useCallback(() => {
    if (queueRef.current.length === 0) return false;
    queueRef.current = [];
    _syncQueue();
    return true;
  }, [_syncQueue]);

  // Pop the most-recently queued (still-unsent) item back out for re-editing.
  // Returns the full { text, options } or null when the queue is empty.
  const dequeueLast = useCallback(() => {
    if (queueRef.current.length === 0) return null;
    const item = queueRef.current.pop();
    _syncQueue();
    return item;
  }, [_syncQueue]);

  // Conversation+code rewind (double-ESC, Claude Code alignment). The IO half:
  // truncate the authoritative model history at the chosen user turn, then —
  // when that turn carries a per-turn checkpoint id — restore the workspace files
  // to before it. The caller (App.js) owns the UI half (slice messages + reload
  // the recalled text). Fail-soft: code restore failing still leaves the
  // conversation rewound. `target` = a rewindControl target ({ rankFromEnd,
  // checkpointId, ... }).
  const rewind = useCallback((target, scope) => {
    if (!target || !Number.isFinite(Number(target.rankFromEnd))) {
      return { success: false, codeRestored: false, error: 'invalid-target' };
    }
    // Restore-scope decision (CC MessageSelector parity): both / conversation / code.
    // The pure leaf resolves the chosen scope into which halves to restore; gate off
    // or no scope → {conversation:true, code:true}, and the code side stays guarded by
    // checkpointId below, so behavior is byte-identical to the pre-scope flow.
    let _scope = { restoreConversation: true, restoreCode: true };
    try { _scope = require('../../rewindScope').resolveRewindScope(scope, target, process.env); } catch { /* fail-soft: default both */ }

    // Summarize-from-here (CC MessageSelector 'summarize'): collapse the selected
    // turn + everything after it into a compact memory instead of discarding it.
    // No code restore, no transcript truncation — App.performRewind keys off
    // `summarized`/`conversationRewound:false` to leave the visible scrollback intact.
    if (_scope && _scope.summarize) {
      let sres = null;
      try { sres = require('../../ai').summarizeFromUserTurn(target.rankFromEnd); } catch (err) {
        return { success: false, codeRestored: false, summarized: false, error: err && err.message };
      }
      if (!sres || !sres.success) {
        return { ...(sres || {}), success: false, codeRestored: false, summarized: false, conversationRewound: false };
      }
      return { ...sres, codeRestored: false, summarized: true, conversationRewound: false };
    }

    let res = null;
    let conversationRewound = false;
    if (_scope.restoreConversation) {
      try { res = require('../../ai').rewindToUserTurn(target.rankFromEnd); } catch (err) {
        return { success: false, codeRestored: false, error: err && err.message };
      }
      if (!res || !res.success) {
        return { ...(res || {}), success: false, codeRestored: false, conversationRewound: false };
      }
      conversationRewound = true;
    } else {
      // Code-only: keep the conversation intact, synthesize a success envelope.
      res = { success: true };
    }
    let codeRestored = false;
    // CC parity: surface WHAT the code restore touches. checkpointService already
    // computes the diff-stat (diffCheckpoint → {stats}); capture it BEFORE the
    // restore so the notice reflects the change being rolled back. Gated + fail-soft:
    // gate off / any error → codeDiffStats stays null and the notice falls back to
    // the plain "已回溯对话与代码" (byte-identical to pre-diffstat behavior).
    let codeDiffStats = null;
    const ckptOn = !_rewindControl || _rewindControl.turnCheckpointEnabled();
    if (res && res.success && _scope.restoreCode && ckptOn && target.checkpointId) {
      const ckCwd = process.env.KHYQUANT_CWD || process.cwd();
      const ckSvc = require('../../../services/workspace/checkpointService');
      try {
        const rn = require('../../rewindNotice');
        if (rn.rewindDiffStatEnabled(process.env)) {
          const d = ckSvc.diffCheckpoint(ckCwd, target.checkpointId);
          if (d && d.stats) {
            codeDiffStats = { additions: d.stats.additions, deletions: d.stats.deletions };
          }
        }
      } catch { /* fail-soft: no stat → plain notice */ }
      try {
        ckSvc.restoreCheckpoint(ckCwd, target.checkpointId);
        codeRestored = true;
      } catch { /* fail-soft: conversation rewound, code left as-is */ }
    }
    return { ...(res || {}), codeRestored, codeDiffStats, conversationRewound };
  }, []);

  const resolveControl = useCallback((answer) => {
    const req = controlRequestRef.current;
    controlRequestRef.current = null;
    if (req && req.resolve) req.resolve(answer);
    // Tell paired devices the prompt is settled so their approval card clears.
    if (req && req._bridgeRequestId) {
      bcast({ type: 'approval_resolved', requestId: req._bridgeRequestId, decision: answer === false ? 'deny' : 'allow' });
    }
    // Persist the decision / question+answer into committed history so it stays
    // visible in scrollback after the overlay clears.
    const record = buildDecisionRecord(req, answer, Date.now());
    if (record) setMessages((m) => [...m, record]);
    setControlRequest(null);
  }, [bcast]);


  // Subscribe to process-level adapter events emitted by the gateway.
  useEffect(() => {
    // Payload is a STRING (kiroAdapter._emitStatus(text); repl.js treats it as a
    // string too). Normalize to a stable message and only update state when it
    // actually changed — returning the SAME ref makes React bail, so a repeated
    // status no longer thrashes adapterInfo's identity and re-fires the footer
    // effect (App.js:1150) → no render storm.
    const onStatus = (info) => {
      const message = normalizeAdapterStatus(info);
      setAdapterInfo((p) => (p.message === message ? p : { ...p, message }));
    };
    const onEmail = (email) => setAdapterInfo((p) => (p.accountEmail === email ? p : { ...p, accountEmail: email }));
    process.on('khy:adapter:status', onStatus);
    process.on('khy:adapter:account-email', onEmail);
    return () => {
      process.off('khy:adapter:status', onStatus);
      process.off('khy:adapter:account-email', onEmail);
      clearTimeout(doneTimerRef.current);
      clearTimeout(flushTimerRef.current);
    };
  }, []);

  // Subscribe to inbound LAN-bridge events from paired devices. 'input' runs as
  // a local turn (submit() enqueues if a turn is already in flight, matching
  // locally-typed behavior); 'approve'/'deny' resolve the active permission
  // prompt. This is the consumer side that the Ink migration left unwired —
  // without it, remote messages reach the server but never the session.
  useEffect(() => {
    const b = getBridge();
    if (!b || typeof b.onBridgeEvent !== 'function') return undefined;
    const unsubscribe = b.onBridgeEvent((event, data) => {
      if (event === 'input') {
        let text = data && typeof data.text === 'string' ? data.text.trim() : '';
        const opts = { source: 'bridge' };
        // Resolve any uploaded attachments (from the mobile page) back into
        // vision images + extracted-text prompt blocks. Mirrors the web path
        // (aiManagementServer._resolveChatAttachments). Fail-soft: a resolution
        // error just sends the text alone.
        const ids = data && Array.isArray(data.attachments) ? data.attachments : [];
        if (ids.length) {
          try {
            const uploadStore = require('../../../services/aiUploadStore');
            const resolved = uploadStore.resolveForChat(ids);
            if (resolved.images && resolved.images.length) opts.images = resolved.images;
            if (resolved.promptBlocks && resolved.promptBlocks.length) {
              const blocks = resolved.promptBlocks.join('\n\n');
              text = text ? `${text}\n\n${blocks}` : blocks;
            }
          } catch { /* fail-soft */ }
        }
        if (text || (opts.images && opts.images.length)) submit(text, opts);
      } else if (event === 'approve') {
        resolveControl(true);
      } else if (event === 'deny') {
        resolveControl(false);
      }
    });
    return unsubscribe;
  }, [getBridge, submit, resolveControl]);

  // Ctrl+O on the committed transcript (Ink mode): append a one-shot, fully
  // expanded copy of the most recent foldable turn below the transcript. Ink's
  // <Static> can't re-render an already-printed process group on prop change, so
  // this append (mirroring classic mode's "print expanded below") is how folded
  // tool detail becomes visible without remounting Static (which would duplicate
  // all scrollback). No-op (returns false) when there is nothing foldable, or
  // when the previous append is still the last item, so repeated presses don't
  // spam identical blocks. Returns true when a fresh expansion was appended.
  const expandLastFoldable = useCallback(() => {
    const target = selectLastFoldableMessage(messages);
    if (!target) return false;
    if (messages.length > 0 && messages[messages.length - 1].role === 'expansion') return false;
    const expansion = buildExpansionMessage(target, Date.now());
    if (!expansion) return false;
    setMessages((s) => s.concat([expansion]));
    return true;
  }, [messages, setMessages]);

  // Items rendered in the committed <Static> region: banner first, then messages.
  // Memoized by messages array identity (stable across streaming frames / keystrokes
  // / nowTick) so we don't re-alloc N+1 wrappers every render. Byte-identical content;
  // gate off (KHY_STATIC_ITEMS_MEMO) → rebuild every render (today's behavior).
  const _staticCacheRef = useRef(null);
  const _staticReconciled = _staticItemsMemo.reconcileStaticItems(
    _staticCacheRef.current, messages, process.env,
  );
  _staticCacheRef.current = _staticReconciled.cache;
  const staticItems = _staticReconciled.items;

  return {
    messages,
    staticItems,
    streaming,
    status,
    statusDetail,
    compaction,
    controlRequest,
    turnStartedAt,
    adapterInfo,
    contextTokens,
    submit,
    queueLen,
    queueItems,
    steerLen,
    dequeueLast,
    rewind,
    clearQueue,
    resolveControl,
    abort,
    setMessages,
    expandLastFoldable,
    resetContext,
  };
}

// Project restored ai._messages into visible <Static> transcript items for a
// `khy resume` relaunch. Keep only user/assistant turns with plain-string
// content: tool-block/system entries don't render cleanly and aren't needed for
// the visible replay — the model context already lives in _messages, so this is
// purely cosmetic. Exported for unit testing.
function buildResumedTranscript(messages, now) {
  const ts = typeof now === 'number' ? now : Date.now();
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content, timestamp: ts, restored: true }));
}

// buildDecisionRecord/summarizeControlInput/formatCompactionResult/projectToolResultForView
// exported for unit testing.
module.exports = { useQueryBridge, buildDecisionRecord, summarizeControlInput, formatCompactionResult, projectToolResultForView, reduceToolPush, reduceToolResult, reduceAgentTree, isAgentFamilyTool, splitSealedText, planStageFlush, selectLastFoldableMessage, buildExpansionMessage, shouldRingCompletionBell, buildResumedTranscript, computeToolPreface, computeToolProgress, computeToolOutcome, computePlanAnnouncement, computePlanProgress, shouldFlushTerminalOutcome, paintYieldEnabled, pickTurnStatsTokens, pickContextOccupancyTokens, submitGateBusy };
