'use strict';

/**
 * Transient-recovery + stop-reason helper family, extracted verbatim from
 * toolUseLoopCore.js (T-021 C3-P9). Cohesive cluster that decides whether a turn's
 * error/stop-reason is transient-retryable and how much bounded recovery budget /
 * delay it gets. All pure (string/env/regex) EXCEPT two collaborators:
 *   - _resolveTaskScale lazy-requires the sibling ../taskScale (path re-based for
 *     this deeper dir; it is only ever called by _resolveTransientRecoveryMax, so it
 *     is leaf-private and NOT destructured back into the core).
 *   - _resolveTransientRecoveryMax reads the seamlessResume leaf's defaultTransientBudget
 *     to raise the small/normal transient floor when 无感续写 is on. To keep the core's
 *     _tryOr fail-soft + avoid a load-time require of a legacy module, that module is
 *     INJECTED via setRecoveryDeps({ seamlessResume }) (same convention as
 *     steering.js/toolNames.js setXxxDeps). Unset → null → byte-identical legacy budget.
 * The core re-requires the 8 names it still calls (all but _resolveTaskScale) and
 * re-exports the same 4 previously-public names. Public surface unchanged.
 */

let _seamlessResume = null;

function setRecoveryDeps(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'seamlessResume')) {
    _seamlessResume = deps.seamlessResume;
  }
}

/** @type {(msg: string, opts?: object) => 'small'|'normal'|'large'} */
function _resolveTaskScale(userMessage = '', options = {}) {
  const { resolveTaskScale } = require('../../taskScale');
  return resolveTaskScale(userMessage, options);
}

function _isTransientLoopErrorType(errorType = '') {
  const t = String(errorType || '')
    .trim()
    .toLowerCase();
  return (
    t === 'timeout' ||
    t === 'cancelled' ||
    t === 'network' ||
    t === 'process' ||
    // server_error: 5xx (502/503/504) = 上游/代理瞬时故障。网关层已对该类做冷却
    // (GATEWAY_SERVER_ERROR_COOLDOWN_MS, 默认 15s) + 网络抖动重试预算增强；但网关预算
    // 耗尽后会把 server_error 原样返回给工具循环,旧逻辑因不在本集合而不重试 → 网络
    // 抖动直接永久中断当前任务。加入后,只要不是冷却缓存错误(_isCooldownFailure 已先
    // 挡住 cooldown),工具循环便可在有界预算内再给网络抖动一次机会。
    t === 'server_error' ||
    // retry_budget_exceeded: 网关层网络抖动重试预算已耗尽。预算耗尽 ≠ 通道永久失败
    // (可能只是抖动窗口较长);工具循环的有界瞬态恢复可在延迟后再次尝试,抖动恢复后即
    // 可续跑,避免一次抖动永久中断。
    t === 'retry_budget_exceeded' ||
    // 'empty': an empty HTTP-200 adapter reply (model produced no text). The
    // gateway no longer cools the channel for this, so a bounded in-loop retry
    // can immediately re-ask the same healthy channel; on exhaustion the
    // error-path salvage surfaces any already-fetched tool data instead of a
    // bare failure. Parity with 'unknown'.
    t === 'empty' ||
    t === 'unknown'
  );
}

function _normalizeStopReason(reason = '') {
  const raw = String(reason || '').trim();
  if (!raw) {
    return '';
  }
  const normalized = raw.toLowerCase();

  if (
    [
      'length',
      'max_tokens',
      'max-tokens',
      'max_tokens_exceeded',
      'max_output_tokens',
      'max_completion_tokens',
    ].includes(normalized)
  ) {
    return 'length';
  }
  if (
    ['tool_use', 'tool_calls', 'tool_call', 'function_call', 'function_calls'].includes(normalized)
  ) {
    return 'tool_use';
  }
  if (['stop', 'end_turn', 'end-turn', 'completed', 'complete'].includes(normalized)) {
    return 'stop';
  }
  return normalized;
}

/**
 * Whether the loop should trust the model's native stop_reason as a continuation
 * signal. Only NATIVE function-calling adapters carry a trustworthy finish/stop
 * reason; text-protocol (weak-local) models synthesize tool calls from raw text,
 * so their stop_reason is meaningless here and the toolUseBlocks/text parse stays
 * authoritative. Gated by KHY_TRUST_STOP_REASON (default on) for a clean rollback.
 *
 * Note: stop_reason is still only a SECONDARY hint — the presence of structured
 * toolUseBlocks remains the primary signal (see `hasStructuredToolUse`). This
 * helper guards one extra recovery: a native turn that says tool_use but lost its
 * blocks should not be silently finalized.
 */
