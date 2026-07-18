'use strict';

/**
 * sovereigntyTiers.js — 数据主权阶层单一真源（§3.1 数据主权阶层）。
 *
 * 「数据主权绝对论」的宪法：把每一个进入系统的数据按其**来源出身**钉死在一个不可僭越的
 * 阶层上。低阶层数据**永远**无权覆盖高阶层数据——这条铁律是确定性的、与模型推理无关的，
 * 是消灭「精神分裂」（多源数据各执一词、相互覆盖）的物理地基。
 *
 *   P0 绝对铁律   硬编码安全边界 / 防呆规则 / 物理极限。任何来源（含用户、含模型）皆不可覆盖。
 *   P1 意志注入   用户显式指令 / 任务目标。仅 P0 可压制。
 *   P2 环境语境   OS 原生特权 / 网络 / 电量等客观环境事实。
 *   P3 推理演算   模型推理 / 记忆召回 / 工具返回值。可被 P0-P2 否决。
 *   P4 默认基座   配置默认值。最低权威，人人可覆盖。
 *
 * 权威秩 rank：0 = 最高权威（P0），4 = 最低（P4）。裁决取**最小 rank**（最高权威）胜出。
 *
 * 纯数据 + 纯函数，确定性，不调模型、不做 I/O。所有「来源 → 阶层」的映射收口于此，
 * 业务侧严禁另起炉灶自行判定权威（防呆①的真源依据）。
 */

const TIER = Object.freeze({
  P0: 'P0',   // 绝对铁律
  P1: 'P1',   // 意志注入
  P2: 'P2',   // 环境语境
  P3: 'P3',   // 推理演算
  P4: 'P4',   // 默认基座
});

// 权威秩：越小越高权威。裁决 = argmin(rank)。
const TIER_RANK = Object.freeze({
  [TIER.P0]: 0,
  [TIER.P1]: 1,
  [TIER.P2]: 2,
  [TIER.P3]: 3,
  [TIER.P4]: 4,
});

const TIER_LABEL = Object.freeze({
  [TIER.P0]: '绝对铁律',
  [TIER.P1]: '意志注入',
  [TIER.P2]: '环境语境',
  [TIER.P3]: '推理演算',
  [TIER.P4]: '默认基座',
});

const ALL_TIERS = Object.freeze([TIER.P0, TIER.P1, TIER.P2, TIER.P3, TIER.P4]);

/**
 * 来源出身 → 主权阶层 单一真源。
 * 业务侧只允许声明「来源」，由本表确定其阶层——绝不允许调用方自报阶层僭越（防呆①）。
 */
const SOURCE_TIER = Object.freeze({
  // —— P0 绝对铁律：硬编码安全边界 / 防呆 / 物理极限 ——
  'foolproof': TIER.P0,
  'safety-boundary': TIER.P0,
  'physical-limit': TIER.P0,
  'constitution': TIER.P0,
  'hard-rule': TIER.P0,
  // —— P1 意志注入：用户显式命令 / 任务目标 ——
  'user': TIER.P1,
  'user-command': TIER.P1,
  'user-directive': TIER.P1,
  'task-goal': TIER.P1,
  // —— P2 环境语境：OS 原生特权 / 网络 / 电量 ——
  'os-native': TIER.P2,
  'os-privilege': TIER.P2,
  'network-state': TIER.P2,
  'battery': TIER.P2,
  'env-context': TIER.P2,
  // —— P3 推理演算：模型推理 / 记忆召回 / 工具返回值 ——
  'model': TIER.P3,
  'model-inference': TIER.P3,
  'memory-recall': TIER.P3,
  'tool-return': TIER.P3,
  'tool': TIER.P3,
  // —— P4 默认基座：配置默认值 ——
  'config': TIER.P4,
  'config-default': TIER.P4,
  'default': TIER.P4,
});

// 「P3 及以上阶层」（权威秩 ≤ 3，即 P0-P3）的落败数据须以 ghost_value 留存供模型反思（防呆②）。
// P4 默认值落败属噪音，静默丢弃即可，不挂幽灵。
const GHOST_MIN_RANK = TIER_RANK[TIER.P3];

// 主权冲突错误码（防呆③ 同阶层打架必抛此码，绝不随机/先后覆盖）。
const ERR_SOVEREIGNTY_CONFLICT = 'ERR_SOVEREIGNTY_CONFLICT';

function isTier(t) {
  return Object.prototype.hasOwnProperty.call(TIER_RANK, t);
}

/**
 * 来源 → 阶层。未知来源 fail-safe 降为 P4（最低权威），确保无出身证明的数据**永不**僭越，
 * 杜绝「未知来源伪装高权威」的提权攻击面。
 * @param {string} source
 * @returns {string} TIER.*
 */
function tierOf(source) {
  const key = String(source || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SOURCE_TIER, key) ? SOURCE_TIER[key] : TIER.P4;
}

/** 阶层 → 权威秩；未知阶层 fail-safe 视为最低权威 P4。 */
function rankOf(tier) {
  return isTier(tier) ? TIER_RANK[tier] : TIER_RANK[TIER.P4];
}

/** a 是否严格高于 b 的权威（rank 更小）。 */
function isHigherAuthority(a, b) {
  return rankOf(a) < rankOf(b);
}

/** 落败数据是否应留存为只读幽灵（P3 及以上阶层，防呆②）。 */
function isGhostable(tier) {
  return rankOf(tier) <= GHOST_MIN_RANK;
}

function labelOf(tier) {
  return TIER_LABEL[tier] || '未知阶层';
}

module.exports = {
  TIER,
  TIER_RANK,
  TIER_LABEL,
  ALL_TIERS,
  SOURCE_TIER,
  GHOST_MIN_RANK,
  ERR_SOVEREIGNTY_CONFLICT,
  isTier,
  tierOf,
  rankOf,
  isHigherAuthority,
  isGhostable,
  labelOf,
};
