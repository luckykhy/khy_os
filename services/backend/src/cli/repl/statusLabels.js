/**
 * Streaming status-label & classification helpers for the classic REPL.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Previously these were per-request closures recreated on every
 * chat turn; they are pure ((phase, text[, status]) → label / key / boolean) so
 * they belong in one importable module. The closure-bound siblings that read
 * live state (`_phaseTargetLabel` via the active provider, `_buildStatusDetail`
 * via the request start time, the live-line flushers/escalators) stay in repl.js
 * and call into these pure helpers.
 */

/** Extract a `current/total` tool step from a `[n / m]` marker, or '' if absent/invalid. */
function extractToolStep(text = '') {
  const m = String(text || '').match(/\[(\d+)\s*\/\s*(\d+)\]/);
  if (!m) return '';
  const current = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return '';
  return `${Math.max(1, Math.min(current, total))}/${total}`;
}

/** Map a phase id to its high-level action label (Chinese), with a generic fallback. */
function phaseActionLabel(phase = '') {
  const p = String(phase || '').trim().toLowerCase();
  if (p === 'init') return '初始化链路';
  if (p === 'request') return '请求上游模型';
  if (p === 'thinking') return '分析约束与计划';
  if (p === 'generating') return '生成最终答复';
  if (p === 'plan') return '生成执行计划';
  if (p === 'tool_progress') return '执行工具步骤';
  if (p === 'compacted') return '压缩上下文';
  if (p === 'summary') return '汇总交付结果';
  if (p === 'done') return '完成请求';
  return '推进执行链路';
}

/** Derive a fine-grained `phase/stage` label from the phase id and status detail text. */
function phaseStageLabel(phase = '', text = '') {
  const p = String(phase || '').trim().toLowerCase();
  const detail = String(text || '');
  const lower = detail.toLowerCase();
  if (p === 'init') {
    if (/预检|probe|gateway|网关/.test(lower)) return '初始化/通道预检';
    if (/rag|检索|知识库|会话上下文/.test(lower)) return '初始化/上下文召回';
    if (/多模态|media|image/.test(lower)) return '初始化/多模态准备';
    if (/任务硬约束|确认/.test(detail)) return '初始化/约束确认';
    if (/能力边界|执行策略/.test(detail)) return '初始化/任务自检';
    if (/预热|warmup|加载模型|本地模型|ollama/.test(lower)) return '初始化/模型预热';
    return '初始化/请求准备';
  }
  if (p === 'request') {
    if (/等待.*响应|waiting|生成响应|stream stalled|未收到新输出/.test(lower)) return '请求/等待模型响应';
    if (/限流|rate limit|throttle|429/.test(lower)) return '请求/限流等待';
    if (/回退|fallback|重试|retry|切换|switch/.test(lower)) return '请求/回退重试';
    if (/预检|probe|gateway|网关/.test(lower)) return '请求/网关握手';
    if (/预热|warmup|加载模型|本地模型|ollama/.test(lower)) return '请求/模型预热';
    if (/多模态|vision|image/.test(lower)) return '请求/多模态适配';
    if (/失败原因|timeout|error|失败/.test(detail)) return '请求/故障处理';
    return '请求/上游推理';
  }
  if (p === 'thinking') return '分析/约束与步骤规划';
  if (p === 'generating') return '生成/最终答复';
  if (p === 'plan') return '规划/任务拆解';
  if (p === 'tool_progress') {
    const step = extractToolStep(detail);
    if (step) return `工具执行/步骤 ${step}`;
    if (/✓|success|completed|done/.test(lower)) return '工具执行/结果确认';
    if (/✗|fail|error/.test(lower)) return '工具执行/失败回传';
    if (/in progress|running|执行中|推进中/.test(lower)) return '工具执行/执行中';
    return '工具执行/推进中';
  }
  if (p === 'compacted') {
    if (/强化压缩|上限|budget/.test(detail)) return '上下文/强化压缩';
    return '上下文/常规压缩';
  }
  if (p === 'summary') return '汇总/交付总结';
  if (p === 'done') {
    if (/失败|error|timeout/i.test(detail)) return '完成/失败结束';
    if (/取消|cancel/i.test(detail)) return '完成/取消结束';
    if (/确认|等待确认/i.test(detail)) return '完成/等待确认';
    return '完成/正常结束';
  }
  return '执行/阶段推进';
}

/**
 * Normalize a status line into a "live key" used to overwrite same-key lines
 * in place. Dynamic heartbeat / upstream-request lines collapse to fixed keys;
 * elapsed-time tokens are templated out so otherwise-identical lines coalesce.
 */
function normalizeProgressKey(phase, text) {
  const raw = String(text || '');
  // All dynamic heartbeat messages (adapter pulse + codex heartbeat)
  // share a single live key so they always overwrite each other in-place.
  if (phase === 'request' && /正在生成响应|流式输出.*已等待|已 \d+s 未收到新输出|等待模型响应中/i.test(raw)) {
    return 'request:_heartbeat_';
  }
  // Collapse repeated "请求上游模型" lines into one live-updating line
  if (phase === 'request' && /请求上游模型/.test(raw)) {
    return 'request:_upstream_';
  }
  const normalized = raw
    .replace(/（\d+s）/g, '(Xs)')
    .replace(/\b\d+s\b/g, 'Xs')
    .replace(/\.{3}\s*\d+s/gi, '... Xs')
    .trim();
  return `${phase}:${normalized}`;
}

/**
 * Normalize a status line into a dedup key (more aggressive than the live key):
 * lowercased, with elapsed times, cooldowns, and channel identifiers templated
 * out so repeated-but-cosmetically-different lines are suppressed.
 */
