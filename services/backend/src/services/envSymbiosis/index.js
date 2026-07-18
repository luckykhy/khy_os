'use strict';

/**
 * envSymbiosis/index.js — EnvSymbiosis，环境共生引擎门面（§4 编排）。
 *
 * 把「环境感知与原生亲和架构」串成一条闭环：核心意图统一进、原生执行路径分裂出，兼容性
 * 阵痛被强制淬火成该环境的进化需求。
 *
 *   顶层 统一意图层      dispatch(intent) —— 平台无关、无状态、跨平台一致（防呆④）
 *        │
 *   中层 环境感知 + 原生路由层
 *        ├─ EnvFingerprintScanner.scan   先刺探指纹（防呆③：无指纹不盲调）
 *        └─ NativeAffinityRouter.route    指纹 → 该环境最锋利原生工具（防呆①：绝不 Polyfill）
 *        │
 *   底层 平台特异性执行层（执行交调用方；本门面只做派发与淬火，零侵入、不碰底层副作用）
 *        │
 *   闭环 兼容性即特长淬火
 *        ├─ 器官空洞   → CompatibilityQuencher.quenchOrganVoid → 器官新生需求(env_scope)
 *        └─ 特长翻车   → SpecialtyBreaker.fuse + quenchRollback → 特长回滚需求(env_scope)（防呆⑤）
 *        ↓
 *        需求池（evoLedger 不可变哈希链；env_scope 钉死环境特异性，不污染全局，防呆②）
 *
 * 防呆④：本门面不持有任何「随平台变化的核心状态机」。dispatch 是 (intent, fingerprint) 的
 * 纯路由函数；唯一可变状态是 SpecialtyBreaker 的熔断态，那是按 env_scope 分桶的运维安全状态，
 * 不参与路由计算（路由器只读查询），因此「同意图同指纹同结果」铁律不破。
 */

const { EnvFingerprintScanner } = require('./envFingerprintScanner');
const { NativeAffinityRouter, ROUTE_STATUS } = require('./nativeAffinityRouter');
const { CompatibilityQuencher } = require('./compatibilityQuencher');
const { SpecialtyBreaker, FUSE_CAUSE } = require('./specialtyBreaker');
const { PLATFORM, topologyFor } = require('./platformIds');
const evoLedger = require('../evoEngine/evoLedger');

const DEFAULT_BRANCH = 'envsymbiosis_pool';

class EnvSymbiosis {
  /**
   * @param {object} [opts]
   * @param {object} [opts.probe]   注入指纹探针（见 EnvFingerprintScanner）
   * @param {string} [opts.branch]  需求池日志分支
   * @param {object} [opts.scanner] [opts.router] [opts.quencher] [opts.breaker] [opts.ledger]
   */
  constructor(opts = {}) {
    this.branch = opts.branch || DEFAULT_BRANCH;
    this.scanner = opts.scanner || new EnvFingerprintScanner({ probe: opts.probe });
    this.breaker = opts.breaker || new SpecialtyBreaker();
    this.router = opts.router || new NativeAffinityRouter({ breaker: this.breaker });
    this.quencher = opts.quencher || new CompatibilityQuencher();
    this.ledger = opts.ledger || evoLedger;
  }

  /** 刺探当前环境指纹（§3.1）。 */
  scan() {
    return this.scanner.scan();
  }

  /**
   * 把核心意图派发到当前环境的原生执行路径；兼容性阻断时即时淬火。永不抛。
   * @param {string} intent  平台无关意图（open_url / monitor_process …）
   * @returns {{
   *   status:'routed'|'degraded'|'blocked'|'quenched',
   *   intent:string, fingerprint:object, route:object, quench?:object
   * }}
   */
  dispatch(intent) {
    const fingerprint = this.scan();           // 防呆③：执行前必先取指纹
    const route = this.router.route(intent, fingerprint);

    switch (route.status) {
      case ROUTE_STATUS.NATIVE:
        // 命中原生器官：交底层执行层按 route.kind 派发（本门面不代执行，零侵入）。
        return { status: 'routed', intent, fingerprint, route };

      case ROUTE_STATUS.DEGRADED_SAFE:
        // 特长已熔断 → 降级通用安全（回滚需求在熔断当刻已入池，此处不重复淬火）。
        return { status: 'degraded', intent, fingerprint, route };

      case ROUTE_STATUS.NO_FINGERPRINT:
        // 防呆③：无可用指纹，拒绝盲调，也无 env_scope 可铸造需求——直接阻断上报。
        return { status: 'blocked', intent, fingerprint, route };

      case ROUTE_STATUS.ORGAN_VOID:
      default: {
        // 防呆①：器官空洞 → 淬火新生该环境原生器官，绝不 Polyfill。
        const quench = this.quencher.quenchOrganVoid(route, fingerprint);
        this._log(evoLedger.KIND.REQUIREMENT, quench);
        return { status: 'quenched', intent, fingerprint, route, quench };
      }
    }
  }

  /**
   * 上报某原生特长在执行期翻车（防呆⑤）：立即熔断 + 首次熔断淬火出回滚需求。
   * @param {{platform:string, specialty:string, cause?:string, detail?:any}} fault
   * @returns {{status:'fused'|'already-fused', fuse:object, quench?:object}}
   */
  reportFault(fault = {}) {
    const platform = fault.platform;
    const specialty = fault.specialty;
    const cause = fault.cause || FUSE_CAUSE.CRASH;
    const fuse = this.breaker.fuse(platform, specialty, cause, fault.detail);

    if (!fuse.newlyFused) {
      return { status: 'already-fused', fuse };
    }
    // 首次熔断：升维出「特长回滚需求」（env_scope 钉死该环境）。
    const quench = this.quencher.quenchRollback({ specialty, cause }, { platform });
    this._log(evoLedger.KIND.ROLLBACK, quench);
    return { status: 'fused', fuse, quench };
  }

  /** 某环境的原生长板拓扑（§3.2）。 */
  topology(platform) {
    return topologyFor(platform);
  }

  /** 读取环境需求池（不可变哈希链拷贝）。 */
  pool() {
    try { return this.ledger.read({ branch: this.branch }); } catch { return []; }
  }

  /** 校验需求池链完整性（防呆⑤ 进化历史不可篡改，复用 evoLedger）。 */
  verifyPool() {
    try { return this.ledger.verify({ branch: this.branch }); }
    catch { return { ok: false, length: 0, brokenAt: null, reason: 'verify-error' }; }
  }

  _log(kind, quench) {
    try {
      return this.ledger.append(kind, {
        source: 'env-symbiosis',
        env_scope: quench.env_scope,           // 防呆②：环境标记落账，需求永不脱离其 env_scope
        kind: quench.kind,
        specialty: quench.specialty,
        requirementId: quench.requirement.id,
        level: quench.requirement.level,
        priority: quench.priority,
        rollback: !!quench.rollback,
      }, { branch: this.branch });
    } catch { return { ok: false }; }
  }
}

module.exports = {
  EnvSymbiosis,
  EnvFingerprintScanner,
  NativeAffinityRouter,
  CompatibilityQuencher,
  SpecialtyBreaker,
  ROUTE_STATUS,
  FUSE_CAUSE,
  PLATFORM,
};
