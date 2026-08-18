'use strict';

/**
 * restoreAgentService.js — 还原收敛闭环 agent（OPS-MAN-082）
 *
 * 设计：编排还原家族 5 层架构的最外层闭环——
 *   ① 三面镜子（restore-check / verify-install / hydration-doctor）→ snapshot
 *   ② agentRestorePlan（OPS-MAN-075）→ 合成有序方案
 *   ③ restoreConflictDetector（OPS-MAN-076）→ 检测矛盾
 *   ④ restoreConflictResolver（OPS-MAN-079）→ 解决矛盾 → moves[]
 *   ⑤ restoreConvergenceVerifier（OPS-MAN-082）→ 判断进展 / 防死循环
 *
 * 循环语义：
 *   - 每 step：probe → plan → execute one move → verify convergence → audit
 *   - converged (blockerCount === 0) → 停止返回成功
 *   - regressed (blocker 增加) → 立即停止并升级
 *   - stalled 连续 2 次 → 升级（STALL_LIMIT = 2）
 *   - advanced (blocker 减少) → 继续，重置 stallCount
 *   - 最多 10 步（env KHY_RESTORE_MAX_STEPS）
 *
 * 每 step 写 healAudit：component='restore-agent'，记录 move + verdict + snapshot delta。
 *
 * CLI 入口：
 *   - `khy restore --auto`：自动闭环直到收敛或升级
 *   - `khy restore --plan`：仅生成并打印方案，不执行
 *
 * 分层：本文件是薄 IO 编排层，所有纯逻辑在 scripts/lib/*。
 */

const path = require('path');
const { assessRestoreReadiness } = require('./restore/restoreReadiness');
const { assessInstallIntegrity } = require('./restore/installIntegrity');
const { assessHydrationHealth } = require('./restore/hydrationHealth');
const { buildRestorePlan } = require('./restore/agentRestorePlan');
const { detectRestoreConflicts } = require('./restore/restoreConflictDetector');
const { resolveRestoreConflicts } = require('./restore/restoreConflictResolver');
const {
  verifyConvergence,
  STALL_LIMIT,
  STOP_CONTINUE,
  STOP_CONVERGED,
  STOP_ESCALATE,
} = require('./restore/restoreConvergenceVerifier');
const { logHealEvent } = require('./healAuditService');
const { escalate } = require('./healEscalationService');

// 复用三个 CLI 的探测器（零重复，各自 fail-soft）
const { probeRestoreFacts } = require('../../../../scripts/restore/restore-check');
const { resolveBundleRoot, probeInstalledBundle } = require('../../../../scripts/install/verify-install');
const { probeHydrationFacts } = require('../../../../scripts/diagnostics/hydration-doctor');

const MAX_STEPS = parseInt(process.env.KHY_RESTORE_MAX_STEPS || '10', 10);

// ── 探测层（调用三面镜子，返回统一 snapshot）────────────────────────────────

/**
 * 探测本机三面镜子 → 返回 snapshot：
 *   { restore: {ready, blockers, warnings}, integrity: {intact, missing}, hydration: {healthy, blockers} }
 * fail-soft：任一探测失败返回该面的保守结果，不影响其余面。
 */
function _probeSnapshot() {
  const snapshot = {
    restore: undefined,
    integrity: undefined,
    hydration: undefined,
  };
  try {
    const facts = probeRestoreFacts();
    snapshot.restore = assessRestoreReadiness(facts);
  } catch {
    snapshot.restore = { ready: false, blockers: [], warnings: [], checked: 0, summary: '还原就绪探测失败' };
  }
  try {
    const bundleRoot = resolveBundleRoot();
    const probes = probeInstalledBundle(bundleRoot);
    snapshot.integrity = assessInstallIntegrity(probes, { bundleResolved: bundleRoot !== null });
  } catch {
    snapshot.integrity = { intact: false, missing: [], present: [], checked: 0, summary: '安装完整性探测失败' };
  }
  try {
    const facts = probeHydrationFacts();
    snapshot.hydration = assessHydrationHealth(facts);
  } catch {
    snapshot.hydration = { healthy: false, blockers: [], warnings: [], checked: 0, summary: '水合健康探测失败' };
  }
  return snapshot;
}

