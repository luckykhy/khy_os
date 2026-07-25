'use strict';

/**
 * subAgentModelSelect — 纯叶子:为子 agent 从「当前通道真正可用的模型列表」里挑出一个
 * 合适的模型 id(优先轻量),而不是盲发一个写死的 tier 别名(如 'haiku')。
 *
 * 背景(为什么存在):
 *   内置 Explore / khyGuide 子 agent 在定义里把 model 钉死为裸 tier 别名 'haiku',
 *   AgentTool 的候选级联又把若干轻量 id(haiku / claude-haiku-3.5 / flash / …)盲写死,
 *   从不校验「当前 provider 是否真有这些模型」。对 relay_api/api 通道,非法 model id
 *   'haiku' 被原样发给 provider → 被拒 → 子 agent 输出不可用。本叶子把「挑模型」收敛成
 *   一处确定性逻辑:输入请求(别名/具体 id/空)+ 可用模型列表 → 输出按 tier 贴合度 +
 *   发现来源可信度排好序的可用 id 列表。IO(拉取 listModels / 解析激活通道)留在调用壳。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 process.env 做门控 / 经 modelTier 读 tier 覆盖 env;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出(排序为稳定排序,decorate-sort-undecorate 带原下标)。
 *   - 绝不抛:任何异常路径都返回安全值([] / false)。
 *   - env 门控 KHY_SUBAGENT_MODEL_AUTOSELECT 默认开;关 = 调用方据 isEnabled() 直接短路,
 *     不拉取可用模型、候选级联用原盲列表 → 字节回退到旧行为。
 *
 * 单一真源:
 *   - 「哪些字符串算裸 tier 别名」= isTierAlias。
 *   - 「给定请求 + 可用列表如何挑模型」= selectAvailableModels(只此一处定排序规则)。
 */

const modelTier = require('./modelTier');

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_SUBAGENT_MODEL_AUTOSELECT;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 裸 tier 别名:子 agent 定义里用它表达「我要这一档」,而非某个具体 model id。
const _TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

/**
 * 是否为裸 tier 别名(trim、大小写不敏感)。具体 id(含连字符/日期)或空 → false。
 * @param {*} s
 * @returns {boolean}
 */
function isTierAlias(s) {
  try {
    if (typeof s !== 'string') return false;
    return _TIER_ALIASES.has(s.trim().toLowerCase());
  } catch {
    return false;
  }
}

// tier → 有序下标(T0 最重 … T3 最轻),用于算「贴合度距离」。
const _TIER_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };
// 裸 tier 别名 → 期望 tier(挑可用模型时按它找最贴合的一档)。
const _ALIAS_PREFER_TIER = { haiku: 'T3', sonnet: 'T1', opus: 'T0' };
// 发现来源可信度:provider 真实通告(remote)> 配置(config)> 静态提示(hint)> 未知。
const _SOURCE_RANK = { remote: 0, config: 1, hint: 2 };

function _sourceRank(src) {
  const r = _SOURCE_RANK[String(src || '').trim().toLowerCase()];
  return Number.isFinite(r) ? r : 3;
}

/**
 * 把可用模型列表归一成 {id, source}[],去空、按 id 去重(首个胜)。
 * 接受元素形状:{id,discoverySource} | {id,source} | 裸字符串。
 * @param {Array} available
 * @returns {{id:string, source:string}[]}
 */
function _normalizeAvailable(available) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(available)) return out;
  for (const entry of available) {
    let id = '';
    let source = '';
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      id = entry.id || entry.model || entry.name || '';
      source = entry.discoverySource || entry.source || '';
    }
    id = typeof id === 'string' ? id.trim() : '';
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, source: typeof source === 'string' ? source : '' });
  }
  return out;
}

/**
 * 从「当前通道可用模型」里挑出按贴合度排好序的模型 id 列表。
 *
 * 规则:
 *   1. available 归一去重;空 → []。
 *   2. requested 是具体 id 且在 available 中(大小写不敏感)→ 返回 [该可用 id](原样大小写)。
 *      具体 id 但不在 available → 以 resolveTier(requested) 作为期望 tier 继续展开。
 *   3. 别名 / tier 展开:对每个可用 id 算 resolveTier,稳定排序:
 *        ① 距期望 tier 的距离(默认期望 T3 → 最轻在前);
 *        ② 发现来源 remote > config > hint > unknown;
 *        ③ 原始下标(保证确定性)。
 *   4. 截断 opts.max(默认 3)。
 *
 * @param {string} requested      请求模型(别名 'haiku' / 具体 id / '')
 * @param {Array}  available      gateway.listModels() 返回的列表
 * @param {{max?:number, preferTier?:string}} [opts]
 * @returns {string[]}            可用模型 id(按贴合度排序),失败/空 → []
 */
function selectAvailableModels(requested, available, opts = {}) {
  try {
    const list = _normalizeAvailable(available);
    if (list.length === 0) return [];

    const max = Number.isFinite(opts && opts.max) && opts.max > 0 ? (opts.max | 0) : 3;
    const req = typeof requested === 'string' ? requested.trim() : '';

    // 2. 具体 id 命中可用列表 → 直接返回那一个(原样)。
    if (req && !isTierAlias(req)) {
      const hit = list.find((e) => e.id.toLowerCase() === req.toLowerCase());
      if (hit) return [hit.id];
    }

    // 期望 tier:别名取映射;具体未命中 id 取其自身 tier;否则默认最轻 T3。
    let preferTier = opts && typeof opts.preferTier === 'string' ? opts.preferTier.trim().toUpperCase() : '';
    if (!_TIER_ORDER.hasOwnProperty(preferTier)) {
      if (req && isTierAlias(req)) {
        preferTier = _ALIAS_PREFER_TIER[req.toLowerCase()] || 'T3';
      } else if (req) {
        preferTier = modelTier.resolveTier(req) || 'T3';
      } else {
        preferTier = 'T3';
      }
    }
    const preferIdx = _TIER_ORDER[preferTier];

    // 3. decorate-sort-undecorate(稳定、确定性)。
    const decorated = list.map((e, i) => {
      let tier;
      try { tier = modelTier.resolveTier(e.id); } catch { tier = 'T2'; }
      const tIdx = _TIER_ORDER.hasOwnProperty(tier) ? _TIER_ORDER[tier] : _TIER_ORDER.T2;
      return { id: e.id, idx: i, dist: Math.abs(tIdx - preferIdx), src: _sourceRank(e.source) };
    });
    decorated.sort((a, b) => (a.dist - b.dist) || (a.src - b.src) || (a.idx - b.idx));

    return decorated.slice(0, max).map((d) => d.id);
  } catch {
    return [];
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeSubAgentModelSelect() {
  return {
    gate: 'KHY_SUBAGENT_MODEL_AUTOSELECT',
    defaultOn: true,
    summary: '子 agent 从「当前通道真正可用的模型列表」里按 tier 贴合度 + 发现来源可信度挑模型'
      + '(优先轻量),取代盲发写死的 tier 别名;门控关则候选级联用原盲列表(字节回退)。',
  };
}

module.exports = {
  isEnabled,
  isTierAlias,
  selectAvailableModels,
  describeSubAgentModelSelect,
};
