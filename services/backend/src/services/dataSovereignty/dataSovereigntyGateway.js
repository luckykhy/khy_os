'use strict';

/**
 * dataSovereigntyGateway.js — 数据主权裁决网关（§3.2 单一权威注入网关 / 防呆③）。
 *
 * 业务函数**绝不**直接读多源数据（全局/环境/DB/工具返回各处取值正是「精神分裂」之源）。
 * 一切参数必经本网关：
 *
 *   收拢多源声明 claims
 *        │
 *   ① 主权裁决   按 P0-P4 绝对覆盖取**唯一**权威值（argmin rank）。低阶层永不覆盖高阶层。
 *        │
 *   ② 同阶层熔断（防呆③）  若最高权威阶层内出现 ≥2 个**异值**，无更高权威可裁——绝不随机/
 *        │                先后覆盖，立即熔断抛 SovereigntyConflictError(ERR_SOVEREIGNTY_CONFLICT)，
 *        │                并由 ConflictQuencher 淬出带 conflict_sources 的 L1 器官新生需求。
 *        │
 *   ③ 幽灵注记（防呆②）  落败的 P3 及以上数据降维为只读 ghost_value，独立通道下发供模型反思。
 *        │
 *   ④ 震荡侦测（§3.3）  同一参数被多源高频来回覆盖（A→B→A）→ 淬出状态锁/裁决器需求。
 *        ▼
 *   极权注入   函数只收到一份**纯净的单一权威参数字典**，幽灵物理隔离、绝不参与逻辑。
 *
 * 唯一可变状态是 `_history`（每参数的来源-值时序，仅用于震荡侦测），按 param 分桶、读多写一，
 * 不参与主权裁决计算——裁决本身是 (claims) 的纯函数，确定性、与历史无关。
 */

const {
  TIER, ERR_SOVEREIGNTY_CONFLICT, tierOf, rankOf, isGhostable, labelOf,
} = require('./sovereigntyTiers');
const { GhostValueAnnotator } = require('./ghostValueAnnotator');
const { ConflictQuencher } = require('./conflictQuencher');

class SovereigntyConflictError extends Error {
  constructor({ param, tier, conflict_sources, requirement }) {
    super(`主权冲突：参数 "${param}" 在同阶层 ${tier}(${labelOf(tier)}) 多源异值打架，熔断（${ERR_SOVEREIGNTY_CONFLICT}，防呆③）`);
    this.name = 'SovereigntyConflictError';
    this.code = ERR_SOVEREIGNTY_CONFLICT;
    this.param = param;
    this.tier = tier;
    this.conflict_sources = conflict_sources;
    this.requirement = requirement;   // 已淬出的 L1 器官新生需求，供门面落账本
  }
}

class DataSovereigntyGateway {
  /**
   * @param {object} [opts]
   * @param {GhostValueAnnotator} [opts.annotator]
   * @param {ConflictQuencher}    [opts.quencher]
   */
  constructor(opts = {}) {
    this.annotator = opts.annotator || new GhostValueAnnotator();
    this.quencher = opts.quencher || new ConflictQuencher();
    this._history = new Map();   // param → [{source, value, tier}]（震荡侦测，唯一可变态）
  }

  /** 把一条原始声明规整为 { param, source, value, tier }。来源决定阶层（防呆①，调用方不得自报阶层）。 */
  _normalizeClaim(param, claim) {
    const source = claim && claim.source;
    return {
      param: String(param),
      source: String(source || 'unknown'),
      value: claim ? claim.value : undefined,
      tier: tierOf(source),   // 阶层一律由 SOURCE_TIER 真源派生，杜绝僭越
    };
  }

