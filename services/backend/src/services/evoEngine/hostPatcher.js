'use strict';

/**
 * hostPatcher.js — 宿主热更新执行器（§4.3）。
 *
 * 自举链路的「执行端」：把沙箱胜出的新器官**受控热载**进宿主。三道硬闸门，缺一不可：
 *
 *   闸门① 凭证校验（防呆①）：必须携带由 OrganogenesisSandbox 针对**同一份代码**签发的、未篡改
 *         的 `passToken`。`sandbox.verifyToken` 不过 → 抛 SandboxBypassError。**绝不**接受
 *         无凭证或伪造凭证的代码——「跳过沙箱直接注入宿主」被定义为系统级自杀。
 *   闸门② 宪法守卫（防呆③）：热载目标若触碰受保护不变量（熔断机制/红线/沙箱/日志），
 *         `EvoTrustBreaker.isProtectedTarget` 命中 → 抛 ConstitutionViolation。自举逻辑绝不
 *         允许改写自己的锁具。
 *   闸门③ 只读锁（防呆④）：引擎一旦被熔断为只读，拒绝一切热载。
 *
 * 热载本身是**影子注册表**写入——把新器官登记进一个进程内 `Map`（演进轨），宿主按需查表
 * 调用，绝不就地覆写官方核心源文件（沿用 dualTrack 用户轨「物理隔离」精神）。回滚即从表中
 * 卸载并恢复前态。所有动作返回结构化结果，由 engine 记入不可变日志。
 */

const sandbox = require('./organogenesisSandbox');
const { EvoTrustBreaker } = require('./evoTrustBreaker');

class SandboxBypassError extends Error {
  constructor(msg) { super(msg); this.name = 'SandboxBypassError'; this.code = 'EVO_SANDBOX_BYPASS'; }
}
class ConstitutionViolation extends Error {
  constructor(msg) { super(msg); this.name = 'ConstitutionViolation'; this.code = 'EVO_CONSTITUTION'; }
}

class HostPatcher {
  /**
   * @param {object} [opts]
   * @param {Map} [opts.registry]  演进轨影子注册表（target → 器官记录）。默认进程内新建。
   * @param {object} [opts.breaker] EvoTrustBreaker 实例（用于只读锁查询）。
   */
  constructor(opts = {}) {
    this.registry = opts.registry instanceof Map ? opts.registry : new Map();
    this.breaker = opts.breaker || null;
    this._history = []; // 每个 target 的前态栈，支持回滚。
  }

  /**
   * 受控热载一个新器官。
   *
   * @param {object} patch
   * @param {string} patch.target    注册键（如 'parser:weird-format'）；触碰受保护不变量即否决
   * @param {string} patch.code      新器官源码
   * @param {string} patch.entry     入口函数名
   * @param {object} patch.verdict   来自 sandbox.evaluate 的判决（含 passToken/verdictDigest）
   * @param {string} [patch.requirementId]
   * @returns {{ok:boolean, patchId?:string, target?:string, error?:string, reason?:string}}
   */
  applyPatch(patch = {}) {
    const target = String(patch.target || '');
    if (!target) return { ok: false, error: 'missing target' };

    // 闸门③：引擎只读锁（防呆④）。
    if (this.breaker && this.breaker.isEngineReadOnly()) {
      return { ok: false, reason: 'engine-readonly', error: '演进引擎已熔断为只读模式，拒绝热载（防呆④）。' };
    }

    // 闸门②：宪法守卫（防呆③）——绝不热载触碰锁具/红线的目标。
    if (EvoTrustBreaker.isProtectedTarget(target) || EvoTrustBreaker.isProtectedTarget(patch.code)) {
      throw new ConstitutionViolation(
        `热载目标触碰受保护不变量（信任熔断/防呆规则/沙箱/日志），绝对禁止（防呆③）：${target}`,
      );
    }

    // 闸门①：沙箱凭证（防呆①）——无判决/未通过/凭证伪造一律拒绝。
    const v = patch.verdict;
    if (!v || v.passed !== true || !v.passToken) {
      throw new SandboxBypassError('缺少有效沙箱判决或未通过，禁止热载（防呆①：绝不跳过沙箱）。');
    }
    if (!sandbox.verifyToken(v.passToken, patch.code, v.verdictDigest)) {
      throw new SandboxBypassError('沙箱凭证校验失败（代码与凭证不匹配或凭证伪造），禁止热载（防呆①）。');
    }

    // 通过三闸门：登记进演进轨影子注册表。保存前态以备回滚。
    const prev = this.registry.has(target) ? this.registry.get(target) : null;
    this._history.push({ target, prev });

    const patchId = `patch_${v.codeHash.slice(0, 12)}`;
    const fn = this._compile(patch.code, patch.entry);
    this.registry.set(target, {
      patchId,
      target,
      entry: patch.entry,
      code: patch.code,
      fn,
      requirementId: patch.requirementId || null,
      codeHash: v.codeHash,
    });
    return { ok: true, patchId, target };
  }

  /** 按 target 取已热载器官的可调用函数（宿主按需调用）。 */
  resolve(target) {
    const rec = this.registry.get(String(target));
    return rec ? rec.fn : null;
  }

  /**
   * 回滚一个 target 到热载前态（§3.4 进化回滚）。无前态则直接卸载。
   * @returns {{ok:boolean, target:string, restored:boolean}}
   */
  rollback(target) {
    const t = String(target);
    // 找该 target 最近一次前态。
    let restored = false;
    for (let i = this._history.length - 1; i >= 0; i--) {
      if (this._history[i].target === t) {
        const prev = this._history[i].prev;
        if (prev) { this.registry.set(t, prev); restored = true; }
        else { this.registry.delete(t); }
        this._history.splice(i, 1);
        break;
      }
    }
    if (!restored && this.registry.has(t)) this.registry.delete(t);
    return { ok: true, target: t, restored };
  }

  /** 当前演进轨已热载的 target 列表。 */
  loadedTargets() { return Array.from(this.registry.keys()); }

  /** 在隔离上下文里把源码编译成可调用函数（与沙箱同构，宿主调用仍受 vm 边界保护）。 */
  _compile(code, entry) {
    const mat = new sandbox.OrganogenesisSandbox()._materialize(code, entry);
    return mat.ok ? mat.fn : null;
  }
}

module.exports = { HostPatcher, SandboxBypassError, ConstitutionViolation };
