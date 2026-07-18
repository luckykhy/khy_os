'use strict';

/**
 * toolParamPath — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 承 Goal(Thread 4)「不只显示对齐,更要 CC 显示背后的**后端逻辑**对齐」。
 * 这一刀对齐的不是 `src/utils/format.ts`(数→串),而是 CC 的 `src/utils/truncate.ts`
 * 里的 **truncatePathMiddle**——工具头行里那条文件路径在放不下时**怎么截**。
 *
 * 真缺口(对照后):TUI `ToolLines.summarizeArgs` 对 read/write/edit 的 `file_path`
 * 用通用 `truncate(s, 60)` = **末尾截断**(`s.slice(0, 59) + '…'`)。深层路径
 *   services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js
 * 会被截成
 *   services/backend/src/cli/tui/ink-components/deeply/nested/MyC…
 * ——**把最关键的文件名截没了**。CC 的 truncatePathMiddle 正是为消灭这个失败:
 * 保留目录前缀**和**文件名,从中间塞 `…`:
 *   services/backend/src/cli/tui/ink-comp…/MyComponent.test.js
 *
 * CC 源(/tmp/cc-src/.../truncate.ts:16-55)分支结构逐句移植。
 *
 * ── 宽度度量(刀80 精化)──────────────────────────────────────────────
 * CC 用 ink 的 `stringWidth`(终端**列宽**,CJK/emoji 双宽)度量预算。本叶子初版
 * 曾降级为**字符数**(code unit `.length`)并把宽度精确度标为「后续可选精化」,当时
 * 的理由是「stringWidth 来自 ink 包、叶子契约要求零依赖」。**该理由现已过时**:khy
 * 自带零依赖 ink 的显示宽度 SSOT `cli/formatters.js::displayWidth`(ASCII 快路径返回
 * `.length`,非 ASCII 走 string-width + 手写东亚宽度回退表),姊妹 `cli/diffRenderer.js`
 * 早已复用它。用**字符数**度量在中文 CLI 下是一个真 bug:一条 40 个汉字的路径
 * 列宽 80 却 `.length===40`,`> 60` 判否 → **永不截断 → 撑破工具头行**;即便截,
 * `.slice(0, N)` 也按 code unit 切、切在错误的列位。
 *
 * 故本刀把预算度量**全程**改为显示宽度(度量 + 两处 fit 判断 + 目录/首/尾三处切分),
 * 经相对 require `./formatters`(叶子→叶子,契约放行)取 `displayWidth`。切分改为**按
 * 显示宽度累加逐码点**推进(surrogate pair 永不被腰斩 → 不产生乱码半字符),而非 code
 * unit `.slice()`。
 *
 * 子门控 KHY_TOOL_PATH_WIDTH(默认开)**只控度量**:
 *   - 开 且 displayWidth 可用 → 显示宽度策略(修 CJK 撑破);
 *   - 关 / displayWidth require 失败 → **原封不动的 code-unit 策略**(`.length`/`.slice`),
 *     与本刀之前逐字节一致。
 * 纯 ASCII 路径:displayWidth 走快路径返回 `.length`、逐点宽度恒 1、切分与 `.slice`
 * 同结果 → **两态字节一致**,不受本刀影响;发散只出现在含 CJK/宽字符的路径(即缺口本身)。
 *
 * **诚实边界(刻意降级)**:逐**码点**对齐(surrogate pair 不被腰斩),但**未做完整
 * grapheme-cluster 分段**(ZWJ 连字 / 区域指示符旗帜等多码点 emoji 序列);此类序列的
 * 每个码点被单独度量,罕见时列数可能差一格。路径绝大多数是 ASCII/CJK/单码点字符,该处
 * 皆精确;多码点 emoji 出现在**文件路径**里属极端情形,留作后续可选精化。
 *
 * 中间截断门控:KHY_TOOL_PATH_MIDDLE_TRUNCATE(默认开)。=0/false/off/no → 关 →
 * 调用方逐字节回退旧末尾截断,与改动前等价。另:CC 只认 `/`,本叶子同时认 `\\`
 * (Khy 支持 Windows,路径可能是反斜杠)——找最后一个分隔符时两者都算,保留实际分隔符做显示。
 *
 * `formatToolHeaderPath`(见文件末)组合姊妹纯叶子 `ccRelativePath`(相对 require,
 * 叶子→叶子,叶子契约放行)+ 本模块的 `truncatePathMiddle`,把 TUI `ToolLines` 早已
 * 内联的「先相对化到 cwd、再中间截断保文件名」两步收敛成单一真源,供**经典(非 Ink)
 * REPL** 的两个孤儿渲染点(`toolDisplay._formatToolParams` 显裸绝对路径、
 * `displayFormatters.toolProgressStart` 相对化了但不中间截断)复用,消除跨渲染器不一致。
 */

