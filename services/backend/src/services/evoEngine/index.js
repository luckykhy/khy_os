'use strict';

/**
 * evoEngine/index.js — SelfBootstrapEngine，需求内源发生器与闭环自愈引擎门面（自举创世）。
 *
 * 把六个纯模块编排成一条达尔文式闭环——**阻力捕获 → 归因铸造 → 代码生成 → 沙箱验证 → 热融合**，
 * 让 Khyos 在运行态自主发现痛点、推演需求、生成代码并受控热载，废弃「人类提需求→Agent实现」
 * 的低效链路：
 *
 *   PainPointScanner   阻力 → EvoRequirement（归因复用 selfHeal 诊断三源合一）
 *   evoLevels          L0/L1/L2 升级格；L2 强制降级 L0 + 3 步验证（防呆②）
 *   OrganogenesisSandbox 影子执行 + 毒性检测 + 差异校验 → 签发 HMAC 热载凭证（防呆①闸门）
 *   HostPatcher        凭证校验 + 宪法守卫 + 只读锁 → 演进轨影子注册（绝不污染核心）
 *   EvoTrustBreaker    分支熔断/引擎只读/回滚（防呆③④，自举逻辑只读不可改的锁具）
 *   evoLedger          全生命周期不可变哈希链日志（防呆⑤）
 *
 * 代码生成是注入式（codeGenerator）：引擎本身不内嵌模型，由调用方提供「需求→候选器官」的
 * 生成器，使引擎模型无关、可确定性单测。零侵入：不接管 toolUseLoop / executeTool（后续 PR）。
 */

const { PainPointScanner } = require('./painPointScanner');
const { OrganogenesisSandbox } = require('./organogenesisSandbox');
const { HostPatcher, SandboxBypassError, ConstitutionViolation } = require('./hostPatcher');
const { EvoTrustBreaker } = require('./evoTrustBreaker');
const evoRequirement = require('./evoRequirement');
const evoLevels = require('./evoLevels');
const evoLedger = require('./evoLedger');

class SelfBootstrapEngine {
  /**
   * @param {object} [opts]
   * @param {function} opts.codeGenerator  (EvoRequirement) => {code, entry, probes, baseline?}
   * @param {string} [opts.branch]         日志分支名（默认 'main'）
   * @param {object} [opts.scanner] [opts.sandbox] [opts.patcher] [opts.breaker] [opts.ledger]
   */
  constructor(opts = {}) {
    this.codeGenerator = typeof opts.codeGenerator === 'function' ? opts.codeGenerator : null;
    this.branch = opts.branch || 'main';
    this.scanner = opts.scanner || new PainPointScanner();
    this.sandbox = opts.sandbox || new OrganogenesisSandbox();
    this.breaker = opts.breaker || new EvoTrustBreaker();
    this.patcher = opts.patcher || new HostPatcher({ breaker: this.breaker });
    this.ledger = opts.ledger || evoLedger;
  }

