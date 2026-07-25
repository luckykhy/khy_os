'use strict';

// 对齐 CC「后端逻辑也对齐」:markdown 行内链接 `[text](url)` 的**展示形态决策**
// 单一真源。镜像 Claude Code `src/utils/markdown.ts` 的 `link` case 两条刻意规则:
//
//   1. mailto: 链接 → 剥掉 `mailto:` scheme,只显**裸邮箱纯文本**
//      (CC 注释:Prevent mailto links from being displayed as clickable links;
//       `const email = token.href.replace(/^mailto:/, ''); return email`)。
//      khy 历史走通用 `[text](url)` 规则 → 渲染成 `Email (mailto:foo@bar)`,
//      把 `mailto:` scheme 泄给用户,且邮箱被埋进 dim 括号里。
//
//   2. 展示文本 === URL(或为空)→ 只显 URL **一次**,不重复
//      (CC:`plainLinkText === token.href` 时只 `createHyperlink(token.href)`)。
//      khy 历史无条件 `text (url)` → `https://x.com (https://x.com)` 自我重复。
//
// 这是一个**纯叶子**:零 IO、零业务 require、确定性。只产出「展示计划」对象
// {kind, ...},chalk 着色一律留 call-site(叶子保持无样式、可单测)。门控
// KHY_MARKDOWN_LINK_DISPLAY 默认开;关 → 一律返回 {kind:'text-url'} 让 call-site
// 逐字节回退到历史的 `text (url)` 渲染。
//
// 诚实边界(刻意不纳入):
//   - CC 用 OSC 8 终端超链接(createHyperlink)在文本≠URL 时让链接可点击;khy 的
//     设计是显式 `text (dim url)`(在任何终端都能看清真实目标,不依赖 OSC 8 能力),
//     这是有意的渲染选择而非缺陷,故**不**引入 OSC 8(那是行为变更非显示对齐)。
//   - 空展示文本 `[](url)` 在 khy 永不命中既有正则(`[^\]]+` 要求至少一字符),
//     叶子仍防御性处理(并入 url-only),但 call-site 不会触发该分支。
//   - 着色/下划线/dim 归 call-site 样式层;mailto 裸邮箱按 CC 走纯文本(不着色)。

function markdownLinkDisplayEnabled(env = process.env) {
  const flag = String((env && env.KHY_MARKDOWN_LINK_DISPLAY) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// mailto: 大小写不敏感(URL scheme 本就大小写不敏感),只剥前缀一次。
const MAILTO_RE = /^mailto:/i;

/**
 * Decide how an inline markdown link should be displayed.
 *
 * @param {string} text - the link's display text (between `[` and `]`)
 * @param {string} url  - the link target (between `(` and `)`)
 * @param {object} [env]
 * @returns {{kind:'plain', text:string}
 *          | {kind:'url-only', url:string}
 *          | {kind:'text-url', text:string, url:string}}
 *   - 'plain'    → render `text` as bare plain text (mailto bare email)
 *   - 'url-only' → render `url` once (text === url, or empty text)
 *   - 'text-url' → render `text` then dimmed `(url)` (historical default)
 */
function planLinkDisplay(text, url, env = process.env) {
  const rawText = String(text == null ? '' : text);
  const rawUrl = String(url == null ? '' : url);

  // 门控关 → 逐字节回退:call-site 永远走 `text (url)` 历史渲染。
  if (!markdownLinkDisplayEnabled(env)) {
    return { kind: 'text-url', text: rawText, url: rawUrl };
  }

  // 1. mailto: → 裸邮箱纯文本(对齐 CC,剥 scheme)。
  if (MAILTO_RE.test(rawUrl)) {
    return { kind: 'plain', text: rawUrl.replace(MAILTO_RE, '') };
  }

  // 2. 展示文本 === URL(或为空)→ 只显 URL 一次,避免自我重复。
  const trimmed = rawText.trim();
  if (!trimmed || trimmed === rawUrl) {
    return { kind: 'url-only', url: rawUrl };
  }

  // 3. 默认:text + dim (url)。
  return { kind: 'text-url', text: rawText, url: rawUrl };
}

module.exports = { markdownLinkDisplayEnabled, planLinkDisplay };
