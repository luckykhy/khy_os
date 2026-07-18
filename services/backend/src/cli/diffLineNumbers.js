'use strict';

/**
 * diffLineNumbers — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「khy 做事像 Claude Code 一样结构化」):给**命令/`git diff` 输出**的
 * ±diff 行补上 CC 那样的**行号 gutter**(参考 Image#2:每行左侧 27/28… + 绿/红底)。
 * Khy 的写改 diff(renderDiffRows + computeStructuredDiffHunks)早已带行号,唯独
 * shell/unified-diff 路径(buildShellDiffRows)无行号——本叶子只补两块纯逻辑:
 *   1) 门控判定;
 *   2) 解析 unified-diff 的 `@@ -a,b +c,d @@` hunk 头,取出 old/new 起始行号。
 * 真正给每行赋 num 的循环留在 buildShellDiffRows(它本就是 unified-diff 解析器);
 * 渲染仍由既有 renderDiffRows 完成(它早已支持 `num` 字段,无须改)。
 *
 * 行号约定与写改 diff 单一真源一致(computeStructuredDiffHunks):
 *   del → 旧文件行号、add → 新文件行号、ctx → 新文件行号(单 gutter,各显其文件行号)。
 *
 * 门控:KHY_DIFF_LINE_NUMBERS(默认开)。=0/false/off/no → 关 → buildShellDiffRows
 * 不赋 num → 与改动前逐字节等价(renderDiffRows 对无 num 行显示 4 空格 gutter)。
 */

function diffLineNumbersEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_LINE_NUMBERS) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 解析 unified-diff hunk 头 `@@ -oldStart[,oldLen] +newStart[,newLen] @@ [ctx]`。
 * @param {string} line
 * @returns {{oldStart:number,newStart:number}|null}  非 hunk 头 / 解析失败 → null
 */
function parseUnifiedHunkHeader(line) {
  try {
    if (typeof line !== 'string') return null;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (!m) return null;
    const oldStart = parseInt(m[1], 10);
    const newStart = parseInt(m[2], 10);
    if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;
    return { oldStart, newStart };
  } catch {
    return null;
  }
}

module.exports = {
  diffLineNumbersEnabled,
  parseUnifiedHunkHeader,
};
