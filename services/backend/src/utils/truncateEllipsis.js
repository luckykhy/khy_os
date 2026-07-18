'use strict';

/**
 * truncateEllipsis.js — 「超长截断 + 省略号」单一真源(n-1 边界 · '…' · 无空白规整)。
 *
 * 收敛 src/ 下 4 处输出等价的私有 `_truncate(s, n)`:
 *   - 逐字节簇(3·body 用 `_str(s)` 即 utils/toStr.toStr):
 *       cli/sessionSlots · cli/crossBranchSynthesis · cli/sessionTopology
 *   - 语义等价(1·body 内联 `s == null ? '' : String(s)`,与 toStr(s) 输出逐一相同):
 *       cli/handlers/topology
 * 语义:toStr 强转后,长度 ≤ n 原样返回;否则 `slice(0, max(0, n-1)) + '…'`。
 *
 * **刻意不收敛**:`_truncate` 家族高度分叉——省略号 '...'/'\n...[truncated]'/'… [truncated]'、
 *   切点 n vs n-3、是否 `.replace(/\s+/g,' ').trim()`、空值返 ''/'-'/s 各异。本 util 只收敛
 *   「n-1 边界 + '…' + 无空白规整」这一支;其余变体留原样(各自另议)。
 *
 * 契约:确定性、不 mutate、绝不抛。'…' 为单字符 U+2026。
 *
 * 各消费方保留同名本地 `const _truncate = require('.../truncateEllipsis')` → 调用点逐字节不变。
 */

const { toStr } = require('./toStr');

function truncateEllipsis(s, n) {
  const str = toStr(s);
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + '…';
}

module.exports = truncateEllipsis;
