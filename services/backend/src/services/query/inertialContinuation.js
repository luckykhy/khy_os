'use strict';

/**
 * inertialContinuation.js — Inertial continuation for unstable-connection seams.
 *
 * Goal (2026-06-25): 「多处链接不稳定的地方可以使用惯性接续」.
 *
 * When a streaming response is cut short by an UNSTABLE connection — the stream
 * stalls (StreamStaleDetector → abort), the socket hangs up (ECONNRESET), or the
 * channel returns an empty / incomplete reply after some text already streamed —
 * the existing recovery seams in toolUseLoop.js (transient-channel retry,
 * empty-reply recovery, stall nudge) discard whatever the model already produced
 * and tell it to start "from scratch". That throws away real progress (the
 * 惯性 / inertia) and makes a flaky channel feel like it restarts from zero on
 * every hiccup.
 *
 * This module is the SINGLE SOURCE for "inertial continuation": preserve the
 * already-produced text prefix and instruct the model to seamlessly resume from
 * it, mirroring the proven max_tokens truncation-accumulator pattern but for the
 * connection-instability seams.
 *
 * Self-gated by KHY_INERTIAL_CONTINUATION (default ON). When disabled — or when
 * there is no meaningful prefix to carry — buildContinuationDirective() returns
 * the EXACT legacy from-scratch string for the seam, so behavior is unchanged and
 * the change is purely additive.
 */

const ENV_FLAG = 'KHY_INERTIAL_CONTINUATION';

// Minimum visible chars a streamed prefix must have to be worth resuming from.
// Below this the prefix is just a fragment / progress preface — continuing from
// it gives the model no useful anchor, so we fall back to from-scratch.
const MIN_CARRYOVER_CHARS = 24;

// How much of the prefix tail we echo back as the resume anchor. We do NOT feed
// the whole prefix back (that invites the model to re-emit it and bloats the
// prompt) — only the tail the model needs to pick up mid-thought.
const ANCHOR_TAIL_CHARS = 320;

/**
 * Inertial continuation is ON by default; only an explicit falsy flag disables.
 * @returns {boolean}
 */
function isEnabled() {
  const v = String(process.env[ENV_FLAG] == null ? '' : process.env[ENV_FLAG])
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// Legacy from-scratch directives, preserved byte-for-byte per seam so that when
// inertial continuation is disabled or no prefix exists, the injected instruction
// is identical to today's behavior.
const LEGACY_DIRECTIVE = {
  transient:
    '\n\n[SYSTEM: Previous round failed due transient channel interruption. Resume from completed progress. Do NOT repeat successful tool calls. Continue execution.]',
  empty_reply:
    '\n\n[SYSTEM: The previous response was empty or incomplete. Generate a complete answer now. Do NOT repeat any prior partial text; produce the full response from scratch.]',
  stall:
    '\n\n[SYSTEM: The previous response was empty. Continue now and produce the complete final answer from scratch. Do NOT repeat any prior partial text and do NOT output a progress preface.]',
};

function legacyDirective(reason) {
  return LEGACY_DIRECTIVE[reason] || LEGACY_DIRECTIVE.empty_reply;
}

// A "progress preface" is a short, content-free opener the model emits before
// real work ("正在分析…", "让我看看", "Let me ", "I'll check…"). Continuing from
// it gives no useful anchor — it must be treated as degenerate and discarded so
// recovery regenerates a real answer instead of resuming a hollow opener. The
// rule only fires for a SHORT prefix that is essentially nothing but the opener;
// a long prefix that merely starts with "让我" carries real content and resumes.
const PROGRESS_PREFACE_MAX_CHARS = 60;
const PROGRESS_PREFACE_RE = new RegExp(
  '^\\s*(?:'
  + '正在(?:分析|检查|查看|执行|处理|搜索|读取|生成|思考|整理|准备)'
  + '|让我(?:来|先)?(?:看看|分析|检查|想想|确认)?'
  + '|我来(?:看看|分析|检查|处理)?'
  + '|好的[，,。\\.！!]*我?(?:来|先)?'
  + '|稍等|请稍候|马上'
  + '|let me\\b|i\'?ll\\b|i am going to\\b|i\'?m going to\\b|let\'?s\\b'
  + '|okay[,，]?\\s*(?:let|i)\\b|sure[,，]?\\s*(?:let|i)\\b'
  + '|thinking\\b|analyzing\\b|checking\\b'
  + ')',
  'iu',
);

/**
 * Whether a prefix is nothing but a content-free progress preface.
 * @param {string} text
 * @returns {boolean}
 */
function isProgressPreface(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  if (t.length > PROGRESS_PREFACE_MAX_CHARS) return false; // long → has real content
  return PROGRESS_PREFACE_RE.test(t);
}

/**
 * Whether a streamed prefix is degenerate — carrying it forward would anchor the
 * resume on junk. Four kinds, in priority order:
 *   • whitespace  — empty after trim
 *   • too_short   — below MIN_CARRYOVER_CHARS visible chars
 *   • repetition  — token-level chanting (delegates to streamRepetitionGuard)
 *   • preface     — pure progress preface with no real content
 *
 * @param {string} text
 * @returns {{ degenerate: boolean, kind: (string|null) }}
 */
function isDegeneratePrefix(text) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  if (!trimmed) return { degenerate: true, kind: 'whitespace' };
  if (trimmed.length < MIN_CARRYOVER_CHARS) return { degenerate: true, kind: 'too_short' };
  // Repetition chant — productive by length yet carries no new information.
  try {
    if (require('./streamRepetitionGuard').findRepetition(raw).tripped) {
      return { degenerate: true, kind: 'repetition' };
    }
  } catch { /* fail-open: a detector error never blocks a resume */ }
  if (isProgressPreface(raw)) return { degenerate: true, kind: 'preface' };
  return { degenerate: false, kind: null };
}

