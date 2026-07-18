'use strict';

/**
 * quarantinePolicy.js — 中转工具调用隔离策略（DESIGN-ARCH-047 PHASE 3，安全核心）。
 *
 * 漏洞根（已核实）：codex-direct 在执行中转 functionCall 前**无条件强开全局 dangerous
 * mode**（codexAdapter ~2310），把外部 agent「声称要调用的工具」照单全收地自动批准执行
 * —— 这正是「调用注入」的无人值守执行面。
 *
 * 本模块是**纯决策函数**：给定一次工具调用的溯源（producer）、交互性、是否已获显式批准、
 * 以及隔离闸开关，裁决 allow / gate / quarantine。它不执行、不开 dangerous mode、不碰
 * 全局状态；codexAdapter 据其裁决决定「跑 / 交审批 / 隔离不跑」。
 *
 * 安全姿态（与标签的 fail-safe 相反）：执行侧 **fail-CLOSED** —— 中转调用在非交互且无既
 * 存批准时**默认 DENY（隔离）**，绝不自动执行。本地 loop（origin=khy-local）从不经此隔离，
 * 保持既有执行路径零回归。逃生口：`KHY_TRAJECTORY_QUARANTINE=0` 全局关闭（迁移用）。
 */

const khyTrace = require('./khyTrace');
const { TRUST, PRODUCER } = khyTrace;

const GATE_ENV = 'KHY_TRAJECTORY_QUARANTINE';

const ACTION = Object.freeze({
  ALLOW: 'allow',           // 放行执行
  GATE: 'gate',             // 交常规审批闸（交互式人工确认）
  QUARANTINE: 'quarantine', // 隔离：绝不执行，回 error 工具结果
});

/**
 * 执行侧 fail-CLOSED 判定：唯有显式 `khy-local` origin 才视为「本地可信」；其余（已知外部
 * 如 codex/claude-code/relay，**或未知/缺省 producer**）一律视为中转，须经隔离闸。这与
 * 标签侧的 fail-safe-to-ours 相反 —— 标签缺信息时偏向「我们的」，执行缺信息时偏向「隔离」。
 */
function _isRelayedForExec(producer) {
  return producer !== PRODUCER.KHY_LOCAL;
}

/**
 * 隔离闸是否开启。默认 **ON**（对中转调用即生效）；仅显式 `0/false/off/no` 关闭。
 * @param {object} [env] 覆盖 process.env（测试用）
 */
function isGateEnabled(env) {
  const src = env || process.env || {};
  const raw = src[GATE_ENV];
  if (raw == null || raw === '') return true; // 缺省 ON
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 裁决一次工具调用的隔离动作。纯函数，无副作用。
 * @param {object} signals
 *   @param {string} signals.producer     _khyTrace.producer（khy-local / codex / claude-code / relay）
 *   @param {boolean} [signals.interactive] 是否交互式（TTY）会话
 *   @param {boolean} [signals.preApproved] 该调用是否已获显式批准
 *   @param {boolean} [signals.gateEnabled] 覆盖闸状态；缺省读 env
 *   @param {string}  [signals.riskLevel]   riskGate 评级（仅随判决回传，便于透明展示）
 * @returns {{action:string, trust:string, reason:string, riskLevel?:string}}
 */
function decide(signals = {}) {
  const {
    producer,
    interactive = false,
    preApproved = false,
    gateEnabled,
    riskLevel,
  } = signals;

  const relayed = _isRelayedForExec(producer);

  // 本地 origin 从不隔离：本地 agent loop 合法使用既有权限路径，零回归。
  if (!relayed) {
    return { action: ACTION.ALLOW, trust: TRUST.VERIFIED, reason: 'local origin (khy-local)', riskLevel };
  }

  const enabled = gateEnabled != null ? gateEnabled : isGateEnabled();

  // 逃生口：显式关闭隔离闸 → 放行（迁移用）。仍标 CLAIMED（非本地验证），保留溯源真相。
  if (!enabled) {
    return { action: ACTION.ALLOW, trust: TRUST.CLAIMED, reason: `quarantine gate disabled via ${GATE_ENV}`, riskLevel };
  }

  // 已获显式批准 → 放行；过常规闸后由本地执行验证，标 VERIFIED。
  if (preApproved) {
    return { action: ACTION.ALLOW, trust: TRUST.VERIFIED, reason: 'relayed call explicitly approved', riskLevel };
  }

  // 交互式 → 交常规审批闸，让人工 gate 决定（不在此处自动放行）。
  if (interactive) {
    return { action: ACTION.GATE, trust: TRUST.CLAIMED, reason: 'relayed call routed to approval gate', riskLevel };
  }

  // 非交互 + 无批准 → fail-CLOSED 隔离，绝不自动执行。
  return {
    action: ACTION.QUARANTINE,
    trust: TRUST.QUARANTINED,
    reason: `quarantined: relayed call requires approval (set ${GATE_ENV}=0 to bypass)`,
    riskLevel,
  };
}

/**
 * 防呆④ 不变式断言：codex-direct 永不再为中转调用自动开全局 dangerous mode。
 * 当 origin 为中转、隔离闸开启、且调用方意图自动开启 dangerous mode 时，抛错阻断。
 * @param {object} ctx { producer, enablingDangerous, gateEnabled }
 */
function assertNoAutoDangerous(ctx = {}) {
  const { producer, enablingDangerous } = ctx;
  if (!enablingDangerous) return;
  const enabled = ctx.gateEnabled != null ? ctx.gateEnabled : isGateEnabled();
  if (enabled && _isRelayedForExec(producer)) {
    throw new Error(
      `[trajectoryProvenance] 不变式违背：中转 origin（${producer}）不得自动开启全局 dangerous mode；` +
      `中转调用必须经隔离闸（${GATE_ENV}）。`
    );
  }
}

module.exports = {
  GATE_ENV,
  ACTION,
  isGateEnabled,
  decide,
  assertNoAutoDangerous,
};
