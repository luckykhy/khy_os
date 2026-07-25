'use strict';

/**
 * blockquoteStyle.js — Pure-leaf decision for how a markdown blockquote's
 * BODY text is styled, aligning the logic behind Claude Code's blockquote
 * renderer.
 *
 * 对齐 CC `src/utils/markdown.ts` 的 `case 'blockquote'` **背后逻辑**(非外观):
 *   const bar = chalk.dim(BLOCKQUOTE_BAR)        // 竖条 dim
 *   ... `${bar} ${chalk.italic(line)}`           // 正文 italic·正常亮度
 *   // 源码注释逐字:"Keep text italic but at normal brightness —
 *   //               chalk.dim is nearly invisible on dark themes."
 *
 * CC 刻意把竖条 dim、正文保持 **italic 且正常亮度**:在深色主题下 `chalk.dim`
 * 几乎不可见,把正文 dim 掉等于复刻 CC 这条注释专门要避免的可读性 bug。
 *
 * khy 历史真缺口=`markdownRenderer.js` blockquote 正文 `c().dim(body)`——
 * 竖条 dim(与 CC 一致)但**正文也 dim**(= CC 注释明确警告的反例)。本叶子
 * 只决策正文样式名(`'italic'` 对齐 CC / `'dim'` 历史回退),竖条仍由 call-site
 * 保持 dim、`│` 竖条字形与 2 空格缩进是 khy 主题选择**刻意不纳入**本刀。
 *
 * 纯叶子:零 IO、零业务 require、确定性。仅读 env 门控,样式应用(chalk)留在
 * call-site(同 `orderedListAlign` 把对齐算法留叶子、着色留 renderer 的分工)。
 */

/**
 * 门控 KHY_BLOCKQUOTE_STYLE(默认开)。仅 `0/false/off/no` 关闭 → 逐字节回退
 * 历史 `c().dim(body)` 口径。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function blockquoteBodyStyleEnabled(env = process.env) {
  const flag = String((env && env.KHY_BLOCKQUOTE_STYLE) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 返回 blockquote 正文应套用的 chalk 样式名:
 *   - 门控开 → `'italic'`(对齐 CC·正常亮度·深色主题可读)
 *   - 门控关 → `'dim'`(历史口径·逐字节回退)
 * call-site 用 `c()[style](body)` 套用(chalk 同时具备 `.italic`/`.dim`)。
 * @param {Record<string,string>} [env]
 * @returns {'italic'|'dim'}
 */
function blockquoteBodyStyle(env = process.env) {
  return blockquoteBodyStyleEnabled(env) ? 'italic' : 'dim';
}

module.exports = { blockquoteBodyStyleEnabled, blockquoteBodyStyle };
