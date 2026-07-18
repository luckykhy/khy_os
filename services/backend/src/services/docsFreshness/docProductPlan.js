'use strict';

/**
 * docProductPlan.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 文档新鲜度系统 Layer 2(产物重生成)的纯规划器。
 *
 * 诉求:文档真源 .md 改了 → 已 committed 的 .html/.pdf 产物应重生成(复用 scripts/docs/md-to-pdf.js)。
 *
 * 红线(重要):**绝不新建产物**。只对**已经进版本控制**的 .html/.pdf 兄弟做重生成;
 *   md-only 文档(绝大多数)一律跳过。这与本仓「产物按需生成、多数文档保持 .md-only」的现状一致
 *   (今仅 OPS-043/044 preset 偶尔分发产物,且当前工作树里并未 committed 产物)。
 *
 * 本叶子只做纯规划:给定一个变更过的 .md 与「已 committed 产物清单」,判断
 *   ① 该 .md 是否有同名 .html/.pdf 兄弟在 committed 清单里;
 *   ② 若有,列出要重生成的产物 + 传给 md-to-pdf.js 的模式(只有 .html → --html-only;含 .pdf → 全量)。
 * 真正跑 md-to-pdf.js、git add 由 runner 完成。
 *
 * 门控 KHY_DOCS_REGEN(默认开;{0,false,off,no} 关)。关 → runner 跳过 Layer 2。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_DOCS_REGEN 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function docRegenEnabled(env = process.env) {
  const raw = env && env.KHY_DOCS_REGEN;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

function _norm(rel) {
  return String(rel == null ? '' : rel).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// 去掉一个路径的扩展名(最后一个 .),保留其余(含中文/空格/方括号)。
function _stripExt(rel) {
  const i = rel.lastIndexOf('.');
  const slash = rel.lastIndexOf('/');
  return i > slash ? rel.slice(0, i) : rel;
}

/**
 * 规划一个变更过的 .md 需要重生成哪些**已 committed** 产物。
 *
 * @param {string} changedMdRel               变更过的 .md(仓库相对)。
 * @param {string[]} committedProductRels      已 committed 的 .html/.pdf 路径清单(仓库相对)。
 * @returns {{regen:Array<{md:string,products:string[],mode:'--html-only'|null}>, skip:Array<{md:string,reason:string}>}}
 *   regen[].mode:只有 .html → '--html-only';含 .pdf → null(全量,md-to-pdf 默认出 html+pdf)。
 */
function planDocProducts(changedMdRel, committedProductRels) {
  const regen = [];
  const skip = [];
  try {
    const md = _norm(changedMdRel);
    if (!md || !md.endsWith('.md')) {
      return { regen, skip: md ? [{ md, reason: 'not-md' }] : [] };
    }
    const base = _stripExt(md); // 去 .md,得同名基
    const committed = new Set(
      (Array.isArray(committedProductRels) ? committedProductRels : []).map(_norm).filter(Boolean),
    );

    const html = `${base}.html`;
    const pdf = `${base}.pdf`;
    const hasHtml = committed.has(html);
    const hasPdf = committed.has(pdf);

    if (!hasHtml && !hasPdf) {
      // md-only:绝大多数文档。绝不新建产物。
      skip.push({ md, reason: 'md-only' });
      return { regen, skip };
    }

    const products = [];
    if (hasHtml) products.push(html);
    if (hasPdf) products.push(pdf);
    // 只 committed .html(无 pdf)→ --html-only,避免无谓依赖 Chrome。
    const mode = hasPdf ? null : '--html-only';
    regen.push({ md, products: products.sort(), mode });
    return { regen, skip };
  } catch {
    return { regen: [], skip: [] };
  }
}

module.exports = {
  docRegenEnabled,
  planDocProducts,
  _stripExt,
};
