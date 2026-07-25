'use strict';

/**
 * memoryTier.js — 记忆分层模型(纯叶子,单一真源)。
 *
 * 用户诉求「记忆分层」分解为一个**保留层(retention tier)**轴 + 两个**操作**:
 *   1) 短期会话内记忆 short_term  —— 只活在当前会话,会话结束即遗忘,绝不落盘为永久文件。
 *   2) 跨会话记忆     cross_session—— 跨会话持久,但按保鲜期/重复度自然老化(可被遗忘/归档)。
 *   3) 永久记忆       permanent   —— 用户身份、核心偏好等;**永不被自动遗忘**(硬不变量)。
 *   4) 信息更新       update      —— 新信息抵达时,同名记忆原地替换(supersede)而非堆叠重复。
 *   5) 遗忘           forget      —— 仅 short_term(会话结束)与 cross_session(超期/重复)可被
 *                                    自动遗忘;permanent 免疫。遗忘=可恢复归档,绝非硬删(见 distiller)。
 *
 * 关键设计:本模块只定义**保留层**这一新轴,与既有两轴正交、互不取代:
 *   - memdir frontmatter `type`(user/feedback/project/reference)= 语义种类。
 *   - memoryLifecycle stage(active→…→pruned)            = 衰减状态机。
 *   - memoryTier tier(short_term/cross_session/permanent)= 保留策略(本模块)。
 * 历史记忆没有 `tier` 字段 → `classifyTier` 从 `type` 确定性派生一个合理层,**无需迁移**。
 *
 * 纯函数:零 IO、零状态;唯一的 env 读取在 `isEnabled()`(KHY_MEMORY_TIERS 默认开),
 * 供调用方决定是否启用「永久免遗忘」等行为变更,关掉即字节回退到既有行为。
 */

// ── 保留层 ───────────────────────────────────────────────────────────
const TIERS = Object.freeze({
  SHORT_TERM: 'short_term',
  CROSS_SESSION: 'cross_session',
  PERMANENT: 'permanent',
});

/** 升级路径(越靠后越持久)。promote() 沿此前进一步。 */
const TIER_ORDER = Object.freeze([TIERS.SHORT_TERM, TIERS.CROSS_SESSION, TIERS.PERMANENT]);

/** 五层模型里的两个操作(文档即契约)。 */
const OPERATIONS = Object.freeze({ UPDATE: 'update', FORGET: 'forget' });

/**
 * 语义种类 → 默认保留层的确定性映射(用于无显式 tier 的历史记忆)。
 *  - user     身份画像 → permanent(身份不该被时间冲走)。
 *  - feedback 协作偏好 → cross_session(偏好持久但可被更新/纠偏取代)。
 *  - reference外部资源 → cross_session(链接会失效,允许老化)。
 *  - project  项目背景 → cross_session(项目完结后自然老化)。
 * 注:没有任何 type 默认派生为 short_term —— 既然它已是落盘文件,就不是「只活在会话内」;
 * short_term 只能由会话内存储显式赋予。
 */
const TYPE_TO_TIER = Object.freeze({
  user: TIERS.PERMANENT,
  feedback: TIERS.CROSS_SESSION,
  reference: TIERS.CROSS_SESSION,
  project: TIERS.CROSS_SESSION,
});

const DEFAULT_TIER = TIERS.CROSS_SESSION;

// ── env 门控 ─────────────────────────────────────────────────────────
const OFF = new Set(['0', 'false', 'off', 'no']);

/** 分层带来的行为变更(如永久免遗忘)是否启用。默认开,KHY_MEMORY_TIERS∈{0,false,off,no} 关。 */
function isEnabled() {
  return !OFF.has(String(process.env.KHY_MEMORY_TIERS || '').trim().toLowerCase());
}

// ── 分类 ─────────────────────────────────────────────────────────────

function _normTier(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return TIER_ORDER.includes(t) ? t : null;
}

/**
 * 判定一条记忆的保留层。
 *   - 入参可为 frontmatter 对象(读 `.tier` / `.type`)或直接的字符串。
 *   - 显式 `tier` 合法则胜出;否则按 `type` 派生;再否则取 DEFAULT_TIER。
 * @param {object|string} fmOrTier
 * @returns {string} TIERS 之一
 */
function classifyTier(fmOrTier) {
  if (typeof fmOrTier === 'string') {
    return _normTier(fmOrTier) || DEFAULT_TIER;
  }
  const fm = fmOrTier && typeof fmOrTier === 'object' ? fmOrTier : {};
  const explicit = _normTier(fm.tier);
  if (explicit) return explicit;
  const byType = TYPE_TO_TIER[String(fm.type || '').trim().toLowerCase()];
  return byType || DEFAULT_TIER;
}

