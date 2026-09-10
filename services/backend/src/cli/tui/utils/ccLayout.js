'use strict';

/**
 * ccLayout.js —— 布局计算（绝对值 + 相对值混合）
 *
 * 参考：[DESIGN-ARCH-081] 绝对值 vs 相对值设置
 */

// ── 绝对值常量 ──────────────────────────────────────────────────────────────

const ABSOLUTE = Object.freeze({
  statusBarHeight: 1,       // 状态栏高度：绝对 1 行
  inputMinHeight: 1,        // 输入框最小高度：绝对 1 行
  toolParamIndent: 2,       // 工具参数缩进：绝对 2 空格
  borderWidth: 1,           // 分割线宽度：绝对 1 字符
  tabIndent: 2,             // Tab 缩进：绝对 2 空格
  messagePaddingX: 0,       // 消息内边距：CC 模式无
});

// ── 边框字符（绝对精确） ────────────────────────────────────────────────────

const BOX_CHARS = Object.freeze({
  horizontal: '─',
  vertical: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  leftT: '├',
  rightT: '┤',
  topT: '┬',
  bottomT: '┴',
  cross: '┼',
  // 简化圆角
  roundTopLeft: '╭',
  roundTopRight: '╮',
  roundBottomLeft: '╯',
  roundBottomRight: '╰',
});

// ── 状态栏分隔符 ────────────────────────────────────────────────────────────

const STATUS_SEPARATOR = ' │ '; // U+2502 + 两侧空格

// ── 布局计算函数 ────────────────────────────────────────────────────────────

/**
 * 计算右侧看板宽度
 * @param {number} cols - 终端列数
 * @returns {number}
 */
function sidebarWidth(cols) {
  return Math.min(30, Math.floor(cols * 0.25));
}

/**
 * 计算主内容区宽度
 * @param {number} cols - 终端列数
 * @param {number} sidebarW - 看板宽度（0 表示看板隐藏）
 * @returns {number}
 */
function mainContentWidth(cols, sidebarW = 0) {
  return cols - sidebarW;
}

/**
 * 计算消息区域高度
 * @param {number} rows - 终端行数
 * @param {number} inputHeight - 输入框高度
 * @returns {number}
 */
function messageAreaHeight(rows, inputHeight = 1) {
  return rows - ABSOLUTE.statusBarHeight - inputHeight;
}

/**
 * 计算输入框最大高度
 * @param {number} rows - 终端行数
 * @returns {number}
 */
function inputMaxHeight(rows) {
  return Math.min(10, Math.floor(rows * 0.3));
}

/**
 * 计算补全菜单最大高度
 * @param {number} rows - 终端行数
 * @returns {number}
 */
function completionMaxHeight(rows) {
  return Math.min(15, Math.floor(rows * 0.4));
}

/**
 * 计算帮助菜单宽度
 * @param {number} cols - 终端列数
 * @returns {number}
 */
function helpMenuWidth(cols) {
  return Math.min(80, Math.floor(cols * 0.8));
}

/**
 * 计算工具名显示宽度
 * @param {number} cols - 终端列数
 * @returns {number}
 */
function toolNameWidth(cols) {
  return Math.max(10, Math.min(20, Math.floor(cols * 0.15)));
}

/**
 * 判断是否应显示右侧看板（终端宽度 >= 120 列）
 * @param {number} cols - 终端列数
 * @returns {boolean}
 */
function shouldShowSidebar(cols) {
  return cols >= 120;
}

/**
 * 获取完整布局参数
 */
function getLayout(cols, rows) {
  const sbWidth = shouldShowSidebar(cols) ? sidebarWidth(cols) : 0;
  return {
    cols,
    rows,
    sidebarWidth: sbWidth,
    mainWidth: mainContentWidth(cols, sbWidth),
    messageHeight: messageAreaHeight(rows),
    inputMaxHeight: inputMaxHeight(rows),
    completionMaxHeight: completionMaxHeight(rows),
    helpMenuWidth: helpMenuWidth(cols),
    toolNameWidth: toolNameWidth(cols),
    statusBarHeight: ABSOLUTE.statusBarHeight,
    showSidebar: sbWidth > 0,
  };
}

module.exports = {
  ABSOLUTE,
  BOX_CHARS,
  STATUS_SEPARATOR,
  sidebarWidth,
  mainContentWidth,
  messageAreaHeight,
  inputMaxHeight,
  completionMaxHeight,
  helpMenuWidth,
  toolNameWidth,
  shouldShowSidebar,
  getLayout,
};