// Negative-vocabulary gate ('0'/'false'/'off'/'no' → distrust, everything else
// → trust). NOT rewritten as !parseBoolean (unknown tokens like 'maybe' would
// flip from true to fallback-driven false) and NOT delegated to
// utils/isOffValue (it also treats '' as off, while here '' → trust). Kept
// local for byte conservation.
function _shouldTrustStopReason(isTextProtocol) {
  if (isTextProtocol) {
    return false;
  }
  const flag = String(process.env.KHY_TRUST_STOP_REASON || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Check if an AI result represents a cooldown/cached failure that should NOT
 * be retried.  Gateway returns these when an adapter's recent failure is still
 * within its cooldown window — retrying immediately will produce the exact
 * same cached error, wasting iterations.
 */
function _isCooldownFailure(aiResult) {
  if (!aiResult) {
    return false;
  }
  const content = String(aiResult.content || '');
  const error = String(aiResult.error || '');
  const combined = content + ' ' + error;
  return /\bcooldown\b/i.test(combined) || /recent.*failure.*cached/i.test(combined);
}

function _resolveTransientRecoveryMax(userMessage = '', options = {}) {
  const explicit = parseInt(String(options.maxTransientRecoveries ?? ''), 10);
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.min(6, explicit));
  }
  const scale = _resolveTaskScale(userMessage, options);
  // 未显式设置 env 时的默认预算交无感续写叶子(门控开 → 抬高 small/normal 地板,
  // 门控关 → 逐字节回退现状 0/1/3)。显式 env 覆盖仍最高优先、原样保留。
  const _dflt = (sc, legacy) =>
    _seamlessResume ? _seamlessResume.defaultTransientBudget(sc, process.env) : legacy;
  if (scale === 'small') {
    const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL;
    const n = parseInt(String(raw == null || raw === '' ? _dflt('small', 0) : raw), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : _dflt('small', 0);
  }
  if (scale === 'large') {
    const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_LARGE;
    const n = parseInt(String(raw == null || raw === '' ? _dflt('large', 3) : raw), 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(6, n)) : _dflt('large', 3);
  }
  const raw = process.env.KHY_TOOL_LOOP_TRANSIENT_RECOVERIES;
  const n = parseInt(String(raw == null || raw === '' ? _dflt('normal', 1) : raw), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : _dflt('normal', 1);
}

/**
 * Bounded retry budget for an empty / no-text terminal reply. Defaults to 2
 * regardless of scale ("网络波动 → 重试几次"), env-tunable; clamped to [0,3].
 * Distinct from the transient budget so an empty reply gets its own retries
 * even when transient recoveries are disabled for small tasks.
 */
function _resolveEmptyRecoveryMax(userMessage = '', options = {}) {
  const explicit = parseInt(String(options.maxEmptyRecoveries ?? ''), 10);
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.min(3, explicit));
  }
  const n = parseInt(String(process.env.KHY_TOOL_LOOP_EMPTY_RECOVERIES || '2'), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 2;
}

function _recoveryDelayMs(attemptIndex = 0) {
  const base = Math.max(
    300,
    parseInt(String(process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS || '1200'), 10) || 1200
  );
  const exp = Math.min(4, Math.max(0, attemptIndex));
  const jitter = Math.random() * 300;
  return Math.round(base * Math.pow(1.65, exp) + jitter);
}

// First stall nudge must feel seamless — a near-zero delay so the continuation
// lands before the user perceives any hitch. Env-tunable; clamped to [0,300] so
// "无感顺滑" can never be turned into a long visible pause.
function _stallNudgeSilentDelayMs() {
  const v = parseInt(String(process.env.KHY_TOOL_LOOP_STALL_SILENT_DELAY_MS ?? '120'), 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(300, v)) : 120;
}

module.exports = {
  setRecoveryDeps,
  _resolveTaskScale,
  _isTransientLoopErrorType,
  _normalizeStopReason,
  _shouldTrustStopReason,
  _isCooldownFailure,
  _resolveTransientRecoveryMax,
  _resolveEmptyRecoveryMax,
  _recoveryDelayMs,
  _stallNudgeSilentDelayMs,
};
