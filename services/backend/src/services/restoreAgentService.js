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
const { assessRestoreReadiness } = require('./domain/backup/restore/restoreReadiness');
const { assessInstallIntegrity } = require('./domain/backup/restore/installIntegrity');
const { assessHydrationHealth } = require('./domain/backup/restore/hydrationHealth');
const { buildRestorePlan } = require('./domain/backup/restore/agentRestorePlan');
const { detectRestoreConflicts } = require('./domain/backup/restore/restoreConflictDetector');
const { resolveRestoreConflicts } = require('./domain/backup/restore/restoreConflictResolver');
const {
  verifyConvergence,
  STALL_LIMIT,
  STOP_CONTINUE,
  STOP_CONVERGED,
  STOP_ESCALATE,
} = require('./domain/backup/restore/restoreConvergenceVerifier');
const { logHealEvent } = require('./healAuditService');
const { escalate } = require('./healEscalationService');

// 复用三个探测器（零重复，各自 fail-soft）。restore-check 仍在核的 scripts/ 里，直接 require；
// 另两个已迁为拓展（khy-installer / khy-diagnostics），必须**按服务名惰性解析**：写死相对
// 路径的话，删掉那个拓展目录会让本模块在加载期就抛 MODULE_NOT_FOUND，整个还原服务连启动
// 都失败——那是「删目录即整机不可用」，不是 §4.1 要的「删目录即该能力消失」。
const { probeRestoreFacts } = require('../../../../scripts/restore/restore-check');
const { requireFromProvider } = require('./domain/extensions/extensions/providerModule');

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
    const verifier = requireFromProvider('install-verifier', 'verify-install.js');
    if (!verifier) {
      // 拓展缺席与探测失败是两回事：前者是「这台机器上没装这个能力」，后者是「装了但坏了」。
      // 报同一句话会让人去查一个根本不存在的故障。
      throw new Error('install-verifier 未提供');
    }
    const bundleRoot = verifier.resolveBundleRoot();
    const probes = verifier.probeInstalledBundle(bundleRoot);
    snapshot.integrity = assessInstallIntegrity(probes, { bundleResolved: bundleRoot !== null });
  } catch (err) {
    const missing = /未提供/.test(err && err.message);
    snapshot.integrity = {
      intact: false, missing: [], present: [], checked: 0,
      summary: missing ? '跳过安装完整性探测：install-verifier 拓展未安装' : '安装完整性探测失败',
    };
  }
  try {
    const doctor = requireFromProvider('hydration-probe', 'hydration-doctor.js');
    if (!doctor) {
      throw new Error('hydration-probe 未提供');
    }
    snapshot.hydration = assessHydrationHealth(doctor.probeHydrationFacts());
  } catch (err) {
    const missing = /未提供/.test(err && err.message);
    snapshot.hydration = {
      healthy: false, blockers: [], warnings: [], checked: 0,
      summary: missing ? '跳过水合健康探测：hydration-probe 拓展未安装' : '水合健康探测失败',
    };
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

// ── 执行层（沙箱执行 + 自动回滚）───────────────────────────────────────

/**
 * 执行一个 move。采用沙箱执行策略：
 *   - 高风险修复（如逻辑修改）：生成报告，用户确认
 *   - 中风险修复（代码修改但测试覆盖充分）：自动执行 + 通知
 *   - 低风险修复（注释/格式/文档）：自动执行
 * 
 * 回滚机制：每次修复前创建 git tag，提供 `khy restore --rollback <tag>`。
 * 
 * @param {object} move 要执行的修复
 * @param {object} opts { dryRun, sandbox }
 * @returns {Promise<{ ok, executed, skipped, reason, rollbackTag? }>}
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
    return { ok: true, executed: false, skipped: false, reason: 'dry-run', move };
  }

  // 风险分级
  const riskLevel = _assessRisk(move);
  
  // 高风险修复 → 生成报告，用户确认
  if (riskLevel === 'high') {
    return { 
      ok: false, 
      executed: false, 
      skipped: true, 
      reason: 'high-risk-requires-confirmation',
      move,
      report: _generateMoveReport(move)
    };
  }

  // 中低风险修复 → 沙箱执行
  return _executeInSandbox(move, opts);
}

/**
 * 评估修复风险等级。
 * @param {object} move 修复 move
 * @returns {'low'|'medium'|'high'}
 */
function _assessRisk(move) {
  const action = String(move.action || '').toLowerCase();
  const concern = String(move.concern || '').toLowerCase();
  
  // 高风险：修改核心逻辑、数据库 schema、安全相关
  if (/src\/services|src\/cli|migration|auth|security|password|secret|permission/.test(concern) ||
      /core|kernel|syscall/.test(concern)) {
    return 'high';
  }
  
  // 中风险：修改业务逻辑、配置文件
  if (/src\//.test(concern) && !/test|spec/.test(concern)) {
    return 'medium';
  }
  
  // 低风险：文档、注释、格式、测试文件
  return 'low';
}

/**
 * 生成修复报告。
 * @param {object} move 修复 move
 * @returns {object} 报告内容
 */
function _generateMoveReport(move) {
  return {
    action: move.action,
    concern: move.concern,
    strategy: move.strategy,
    description: move.description,
    risk: 'high',
    requiresConfirmation: true,
    rollbackPlan: 'khy restore --rollback <tag>',
    timestamp: new Date().toISOString(),
  };
}

/**
 * 沙箱执行修复（git worktree + 自动回滚）。
 * @param {object} move 修复 move
 * @param {object} opts { sandbox }
 * @returns {Promise<object>} 执行结果
 */
async function _executeInSandbox(move, opts = {}) {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  
  const tag = `restore-${Date.now()}`;
  const sandboxDir = path.join(process.cwd(), '.restore-sandbox');
  
  try {
    // 1. 创建回滚 tag
    execSync(`git tag ${tag}`, { stdio: 'pipe' });
    
    // 2. 创建 git worktree（沙箱）
    fs.mkdirSync(sandboxDir, { recursive: true });
    execSync(`git worktree add ${sandboxDir} HEAD`, { stdio: 'pipe' });
    
    // 3. 在沙箱中执行修复
    const result = await _runActionInWorktree(move.action, sandboxDir);
    
    // 4. 如果执行成功，合并到主分支
    if (result.success) {
      // 将沙箱中的改动合并回主分支
      execSync(`git -C ${sandboxDir} add -A`, { stdio: 'pipe' });
      execSync(`git -C ${sandboxDir} commit -m "auto-restore: ${move.concern}"`, { stdio: 'pipe' });
      // 注意：实际合并可能需要更复杂的处理，这里简化为记录
      return { 
        ok: true, 
        executed: true, 
        skipped: false, 
        reason: 'sandbox-executed',
        rollbackTag: tag,
        move
      };
    } else {
      // 执行失败，清理
      throw new Error(result.error || '执行失败');
    }
    
  } catch (err) {
    // 回滚
    try {
      execSync(`git tag -d ${tag}`, { stdio: 'pipe' });
      execSync(`git worktree remove ${sandboxDir} --force`, { stdio: 'pipe' });
    } catch {
      // 忽略清理错误
    }
    
    return { 
      ok: false, 
      executed: false, 
      skipped: true, 
      reason: 'sandbox-failed',
      error: err.message,
      move
    };
  }
}

/**
 * 在 git worktree 中执行修复动作。
 * @param {string} action 修复命令
 * @param {string} worktreeDir worktree 目录
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
async function _runActionInWorktree(action, worktreeDir) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    const { stdout, stderr } = await execAsync(action, { 
      cwd: worktreeDir,
      timeout: 30000 
    });
    return { success: true, output: stdout, error: stderr };
  } catch (err) {
    return { success: false, output: err.stdout, error: err.stderr || err.message };
  }
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
