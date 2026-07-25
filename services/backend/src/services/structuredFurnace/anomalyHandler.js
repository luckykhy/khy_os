'use strict';

/**
 * anomalyHandler.js — 拒损与降级裁决器（DESIGN-ARCH-036 §3.4，骨架强制实现项 AnomalyHandler）。
 *
 * 坍缩产出若存在逻辑死锁/自相矛盾/要素缺失，绝不允许模型“脑补”调和（防呆④）。
 * 本模块是唯一裁决口，二选一：
 *
 *   拒损 REJECT   抛出结构化异常 FurnaceRejection，附**缺失/冲突要素枚举**，
 *                 强制上层向人类回问澄清。用于：硬要素缺失、DAG 成环（死锁）、
 *                 高置信度的不可调和矛盾。
 *   降级 DEGRADE  不阻断，但标记高不确定性，建议降级为「沙箱试探执行」并**锁定后续写权限**
 *                 （strategy 提升至 CODE_HARD 起步、sandbox=true、writeLocked=true）。
 *                 用于：低置信度、可隔离的轻度矛盾、模糊词残留导致的不确定。
 *
 * 裁决只依据结构化信号（环、contradictions、confidence、missing 枚举），不读原文、不猜意图。
 * 锁级一律经 metaplan/constraintStrategy.escalate 单调取严（桥接，不自定义）。
 */

const S = require('../metaplan/constraintStrategy');

const ANOMALY_KINDS = Object.freeze([
  'MISSING_ELEMENTS',   // 必填要素缺失（forgeSchema 校验失败）
  'DEADLOCK_CYCLE',     // TaskGraph 成环
  'CONTRADICTION',      // StateMachine 标记了矛盾
  'LOW_CONFIDENCE',     // 置信度低于阈值
  'UNKNOWN_ACTION',     // 动作未能映射到标准原语
]);

// 低于此置信度且无硬错误 → 降级沙箱，而非直接放行。
const DEGRADE_CONFIDENCE_FLOOR = 0.65;
// 矛盾的“可调和性”：标记数 <= 此值且置信度尚可 → 允许降级隔离；超过则拒损。
const CONTRADICTION_DEGRADE_MAX = 1;

class FurnaceRejection extends Error {
  /**
   * @param {string} message
   * @param {{ kind:string, missing?:string[], conflicts?:Array, detail?:object }} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'FurnaceRejection';
    this.kind = info.kind || 'MISSING_ELEMENTS';
    this.missing = Array.isArray(info.missing) ? info.missing : [];
    this.conflicts = Array.isArray(info.conflicts) ? info.conflicts : [];
    this.detail = info.detail || {};
    this.recoverable = false; // 拒损=不可自动恢复，必须人类澄清
  }

  toJSON() {
    return {
      error: this.name,
      kind: this.kind,
      message: this.message,
      missing: this.missing,
      conflicts: this.conflicts,
      detail: this.detail,
    };
  }
}

/**
 * 评估一份坍缩产出的异常并裁决。
 *
 * @param {object} input
 * @param {object} input.payload         坍缩 payload（ActionIntent/TaskGraph/StateMachine）
 * @param {object} [input.validation]    forgeSchema.validate 结果 { valid, error, missing }
 * @param {string[]} [input.cycle]       TaskGraph 死锁节点（findCycle 结果）
 * @param {Array} [input.contradictions] StateMachine 矛盾列表
 * @param {number} [input.confidence]    整体置信度
 * @returns {{ verdict:'PASS'|'DEGRADE', payload:object } }
 * @throws {FurnaceRejection} verdict=REJECT 时抛出（拒损不返回，强制上层捕获回问）
 */
function adjudicate(input = {}) {
  const { payload = {}, validation, cycle, contradictions = [], confidence } = input;
  const conf = typeof confidence === 'number'
    ? confidence
    : (typeof payload.confidence === 'number' ? payload.confidence : 1);

  // —— 拒损路径（硬错误，不可自动恢复）——
  if (validation && validation.valid === false) {
    throw new FurnaceRejection(`结构化校验未通过：${validation.error}`, {
      kind: 'MISSING_ELEMENTS',
      missing: validation.missing || [],
      detail: { error: validation.error },
    });
  }
  if (Array.isArray(cycle) && cycle.length > 0) {
    throw new FurnaceRejection('任务图存在逻辑死锁（成环），拒绝脑补调和', {
      kind: 'DEADLOCK_CYCLE',
      conflicts: cycle,
      detail: { cycle },
    });
  }
  // 多处不可调和矛盾 → 拒损；单处轻度矛盾 → 留给降级隔离。
  if (contradictions.length > CONTRADICTION_DEGRADE_MAX) {
    throw new FurnaceRejection('存在多处自相矛盾，无法确定唯一意图，拒损待澄清', {
      kind: 'CONTRADICTION',
      conflicts: contradictions,
      detail: { count: contradictions.length },
    });
  }

  // —— 降级路径（可隔离，不阻断但锁写）——
  const needsDegrade = conf < DEGRADE_CONFIDENCE_FLOOR || contradictions.length === 1;
  if (needsDegrade) {
    return { verdict: 'DEGRADE', payload: _degrade(payload, { confidence: conf, contradictions }) };
  }

  return { verdict: 'PASS', payload };
}

/** 给 payload 打上沙箱降级与写锁标记，并把锁级单调提升至 CODE_HARD 起步。 */
function _degrade(payload, meta) {
  const escalated = S.escalate(payload.strategy || S.STRATEGIES.PROMPT_SOFT, S.STRATEGIES.CODE_HARD);
  return {
    ...payload,
    strategy: escalated,
    degraded: true,
    sandbox: true,
    writeLocked: true,
    degradeReason: meta.contradictions && meta.contradictions.length
      ? 'isolable-contradiction'
      : 'low-confidence',
    uncertainty: { confidence: meta.confidence, contradictions: (meta.contradictions || []).length },
  };
}

module.exports = {
  adjudicate,
  FurnaceRejection,
  ANOMALY_KINDS,
  DEGRADE_CONFIDENCE_FLOOR,
  CONTRADICTION_DEGRADE_MAX,
};