  /**
   * 对单个参数的多源声明做主权裁决（核心）。
   * @param {string} param
   * @param {Array<{source, value}>} rawClaims
   * @returns {{param, value, tier, source, ghosts:Array, defeated:Array, oscillation?:object}}
   * @throws {SovereigntyConflictError} 同阶层异值打架时熔断（防呆③）
   */
  adjudicate(param, rawClaims = []) {
    const claims = (Array.isArray(rawClaims) ? rawClaims : [rawClaims])
      .filter((c) => c && c.source !== undefined)
      .map((c) => this._normalizeClaim(param, c));

    if (claims.length === 0) {
      return { param: String(param), value: undefined, tier: undefined, source: undefined, ghosts: [], defeated: [] };
    }

    // ① 主权裁决：取最高权威（最小 rank）。
    const minRank = Math.min(...claims.map((c) => rankOf(c.tier)));
    const topTierClaims = claims.filter((c) => rankOf(c.tier) === minRank);
    const winnerTier = topTierClaims[0].tier;

    // ② 同阶层熔断（防呆③）：最高权威阶层内出现异值即冲突，绝不随机/先后覆盖。
    const distinctTopValues = new Set(topTierClaims.map((c) => _stableKey(c.value)));
    if (distinctTopValues.size > 1) {
      const fight = {
        param: String(param),
        tier: winnerTier,
        claims: topTierClaims.map((c) => ({ source: c.source, value: c.value })),
      };
      const quench = this.quencher.quenchSameTier(fight);
      throw new SovereigntyConflictError({
        param: String(param),
        tier: winnerTier,
        conflict_sources: quench.conflict_sources,
        requirement: quench.requirement,
      });
    }

    // 单一权威值确立（同阶层同值即合法去重）。
    const winner = topTierClaims[0];
    const defeated = claims.filter((c) => c !== winner && rankOf(c.tier) > minRank);

    // ③ 幽灵注记（防呆②）：P3 及以上落败者降维为只读幽灵。
    const ghosts = defeated
      .filter((d) => isGhostable(d.tier))
      .map((d) => this.annotator.annotate(d, { source: winner.source, tier: winner.tier }));

    // ④ 震荡侦测（§3.3）：记录权威值时序，检测高频来回覆盖。
    const oscillation = this._recordAndDetect(String(param), winner);

    return {
      param: String(param),
      value: winner.value,
      tier: winner.tier,
      source: winner.source,
      ghosts,
      defeated: defeated.map((d) => ({ source: d.source, tier: d.tier, value: d.value })),
      ...(oscillation ? { oscillation } : {}),
    };
  }

  /**
   * 收拢一批跨参数声明，逐参数裁决，汇成单一权威参数字典 + 分离幽灵袋 + 震荡需求。
   * 任一参数触发同阶层冲突 → 抛 SovereigntyConflictError，整次注入 fail-closed 熔断（防呆③）。
   * @param {Array<{param, source, value}>} claims
   * @returns {{params:Object, ghosts:Object, oscillations:Array, decisions:Array}}
   */
  resolve(claims = []) {
    const byParam = new Map();
    for (const c of (Array.isArray(claims) ? claims : [])) {
      if (!c || c.param === undefined) continue;
      const k = String(c.param);
      (byParam.get(k) || byParam.set(k, []).get(k)).push(c);
    }

    const params = {};
    const ghosts = {};
    const oscillations = [];
    const decisions = [];

    for (const [param, group] of byParam) {
      const d = this.adjudicate(param, group);   // 冲突在此熔断上抛
      params[param] = d.value;
      if (d.ghosts.length) ghosts[param] = d.ghosts;
      if (d.oscillation) oscillations.push(d.oscillation);
      decisions.push({ param, tier: d.tier, source: d.source, defeated: d.defeated });
    }

    return { params, ghosts, oscillations, decisions };
  }

  /** 记录权威值时序并侦测震荡（A→B→A：某值非相邻地重现，且来源相异）。 */
  _recordAndDetect(param, winner) {
    const hist = this._history.get(param) || [];
    hist.push({ source: winner.source, value: winner.value, tier: winner.tier });
    this._history.set(param, hist);

    // 压缩相邻重复后看是否有「值重现」——典型 A→B→A 拉扯。
    const seq = [];
    for (const h of hist) {
      const key = _stableKey(h.value);
      if (!seq.length || seq[seq.length - 1].key !== key) seq.push({ key, source: h.source });
    }
    if (seq.length < 3) return null;

    const seen = new Map();
    for (let i = 0; i < seq.length; i++) {
      if (seen.has(seq[i].key)) {
        // 该值曾出现、中间被别的值打断后又回来 → 震荡。
        const sources = [...new Set(hist.map((h) => h.source))];
        const values = [...new Set(seq.map((s) => s.key))];
        return this.quencher.quenchOscillation({ param, sources, values });
      }
      seen.set(seq[i].key, i);
    }
    return null;
  }

  /** 清空震荡历史（会话边界/测试隔离）。 */
  resetHistory() {
    this._history.clear();
  }
}

/** 值的稳定可比键（区分 1 与 "1"、对象按 JSON）。 */
function _stableKey(v) {
  const t = typeof v;
  if (v === null) return 'null';
  if (t === 'object') { try { return 'json:' + JSON.stringify(v); } catch { return 'obj:[unserializable]'; } }
  return `${t}:${String(v)}`;
}

module.exports = { DataSovereigntyGateway, SovereigntyConflictError, TIER };
