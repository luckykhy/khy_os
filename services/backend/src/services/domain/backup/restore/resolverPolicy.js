'use strict';

/**
 * resolverPolicy.js — restoreConflictResolver 的「策略词汇表」纯叶子（零 IO · 绝不抛）。
 *
 * 从 restoreConflictResolver.js 行为保真抽出：策略常量、autonomy 常量、排序键、危险令牌黑名单、
 * hydration 拦路项分类集，以及只读这些自身常量的无状态判定/构造助手。簇内自引用、零回边到主体，
 * 故不构成 require 环。主体（_RESOLUTIONS / resolveRestoreConflicts）经 require 本叶子消费它们，
 * 二者公共面逐字节不变。
 */

// ── 策略常量与排序 ────────────────────────────────────────────────────────────
const STRATEGY_REPROBE = 'reprobe';
const STRATEGY_RECONCILE = 'reconcile';
const STRATEGY_TRUST_PESSIMISTIC = 'trust-pessimistic';
const STRATEGY_ESCALATE = 'escalate';

const AGENT = 'agent';
const HUMAN = 'human';

// move 的确定性排序键：先便宜后昂贵——重探(可能直接消解) < 自洽(纯推理) < 采信悲观(带补救) < 升级(交人)。
const _STRATEGY_ORDER = Object.freeze({
  [STRATEGY_REPROBE]: 10,
  [STRATEGY_RECONCILE]: 20,
  [STRATEGY_TRUST_PESSIMISTIC]: 30,
  [STRATEGY_ESCALATE]: 90,
});

// 与检测器同源的危险令牌黑名单（消解 action 绝不含这些）。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// 首启常态 hydration 拦路项（跑一次 khy 即自然收敛，非真矛盾）——与检测器同款集合。
const _FIRST_RUN_NORMAL_HYDRATION = new Set(['no-node-modules', 'modules-not-hydrated']);

// agent 可幂等自愈的 hydration 拦路项（重新水合 / 自愈标记即可）。此分类与 agentRestorePlan
// 的 _CONCERN_POLICY autonomy 取向保持一致：可水合/可自愈→agent；需取源→human。
const _AGENT_FIXABLE_HYDRATION = new Set([
  'no-node-modules', 'modules-not-hydrated', 'missing-critical-package',
  'optional-degraded', 'splitbrain-marker', 'shared-link-broken', 'portable-node-missing',
]);
// 结构性拦路项：需要人工提供官方包 / 种子，agent 无法凭空补。
const _STRUCTURAL_HYDRATION = new Set(['seed-missing']);

// ── 小工具（全 fail-soft，绝不抛）─────────────────────────────────────────────
function _arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 断言一段 action 文本不含危险动作。 */
function _actionIsSafe(text) {
  const s = String(text || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** hydration 的 blocker 是否全落在首启正常态集合内（无 blocker → false）。 */
function _hydrationBlockersAllNormal(hydration) {
  const bs = _arr(hydration && hydration.blockers);
  if (bs.length === 0) return false;
  return bs.every((b) => b && _FIRST_RUN_NORMAL_HYDRATION.has(b.id));
}

/** hydration 的 blocker 是否**全部** agent 可自愈（含首启常态）。空 → true（无阻碍）。 */
function _hydrationAllAgentFixable(hydration) {
  const bs = _arr(hydration && hydration.blockers);
  return bs.every((b) =>
    b && (_AGENT_FIXABLE_HYDRATION.has(b.id) || _FIRST_RUN_NORMAL_HYDRATION.has(b.id))
    && !_STRUCTURAL_HYDRATION.has(b.id));
}

/**
 * 造一个消解 move。危险令牌自检：命中即强制 human 并隐去原文（防越界）。
 * @returns {{strategy,autonomy,action,verify,rationale,order}}
 */
function _move(strategy, autonomy, action, verify, rationale) {
  const safe = _actionIsSafe(action);
  return {
    strategy,
    autonomy: safe ? autonomy : HUMAN, // 危险动作一律交人
    action: safe
      ? String(action || '')
      : '（原消解动作含被禁令牌，已隐去）请查阅 khyos 官方还原文档人工处置。',
    verify: String(verify || ''),
    rationale: String(rationale || ''),
    order: _STRATEGY_ORDER[strategy] != null ? _STRATEGY_ORDER[strategy] : 99,
  };
}

module.exports = {
  _arr,
  _move,
  _actionIsSafe,
  _hydrationBlockersAllNormal,
  _hydrationAllAgentFixable,
  STRATEGY_REPROBE,
  STRATEGY_RECONCILE,
  STRATEGY_TRUST_PESSIMISTIC,
  STRATEGY_ESCALATE,
  AGENT,
  HUMAN,
  _STRATEGY_ORDER,
};
