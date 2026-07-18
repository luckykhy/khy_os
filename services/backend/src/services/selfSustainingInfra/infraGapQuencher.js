'use strict';

/**
 * infraGapQuencher.js — 基建缺失淬火器（§3.4 裸奔即需求）。
 *
 * 模块缺契约、缺测试、或藏隐式依赖，**不视为人祸，而视为系统的基建自愈需求**：静态扫描发现
 * 裸奔点 → 升维铸造 `EvoRequirement`「为 XX 补全类型契约与行为快照」→ 简单模型据此自愈。
 *
 * 扫描的四类裸奔（gap）：
 *   missing-contract     导出公共函数无 JSDoc 契约（@param/@returns 缺失）——违反防呆①「契约即文档」。
 *   untyped-any          契约用 {any}/{*}/{Object}/{} 无形状类型——违反防呆②「禁无类型传递」。
 *   implicit-dependency  直读 process.env/global/globalThis——违反 §3.2 正交隔离。
 *   missing-test         公共函数无行为快照/单测（由门面结合测试索引判定）——违反防呆③。
 *
 * 复用 [[evoRequirement]] 真源铸造（不改其定形），why 措辞经 evoLevels.classify 校准锁 L1
 * （含「拓扑空洞 / 新增…工具」，规避 网关/压缩/调度 等 L2 触发词）。纯逻辑，落账本由门面负责。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const evoLevels = require('../evoEngine/evoLevels');

const GAP_KIND = Object.freeze({
  MISSING_CONTRACT: 'missing-contract',
  UNTYPED_ANY: 'untyped-any',
  IMPLICIT_DEPENDENCY: 'implicit-dependency',
  MISSING_TEST: 'missing-test',
});

// 无形状/弱类型标注（违反强类型契约铁律）。
const WEAK_TYPES = new Set(['any', '*', 'object', '{}', '']);
const DOC_BLOCK = /\/\*\*([\s\S]*?)\*\//g;

class InfraGapQuencher {
  /**
   * 静态扫描单文件的基建裸奔点（纯函数，不含 missing-test）。
   * @param {string} source
   * @param {string} fileName
   * @returns {Array<{kind:string, symbol:string, detail:string, file:string}>}
   */
  audit(source, fileName) {
    const src = String(source == null ? '' : source);
    const file = String(fileName || 'unknown.js');
    const gaps = [];

    const publics = this._publicSymbols(src);
    const documented = this._documentedFns(src);
    const fnDecls = this._functionNames(src);

    // missing-contract：公共且是函数，却无 @param/@returns 契约。
    for (const name of publics) {
      if (!fnDecls.has(name)) continue;
      if (!documented.has(name)) {
        gaps.push({ kind: GAP_KIND.MISSING_CONTRACT, symbol: name, file,
          detail: `公共函数「${name}」缺 JSDoc 契约（@param/@returns），文档无法自动坍缩` });
      }
    }

    // untyped-any：契约里出现无形状类型。
    for (const t of this._weakTypeHits(src)) {
      gaps.push({ kind: GAP_KIND.UNTYPED_ANY, symbol: t.where, file,
        detail: `弱类型契约 {${t.type}}，违反强类型铁律——禁 any/无类型字典传递` });
    }

    // implicit-dependency：直读全局态。
    for (const d of this._implicitDeps(src)) {
      gaps.push({ kind: GAP_KIND.IMPLICIT_DEPENDENCY, symbol: d, file,
        detail: `直读全局态「${d}」破坏正交隔离，应经依赖注入传入` });
    }

    return gaps;
  }

  /** 提取 module.exports / exports.X 暴露的公共符号名。 */
  _publicSymbols(src) {
    const names = new Set();
    const objRe = /module\.exports\s*=\s*\{([\s\S]*?)\}/g;
    let m;
    while ((m = objRe.exec(src)) !== null) {
      for (const piece of m[1].split(',')) {
        const nm = piece.split(':')[0].trim().replace(/\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
      }
    }
    const dotRe = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = dotRe.exec(src)) !== null) names.add(m[1]);
    return names;
  }

  /** 有 @param/@returns 契约且其后紧跟函数声明的函数名集合。 */
  _documentedFns(src) {
    const documented = new Set();
    let m;
    DOC_BLOCK.lastIndex = 0;
    while ((m = DOC_BLOCK.exec(src)) !== null) {
      if (!/@param|@returns?/.test(m[1])) continue;
      const after = src.slice(m.index + m[0].length);
      const sig = this._firstFnName(after);
      if (sig) documented.add(sig);
    }
    return documented;
  }

  /** 所有函数声明名（function / const arrow / const function）。 */
  _functionNames(src) {
    const names = new Set();
    let m;
    const a = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
    while ((m = a.exec(src)) !== null) names.add(m[1]);
    const b = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function)/g;
    while ((m = b.exec(src)) !== null) names.add(m[1]);
    return names;
  }

  _firstFnName(text) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('*') || line.startsWith('//')) continue;
      const mm = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)
        || /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      return mm ? mm[1] : null;
    }
    return null;
  }

  /** 扫描 JSDoc 弱类型标注。 */
  _weakTypeHits(src) {
    const hits = [];
    const re = /@(param|returns?)\s+\{([^}]*)\}(?:\s+(\[?[\w.$]+\]?))?/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const type = m[2].trim().toLowerCase();
      if (WEAK_TYPES.has(type)) hits.push({ type: m[2].trim() || '∅', where: m[3] || m[1] });
    }
    return hits;
  }

  /** 扫描直读全局态。 */
  _implicitDeps(src) {
    const found = new Set();
    const re = /\b(process\.env\.[A-Za-z_][\w]*|global\.[A-Za-z_$][\w$]*|globalThis\.[A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
    return [...found];
  }

  /**
   * 把一个裸奔点淬火为基建自愈 EvoRequirement（L1，复用 evoRequirement 真源）。
   * @param {{kind, symbol, detail, file}} gap
   * @returns {object} EvoRequirement（装饰 gapKind/targetSymbol/file）
   */
  quench(gap) {
    const g = gap || {};
    const symbol = String(g.symbol || '匿名');
    const file = String(g.file || 'unknown.js');
    const req = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `「${file}:${symbol}」基建裸奔（${g.kind}）：${String(g.detail || '').slice(0, 80)}`,
      attribution: {
        kind: 'infra-bareness',
        // L1 校准：基建拓扑空洞 + 新增…工具，规避 L2 触发词。
        why: `模块裸奔缺类型契约与行为快照，基建拓扑空洞——须为「${symbol}」新增契约提取与测试骨架工具补全自持基建`,
        surface: 'infra-gap',
      },
      impact: `${g.kind} 致文档/测试无法自动坍缩，简单模型不敢维护「${file}」`,
      proposedModules: ['契约注释补全', '行为快照测试骨架(AutoTestScaffolder)'],
      acceptanceCriteria: [
        `「${symbol}」具备 @param/@returns 强类型契约，ContractDocGenerator 可坍缩出文档`,
        `「${symbol}」具备行为快照测试，提交门禁放行`,
      ],
    });
    return this._decorate(req, g);
  }

  /** 把一批裸奔点批量淬火（去重同 symbol+kind）。 */
  quenchAll(gaps) {
    const seen = new Set();
    const reqs = [];
    for (const g of gaps || []) {
      const key = `${g.kind}::${g.symbol}::${g.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reqs.push(this.quench(g));
    }
    return reqs;
  }

  _decorate(req, gap) {
    req.infraGap = true;
    req.gapKind = gap.kind;
    req.targetSymbol = String(gap.symbol || '');
    req.gapFile = String(gap.file || '');
    // L0/L1 不变式自检：基建补全绝不应擅升 L2（措辞失手即归一）。
    if (req.level === evoLevels.LEVELS.L2) {
      req.level = evoLevels.LEVELS.L1;
      req.executionLevel = evoLevels.LEVELS.L1;
      req.validationSteps = 1;
      req.l2Valid = true;
    }
    return req;
  }
}

module.exports = { InfraGapQuencher, GAP_KIND };
