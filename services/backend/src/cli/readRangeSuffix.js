'use strict';

/**
 * readRangeSuffix — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 *
 * CC `packages/builtin-tools/src/tools/FileReadTool/UI.tsx` 的 `renderToolUseMessage`
 * 在 Read 工具头行的路径**之后**追加「读取范围」后缀,用一段具体算术把 offset/limit 折成
 * 人读的行区间:
 *   const startLine = offset ?? 1;
 *   const lineRange = limit ? `lines ${startLine}-${startLine + limit - 1}` : `from line ${startLine}`;
 * 即 `Read(foo.ts · lines 40-80)` 或(仅 offset)`Read(foo.ts · from line 40)`。
 *
 * Khy 历史在两处工具头渲染(经典 REPL `cli/toolDisplay.js` 的 read 分支、默认 TUI
 * `cli/tui/ink-components/ToolLines.js` 的 `summarizeArgs`)都**只回显裸路径**,把 read 真实
 * 携带并消费的 offset/limit(`src/tools/readFile.js` inputSchema 有这两个参数、且第 105-109 行
 * 据此切行区间)**整段丢弃**——模型分页读大文件某一段时,用户看不出读了哪一段。本叶子补齐
 * 那段「offset/limit → 行区间串」的后端算术(`startLine + limit - 1`、无 limit 时的 `从第 N 行起`
 * 回退),收敛成单一真源给两处头渲染调用。
 *
 * 诚实边界(刻意不纳入):
 *   - **绝不**移植 CC 的 `pages` 分支(PDF 页区间):Khy 的 read 工具**没有** `pages` 参数
 *     (readFile.js inputSchema 只有 offset/limit),凭空造 `· pages N` 等于臆造 Khy 不携带的数据。
 *   - 只认 offset/limit 两个**正整数**参数;缺省 / 非正 / 非整 / 非数 → 不产后缀(返回 `''`)。
 *   - 不做 CC 的 verbose 门控:Khy 无 verbose 概念,且行区间是「读了哪一段」的实质信息而非冗余,
 *     大多数读不设 offset/limit 故不嘈杂——故 offset/limit 一旦出现即**无条件**展示
 *     (与 CC 自身**总是**展示 `pages` 分支同一设计取向,只是落到 Khy 携带的行区间数据上)。
 *
 * 门控:KHY_READ_RANGE_SUFFIX(默认开)。=0/false/off/no → 关 → `buildReadRangeSuffix`
 *   **逐字节回退**(返回 `''`,头行只剩裸路径,与历史一致)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function readRangeSuffixEnabled(env = process.env) {
  const flag = String((env && env.KHY_READ_RANGE_SUFFIX) || '').trim().toLowerCase();
  return !_FALSY.has(flag);
}

/** 工具名归一后判定是否为 read(与 toolDisplay 的归一同规则:小写、去空格/下划线/连字符)。 */
function isReadToolName(toolName) {
  const name = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  return name === 'read' || name === 'readfile';
}

/** 仅接受**正整数**(数字或纯数字串);其余 → null。 */
function _posInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = parseInt(v.trim(), 10);
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * 由 read 工具参数构造「读取范围」后缀(含前导 ` · `),对齐 CC 的 offset/limit 算术。
 *
 *   - 门控关 → `''`(逐字节回退)。
 *   - offset/limit 都不是正整数 → `''`(无范围信息可显)。
 *   - limit 在 → ` · 第 {start}-{start+limit-1} 行`(start = offset ?? 1)。
 *   - 仅 offset(无 limit)→ ` · 从第 {start} 行起`。
 *
 * 纯函数:不读 IO(除门控 env)、不抛、不改入参。
 *
 * @param {object} params  read 工具参数(可能含 offset/limit)。
 * @param {object} [env]
 * @returns {string}  后缀串(空串表示不追加)。
 */
function buildReadRangeSuffix(params, env = process.env) {
  if (!readRangeSuffixEnabled(env)) return '';
  if (!params || typeof params !== 'object') return '';
  const offset = _posInt(params.offset);
  const limit = _posInt(params.limit);
  if (offset == null && limit == null) return '';
  const startLine = offset == null ? 1 : offset;
  const range = limit != null
    ? `第 ${startLine}-${startLine + limit - 1} 行`
    : `从第 ${startLine} 行起`;
  return ` · ${range}`;
}

module.exports = {
  readRangeSuffixEnabled,
  isReadToolName,
  buildReadRangeSuffix,
};
