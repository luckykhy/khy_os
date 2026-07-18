'use strict';

/**
 * capacityFlow.js — 3-Checkpoint Capacity Flow System
 *
 * Aligned with DeepSeek-TUI's graduated capacity management.
 * Three checkpoints in the tool-use loop with escalating interventions:
 *
 *   1. Pre-request   — Before API call. Detects context pressure early.
 *   2. Post-tool     — After tool execution. Detects risky state drift.
 *   3. Error-escalation — On consecutive errors. Escalates to replan.
 *
 * Each checkpoint returns a CapacityDecision that the loop should act on.
 */

const contextWindowGuard = require('./contextWindowGuard');
let _contextDiagnostics;
try { _contextDiagnostics = require('./contextDiagnostics'); } catch { _contextDiagnostics = null; }

// 诊断驱动的补判模式（环境变量单一真源）：
//   off     — 完全关闭，不计算，行为与历史一致
//   observe — 计算并把 details.diagnostics 挂出（可观测），但绝不改变决策
//   on(默认) — 计算 + 挂出 + 在比例闸门放行时，对高置信「非溢出」病态升级
function _diagnosticsMode() {
  const v = String(process.env.KHY_CONTEXT_DIAGNOSTICS || 'on').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'observe' || v === 'shadow') return 'observe';
  return 'on';
}

// ── Capacity Decision Enum ────────────────────────────────────────────

const CapacityDecision = Object.freeze({
  /** No action needed — context healthy. */
  None: 'none',
  /** Trim oldest messages to free space. */
  TargetedRefresh: 'targeted_refresh',
  /** Re-execute last read-only tool to verify state consistency. */
  VerifyReplay: 'verify_replay',
  /** Reset to canonical state and replan from scratch. */
  VerifyReplan: 'verify_replan',
});

// ── Risk Level ────────────────────────────────────────────────────────
//
// DOMAIN NOTE — this is the CAPACITY / context-window-health domain, NOT the
// security-approval domain. These four names (low/medium/high/critical) grade
// context-window pressure and tool-loop state drift for the capacity scheduler.
// They are ORTHOGONAL to tool/syscall security approval (syscallGateway /
// execApproval / permissionPolicy / constants/riskOrder.js). Reusing the four
// words is coincidental; there is NO relationship to the security risk scale.
// Canonical name is `CapacityRiskLevel`; `RiskLevel` is kept as a backward-
// compatible alias so existing consumers keep working. Both are exported.
const CapacityRiskLevel = Object.freeze({
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Critical: 'critical',
});
// Backward-compatible alias (minimizes diff for internal use sites below).
const RiskLevel = CapacityRiskLevel;

// ── Thresholds ────────────────────────────────────────────────────────

const MEDIUM_USAGE_RATIO = 0.60;
const HIGH_USAGE_RATIO   = 0.80;
const CRITICAL_USAGE_RATIO = 0.90;

// Error escalation: how many consecutive errors trigger replan
const ERROR_ESCALATION_WARN  = 2;
const ERROR_ESCALATION_REPLAN = 4;

// Post-tool: how many high-risk tool results trigger verification
const POST_TOOL_HIGH_RISK_THRESHOLD = 3;

// ── Checkpoint 1: Pre-Request ─────────────────────────────────────────

/**
 * Evaluate context health before making an API call.
 * If context is getting crowded, trigger a targeted refresh.
 *
 * @param {object} ctx
 * @param {number} ctx.usedTokens      - Current token usage
 * @param {number} ctx.contextWindow    - Total context window size
 * @param {Array}  ctx.messages         - Conversation messages
 * @param {function} [ctx.estimateTokens] - Token estimator fn
 * @param {object} [ctx.logger]
 * @returns {{ decision: string, risk: string, details: object }}
 */
function preRequestCheckpoint(ctx) {
  const base = _ratioDecision(ctx);
  return _overlayDiagnostics(base, ctx);
}

/**
 * 比例闸门：历史行为，纯 token 占用 + guard 驱动。保持 byte-identical。
 */
function _ratioDecision(ctx) {
  const { usedTokens, contextWindow } = ctx;
  if (!contextWindow || contextWindow <= 0) {
    return { decision: CapacityDecision.None, risk: RiskLevel.Low, details: {} };
  }

  const ratio = usedTokens / contextWindow;
  const guard = contextWindowGuard.evaluateGuard({
    usedTokens,
    contextWindowTokens: contextWindow,
  });

  // Critical: about to overflow
  if (ratio >= CRITICAL_USAGE_RATIO || guard.shouldBlock) {
    return {
      decision: CapacityDecision.TargetedRefresh,
      risk: RiskLevel.Critical,
      details: {
        usageRatio: ratio,
        remainingTokens: guard.remainingTokens,
        action: 'Prune oldest messages — context near overflow',
      },
    };
  }

  // High: getting crowded
  if (ratio >= HIGH_USAGE_RATIO || guard.shouldWarn) {
    return {
      decision: CapacityDecision.TargetedRefresh,
      risk: RiskLevel.High,
      details: {
        usageRatio: ratio,
        remainingTokens: guard.remainingTokens,
        action: 'Trim non-essential older messages',
      },
    };
  }

  // Medium: worth watching but no action yet
  if (ratio >= MEDIUM_USAGE_RATIO) {
    return {
      decision: CapacityDecision.None,
      risk: RiskLevel.Medium,
      details: {
        usageRatio: ratio,
        remainingTokens: guard.remainingTokens,
      },
    };
  }

  return { decision: CapacityDecision.None, risk: RiskLevel.Low, details: {} };
}

