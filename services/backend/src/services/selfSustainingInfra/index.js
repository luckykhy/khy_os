'use strict';

/**
 * selfSustainingInfra/index.js — SelfSustainingInfra，自持基建门面（§4 编排）。
 *
 * 为 Khyos 注入「自说明、自验证、自修复」基因：把代码自动坍缩为文档与测试，让简单模型只关注
 * 局部增删改、无需理解全局脉络即可安全维护。门面把四件基建装置串成闭环：
 *
 *   源码契约
 *     │
 *   generateDocs(fileMap)          ContractDocGenerator   契约即文档（防呆①）
 *   impactOf(changed, fileMap)     DependencyImpactScanner 影响面评估（防呆④）
 *   scaffoldTests(src, file)       AutoTestScaffolder     行为快照骨架（§3.3）
 *   audit(fileMap, {tested})       InfraGapQuencher       基建裸奔诊断（防呆②）
 *     │
 *   commitGate(fileMap, tested)    新增公共函数缺测试 → 阻断提交 + 淬火（防呆③）
 *   guardRefactor(changed, …)      未评估影响面禁改公共契约（防呆④）
 *     ↓
 *   基建自愈需求池（evoLedger 不可变哈希链）
 *
 * 零侵入：自成纯子系统，不接管构建/提交主流程；可由后续 PR 把 commitGate 挂到 pre-commit、
 * 把 generateDocs 挂到 CI，落地「代码→契约→文档/测试」的自动坍缩流。
 */

const { ContractDocGenerator } = require('./contractDocGenerator');
const { DependencyImpactScanner } = require('./dependencyImpactScanner');
const { AutoTestScaffolder } = require('./autoTestScaffolder');
const { InfraGapQuencher, GAP_KIND } = require('./infraGapQuencher');
const evoLedger = require('../evoEngine/evoLedger');

const DEFAULT_BRANCH = 'self_sustaining_infra_pool';

class SelfSustainingInfra {
  constructor(opts = {}) {
    this.branch = opts.branch || DEFAULT_BRANCH;
    this.docGen = opts.docGen || new ContractDocGenerator();
    this.scanner = opts.scanner || new DependencyImpactScanner();
    this.scaffolder = opts.scaffolder || new AutoTestScaffolder();
    this.quencher = opts.quencher || new InfraGapQuencher();
    this.ledger = opts.ledger || evoLedger;
  }

  /**
   * 从 {file: source} 坍缩出 API Markdown（防呆①：代码即唯一真相）。
   * @param {Object<string,string>} fileMap
   * @returns {string}
   */
  generateDocs(fileMap) {
    const modules = Object.keys(fileMap || {}).map((f) => this.docGen.extractContracts(fileMap[f], f));
    return this.docGen.renderMarkdown(modules);
  }

  /**
   * 评估改动文件的受影响下游（防呆④）。
   * @param {string} changedFile
   * @param {Object<string,string>} fileMap
   * @returns {{changed, impacted, count, hasDownstream}}
   */
  impactOf(changedFile, fileMap) {
    const graph = this.scanner.buildGraph(fileMap);
    return this.scanner.impactedBy(changedFile, graph);
  }

  /**
   * 为源码生成 node:test 行为快照骨架（§3.3）。
   * @param {string} source
   * @param {object} [opts] { requirePath, moduleName }
   * @returns {string}
   */
  scaffoldTests(source, opts = {}) {
    const sigs = this.scaffolder.parseSignatures(source);
    return this.scaffolder.scaffold(sigs, opts);
  }

