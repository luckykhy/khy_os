'use strict';

/**
 * specialtyBreaker.js — 平台特异性「特长熔断器」（防呆⑤）。
 *
 * 原生特长是双刃剑：在该环境发挥极限性能，也可能在该环境引发安全降级或系统崩溃。一旦某
 * 原生特长翻车，**必须立即熔断该特长**——后续路由不得再派发它，转走通用安全方案，并由淬火器
 * 报出一条「特长回滚需求」。本模块是熔断态的唯一权威，按 `platform::specialty` 分桶记录。
 *
 * 关于防呆④「核心状态机无状态」：熔断态是**运维安全状态**，不是意图→路由的核心状态机；
 * 它按 env_scope 物理分桶、绝不参与跨平台一致的路由计算（路由器只读查询 isFused），因此
 * 既隔离了平台差异，又不污染「同指纹同结果」的无状态铁律。默认纯内存、进程级，不落盘。
 */

/** 触发熔断的事由类别。 */
const FUSE_CAUSE = Object.freeze({
  SECURITY_DEGRADE: 'security-degrade',  // 安全降级（越权/泄漏/沙箱逃逸迹象）
  CRASH: 'crash',                        // 系统/进程崩溃
});

class SpecialtyBreaker {
  constructor() {
    /** @type {Map<string,{platform:string, specialty:string, cause:string, count:number, detail:any}>} */
    this._fused = new Map();
  }

  _key(platform, specialty) {
    return `${String(platform)}::${String(specialty)}`;
  }

  /**
   * 熔断一个原生特长。幂等：重复熔断只累加计数、不改首次事由。
   * @returns {{newlyFused:boolean, key:string, platform:string, specialty:string, cause:string, count:number}}
   */
  fuse(platform, specialty, cause = FUSE_CAUSE.CRASH, detail = null) {
    const key = this._key(platform, specialty);
    const safeCause = Object.values(FUSE_CAUSE).includes(cause) ? cause : FUSE_CAUSE.CRASH;
    const existing = this._fused.get(key);
    if (existing) {
      existing.count += 1;
      return { newlyFused: false, key, platform, specialty, cause: existing.cause, count: existing.count };
    }
    this._fused.set(key, { platform, specialty, cause: safeCause, count: 1, detail });
    return { newlyFused: true, key, platform, specialty, cause: safeCause, count: 1 };
  }

  /** 该特长当前是否处于熔断（路由器据此跳过派发，降级通用安全）。 */
  isFused(platform, specialty) {
    return this._fused.has(this._key(platform, specialty));
  }

  /** 解除熔断（回滚需求落地、验证通过后由上层调用恢复）。 */
  reset(platform, specialty) {
    return this._fused.delete(this._key(platform, specialty));
  }

  /** 列出当前所有熔断态（拷贝）。 */
  list() {
    return Array.from(this._fused.values()).map((v) => Object.assign({}, v));
  }

  /** 测试夹具：清空熔断态。 */
  _resetForTest() {
    this._fused.clear();
  }
}

module.exports = { SpecialtyBreaker, FUSE_CAUSE };