function normalizeStatusDedupKey(phase, text) {
  const raw = String(text || '');
  // Heartbeat messages from any source share a single dedup key
  if (phase === 'request' && /正在生成响应|流式输出.*已等待|已 \d+s 未收到新输出|等待模型响应中/i.test(raw)) {
    return 'request:_heartbeat_';
  }
  const normalized = raw
    .toLowerCase()
    .replace(/\d+(\.\d+)?s\b/g, 'Xs')
    .replace(/\b\d+ms\b/g, 'Xms')
    .replace(/约\s*\d+\s*s/g, '约 Xs')
    .replace(/cooldown\s*\d+\s*s/gi, 'cooldown Xs')
    .replace(/（[^）]*\d+s[^）]*）/g, '(X)')
    .replace(/(首选通道|预检首选通道|尝试通道|adapter)\s*[:：]\s*[^\s，,；;]+/gi, '$1:*')
    .replace(/\s+/g, ' ')
    .trim();
  return `${phase}:${normalized}`;
}

/** True when a "failure"-worded status is actually a zero-failure metric line (no real failure). */
function isFailureMetricOnlyStatus(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (!/(失败|failed|error|异常)/i.test(raw)) return false;
  if (/失败率\s*0\s*%/.test(raw)) return true;
  if (/失败\s*0\s*\/\s*\d+/.test(raw)) return true;
  if (/首包\s*P50\/P95/i.test(raw) && /失败\s*\d+\s*\/\s*\d+/.test(raw)) return true;
  return false;
}

/** True for low-value gateway/channel chatter during the request phase (foldable noise). */
function isLowValueGatewayStatus(phase, text) {
  return (
    phase === 'request'
    && /(首选通道|预检首选通道|尝试通道|冷却期|重试中|并行探测|fallback|切换到|switching|已自动优化网关参数|任务模式|通道状态刷新|冷却探活|已连接并响应|密钥池)/i.test(String(text || ''))
  );
}

/** True when a status represents a genuine failure signal (tool failure or failure-worded text). */
function isFailureSignalStatus(phase, text, status = null) {
  if (phase === 'tool_progress' && status && status.success === false) return true;
  if (isFailureMetricOnlyStatus(text)) return false;
  return /(失败|异常|error|failed|timeout|超时|retry|重试|拒绝|denied|取消|canceled|中断|终止)/i.test(String(text || ''));
}

/** True when a status should bypass the start-silent window (terminal phases or real failures). */
function shouldBypassStartSilent(phase, text, status = null) {
  if (phase === 'done' || phase === 'summary') return true;
  if (phase === 'tool_progress' && status && status.success === false) return true;
  if (isFailureMetricOnlyStatus(text)) return false;
  return /(失败|异常|error|failed|timeout|超时|retry|重试|拒绝|denied|终止|取消|canceled|中断)/i.test(String(text || ''));
}

/** True for the dynamic, self-overwriting progress lines (elapsed-time heartbeats). */
function isDynamicProgressStatus(phase, text) {
  return (
    phase === 'request'
    && /正在生成响应（已耗时 \d+s）|等待模型响应中\.\.\.\s*\d+s|等待 .*流式输出（已等待 \d+s）|已 \d+s 未收到新输出|请求上游模型/i.test(String(text || ''))
  );
}

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
    try { _voice = require('../toolPrefaceVoice'); } catch { _voice = null; }
  }
  return _voice;
}

/** Strip a trailing ellipsis (… or ...) so a narration can be recomposed. */
function stripTrailingEllipsis(s) {
  return String(s || '').replace(/(?:…|\.{3})\s*$/, '').trim();
}

/** Last meaningful clause of a reasoning tail, whitespace-collapsed, ≤ max chars. */
function thinkingClause(tail, max = 36) {
  const raw = String(tail || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // Take the last sentence-ish fragment so the label reflects the CURRENT thought,
  // not the opening of a long reasoning block.
  const parts = raw.split(/(?<=[。．.!?！？；;])\s*/).map((s) => s.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : raw;
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
  if (String(e.KHY_LIVE_ACTIVITY || '').trim() === '0') return '';
  const phase = String(status || '').trim().toLowerCase();
  const detail = String(statusDetail || '').replace(/\s+/g, ' ').trim();

  if (phase === 'tool' || phase === 'tool_progress') {
    const name = runningTool && (runningTool.name || runningTool.toolName);
    if (name) {
      const voice = _getVoice();
      if (voice && typeof voice.toolRunningNarration === 'function') {
        try {
          const narration = stripTrailingEllipsis(
            voice.toolRunningNarration(name, runningTool.input || runningTool.params || {})
          );
          if (narration) return narration;
        } catch { /* fall through to name/detail */ }
      }
      return `运行 ${String(name).trim()}`;
    }
    return detail;
  }
  if (phase === 'thinking') {
    return thinkingClause(thinkingTail) || detail;
  }
  // streaming/generating already shows visible text → keep the bare base label.
  if (phase === 'streaming' || phase === 'generating') return '';
  // summary / done / compacting / request / init / local / unknown → gateway detail.
  return detail;
}

module.exports = {
  extractToolStep,
  phaseActionLabel,
  phaseStageLabel,
  normalizeProgressKey,
  normalizeStatusDedupKey,
  isFailureMetricOnlyStatus,
  isLowValueGatewayStatus,
  isFailureSignalStatus,
  shouldBypassStartSilent,
  isDynamicProgressStatus,
  deriveLiveActivity,
  stripTrailingEllipsis,
  thinkingClause,
};
