'use strict';

/**
 * physicalCodes.js — 双轨淬火引擎的「物理异常码」单一真源（§3.2 确定性升维映射）。
 *
 * 「物理异常」= 可被纯代码客观计算判定的硬伤，不依赖任何模型认知：Schema 违例、工具调用
 * 幻觉、行为越权、资源越界。每个码对应一条**确定性升维映射**——查表即得「保底需求」，
 * 零模型依赖、永远可产出。这张表同时被两端消费：
 *   - `PhysicalAssertionGate` 据 `match`/`signature` 把运行态失败判别成某个码；
 *   - `DeterministicElevator` 据 `signal/why/proposedModules/action/intendedLevel` 铸造保底需求。
 *
 * why 措辞经过校准，使 `evoLevels.classify` 把保底需求稳定落在 L0/L1（器官新生级，颗粒度
 * 粗但稳定）——L2 架构级需求是模型增益轨的产物，绝不由保底轨擅自升格。**绝不**在 why 里
 * 出现 classify 的 L2 触发词（压缩/网关/调度/核心流转/元约束）；§3.2 处方里的「网关」等词
 * 一律收纳进与 classify 无关的 `action` / `proposedModules` 字段。
 */

const { SIGNALS } = require('../evoEngine/evoRequirement');

const PHYSICAL_CODES = Object.freeze({
  ERR_SCHEMA_VIOLATION: 'ERR_SCHEMA_VIOLATION',
  ERR_TOOL_HALLUCINATION: 'ERR_TOOL_HALLUCINATION',
  ERR_BEHAVIOR_FORBIDDEN: 'ERR_BEHAVIOR_FORBIDDEN',
  ERR_RESOURCE_OVERFLOW: 'ERR_RESOURCE_OVERFLOW',
});

/**
 * 确定性升维映射表（§3.2）。每条：
 *   signal           映射到 evoRequirement.SIGNALS.*（喂给 forge）
 *   priority         保底需求优先级
 *   intendedLevel    期望演进级（被测试锁定，防 classify 漂移）
 *   why              元认知归因（classify 据此分级——已校准避开 L2 触发词）
 *   proposedModules  拟新增器官（§3.2 处方，可含「网关」等词，classify 不看）
 *   action           保底处方一句话（写入 merged_action 的 [保底] 段）
 *   gateOrder        物理网关多命中时的判别优先级（小=先判，安全/越权优先）
 */
const ELEVATION_MAP = Object.freeze({
  [PHYSICAL_CODES.ERR_BEHAVIOR_FORBIDDEN]: {
    signal: SIGNALS.INTERCEPTOR_BLOCK,
    priority: 'High',
    intendedLevel: 'L1',
    why: '行为越权被守卫阻断——缺细粒度权限沙箱与行为前置审批，能力拓扑空洞。',
    proposedModules: ['细粒度权限沙箱', '行为前置审批网关'],
    action: '增加细粒度权限沙箱与行为前置审批网关',
    gateOrder: 0,
  },
  [PHYSICAL_CODES.ERR_TOOL_HALLUCINATION]: {
    signal: SIGNALS.TOOL_FAILURE,
    priority: 'High',
    intendedLevel: 'L1',
    why: '调用了不存在的工具——能力拓扑空洞，缺工具路由白名单校验与降级兜底工具。',
    proposedModules: ['工具路由白名单校验', '降级兜底工具'],
    action: '增加工具路由白名单校验与降级兜底工具',
    gateOrder: 1,
  },
  [PHYSICAL_CODES.ERR_RESOURCE_OVERFLOW]: {
    signal: SIGNALS.CONTEXT_MELTDOWN,
    priority: 'Medium',
    intendedLevel: 'L1',
    why: '资源越界/上下文溢出——预算阈值僵化，缺硬限与异步快照执行能力，能力拓扑空洞。',
    proposedModules: ['上下文预算硬限网关', '异步快照执行器'],
    action: '增加上下文预算硬限网关与异步快照执行器',
    gateOrder: 2,
  },
  [PHYSICAL_CODES.ERR_SCHEMA_VIOLATION]: {
    signal: SIGNALS.TOOL_FAILURE,
    priority: 'Medium',
    intendedLevel: 'L1',
    why: '输出违反结构化 Schema——缺格式校验与自动重试解析，能力拓扑空洞。',
    proposedModules: ['输出格式校验拦截器', '自动重试解析器'],
    action: '增加/强化输出格式校验拦截器与自动重试解析器',
    gateOrder: 3,
  },
});

/** 一个物理码的升维映射（未知码 → null）。 */
function mappingFor(code) {
  return Object.prototype.hasOwnProperty.call(ELEVATION_MAP, code) ? ELEVATION_MAP[code] : null;
}

/** 是否合法物理码。 */
function isPhysicalCode(code) {
  return Object.prototype.hasOwnProperty.call(ELEVATION_MAP, code);
}

module.exports = { PHYSICAL_CODES, ELEVATION_MAP, mappingFor, isPhysicalCode };
