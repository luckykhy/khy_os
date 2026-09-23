'use strict';

/**
 * ghostBorder.js — 用 ANSI 光标定位绘制「幽灵边框」。
 *
 * 原理（[DESIGN-ARCH-079] §11.6，对齐 OpenCode 的复制行为）：
 *   边框字符通过 ESC[row;colH（CUP，光标定位）画到屏幕上，不占用内容的字符流。
 *   终端选中复制时只捕获「内容字符」（即 ink 正文输出的文本），不捕获光标定位
 *   叠加绘制的边框字符 —— 因为那些字符从未进入 stdout 的内容流，只是被单独
 *   寻址「画」在屏幕格子上。
 *
 * 与字符边框（chalk.dim('│')）的对比：
 *   字符边框：│ 是内容流的一部分，用户选中整块时 │ 被一并复制，需手动删除。
 *   幽灵边框：│ 由 CUP 叠加绘制，内容流里没有 │，复制结果干净无框线。
 *
 * 门控：KHY_GHOST_BORDER（默认 off，渐进式启用）。
 *   - off（默认）：sidebarRail 维持现有 chalk 字符边框，逐字节向后兼容。
 *   - on：右栏看板边框改由 CUP 绘制（见 sidebarRail._border 的 ghost 分支）。
 *
 * 约束（[DESIGN-ARCH-079] §4 / 工程规则 4）：
 *   - 只用 CUP（ESC[row;colH）+ SGR（ESC[...m），**绝不用** DECSTBM（ESC[n;mr）
 *     滚动区 —— 那会杀死终端回滚（见 AGENTS.md 规则 4 红线）。
 *   - 每段 CUP 序列首尾包 ESC[ s / ESC[u（DECSC/DECRC，保存/恢复光标），
 *     保证叠加绘制后主光标位置不变，不干扰 ink 自身的帧渲染。
 *   - 纯叶子：零 IO、零 require 副作用（chalk 可选，缺省回退裸 SGR 字节），绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 判断 KHY_GHOST_BORDER 是否启用。
 * 默认 off（渐进式）：只有显式 1/on/true/yes 才开。
 * @param {object} [env] - 门控环境（测试注入，默认 process.env）
 * @returns {boolean}
 */
function isGhostBorderEnabled(env) {
  try {
    const e = env || process.env;
    const raw = e.KHY_GHOST_BORDER;
    if (raw === undefined || raw === null || raw === '') {
      return false; // 默认 off
    }
    const v = String(raw).trim().toLowerCase();
    if (OFF_VALUES.includes(v)) {
      return false;
    }
    return v === '1' || v === 'on' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

/** 单字符的 SGR 颜色段（dim gray，与字符边框视觉一致；缺 chalk 时用裸字节）。 */
function _dimGray(ch) {
  // chalk.dim(chalk.gray(ch)) 等价裸序列：\x1b[2m（dim）+ \x1b[90m（bright black ≈ gray）
  // 用 90（bright black）近似 gray，兼容性优于 30（true black）。
  return '\x1b[2;90m' + ch + '\x1b[0m';
}

/**
 * 单个幽灵字符：在 (row, col) 处画一个 ch，光标定位绘制，保存/恢复主光标。
 *
 * 序列结构：
 *   ESC[s          保存光标（DECSC）
 *   ESC[row;colH   定位到格子（CUP）
 *   <ch with SGR>  画字符 + 颜色
 *   ESC[u          恢复光标（DECRC）
 *
 * 全程不碰滚动区（无 ESC[n;mr），不擦除（无 ESC[2J），符合渲染安全红线。
 *
 * @param {number} row - 1-based 行号
 * @param {number} col - 1-based 列号
 * @param {string} ch  - 边框字符（默认 '│'）
 * @param {string} [color='dim'] - 颜色提示（当前实现统一 dim gray，接口保留供扩展）
 * @returns {string}
 */
function ghostChar(row, col, ch, color) {
  const r = Math.max(1, Math.floor(Number(row) || 1));
  const c = Math.max(1, Math.floor(Number(col) || 1));
  return '\x1b[s' + '\x1b[' + r + ';' + c + 'H' + _dimGray(ch) + '\x1b[u';
}

/**
 * 竖直幽灵边框：在固定 col 上，从 topRow 画到 bottomRow（含端点）。
 * @param {number} col - 1-based 列
 * @param {number} topRow - 1-based 顶行
 * @param {number} bottomRow - 1-based 底行
 * @param {string} [ch='│']
 * @param {string} [color='dim']
 * @returns {string}
 */
function ghostVerticalBorder(col, topRow, bottomRow, ch, color) {
  const c = Math.max(1, Math.floor(Number(col) || 1));
  let t = Math.max(1, Math.floor(Number(topRow) || 1));
  let b = Math.max(1, Math.floor(Number(bottomRow) || 1));
  if (b < t) {
    const tmp = t;
    t = b;
    b = tmp;
  }
  let out = '';
  for (let r = t; r <= b; r++) {
    out += ghostChar(r, c, ch, color);
  }
  return out;
}

/**
 * 水平幽灵边框：在固定 row 上，从 leftCol 画到 rightCol（含端点）。
 * @param {number} row - 1-based 行
 * @param {number} leftCol - 1-based 左列
 * @param {number} rightCol - 1-based 右列
 * @param {string} [ch='─']
 * @param {string} [color='dim']
 * @returns {string}
 */
function ghostHorizontalBorder(row, leftCol, rightCol, ch, color) {
  const r = Math.max(1, Math.floor(Number(row) || 1));
  let l = Math.max(1, Math.floor(Number(leftCol) || 1));
  let rr = Math.max(1, Math.floor(Number(rightCol) || 1));
  if (rr < l) {
    const tmp = l;
    l = rr;
    rr = tmp;
  }
  let out = '';
  for (let c = l; c <= rr; c++) {
    out += ghostChar(r, c, ch, color);
  }
  return out;
}

/**
 * 生成「一整列幽灵竖框 + 左右各一条短水平横线（顶/底封口）」的复合序列，
 * 供右栏看板（sidebarRail）在 KHY_GHOST_BORDER=1 时替代字符边框使用。
 * 返回可直接 append 到 ink 帧尾的字符串（零 IO，纯字节构造）。
 *
 * @param {{leftCol:number, topRow:number, bottomRow:number, topMark?:string, bottomMark?:string}} geom
 * @returns {string}
 */
function ghostBorderBlock(geom) {
  if (!geom) {
    return '';
  }
  const left = Math.max(1, Math.floor(Number(geom.leftCol) || 1));
  const top = Math.max(1, Math.floor(Number(geom.topRow) || 1));
  const bottom = Math.max(1, Math.floor(Number(geom.bottomRow) || 1));
  if (bottom < top) {
    return '';
  }
  // 竖线（不含顶/底封口），避免与横线端点重复画
  let out = '';
  for (let r = top; r <= bottom; r++) {
    out += ghostChar(r, left, geom.char || '│');
  }
  return out;
}

module.exports = {
  isGhostBorderEnabled,
  ghostChar,
  ghostVerticalBorder,
  ghostHorizontalBorder,
  ghostBorderBlock,
};
