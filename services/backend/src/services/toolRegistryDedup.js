'use strict';

/**
 * toolRegistryDedup —— 纯叶子(pure leaf):模型可见工具列表的「真重复实现」折叠器。
 *
 * 契约:零 IO(不碰 fs/网络/子进程/process.exit)、确定性(同输入同输出)、
 * 单一真源(冗余对的判定只在本文件的 REDUNDANT_FAMILIES 表)、env 门控默认开
 * (`KHY_TOOL_DEDUP`,仅 0/false/off/no 关闭,关闭即字节回退原列表)、fail-soft 绝不抛。
 *
 * 背景(经源码核实,非臆测):工具注册表跑两套并行栈——子目录 BaseTool 类
 * (`Read`/`Write`/`Edit`,路径参数 `file_path`)与扁平 defineTool 文件
 * (`readFile`/`writeFile`/`editFile`,路径参数 `path`)。同一操作各有一份实现,
 * 归一化名不同(read vs readfile)故都进了模型可见列表 → 模型要在等价工具间二选一,
 * 徒增调用错误率与上下文。本叶子在模型可见列表组装的最后一道,把**已核实为真重复**的
 * 扁平实现折叠成规范工具的别名(从列表移除、但仍可经既有别名解析被调用 → 零能力损失)。
 *
 * 零假阳性底线:只折叠 REDUNDANT_FAMILIES 里**人工核实过**的等价对,绝不做启发式合并;
 * 规范工具不在列表时,保留其冗余实现(宁可冗余,不丢能力)。
 */

// 单一真源:规范工具 ← 其等价冗余实现名。新增前必须核实两者语义/行为等价,
// 且冗余实现的入参经既有别名解析(normalizeToolName)+ 参数强制(normalizeToolParams)
// 能被规范工具接住,折叠后不丢能力。
const REDUNDANT_FAMILIES = [
  { canonical: 'Read', redundant: ['readFile'] },
  { canonical: 'Write', redundant: ['writeFile'] },
  { canonical: 'Edit', redundant: ['editFile'] },
  // 本表只登记「归一化名 **不同**」的真重复对(如 read⇄readfile):这类若不折叠会双双
  // 进模型清单,故须本叶子在最后一道显式折叠。
  //
  // 另有 4 对孪生 —— Glob⇄glob / Grep⇄grep / WebSearch⇄webSearch / SendMessage⇄sendMessage
  // —— **不**登记本表,因为它们仅**大小写不同**(_normalize 归一后 glob===glob),会被
  // getToolDefinitions 上游的 `_normalize` 去重步(lowercase+strip-underscore,保留首次出现=
  // Phase 1 先加载的规范工具)天然折叠掉,legacy 名在模型清单里本就不出现(经全量管线核实:
  // KHY_TOOL_DEDUP 开/关模型清单都不含 glob/grep/webSearch/sendMessage)。若把它们写进本表,
  // buildRedundancyIndex 的自引用守卫(norm === canonicalNorm)会直接跳过 → 纯 no-op 且误导读者,
  // 故刻意不登记。这 4 对由契约审计器(toolContract)以 same-category/same-risk warning 标注。
];

function _enabled() {
  const v = String(process.env.KHY_TOOL_DEDUP || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// 收敛到 utils/trimLowerStripUnderscores 单一真源(逐字节委托,调用点不变)
const _normalize = require('../utils/trimLowerStripUnderscores');

/**
 * 把 REDUNDANT_FAMILIES 展开成 { 归一化冗余名 -> { canonical, canonicalNorm, raw } }。
 * 确定性、无副作用。导出供测试核对单一真源。
 */
function buildRedundancyIndex() {
  const idx = new Map();
  for (const fam of REDUNDANT_FAMILIES) {
    const canonical = String(fam && fam.canonical || '').trim();
    const canonicalNorm = _normalize(canonical);
    if (!canonical) continue;
    const reds = Array.isArray(fam.redundant) ? fam.redundant : [];
    for (const r of reds) {
      const norm = _normalize(r);
      if (!norm || norm === canonicalNorm) continue; // 自指/空名跳过
      if (!idx.has(norm)) idx.set(norm, { canonical, canonicalNorm, raw: String(r).trim() });
    }
  }
  return idx;
}

function _mergeAliases(existing, extra) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const s = String(name || '').trim();
    if (!s) return;
    const k = _normalize(s);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  if (Array.isArray(existing)) for (const a of existing) push(a);
  for (const a of extra) push(a);
  return out;
}

/**
 * 折叠模型可见工具定义列表中的真重复实现。
 *
 * @param {Array<{name:string, aliases?:string[]}>} defs - 已组装、已归一化去重的工具定义列表
 * @returns {Array} 折叠后的列表(顺序稳定;关闭门控或入参非法 → 原样返回)
 *
 * 行为:对每个 def,若其归一化名命中冗余表 **且** 对应规范工具也在 defs 中,则丢弃该 def,
 * 并把它的名字并入规范工具的 aliases(规范工具仍可经别名被调用)。规范工具缺席时保留冗余实现。
 * 不就地破坏入参:仅对获得新别名的规范 def 浅克隆。
 */
function collapseRedundant(defs) {
  if (!_enabled()) return defs;
  if (!Array.isArray(defs)) return defs;
  try {
    const idx = buildRedundancyIndex();
    if (idx.size === 0) return defs;

    // 哪些规范工具确实在列表里(决定能否安全折叠)
    const presentNorms = new Set();
    for (const d of defs) {
      const n = _normalize(d && d.name);
      if (n) presentNorms.add(n);
    }

    // 规范工具 -> 需要并入的别名名列表
    const foldInto = new Map(); // canonicalNorm -> string[]
    for (const [redNorm, info] of idx.entries()) {
      if (presentNorms.has(redNorm) && presentNorms.has(info.canonicalNorm)) {
        const list = foldInto.get(info.canonicalNorm) || [];
        // 用列表里该冗余 def 的原始名,保留大小写
        list.push(redNorm);
        foldInto.set(info.canonicalNorm, list);
      }
    }
    if (foldInto.size === 0) return defs;

    const dropNorms = new Set(idx.keys()); // 候选丢弃集(仅当 canonical 在场才真丢)

    const out = [];
    for (const def of defs) {
      const norm = _normalize(def && def.name);
      const info = idx.get(norm);
      // 是冗余实现,且其规范工具在场 → 丢弃(其名将并入规范工具别名)
      if (info && dropNorms.has(norm) && presentNorms.has(info.canonicalNorm)) {
        continue;
      }
      // 是获得折叠别名的规范工具 → 浅克隆并入别名
      const extra = foldInto.get(norm);
      if (extra && extra.length) {
        const originalNames = extra.map((rn) => {
          const i = idx.get(rn);
          return i ? i.raw : rn;
        });
        out.push(Object.assign({}, def, {
          aliases: _mergeAliases(def && def.aliases, originalNames),
        }));
        continue;
      }
      out.push(def);
    }
    return out;
  } catch {
    return defs; // fail-soft:任何异常都回退原列表
  }
}

module.exports = {
  REDUNDANT_FAMILIES,
  buildRedundancyIndex,
  collapseRedundant,
  _normalize,
  _enabled,
};