/**
 * 诊断补判：覆盖 capacityFlow 历史盲区——比例闸门只看「溢出」，对投毒/稀释/混淆
 * 完全不可见（框架点破的「假象差」：占用 50% 却已自我回显投毒）。
 *
 * 规则（保证零回归）：
 *   - 仅在 messages 提供 且 模式≠off 时计算；任何异常吞掉，回退原决策。
 *   - 始终把 details.diagnostics 摘要挂出（可观测，状态透明）。
 *   - 只「升级」不「降级」：仅当原决策为 None（比例判健康）时，才可能因高置信
 *     非溢出病态升级为 TargetedRefresh；原本已有动作的决策原样透传。
 *   - observe 模式只挂诊断、绝不改决策。
 *
 * @param {{decision:string, risk:string, details:object}} base
 * @param {object} ctx  preRequestCheckpoint 入参（需含 messages 才能诊断）
 */
function _overlayDiagnostics(base, ctx) {
  const mode = _diagnosticsMode();
  if (mode === 'off' || !_contextDiagnostics || !Array.isArray(ctx && ctx.messages) || ctx.messages.length === 0) {
    return base;
  }
  let diag;
  try {
    diag = _contextDiagnostics.diagnoseContext(ctx.messages, {
      contextWindow: ctx.contextWindow,
      estimateTokens: ctx.estimateTokens,
    });
  } catch {
    return base; // 诊断永不阻断主流程
  }
  if (!diag) return base;

  // 始终挂出摘要（即便不改决策）。
  const details = Object.assign({}, base.details, {
    diagnostics: {
      health: diag.health,
      worst: diag.worst,
      summary: _contextDiagnostics.summarize(diag),
      recommendations: diag.recommendations,
    },
  });

  // observe 模式 / 已有动作的决策：只挂诊断，不改决策。
  if (mode === 'observe' || base.decision !== CapacityDecision.None) {
    return Object.assign({}, base, { details });
  }

  // on 模式 + 原本放行：补判高置信非溢出病态。
  const pathology = _contextDiagnostics.hasNonOverflowPathology(diag);
  if (pathology) {
    return {
      decision: CapacityDecision.TargetedRefresh,
      risk: RiskLevel.High,
      details: Object.assign(details, {
        triggeredBy: 'diagnostics',
        failureMode: pathology.mode,
        action: `Context ${pathology.mode} detected at healthy token ratio — refresh before it self-reinforces`,
      }),
    };
  }
  return Object.assign({}, base, { details });
}

// ── Checkpoint 2: Post-Tool ───────────────────────────────────────────

/**
 * Evaluate context health after tool execution.
 * Detects risky state: many errors, large output, potential drift.
 *
 * @param {object} ctx
 * @param {Array}  ctx.toolResults      - Results from this iteration's tools
 * @param {number} ctx.usedTokens       - Current token usage after results
 * @param {number} ctx.contextWindow    - Total context window
 * @param {number} ctx.iterationErrors  - Errors in this iteration
 * @param {number} ctx.totalIterations  - How far into the loop
 * @returns {{ decision: string, risk: string, details: object }}
 */
function postToolCheckpoint(ctx) {
  const { toolResults = [], usedTokens = 0, contextWindow = 0, iterationErrors = 0, totalIterations = 0 } = ctx;

  if (!contextWindow || contextWindow <= 0) {
    return { decision: CapacityDecision.None, risk: RiskLevel.Low, details: {} };
  }

  const ratio = usedTokens / contextWindow;

  // Critical: context overflowed after tool execution
  if (ratio >= CRITICAL_USAGE_RATIO) {
    return {
      decision: CapacityDecision.VerifyReplan,
      risk: RiskLevel.Critical,
      details: {
        usageRatio: ratio,
        action: 'Context near overflow after tools — replan from canonical state',
      },
    };
  }

  // High risk: many tool errors in this iteration suggest state drift
  const failedCount = toolResults.filter(tr => tr.result && !tr.result.success).length;
  if (failedCount >= POST_TOOL_HIGH_RISK_THRESHOLD) {
    return {
      decision: CapacityDecision.VerifyReplay,
      risk: RiskLevel.High,
      details: {
        failedCount,
        totalTools: toolResults.length,
        action: 'Multiple tool failures — verify recent work with replay',
      },
    };
  }

  // Medium: context growing after tool expansion
  if (ratio >= HIGH_USAGE_RATIO) {
    return {
      decision: CapacityDecision.TargetedRefresh,
      risk: RiskLevel.Medium,
      details: {
        usageRatio: ratio,
        action: 'Context expanded from tool output — targeted trim',
      },
    };
  }

  return { decision: CapacityDecision.None, risk: RiskLevel.Low, details: {} };
}