const ELLIPSIS = '…'; // '…'

function pathMiddleTruncateEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_PATH_MIDDLE_TRUNCATE) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// Width-metric sub-gate: when off, the leaf uses the original code-unit budget
// (byte-identical to the pre-刀80 behaviour). Default on.
function pathWidthAwareEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_PATH_WIDTH) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// Longest PREFIX of s (whole code points) whose display width <= budget.
// Iterates by code point (for…of) so surrogate pairs are never bisected.
function _prefixByWidth(s, budget, dw) {
  s = String(s);
  if (budget <= 0) return '';
  let acc = 0;
  let out = '';
  for (const ch of s) {
    const cw = dw(ch);
    if (acc + cw > budget) break;
    acc += cw;
    out += ch;
  }
  return out;
}

// Longest SUFFIX of s (whole code points) whose display width <= budget.
function _suffixByWidth(s, budget, dw) {
  s = String(s);
  if (budget <= 0) return '';
  const cps = Array.from(s); // code points, not UTF-16 units
  let acc = 0;
  let out = '';
  for (let i = cps.length - 1; i >= 0; i--) {
    const cw = dw(cps[i]);
    if (acc + cw > budget) break;
    acc += cw;
    out = cps[i] + out;
  }
  return out;
}

/**
 * Resolve the budget-measurement strategy for this env.
 *   - width-gate ON + displayWidth importable → display-width strategy;
 *   - otherwise → legacy code-unit strategy (`.length` / `.slice`), byte-identical
 *     to the pre-刀80 implementation.
 * fail-soft: any require/typeof miss falls through to the legacy strategy.
 */
function _strategy(env) {
  if (pathWidthAwareEnabled(env)) {
    try {
      const dw = require('./formatters').displayWidth;
      if (typeof dw === 'function') {
        const w = (s) => dw(String(s));
        return {
          width: w,
          prefix: (s, budget) => _prefixByWidth(s, budget, w),
          suffix: (s, budget) => _suffixByWidth(s, budget, w),
        };
      }
    } catch { /* fall through to legacy code-unit strategy */ }
  }
  // Legacy strategy — the exact `.length` / `.slice` shapes the leaf used before.
  return {
    width: (s) => String(s).length,
    prefix: (s, budget) => String(s).slice(0, budget),
    suffix: (s, budget) => {
      s = String(s);
      return s.slice(s.length - budget);
    },
  };
}

// End-truncate to a display-width budget, appending '…' (mirrors CC
// truncateToWidth's shape: keep budget-1 of width + ellipsis).
function _truncateEnd(s, maxLen, st) {
  s = String(s);
  if (st.width(s) <= maxLen) return s;
  if (maxLen <= 1) return ELLIPSIS;
  return st.prefix(s, maxLen - 1) + ELLIPSIS;
}

// Start-truncate to a display-width budget, prepending '…' (mirrors CC
// truncateStartToWidth).
function _truncateStart(s, maxLen, st) {
  s = String(s);
  if (st.width(s) <= maxLen) return s;
  if (maxLen <= 1) return ELLIPSIS;
  return ELLIPSIS + st.suffix(s, maxLen - 1);
}

/**
 * Middle-truncate a path so the basename survives. Faithful port of CC
 * truncate.ts `truncatePathMiddle`, measured by display width (see header note).
 *
 * @param {string} pathStr
 * @param {number} maxLen  Maximum display width of the result (must be > 0 to keep
 *   meaningful content; <=0 yields just the ellipsis, per CC).
 * @param {object} [env]   Selects the width strategy (KHY_TOOL_PATH_WIDTH).
 * @returns {string} The middle-truncated path, or the original if it fits.
 */
