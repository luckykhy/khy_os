'use strict';

/**
 * ccCountLines — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * CC 在「Writing X (N lines)」「已写入 (M 行)」这类摘要里显示的行数,不是裸
 * `content.split('\n').length`——CC 有一个专门的 `countLines` 后端算法
 * (src/tools/FileWriteTool/UI.tsx `countLines(content)`):
 *
 *     const parts = content.split('\n')
 *     return content.endsWith('\n') ? parts.length - 1 : parts.length
 *
 * 两条关键后端逻辑:
 *   ① **末尾换行是行终止符,不是一个新空行**——绝大多数文本文件都以 '\n' 结尾,
 *      裸 `split('\n').length` 会把这个终止换行当成一个额外空行 → **恒定多算 1 行**
 *      (一个 3 行文件报成 "4 lines")。CC 用 endsWith('\n') 把它减回去。
 *   ② **永远按 `\n` 切,刻意不用 os.EOL**——否则 Windows 的 `\r\n` 会让每个文件
 *      都被算成 1 行(CC 源码对此有明确注释)。
 *
 * Khy 现状(本刀收敛的真缺口):CC 这套算法此前只被**私有**复制进
 * `cli/toolResultSummary.js` 的 `_writeLineCount`(post-exec「已写入 M 行」摘要,
 * 已修),而 `cli/toolDisplay.js` 的 `_estimateLines`(pre-exec「✏️ Writing X
 * (N lines)」)仍用裸 `split('\n').length`——**同一次写入**先显 "2 lines" 再显
 * "1 行"(差 1)。本叶子把该算法提升为**单一真源**,两处 call-site 共同委派。
 *
 * 门控:KHY_WRITE_COUNT_LINES_CC(**复用** `_writeLineCount` 既有门控键,使
 * countLines 算法在两个 call-site 由同一开关统一治理)。默认开;`{0,false,off,no}`
 * (大小写/空白不敏感)关 → 逐字节回退裸 `split('\n').length`。
 *
 * 空串语义**刻意留给 call-site**:CC `countLines('')` = 1(`''.split('\n')` →
 * `['']`,不 endsWith '\n' → 1),但 Khy 两处 call-site 都有各自的「空内容 → 0 行
 * (省略行数段)」产品守卫,故本叶子只实现**非空**的忠实算法,空串守卫由 call-site
 * 在调用前保留(见各 call-site 的 `if (!content) return 0` / `if (s==='') return 0`)。
 */

// 门控 KHY_WRITE_COUNT_LINES_CC(与 toolResultSummary._writeLineCount 同键)。
function countLinesEnabled(env = process.env) {
  const flag = String((env && env.KHY_WRITE_COUNT_LINES_CC) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * CC `countLines` 的逐字节移植:末尾换行当行终止符,永远按 `\n` 切。
 * @param {*} content  任意值(非串一律 String() 归一;null/undefined → '')。
 * @returns {number}   行数(绝不抛)。空串 → 1(CC 口径;call-site 自行守卫成 0)。
 */
function ccCountLines(content) {
  const s = String(content == null ? '' : content);
  const parts = s.split('\n');
  return s.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * 门控包装:门控开 → CC `countLines`;门控关 → 裸 `split('\n').length`(逐字节回退
 * 两个 call-site 共同的历史 legacy)。call-site 在调用**前**保留自己的空内容 → 0 守卫。
 * @param {*} content
 * @param {object} [env]
 * @returns {number}
 */
function countLinesOr(content, env = process.env) {
  const s = String(content == null ? '' : content);
  if (!countLinesEnabled(env)) return s.split('\n').length; // legacy 裸口径
  return ccCountLines(s);
}

module.exports = { countLinesEnabled, ccCountLines, countLinesOr };
