'use strict';

/**
 * resilience/intentTrees.js — 内置降级树定义（开箱即用的核心意图）。
 *
 * 协议要求「每个核心意图绑定一棵降级熔断树」。这里给出第一棵也是范例那棵：
 *
 *   fetch-web-content（获取网页内容）
 *     Plan A: WebBrowser  —— 真实浏览器渲染（最强，最贵；依赖 puppeteer/playwright）
 *       └─失败→ Plan B: WebFetch  —— 直接 HTTP 抓取 + 正文抽取（轻量）
 *           └─失败→ Plan C: WebSearch —— 退而求其次，搜索引擎摘要兜底（拿到线索即算交差残料）
 *               └─失败→ 强制兜底协议
 *
 * 每个 Plan 自带 extractSalvage：哪怕该 Plan 失败，也尽量从结果里抠出可交差的残料
 * （部分 HTML / 摘要 / 标题），喂给 SalvageProtector，做到「兜底必须交差」。
 */

const { FallbackTreeBuilder } = require('./fallbackTree');

/** 从任意工具结果里尽力抠出一段可读文本残料（fail-safe，绝不抛错）。 */
function _textSalvage(result) {
  if (!result || typeof result !== 'object') {
    return typeof result === 'string' ? result.slice(0, 4000) : null;
  }
  const cand = result.content || result.text || result.body || result.html
    || result.summary || result.snippet || result.markdown
    || (result.data && (result.data.content || result.data.text));
  if (typeof cand === 'string' && cand.trim()) return cand.trim().slice(0, 4000);
  // 搜索类：结果常是 results[] —— 拼标题 + 链接当线索残料。
  const list = result.results || (result.data && result.data.results);
  if (Array.isArray(list) && list.length > 0) {
    return list.slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.title || r.name || ''} ${r.url || r.link || ''}`.trim())
      .join('\n')
      .slice(0, 4000);
  }
  return null;
}

/**
 * 构造「获取网页内容」降级树。
 * @param {object} [opts] { url, query } —— 由意图上下文提供，也可在 run(context) 时再给。
 */
function buildWebContentTree() {
  return new FallbackTreeBuilder('fetch-web-content', { description: '获取网页内容' })
    .plan('WebBrowser', {
      tool: 'WebBrowser',
      buildParams: (ctx) => ({ url: ctx.url, action: 'read', query: ctx.query }),
      extractSalvage: _textSalvage,
      suggestion: '浏览器渲染失败，多因依赖缺失或目标反爬；可改用轻量抓取或搜索。',
    })
    .plan('WebFetch', {
      tool: 'WebFetch',
      buildParams: (ctx) => ({ url: ctx.url }),
      extractSalvage: _textSalvage,
      suggestion: '直接抓取失败，多因鉴权/限频/动态渲染；可退化到搜索摘要。',
    })
    .plan('WebSearch', {
      tool: 'WebSearch',
      buildParams: (ctx) => ({ query: ctx.query || ctx.url }),
      extractSalvage: _textSalvage,
      suggestion: '搜索兜底也未命中；请核对关键词或更换信息源。',
    })
    .build();
}

/** 意图 → 构造器 注册表（可扩展更多核心意图的降级树）。 */
const INTENT_TREE_BUILDERS = Object.freeze({
  'fetch-web-content': buildWebContentTree,
});

/** 按意图名取一棵新构造的降级树；未知意图返回 null。 */
function getIntentTree(intent) {
  const fn = INTENT_TREE_BUILDERS[String(intent || '').trim()];
  return typeof fn === 'function' ? fn() : null;
}

module.exports = {
  buildWebContentTree,
  getIntentTree,
  INTENT_TREE_BUILDERS,
  _textSalvage,
};