function truncatePathMiddle(pathStr, maxLen, env = process.env) {
  const p = String(pathStr == null ? '' : pathStr);
  const max = Number(maxLen);
  if (!Number.isFinite(max)) return p;

  const st = _strategy(env);

  // No truncation needed.
  if (st.width(p) <= max) return p;

  // Edge case: non-positive budget.
  if (max <= 0) return ELLIPSIS;

  // Need room for "…" + something meaningful — fall back to end-truncate.
  if (max < 5) return _truncateEnd(p, max, st);

  // Find the last path separator ('/' or '\\' — Khy supports Windows paths). A
  // separator is always a single BMP unit, so slicing at it never splits a pair.
  const lastSlash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  // Include the leading separator in the filename for display (CC behaviour).
  const filename = lastSlash >= 0 ? p.slice(lastSlash) : p;
  const directory = lastSlash >= 0 ? p.slice(0, lastSlash) : '';
  const filenameLen = st.width(filename);

  // If the filename alone is (nearly) the whole budget, truncate from the start.
  if (filenameLen >= max - 1) return _truncateStart(p, max, st);

  // Space left for the directory prefix. Result: directory + "…" + filename.
  const availableForDir = max - 1 - filenameLen; // -1 for the ellipsis
  if (availableForDir <= 0) return _truncateStart(filename, max, st);

  // Truncate the directory (no ellipsis — the middle '…' is the separator).
  const truncatedDir = st.prefix(directory, availableForDir);
  return truncatedDir + ELLIPSIS + filename;
}

module.exports = {
  pathMiddleTruncateEnabled,
  pathWidthAwareEnabled,
  truncatePathMiddle,
  formatToolHeaderPath,
};

/**
 * 工具头行 file_path 的**统一展示口径**:先相对化到 cwd(CC toRelativePath,
 * 姊妹叶子 ccRelativePath;门控 KHY_TOOL_RELATIVE_PATH),再在超出预算时中间截断
 * 保住文件名(本模块 truncatePathMiddle;门控 KHY_TOOL_PATH_MIDDLE_TRUNCATE)。
 * 两步门控**各自独立**:
 *   - 两门控都关 → 原样返回 raw(逐字节回退历史裸路径,绝不相对化 / 不截断);
 *   - 仅相对化开 → 返回相对路径(与 displayFormatters 既有相对化行为一致);
 *   - 仅中间截断开 → 对原路径按预算中间截断;
 *   - 都开 → 相对化 + 中间截断(与 TUI ToolLines 一致)。
 * 相对 require 姊妹叶子(叶子→叶子,契约放行);任何异常 → 回退 raw(绝不抛)。
 *
 * @param {string} rawPath
 * @param {string} [cwd]
 * @param {object} [env]
 * @param {number} [maxLen=60]  与 TUI ToolLines 同预算。
 * @returns {string}
 */
function formatToolHeaderPath(rawPath, cwd = process.cwd(), env = process.env, maxLen = 60) {
  const raw0 = String(rawPath == null ? '' : rawPath);
  if (!raw0) return raw0;
  let rel;
  try {
    rel = require('./ccRelativePath').relativizeToolPath(raw0, cwd, env);
  } catch {
    rel = raw0;
  }
  if (!pathMiddleTruncateEnabled(env)) return rel;
  // 与 ToolLines 一致:归一空白后交给 truncatePathMiddle。它内部按显示宽度判断
  // 「放得下就原样返回」,故这里无需再自行做 fit 判断(旧版的 `norm.length > maxLen`
  // 是 code-unit 判断,对 CJK 会误判「放得下」而漏截;收敛进 truncatePathMiddle 后
  // fit 判断也是显示宽度口径。门控关时策略退化为 code-unit → 逐字节回退)。
  const norm = String(rel).replace(/\s+/g, ' ').trim();
  return truncatePathMiddle(norm, maxLen, env);
}
