'use strict';

/**
 * dataSovereignty/index.js — DataSovereignty，数据主权与极权路由门面（§4 编排）。
 *
 * 把「数据主权绝对论 + 单一权威注入网关」串成一条闭环，消灭多源数据「精神分裂」：
 *
 *   业务侧只声明「来源 + 值」claims（绝不自行读全局/环境/DB——防呆①）
 *        │
 *   inject(claims)
 *        ├─ DataSovereigntyGateway.resolve   按 P0-P4 绝对裁决唯一权威值
 *        │     ├─ 同阶层异值打架 → 熔断抛 ERR_SOVEREIGNTY_CONFLICT（防呆③）
 *        │     └─ 落败 P3+ 数据 → GhostValueAnnotator 降维只读幽灵（防呆②）
 *        ├─ 冲突淬火 → 带 conflict_sources 的 L1 器官新生需求落账本（防呆④）
 *        └─ 震荡淬火 → 状态锁/裁决器需求落账本（§3.3）
 *        ▼
 *   { status:'injected', params, ghosts } —— 函数只拿纯净权威字典，幽灵独立通道
 *   { status:'conflict', requirement, conflict_sources } —— 熔断，绝不放行任何参数
 *
 * 零侵入：自成纯子系统，不接管 executeTool；可由后续 PR 把真实多源取值改道经本门面注入。
 */

const {
  DataSovereigntyGateway, SovereigntyConflictError,
} = require('./dataSovereigntyGateway');
const { GhostValueAnnotator, GhostPollutionError } = require('./ghostValueAnnotator');
const { ConflictQuencher, QUENCH_KIND } = require('./conflictQuencher');
const sovereigntyTiers = require('./sovereigntyTiers');
const evoLedger = require('../evoEngine/evoLedger');

const DEFAULT_BRANCH = 'data_sovereignty_pool';

// 防呆①机械审计：业务函数体内严禁出现的「直读多源」反模式。必须全部改走主权网关注入。
const FORBIDDEN_DIRECT_READS = Object.freeze([
  { name: 'process.env 直读', re: /\bprocess\s*\.\s*env\b/ },
  { name: 'global/globalThis 直读', re: /\b(?:globalThis|global)\s*\.\s*[A-Za-z_$]/ },
  { name: '数据库直接查询', re: /\b(?:db|database|knex|sequelize|prisma|pool)\s*\.\s*(?:query|execute|raw|find\w*|select)\b/i },
]);

class DataSovereignty {
  /**
   * @param {object} [opts]
   * @param {string} [opts.branch]
   * @param {DataSovereigntyGateway} [opts.gateway]
   * @param {object} [opts.ledger]
   */
  constructor(opts = {}) {
    this.branch = opts.branch || DEFAULT_BRANCH;
    this.annotator = opts.annotator || new GhostValueAnnotator();
    this.quencher = opts.quencher || new ConflictQuencher();
    this.gateway = opts.gateway || new DataSovereigntyGateway({ annotator: this.annotator, quencher: this.quencher });
    this.ledger = opts.ledger || evoLedger;
  }

  /**
   * 极权注入：收拢多源 claims → 裁决唯一权威值 → 幽灵分离 → 冲突/震荡淬火落账本。
   * @param {Array<{param, source, value}>} claims
   * @returns {{
   *   status:'injected'|'conflict',
   *   params?:object, ghosts?:object, oscillations?:Array,
   *   error?:object, requirement?:object, conflict_sources?:string[]
   * }}
   */
  inject(claims = []) {
    let resolved;
    try {
      resolved = this.gateway.resolve(claims);
    } catch (e) {
      if (e instanceof SovereigntyConflictError) {
        // 防呆③：同阶层熔断——淬出的 L1 需求落账本，绝不放行任何参数。
        this._log(this.ledger.KIND.REQUIREMENT, {
          conflictKind: QUENCH_KIND.SAME_TIER_FIGHT,
          param: e.param, tier: e.tier,
          conflict_sources: e.conflict_sources, requirement: e.requirement,
        });
        return {
          status: 'conflict',
          error: { code: e.code, message: e.message, param: e.param, tier: e.tier },
          requirement: e.requirement,
          conflict_sources: e.conflict_sources,
        };
      }
      throw e;
    }

    // 震荡需求（§3.3）落账本——状态拉扯虽不熔断本次注入，但须升维进化。
    for (const osc of resolved.oscillations) {
      this._log(this.ledger.KIND.REQUIREMENT, {
        conflictKind: QUENCH_KIND.OSCILLATION,
        param: osc.param, conflict_sources: osc.conflict_sources, requirement: osc.requirement,
      });
    }

    // 防呆②：注入前断言权威字典无幽灵渗入（幽灵只走 ghosts 独立通道）。
    const params = this.annotator.sanitizeForExecution(resolved.params);

    return {
      status: 'injected',
      params,
      ghosts: resolved.ghosts,
      oscillations: resolved.oscillations.map((o) => ({ param: o.param, requirementId: o.requirement.id })),
      decisions: resolved.decisions,
    };
  }

  /**
   * 防呆①机械审计：扫描业务函数源码，揪出「直读全局/环境/DB」的架构毒瘤。
   * 给 CI 一个确定性门禁——这类直读必须全部改走主权网关注入。
   * @param {string|Function} fn  函数源码字符串或函数对象
   * @returns {{pure:boolean, violations:Array<{rule, snippet}>}}
   */
  auditInjectionPurity(fn) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn || '');
    const violations = [];
    for (const f of FORBIDDEN_DIRECT_READS) {
      const m = f.re.exec(src);
      if (m) violations.push({ rule: f.name, snippet: m[0] });
    }
    return { pure: violations.length === 0, violations };
  }

  /** 主权需求池（不可变哈希链拷贝）。 */
  pool() {
    try { return this.ledger.read({ branch: this.branch }); } catch { return []; }
  }

  /** 校验需求池链完整性（复用 evoLedger）。 */
  verifyPool() {
    try { return this.ledger.verify({ branch: this.branch }); }
    catch { return { ok: false, length: 0, brokenAt: null, reason: 'verify-error' }; }
  }

  _log(kind, q) {
    try {
      return this.ledger.append(kind, {
        source: 'data-sovereignty',
        conflictKind: q.conflictKind,
        param: q.param,
        tier: q.tier,
        conflict_sources: q.conflict_sources,   // 防呆④：审计可追溯打架来源
        requirementId: q.requirement.id,
        level: q.requirement.level,
      }, { branch: this.branch });
    } catch { return { ok: false }; }
  }
}

module.exports = {
  DataSovereignty,
  DataSovereigntyGateway,
  SovereigntyConflictError,
  GhostValueAnnotator,
  GhostPollutionError,
  ConflictQuencher,
  QUENCH_KIND,
  ...sovereigntyTiers,   // TIER / tierOf / rankOf / isGhostable / ERR_SOVEREIGNTY_CONFLICT …
};