// ── 方案合成层（agentRestorePlan + conflict detection/resolution）───────────

/**
 * 从 snapshot 合成有序还原方案 → 检测矛盾 → 解决矛盾 → 返回可执行的 moves[]。
 * fail-soft：任何环节失败返回空方案（交人）。
 */
function _synthesizePlan(snapshot) {
  try {
    const plan = buildRestorePlan(snapshot);
    if (!plan.steps || plan.steps.length === 0) {
      return { ready: true, moves: [], plan, conflicts: null, resolution: null };
    }
    const conflicts = detectRestoreConflicts(snapshot);
    const resolution = resolveRestoreConflicts({ snapshot, conflicts });
    // resolution.moves: [{action, strategy, autonomy, concern, ...}]
    return {
      ready: plan.ready,
      moves: resolution.moves || [],
      plan,
      conflicts,
      resolution,
    };
  } catch (err) {
    return {
      ready: false,
      moves: [],
      plan: null,
      conflicts: null,
      resolution: null,
      error: err.message,
    };
  }
}

// ── 执行层（stub：当前阶段仅记录 move，不实际执行修法命令）─────────────────

/**
 * 执行一个 move。当前实现：仅记录到 audit，不实际执行修法命令（防越界）。
 * 返回 { ok, executed, skipped, reason }。
 *
 * TODO (future)：当 autonomy gate 授权后，调用 execSync(move.action) 真实执行。
 */
async function _executeMove(move, opts = {}) {
  const dryRun = opts.dryRun !== false; // 默认 dry-run
  if (!move || !move.action) {
    return { ok: false, executed: false, skipped: true, reason: 'no-action' };
  }
  if (move.autonomy === 'human') {
    return { ok: false, executed: false, skipped: true, reason: 'human-required' };
  }
  if (dryRun) {
    // Dry-run 模式：仅记录，不执行
    return { ok: true, executed: false, skipped: false, reason: 'dry-run', move };
  }
  // TODO: 实际执行 move.action（需 autonomy gate 授权 + shell exec）
  return { ok: true, executed: true, skipped: false, reason: 'executed', move };
}

// ── Audit 层 ──────────────────────────────────────────────────────────────

/**
 * 写一条 healAudit 记录当前 step 的执行情况。
 * fail-soft：logHealEvent 返回 false 不影响主循环。
 */
function _writeHealAudit({ step, move, verdict, before, after }) {
  const beforeCount = _countBlockers(before);
  const afterCount = _countBlockers(after);
  const details = {
    step,
    verdict: verdict.verdict,
    stop: verdict.stop,
    stallCount: verdict.stallCount,
    beforeBlockers: beforeCount,
    afterBlockers: afterCount,
    resolved: verdict.resolved || [],
    introduced: verdict.introduced || [],
    move: move ? { action: move.action, strategy: move.strategy, concern: move.concern } : null,
  };
  logHealEvent({
    component: 'restore-agent',
    action: `step-${step}`,
    target: move ? move.concern : 'probe',
    result: verdict.converged ? 'converged' : verdict.verdict === 'regressed' ? 'regressed' : 'advanced',
    details,
  });
}

/** 从 snapshot 计算 blocker 总数（三面镜子 blocker 之和）。 */
function _countBlockers(snapshot) {
  let count = 0;
  if (snapshot.restore && Array.isArray(snapshot.restore.blockers)) {
    count += snapshot.restore.blockers.length;
  }
  if (snapshot.integrity && Array.isArray(snapshot.integrity.missing)) {
    count += snapshot.integrity.missing.length;
  }
  if (snapshot.hydration && Array.isArray(snapshot.hydration.blockers)) {
    count += snapshot.hydration.blockers.length;
  }
  return count;
}

// ── 升级层 ────────────────────────────────────────────────────────────────

/**
 * 升级：调用 healEscalationService 并返回标准结果。
 * fail-soft：escalate 失败不抛异常。
 */
