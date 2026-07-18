'use strict';

/**
 * ccTruncateLines —— 对齐 Claude Code `src/utils/stringUtils.ts` `truncateToLines`
 * 的「后端逻辑」,而不只是表面外观。
 *
 * CC 的关键后端逻辑:把多行内容收敛到前 N 行时,**截断绝不静默**——始终在末尾缀一个
 * 标记,让模型 / 用户一眼看出「预览不完整、下面还有内容」。CC 原文:
 *     export function truncateToLines(text, maxLines) {
 *       const lines = text.split('\n')
 *       if (lines.length <= maxLines) return text
 *       return lines.slice(0, maxLines).join('\n') + '…'
 *     }
 *
 * Khy 历史真缺口:行数截断散落各处 `split('\n').slice(0, N).join('\n')`,多处**静默丢弃**
 * 尾部行(无任何标记 → 一篇 500 行的文档被切成 80 行后看起来像完整文档);少数处又各自
 * 用不一致措辞(exploreTool「+N more lines」/ repl「(+N more lines)」),既无单一真源也无
 * 统一的「诚实告知」约定。本叶子收敛成单一真源:
 *   - `truncateToLines` —— CC 逐字节移植(裸 '…' 标记),供对齐 / 测试;
 *   - `truncatePreview` —— Khy 路由用的门控诚实预览:门控关 → 逐字节回退历史静默
 *     `slice(0,N).join('\n')`;门控开 → 保留前 N 行 + 独立标记行「… +<dropped> 行」
 *     (信息量大于 CC 裸 '…',明确告知丢了多少行)。
 *
 * 纯叶子:零 IO / 确定性 / 绝不抛 / 不引入任何外部依赖。
 */

// 门控 KHY_TRUNCATE_TO_LINES 默认开;标准 falsy 串(0/false/off/no,大小写/空白不敏感)关。
function truncateLinesEnabled(env = process.env) {
  const flag = String((env && env.KHY_TRUNCATE_TO_LINES) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function _asString(text) {
  return typeof text === 'string' ? text : String(text == null ? '' : text);
}

/**
 * CC `truncateToLines` 的逐字节移植:`lines.length <= maxLines` → 原文;
 * 否则前 N 行 `join('\n')` + 标记(默认 '…',直接缀在末行尾,与 CC 一致)。
 * 防呆:maxLines 非有限 / 为负 → 返回原文(绝不抛)。
 */
function truncateToLines(text, maxLines, ellipsis = '…') {
  const s = _asString(text);
  const n = Number(maxLines);
  if (!Number.isFinite(n) || n < 0) return s;
  const lines = s.split('\n');
  if (lines.length <= n) return s;
  return lines.slice(0, n).join('\n') + ellipsis;
}

/**
 * Khy 路由用的门控诚实预览。
 *   - 行数 <= maxLines:两态都原样返回(`split('\n').slice(0,n).join('\n')` 对 ≤n 行是
 *     恒等变换,故返回原文与历史 join 形式逐字节等价)。
 *   - 行数 > maxLines:
 *       门控关 → `lines.slice(0,n).join('\n')`(逐字节回退历史静默截断,无标记);
 *       门控开 → 上述 head + 一行「… +<dropped> 行」诚实标记。
 * 防呆:maxLines 非有限 / 为负 → 返回原文。
 */
function truncatePreview(text, maxLines, env = process.env) {
  const s = _asString(text);
  const n = Number(maxLines);
  if (!Number.isFinite(n) || n < 0) return s;
  const lines = s.split('\n');
  if (lines.length <= n) return s;
  const head = lines.slice(0, n).join('\n');
  if (!truncateLinesEnabled(env)) return head;
  const dropped = lines.length - n;
  return head + '\n… +' + dropped + ' 行';
}

module.exports = { truncateLinesEnabled, truncateToLines, truncatePreview };