  /**
   * 跑一次完整自举演进闭环。
   * @param {object} friction  阻力信号（见 PainPointScanner.scan）
   * @returns {object} 结构化结果（status + 各阶段产物），全程已记入不可变日志。
   */
  evolve(friction = {}) {
    // —— 阶段1 阻力捕获 + 归因铸造 ——
    const req = this.scanner.scan(friction);
    this._log(evoLedger.KIND.REQUIREMENT, req);

    const valid = evoRequirement.validate(req);
    if (!valid.valid) {
      // 防呆②：L2 缺架构对比/爆炸半径在此被拦死。
      return this._halt('requirement-invalid', req, { missing: valid.missing,
        reason: `需求规格不合规：${valid.missing.join('、')}` });
    }

    // —— 熔断前置：分支已熔断 / 引擎只读 → 拒绝自举 ——
    if (this.breaker.isBranchFused(req.id)) {
      return this._halt('branch-fused', req, { reason: `痛点 ${req.id} 分支已熔断，停止自举（§3.4）。` });
    }
    if (this.breaker.isEngineReadOnly()) {
      return this._halt('engine-readonly', req, { reason: '演进引擎已锁定为只读（防呆④）。' });
    }

    // —— 阶段2 代码生成（注入式） ——
    if (!this.codeGenerator) {
      return this._halt('no-generator', req, { reason: '未配置 codeGenerator，无法生成候选器官。' });
    }
    let candidate;
    try {
      candidate = this.codeGenerator(req);
    } catch (e) {
      return this._halt('generation-error', req, { reason: `代码生成失败：${e.message}` });
    }
    if (!candidate || !candidate.code || !candidate.entry) {
      return this._halt('generation-empty', req, { reason: '生成器未产出有效 {code, entry}。' });
    }
    this._log(evoLedger.KIND.CODE, {
      requirementId: req.id, entry: candidate.entry, codeLength: String(candidate.code).length,
      executionLevel: req.executionLevel, validationSteps: req.validationSteps,
    });

    // —— 阶段3 沙箱验证（影子执行 + 毒性 + 差异校验） ——
    const verdict = this.sandbox.evaluate({
      code: candidate.code,
      entry: candidate.entry,
      probes: candidate.probes || [],
      baseline: candidate.baseline,
    });
    this._log(evoLedger.KIND.SANDBOX, {
      requirementId: req.id, passed: verdict.passed, solved: verdict.solved,
      regressed: verdict.regressed, toxic: verdict.toxic, toxicity: verdict.toxicity,
      error: verdict.error, codeHash: verdict.codeHash,
    });

    const fuse = this.breaker.recordSandboxResult(req.id, verdict.passed);
    if (fuse.alert) this._log(evoLedger.KIND.ALERT, fuse.alert);
    if (fuse.engineReadOnly && !verdict.passed) this._log(evoLedger.KIND.FUSE, this.breaker._snapshot());

    if (!verdict.passed) {
      return this._halt('sandbox-rejected', req, {
        reason: verdict.toxic ? `沙箱判毒：${verdict.toxicity.join('；')}`
          : verdict.regressed ? '影子方案引入退化，否决热载。'
            : verdict.error ? `影子执行异常：${verdict.error}` : '未解决痛点，否决热载。',
        verdict, branchFused: fuse.branchFused, engineReadOnly: fuse.engineReadOnly, alert: fuse.alert,
      });
    }

    // —— 阶段4 受控热融合（凭证 + 宪法 + 只读三闸门在 applyPatch 内强制） ——
    let load;
    try {
      load = this.patcher.applyPatch({
        target: candidate.target || `organ:${req.id}`,
        code: candidate.code, entry: candidate.entry,
        verdict, requirementId: req.id,
      });
    } catch (e) {
      // 凭证伪造/宪法越界：记日志并上抛语义，绝不静默。
      this._log(evoLedger.KIND.ALERT, { kind: 'patch-rejected', requirementId: req.id, error: e.message, code: e.code });
      return this._halt(e.code === 'EVO_CONSTITUTION' ? 'constitution-violation' : 'sandbox-bypass-blocked',
        req, { reason: e.message, verdict });
    }
    if (!load.ok) {
      return this._halt('hotload-failed', req, { reason: load.error || load.reason, verdict });
    }
    this._log(evoLedger.KIND.HOTLOAD, { requirementId: req.id, patchId: load.patchId, target: load.target });

    return {
      status: 'evolved',
      requirement: req,
      verdict,
      patch: load,
      executionLevel: req.executionLevel,
      validationSteps: req.validationSteps,
    };
  }

  /**
   * 登记已热载补丁在后续任务的运行结果，必要时回滚（§3.4）。
   * @returns {{rollback:boolean, anomalies:number, rolledBack?:object}}
   */
  observePatch(patchId, target, anomaly) {
    const r = this.breaker.recordPostLoadOutcome(patchId, anomaly);
    if (r.rollback) {
      const rb = this.patcher.rollback(target);
      this._log(evoLedger.KIND.ROLLBACK, { patchId, target, anomalies: r.anomalies, restored: rb.restored });
      return { ...r, rolledBack: rb };
    }
    return r;
  }

  /** 校验进化黑历史链完整性（防呆⑤）。 */
  verifyLedger() { return this.ledger.verify({ branch: this.branch }); }

  /** 读取进化黑历史（只读拷贝）。 */
  history() { return this.ledger.read({ branch: this.branch }); }

  _log(kind, payload) {
    try { return this.ledger.append(kind, payload, { branch: this.branch }); }
    catch { return { ok: false }; }
  }

  _halt(status, requirement, extra) {
    return { status, requirement, ...extra };
  }
}

module.exports = {
  SelfBootstrapEngine,
  PainPointScanner,
  OrganogenesisSandbox,
  HostPatcher,
  EvoTrustBreaker,
  SandboxBypassError,
  ConstitutionViolation,
  evoRequirement,
  evoLevels,
  evoLedger,
};