/**
 * Normalize a streamed partial into a carryover candidate. A carryover is
 * "meaningful" only when it has enough visible content to anchor a resume AND is
 * not degenerate (whitespace / too short / repetition chant / pure preface).
 *
 * @param {string} text - text streamed before the connection broke
 * @returns {{ text: string, meaningful: boolean, kind: (string|null) }}
 */
function captureCarryover(text) {
  if (!isEnabled()) return { text: '', meaningful: false, kind: 'disabled' };
  const trimmed = String(text == null ? '' : text).replace(/\s+$/u, '');
  const deg = isDegeneratePrefix(trimmed);
  if (deg.degenerate) return { text: '', meaningful: false, kind: deg.kind };
  return { text: trimmed, meaningful: true, kind: null };
}

/**
 * Build the directive injected for a recovery round.
 *   • inertial continuation enabled AND a meaningful prefix exists → resume directive
 *   • otherwise → the EXACT legacy from-scratch string for the seam
 *
 * The resume directive only echoes the prefix TAIL as an anchor and explicitly
 * forbids re-emitting it, so the model continues mid-thought without repeating
 * what the user already saw streamed.
 *
 * @param {{ carryover?: string, reason?: string }} [opts]
 * @returns {string} directive (already prefixed with blank lines)
 */
function buildContinuationDirective(opts = {}) {
  const reason = opts && opts.reason ? opts.reason : 'empty_reply';
  const carry = String(opts && opts.carryover != null ? opts.carryover : '')
    .replace(/\s+$/u, '');
  if (!isEnabled() || carry.trim().length < MIN_CARRYOVER_CHARS) {
    return legacyDirective(reason);
  }
  const tail = carry.length > ANCHOR_TAIL_CHARS ? carry.slice(-ANCHOR_TAIL_CHARS) : carry;
  // The transient seam additionally carries TOOL progress; keep that contract.
  const toolClause = reason === 'transient'
    ? '已成功的工具调用无需重复（沿用其结果）；'
    : '';
  return '\n\n[SYSTEM: 你上一段回答因连接中断/超时被打断，尚未写完。'
    + `${toolClause}下面方括号内是你**已经输出并已展示给用户**的结尾片段。`
    + '请从它的断点处**无缝继续**往下写：不要重复这段内容、不要重新打招呼或重写开头、'
    + '不要输出任何前言或进度说明，直接接着写完剩余部分。\n'
    + `已输出片段结尾：【…${tail}】]`;
}

/**
 * Stitch a preserved prefix with the continuation reply. If the model ignored
 * the "do not repeat" instruction and re-emitted part of the tail, drop the
 * duplicated head of the continuation so the merged text reads cleanly.
 *
 * @param {string} prefix - text produced before the connection broke
 * @param {string} suffix - text produced by the continuation round
 * @returns {string}
 */
function mergePrefix(prefix, suffix) {
  const p = String(prefix == null ? '' : prefix);
  const s = String(suffix == null ? '' : suffix);
  if (!p) return s;
  if (!s) return p;
  // Largest k such that the last k chars of p equal the first k chars of s.
  const max = Math.min(p.length, s.length, ANCHOR_TAIL_CHARS);
  let overlap = 0;
  for (let k = max; k > 0; k--) {
    if (p.slice(p.length - k) === s.slice(0, k)) {
      overlap = k;
      break;
    }
  }
  return p + s.slice(overlap);
}

