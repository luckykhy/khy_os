'use strict';

/**
 * ccRelativePath —— 对齐 Claude Code `src/utils/path.ts` `toRelativePath` 的
 * 「后端逻辑」,而不只是表面外观。
 *
 * CC 的关键后端逻辑:在工具输出 / 权限框 / 拒绝消息里展示文件路径时,先把绝对路径
 * **相对化到 cwd**(省 token、更易读),但若相对路径会跳出 cwd(以 `..` 开头)则
 * 保留绝对路径以免歧义。CC 原文(src/utils/path.ts:120):
 *     export function toRelativePath(absolutePath) {
 *       const relativePath = relative(getCwd(), absolutePath)
 *       // If the relative path would go outside cwd (starts with ..), keep absolute
 *       return relativePath.startsWith('..') ? absolutePath : relativePath
 *     }
 * 这条 relative-to-cwd 约定在 CC 各处展示路径时统一使用:FileEdit / FileWrite /
 * Read 权限框 subtitle、编辑拒绝消息、诊断面板、Ultraplan 等都是
 * `verbose ? absolutePath : relative(getCwd(), path)`。
 *
 * Khy 历史真缺口:TUI `ToolLines.summarizeArgs` 与经典 REPL
 * `displayFormatters.toolProgressStart` 展示 read/write/edit 的 file_path 时,
 * 显示**完整绝对路径**(仅在 >60 列时中间截断保文件名,truncatePathMiddle),
 * 从不相对化 → 一条工具头行被 `/home/kodehu03/Khy-OS/...` 长前缀占满,既费列宽
 * 又难读,与 CC 不一致。本叶子收敛成单一真源:
 *   - `toRelativePath(absolutePath, cwd)` —— CC 逐字节移植(供对齐 / 测试);
 *   - `relativizeToolPath(absolutePath, cwd?, env?)` —— Khy 路由用的门控封装:
 *       门控关 → 原样返回(逐字节回退历史绝对路径展示);
 *       门控开 → 相对化(非绝对 / cwd 外 / 出错 / 空结果 → 安全回退原值)。
 *
 * 纯叶子:仅依赖 node `path`(纯字符串、确定性、无 IO);绝不抛。
 */
const path = require('path');

const FALSY = new Set(['0', 'false', 'off', 'no']);

// 门控 KHY_TOOL_RELATIVE_PATH 默认开;标准 falsy 串(0/false/off/no,大小写/空白不敏感)关。
function relativeToolPathEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_RELATIVE_PATH) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

/**
 * CC `toRelativePath` 的逐字节移植。
 *   - 非绝对路径输入:原样返回(已是相对,无 cwd 可减)。
 *   - 绝对路径:`path.relative(cwd, abs)`;结果以 `..` 开头(会跳出 cwd)→ 保留绝对。
 * 防呆:abs/cwd 缺失或 `path.relative` 抛 → 返回 abs(绝不抛)。
 */
function toRelativePath(absolutePath, cwd) {
  const abs = String(absolutePath == null ? '' : absolutePath);
  const base = String(cwd == null ? '' : cwd);
  if (!abs || !base) return abs;
  if (!path.isAbsolute(abs)) return abs;
  let rel;
  try { rel = path.relative(base, abs); } catch { return abs; }
  return rel.startsWith('..') ? abs : rel;
}

/**
 * Khy 路由用的门控封装。
 *   - 门控关 → 原样返回 input(逐字节回退历史绝对路径展示)。
 *   - 门控开 → toRelativePath;若相对化结果为空串(路径恰 === cwd 本身,CC 字面
 *     会返回空)→ 回退原绝对路径,避免展示空路径(刻意偏离 CC 字面的边角行为,
 *     仅影响 path===cwd 这一对「文件路径」无意义的边角)。
 */
function relativizeToolPath(absolutePath, cwd = process.cwd(), env = process.env) {
  if (!relativeToolPathEnabled(env)) return absolutePath;
  const rel = toRelativePath(absolutePath, cwd);
  if (rel === '') return String(absolutePath == null ? '' : absolutePath);
  return rel;
}

module.exports = { relativeToolPathEnabled, toRelativePath, relativizeToolPath };