  /**
   * 全量静态扫描基建裸奔点（含 missing-test，依赖已测符号索引）。
   * @param {Object<string,string>} fileMap
   * @param {object} [opts] { testedSymbols: string[]|Set }
   * @returns {{gaps:Array, byKind:Object<string,number>}}
   */
  audit(fileMap, opts = {}) {
    const tested = new Set(opts.testedSymbols || []);
    const gaps = [];
    for (const file of Object.keys(fileMap || {})) {
      const src = fileMap[file];
      const fileGaps = this.quencher.audit(src, file);
      gaps.push(...fileGaps);
      // missing-test：公共函数无对应已测符号（防呆③ 的扫描面）。
      for (const name of this.quencher._publicSymbols(String(src))) {
        if (this.quencher._functionNames(String(src)).has(name) && !tested.has(name)) {
          gaps.push({ kind: GAP_KIND.MISSING_TEST, symbol: name, file,
            detail: `公共函数「${name}」无行为快照/单测` });
        }
      }
    }
    const byKind = {};
    for (const g of gaps) byKind[g.kind] = (byKind[g.kind] || 0) + 1;
    return { gaps, byKind };
  }

  /**
   * 提交门禁（防呆③）：新增公共函数缺行为快照/单测则阻断，并淬火出补全需求落账本。
   * @param {Object<string,string>} fileMap
   * @param {object} [opts] { testedSymbols }
   * @returns {{blocked:boolean, gaps:Array, requirements:Array, reason:string}}
   */
  commitGate(fileMap, opts = {}) {
    const { gaps } = this.audit(fileMap, opts);
    // 阻断面：缺测试 + 缺契约（裸奔的公共面）。
    const blockingKinds = new Set([GAP_KIND.MISSING_TEST, GAP_KIND.MISSING_CONTRACT, GAP_KIND.UNTYPED_ANY]);
    const blocking = gaps.filter((g) => blockingKinds.has(g.kind));
    const requirements = this.quencher.quenchAll(blocking);
    for (const req of requirements) this._log(req);
    return {
      blocked: blocking.length > 0,
      gaps,
      requirements,
      reason: blocking.length
        ? `检出 ${blocking.length} 处基建裸奔，阻断提交并已淬火补全需求（防呆③）`
        : '基建完备，放行',
    };
  }

  /**
   * 重构守卫（防呆④）：未评估影响面禁改公共契约。
   * @param {string} changedFile
   * @param {Object<string,string>} fileMap
   * @param {object} [opts] { reviewedImpact:boolean, touchesPublicContract:boolean }
   * @returns {{allowed:boolean, impact:object, reason:string}}
   */
  guardRefactor(changedFile, fileMap, opts = {}) {
    const impact = this.impactOf(changedFile, fileMap);
    const reviewed = !!opts.reviewedImpact;
    // 有下游且未查看 DependencyImpactScanner 输出 → 拒绝盲改（防呆④）。
    if (impact.hasDownstream && !reviewed) {
      return {
        allowed: false,
        impact,
        reason: `「${changedFile}」有 ${impact.count} 个下游依赖，未评估影响面前禁止重构公共契约（防呆④）`,
      };
    }
    return {
      allowed: true,
      impact,
      reason: impact.hasDownstream
        ? `已评估 ${impact.count} 个下游影响，放行`
        : '无下游依赖，可安全盲改内部实现',
    };
  }

  /** 基建自愈需求池（不可变哈希链拷贝）。 */
  pool() {
    try { return this.ledger.read({ branch: this.branch }); } catch { return []; }
  }

  /** 校验需求池链完整性。 */
  verifyPool() {
    try { return this.ledger.verify({ branch: this.branch }); }
    catch { return { ok: false, length: 0, brokenAt: null, reason: 'verify-error' }; }
  }

  _log(req) {
    try {
      return this.ledger.append(this.ledger.KIND.REQUIREMENT, {
        source: 'self-sustaining-infra',
        gapKind: req.gapKind,
        targetSymbol: req.targetSymbol,
        file: req.gapFile,
        requirementId: req.id,
        level: req.level,
      }, { branch: this.branch });
    } catch { return { ok: false }; }
  }
}

module.exports = {
  SelfSustainingInfra,
  ContractDocGenerator,
  DependencyImpactScanner,
  AutoTestScaffolder,
  InfraGapQuencher,
  GAP_KIND,
};