function isPermanent(fmOrTier) { return classifyTier(fmOrTier) === TIERS.PERMANENT; }
function isShortTerm(fmOrTier) { return classifyTier(fmOrTier) === TIERS.SHORT_TERM; }

// ── 遗忘策略 ─────────────────────────────────────────────────────────

/**
 * 某层的遗忘策略。
 * @param {string} tier
 * @returns {{ autoForget:boolean, expiresAtSessionEnd:boolean, reason:string }}
 */
function forgetPolicy(tier) {
  const t = _normTier(tier) || DEFAULT_TIER;
  if (t === TIERS.PERMANENT) {
    return { autoForget: false, expiresAtSessionEnd: false, reason: '永久层:永不自动遗忘' };
  }
  if (t === TIERS.SHORT_TERM) {
    return { autoForget: true, expiresAtSessionEnd: true, reason: '短期层:会话结束即遗忘' };
  }
  return { autoForget: true, expiresAtSessionEnd: false, reason: '跨会话层:按保鲜期/重复度老化' };
}

/**
 * 这条记忆是否可被「定期蒸馏」自动遗忘(归档)。永久层永远返回 false —— 这是
 * distiller 该尊重的硬不变量。门控关闭时一律返回 true(回退既有行为:由 distiller
 * 自己的 per-type 保鲜期决定)。
 * @param {object|string} fmOrTier
 * @returns {boolean}
 */
function isForgetEligible(fmOrTier) {
  if (!isEnabled()) return true;
  return forgetPolicy(classifyTier(fmOrTier)).autoForget;
}

// ── 信息更新(同名记忆原地替换 vs 堆叠)────────────────────────────────

/**
 * 决定一条新到达的记忆相对既有记忆该如何写入(「信息更新」)。
 * 规则(保守、确定性):
 *   - 既有为空 → insert(首次写入)。
 *   - 标准化后**正文相同** → skip(无新信息,避免无谓写盘/重复)。
 *   - 同名(name 标准化相等) → supersede(原地替换,保留较高层级)——这正是
 *     「记住最新的、别堆一堆过时副本」。被取代者交由调用方做可恢复归档。
 *   - 否则 → insert(不同主题,新增)。
 * 返回的 `tier` 是合并后应采用的层:取两者中更持久的一层(信息升级不降级)。
 * @param {object|null} existing - { name, body|content, tier?, type? } 或 null
 * @param {object} incoming      - 同结构
 * @returns {{ action:'insert'|'supersede'|'skip', tier:string, reason:string }}
 */
function decideUpdate(existing, incoming) {
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const incTier = classifyTier(inc);
  if (!existing || typeof existing !== 'object') {
    return { action: 'insert', tier: incTier, reason: '首次写入' };
  }
  const exTier = classifyTier(existing);
  const mergedTier = _moreDurable(exTier, incTier);

  const exBody = _normText(existing.body != null ? existing.body : existing.content);
  const incBody = _normText(inc.body != null ? inc.body : inc.content);
  if (exBody && incBody && exBody === incBody) {
    return { action: 'skip', tier: mergedTier, reason: '正文未变,无新信息' };
  }

  const exName = _normText(existing.name);
  const incName = _normText(inc.name);
  if (exName && incName && exName === incName) {
    return { action: 'supersede', tier: mergedTier, reason: '同名记忆,原地更新为最新' };
  }
  return { action: 'insert', tier: incTier, reason: '不同主题,新增' };
}

// ── 升级 ─────────────────────────────────────────────────────────────

/**
 * 把一条记忆升一层(short_term → cross_session → permanent)。已是最高层则不变。
 * 用于:会话内记下的短期事实被反复确认 → 提升为跨会话;跨会话偏好被定型 → 永久。
 * @param {string} tier
 * @returns {string}
 */
function promote(tier) {
  const t = _normTier(tier) || DEFAULT_TIER;
  const i = TIER_ORDER.indexOf(t);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : t;
}

// ── 内部 ─────────────────────────────────────────────────────────────

// 收敛到 utils/collapseWhitespace 单一真源(逐字节委托,调用点不变)
const _normText = require('../utils/collapseWhitespace');

/** 返回两层中更持久的一层(索引更大者)。 */
function _moreDurable(a, b) {
  const ia = TIER_ORDER.indexOf(_normTier(a) || DEFAULT_TIER);
  const ib = TIER_ORDER.indexOf(_normTier(b) || DEFAULT_TIER);
  return TIER_ORDER[Math.max(ia, ib)];
}

module.exports = {
  TIERS,
  TIER_ORDER,
  OPERATIONS,
  TYPE_TO_TIER,
  DEFAULT_TIER,
  isEnabled,
  classifyTier,
  isPermanent,
  isShortTerm,
  forgetPolicy,
  isForgetEligible,
  decideUpdate,
  promote,
};
