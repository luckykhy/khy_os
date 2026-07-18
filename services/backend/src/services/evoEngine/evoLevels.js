'use strict';

/**
 * evoLevels.js — 三级自举演进阶梯（§3.2）。
 *
 * 一条单调升级的格 L0 ⊏ L1 ⊏ L2，把「需求影响深度」映射到「自主行动权限」与「爆炸半径」：
 *
 *   L0 启发式缝合  边缘 Case 未覆盖、无系统性风险。仅改 Prompt / 注入 If-Then 规则。   记忆区补丁
 *   L1 器官新生    能力拓扑有空洞，需新工具/解析器。自主编码新函数并注册执行器。       新增代码 + 注册条目
 *   L2 宪法修正    核心流转逻辑（压缩/网关）有系统性缺陷。重构核心引擎或元约束。       核心覆写 + 迁移
 *
 * 防呆②（硬编码进算法，不可绕过）：L2 极危。任何 L2 演进**必须**先输出
 *   「修改前后架构对比 architectureDiff」+「爆炸半径评估 blastRadius」，且**强制降级为
 *   L0 执行，附 3 步验证**——绝不允许 L2 直接重写核心运行态。`planL2` 是这条铁律的唯一闸门。
 *
 * 纯函数、确定性：不调模型、不做 I/O。升级只取严（escalate），镜像 metaplan
 * `constraintStrategy` 的最小上界格，保证任何叠加层只能加锁不能减锁。
 */

const LEVELS = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2' });

// 严格度秩：越高 = 爆炸半径越大、所需护栏越多。
const RANK = Object.freeze({ [LEVELS.L0]: 0, [LEVELS.L1]: 1, [LEVELS.L2]: 2 });

const ALL = Object.freeze([LEVELS.L0, LEVELS.L1, LEVELS.L2]);

// L2 强制降级后的实际执行级 + 验证步数（防呆②）。写死，不可调。
const L2_DOWNGRADE_TO = LEVELS.L0;
const L2_VALIDATION_STEPS = 3;

function isLevel(l) {
  return Object.prototype.hasOwnProperty.call(RANK, l);
}

/** 严格度秩；未知 → 最严 L2（fail-safe）。 */
function rankOf(l) {
  return isLevel(l) ? RANK[l] : RANK[LEVELS.L2];
}

/** 两级的较严者（最小上界）。叠加任何层只能升级，绝不降级。 */
function escalate(a, b) {
  return rankOf(a) >= rankOf(b) ? _norm(a) : _norm(b);
}

/** actual 是否至少与 required 同严。 */
function atLeast(actual, required) {
  return rankOf(actual) >= rankOf(required);
}

/**
 * 把归因信号映射到建议演进级。纯启发：
 *   - 命中核心流转逻辑关键字（压缩/网关/调度/元约束）→ L2。
 *   - 需新增工具/解析器/执行器（能力空洞）→ L1。
 *   - 其余（边缘 case / 规则误杀 / 阈值僵化）→ L0。
 * @param {object} attribution { kind, why, surface } 来自 PainPointScanner 归因
 * @returns {string} LEVELS.*
 */
function classify(attribution = {}) {
  const blob = `${attribution.why || ''} ${attribution.surface || ''} ${attribution.kind || ''}`.toLowerCase();
  if (/(压缩|网关|调度|核心引擎|元约束|constitution|gateway|compress|scheduler|核心流转)/.test(blob)) {
    return LEVELS.L2;
  }
  if (/(缺.*工具|新.*解析器|新.*工具|能力空洞|未覆盖格式|missing tool|new parser|new tool|拓扑空洞)/.test(blob)) {
    return LEVELS.L1;
  }
  return LEVELS.L0;
}

/**
 * 防呆②闸门：L2 演进的强制降级规划。
 * 缺架构对比/爆炸半径即判不合规——绝不放行裸 L2。
 *
 * @param {object} l2Plan { architectureDiff, blastRadius }
 * @returns {{
 *   valid:boolean, missing:string[],
 *   declaredLevel:string, executionLevel:string, validationSteps:number,
 *   reason:string
 * }}
 */
function planL2(l2Plan = {}) {
  const missing = [];
  if (!l2Plan.architectureDiff || String(l2Plan.architectureDiff).trim().length < 8) {
    missing.push('architectureDiff(修改前后架构对比)');
  }
  if (!l2Plan.blastRadius || String(l2Plan.blastRadius).trim().length < 8) {
    missing.push('blastRadius(爆炸半径评估)');
  }
  const valid = missing.length === 0;
  return {
    valid,
    missing,
    declaredLevel: LEVELS.L2,
    // 无论是否齐备，执行级一律强制降级为 L0（防呆②）；不齐备时 valid=false 直接拦在闸门外。
    executionLevel: L2_DOWNGRADE_TO,
    validationSteps: L2_VALIDATION_STEPS,
    reason: valid
      ? `L2 宪法修正强制降级为 ${L2_DOWNGRADE_TO} 执行，附 ${L2_VALIDATION_STEPS} 步验证（防呆②）。`
      : `L2 缺少必填项，阻断：${missing.join('、')}（防呆②）。`,
  };
}

function _norm(l) {
  return isLevel(l) ? l : LEVELS.L2;
}

module.exports = {
  LEVELS,
  RANK,
  ALL,
  L2_DOWNGRADE_TO,
  L2_VALIDATION_STEPS,
  isLevel,
  rankOf,
  escalate,
  atLeast,
  classify,
  planL2,
};