// ── Checkpoint 3: Error Escalation ────────────────────────────────────

/**
 * Evaluate whether consecutive errors warrant a full replan.
 * Skips transient errors (network, rate-limit) — only escalates persistent failures.
 *
 * @param {object} ctx
 * @param {number} ctx.consecutiveErrors - Count of consecutive failed iterations
 * @param {Array}  ctx.recentErrors      - Error descriptions from recent failures
 * @param {number} ctx.usedTokens
 * @param {number} ctx.contextWindow
 * @returns {{ decision: string, risk: string, details: object }}
 */
function errorEscalationCheckpoint(ctx) {
  const { consecutiveErrors = 0, recentErrors = [], usedTokens = 0, contextWindow = 0 } = ctx;

  // Skip escalation for transient errors (network, timeout, rate-limit)
  const transientPatterns = /\b(timeout|econnrefused|enotfound|rate.?limit|429|503|502)\b/i;
  const allTransient = recentErrors.length > 0 && recentErrors.every(e =>
    transientPatterns.test(typeof e === 'string' ? e : String(e?.message || e?.error || e))
  );
  if (allTransient) {
    return {
      decision: CapacityDecision.None,
      risk: RiskLevel.Low,
      details: { reason: 'All errors are transient — skip escalation' },
    };
  }

  // Context overflow always escalates immediately
  if (contextWindow > 0 && usedTokens / contextWindow >= CRITICAL_USAGE_RATIO) {
    return {
      decision: CapacityDecision.VerifyReplan,
      risk: RiskLevel.Critical,
      details: {
        consecutiveErrors,
        action: 'Context overflow + errors — force replan',
      },
    };
  }

  // 4+ consecutive non-transient errors → replan
  if (consecutiveErrors >= ERROR_ESCALATION_REPLAN) {
    return {
      decision: CapacityDecision.VerifyReplan,
      risk: RiskLevel.High,
      details: {
        consecutiveErrors,
        action: 'Persistent errors — reset to canonical state and replan',
      },
    };
  }

  // 2+ consecutive errors → warn (trigger targeted refresh)
  if (consecutiveErrors >= ERROR_ESCALATION_WARN) {
    return {
      decision: CapacityDecision.TargetedRefresh,
      risk: RiskLevel.Medium,
      details: {
        consecutiveErrors,
        action: 'Repeated errors — targeted context refresh',
      },
    };
  }

  return { decision: CapacityDecision.None, risk: RiskLevel.Low, details: {} };
}

// ── Utility: Execute Decision ─────────────────────────────────────────

/**
 * Apply a capacity decision to the message array.
 * Returns the potentially modified messages array.
 *
 * @param {string} decision - CapacityDecision value
 * @param {Array} messages  - Current conversation messages
 * @param {object} opts
 * @param {function} opts.estimateTokens
 * @param {number} opts.contextWindow
 * @param {function} [opts.onRefresh] - Callback when refresh happens
 * @param {function} [opts.onReplan]  - Callback when replan happens
 * @returns {Array} Modified messages
 */
function applyDecision(decision, messages, opts = {}) {
  if (decision === CapacityDecision.None) return messages;

  const { estimateTokens, contextWindow, onRefresh, onReplan } = opts;

  if (decision === CapacityDecision.TargetedRefresh) {
    if (!estimateTokens || !contextWindow) return messages;
    const targetTokens = Math.floor(contextWindow * 0.70);
    const { pruned, removedCount, removedTokens } = contextWindowGuard.pruneMessages(
      messages,
      { targetTokens, estimateTokens }
    );
    if (onRefresh) onRefresh({ removedCount, removedTokens });
    return pruned;
  }

  if (decision === CapacityDecision.VerifyReplan) {
    if (onReplan) onReplan({ messageCount: messages.length });
    // Replan: keep system + last user message only
    const system = messages.filter(m => m.role === 'system');
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    return lastUser ? [...system, lastUser] : system;
  }

  // VerifyReplay — caller handles replay logic; no message modification here
  return messages;
}

module.exports = {
  CapacityDecision,
  CapacityRiskLevel,
  RiskLevel, // backward-compatible alias of CapacityRiskLevel
  preRequestCheckpoint,
  postToolCheckpoint,
  errorEscalationCheckpoint,
  applyDecision,
  // Internal seams exposed for testing / advanced callers
  _ratioDecision,
  _overlayDiagnostics,
  // Thresholds exported for testing
  MEDIUM_USAGE_RATIO,
  HIGH_USAGE_RATIO,
  CRITICAL_USAGE_RATIO,
  ERROR_ESCALATION_WARN,
  ERROR_ESCALATION_REPLAN,
};