// ── 惯性接续规则（显式单源）─────────────────────────────────────────────────
// 「能接续 / 不能接续」由 classify() 一处裁定，四条规则全部成立才接续 (CAN)：
//   R1 非用户主动中止（!aborted）         —— 用户喊停绝不自动续接（意图优先）。
//   R2 非确定性失败（!cooldown）           —— 冷却 / 缓存错误重试必撞同一堵墙。
//   R3 错误类型可恢复                       —— 委派 continuation.isResumableError：
//        内容安全 / 拒答 / 权限 / 上下文溢出绝不续（红线复用，不在此重复定义）。
//   R4 已产出前缀可锚定（!degenerate）      —— 退化前缀=纯空白/过短/重复chanting/纯进度前言。
// 任一不成立 ⟹ 不接续 (CANNOT)，返回具名 reason：
//   user_abort / cooldown / non_resumable_error / degenerate_prefix（细分见 detail）。
// 语义分层：R1–R3 不成立=连「带惯性重试」都不该做（上层 seam 既有红线已先行拦截，这里
// 是防御纵深）；R4 不成立=可重试但须丢弃废前缀、回落 from-scratch。两种情形 classify 都
// 给出 carryover:''，buildContinuationDirective 据此自动回落旧指令，调用方零分支。
const RULES = Object.freeze({
  R1_not_aborted: '非用户主动中止',
  R2_not_cooldown: '非确定性冷却失败',
  R3_resumable_error: '错误类型可恢复（继承 continuation 红线）',
  R4_anchorable_prefix: '前缀可锚定（非空白/过短/重复/纯前言）',
});

/**
 * 惯性接续的显式裁决：给定一次不稳定接缝的上下文，回答「能不能带着已产出前缀续接」。
 *
 * @param {object} [opts]
 * @param {string} [opts.errorType] - 本轮错误类型（空响应接缝可不传）
 * @param {boolean} [opts.aborted]  - 用户是否主动中止
 * @param {boolean} [opts.cooldown] - 是否确定性冷却失败
 * @param {string} [opts.prior]     - 跨轮已累积的前缀
 * @param {string} [opts.streamed]  - 本轮新流出的前缀
 * @returns {{ resumable: boolean, reason: string, detail: (string|null), carryover: string }}
 */
function classify(opts = {}) {
  const o = opts || {};
  if (!isEnabled()) {
    return { resumable: false, reason: 'disabled', detail: null, carryover: '' };
  }
  // R1：用户主动中止 —— 意图优先，绝不自动续接。
  if (o.aborted) {
    return { resumable: false, reason: 'user_abort', detail: null, carryover: '' };
  }
  // R2：确定性冷却失败 —— 续接只会复现同一缓存错误。
  if (o.cooldown) {
    return { resumable: false, reason: 'cooldown', detail: null, carryover: '' };
  }
  // R3：错误类型红线（委派 continuation 单源，避免重复定义安全/权限/溢出集合）。
  if (o.errorType) {
    let resumableErr = true;
    try { resumableErr = require('./continuation').isResumableError(o.errorType); } catch { /* fail-open */ }
    if (!resumableErr) {
      return { resumable: false, reason: 'non_resumable_error', detail: String(o.errorType), carryover: '' };
    }
  }
  // R4：前缀可锚定 —— 合并跨轮前缀 + 本轮新流出，判退化。
  const merged = mergePrefix(
    String(o.prior == null ? '' : o.prior),
    String(o.streamed == null ? '' : o.streamed),
  );
  const deg = isDegeneratePrefix(merged);
  if (deg.degenerate) {
    // 可重试，但须丢弃废前缀回落 from-scratch（carryover 置空）。
    return { resumable: false, reason: 'degenerate_prefix', detail: deg.kind, carryover: '' };
  }
  return { resumable: true, reason: 'ok', detail: null, carryover: merged };
}

module.exports = {
  isEnabled,
  captureCarryover,
  isProgressPreface,
  isDegeneratePrefix,
  classify,
  buildContinuationDirective,
  mergePrefix,
  legacyDirective,
  RULES,
  ENV_FLAG,
  MIN_CARRYOVER_CHARS,
  ANCHOR_TAIL_CHARS,
  PROGRESS_PREFACE_MAX_CHARS,
  LEGACY_DIRECTIVE,
};