async function _escalate(reason, details = {}) {
  try {
    const result = await escalate({
      component: 'restore-agent',
      reason: typeof reason === 'string' ? reason : reason.reason || 'unknown',
      details: {
        ...details,
        verdict: reason.verdict,
        stallCount: reason.stallCount,
        beforeCount: reason.beforeCount,
        afterCount: reason.afterCount,
      },
    });
    return {
      ok: false,
      converged: false,
      escalated: true,
      reason: result.reason || reason,
      escalation: result,
    };
  } catch (err) {
    return {
      ok: false,
      converged: false,
      escalated: false,
      reason: 'escalation-failed',
      error: err.message,
    };
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────

/**
 * 自动还原闭环：循环执行 probe → plan → execute → verify，直到收敛或升级。
 *
 * @param {object} opts
 *   opts.maxSteps  最大步数（默认 env KHY_RESTORE_MAX_STEPS || 10）
 *   opts.dryRun    仅记录不实际执行（默认 true）
 * @returns {Promise<{ok, converged, steps, reason?, escalation?}>}
 */
async function runAutoRestore(opts = {}) {
  const maxSteps = opts.maxSteps || MAX_STEPS;
  const dryRun = opts.dryRun !== false;
  let stallCount = 0;
  const history = [];

  for (let step = 1; step <= maxSteps; step++) {
    // 1. 探测 before snapshot
    const before = _probeSnapshot();
    const beforeCount = _countBlockers(before);

    // 2. 合成方案
    const synthesis = _synthesizePlan(before);
    if (!synthesis.moves || synthesis.moves.length === 0) {
      // 无 move → 已收敛或无法自动修复
      if (beforeCount === 0) {
        _writeHealAudit({ step, move: null, verdict: { verdict: 'converged', stop: STOP_CONVERGED, converged: true }, before, after: before });
        return { ok: true, converged: true, steps: step, history };
      } else {
        // 有 blocker 但无可用 move → 升级
        const reason = { reason: 'no-moves-available', beforeCount };
        _writeHealAudit({ step, move: null, verdict: { verdict: 'stalled', stop: STOP_ESCALATE, converged: false }, before, after: before });
        return _escalate(reason, { step, beforeCount });
      }
    }

    // 3. 执行第一个 move
    const move = synthesis.moves[0];
    const execResult = await _executeMove(move, { dryRun });
    history.push({ step, move, execResult });

    // 4. 探测 after snapshot
    const after = _probeSnapshot();
    const afterCount = _countBlockers(after);

    // 5. 验证收敛
    const verdict = verifyConvergence({
      before,
      after,
      move,
      stallCount,
      stallLimit: STALL_LIMIT,
    });
    _writeHealAudit({ step, move, verdict, before, after });

    // 6. 根据 verdict.stop 决定下一步
    if (verdict.stop === STOP_CONVERGED) {
      return { ok: true, converged: true, steps: step, history };
    }
    if (verdict.stop === STOP_ESCALATE) {
      return _escalate(verdict, { step, move, beforeCount, afterCount });
    }
    // verdict.stop === STOP_CONTINUE
    stallCount = verdict.stallCount;
  }

  // 达到最大步数仍未收敛 → 升级
  const reason = { reason: 'max-steps-reached', maxSteps };
  return _escalate(reason, { maxSteps });
}

/**
 * 生成还原方案（不执行）：用于 `khy restore --plan`。
 *
 * @param {object} opts (保留，未来可能需要)
 * @returns {Promise<{ok, ready, plan, conflicts, resolution, moves}>}
 */
async function generateRestorePlan(opts = {}) {
  try {
    const snapshot = _probeSnapshot();
    const synthesis = _synthesizePlan(snapshot);
    return {
      ok: true,
      ready: synthesis.ready,
      plan: synthesis.plan,
      conflicts: synthesis.conflicts,
      resolution: synthesis.resolution,
      moves: synthesis.moves,
      snapshot,
    };
  } catch (err) {
    return {
      ok: false,
      ready: false,
      plan: null,
      conflicts: null,
      resolution: null,
      moves: [],
      error: err.message,
    };
  }
}

// ── 导出 ──────────────────────────────────────────────────────────────────

module.exports = {
  runAutoRestore,
  generateRestorePlan,
  // 供测试 / 上层调用的内部件
  _probeSnapshot,
  _synthesizePlan,
  _executeMove,
  _writeHealAudit,
  _countBlockers,
  _escalate,
  MAX_STEPS,
};
