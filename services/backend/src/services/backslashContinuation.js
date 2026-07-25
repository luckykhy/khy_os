'use strict';

/**
 * backslashContinuation.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 对齐 Claude Code 的「反斜杠续行」:在提示输入框里,Enter 前紧邻一个 `\` 表示续行 ——
 * 应删掉那个反斜杠、插入换行,而不是提交。khy 的 Ink TUI 此前只识别 Shift/Alt/Ctrl+Enter
 * 与 paste-guard 窗口作为换行,裸的尾部 `\` + Enter 会直接提交。本叶子补齐这条判定。
 *
 * 转义细节(与 shell 续行一致):被再前一个反斜杠转义的反斜杠不算续行标记 ——
 * 尾部反斜杠的连续个数为**奇数**才是续行(最后一个 `\` 未被转义);偶数个(如 `\\`)是
 * 字面反斜杠,应正常提交。
 *
 * 门控:KHY_BACKSLASH_NEWLINE(default-on;0/false/off/no 关闭 → shouldContinue 恒 false,
 * 逐字节回退历史「尾部 \ 直接提交」行为)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 反斜杠续行是否启用。默认开;仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_BACKSLASH_NEWLINE;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return true;
  }
}

/**
 * 光标位于 offset 处、即将响应 Enter 时,前一个字符是否为「未转义的续行反斜杠」。
 *
 * @param {string} text   当前缓冲全文
 * @param {number} offset 光标偏移(0..text.length)
 * @param {object} [env]
 * @returns {boolean} 门开、且 text[offset-1] 是奇数个连续尾部反斜杠中的最后一个 → true。
 */
function shouldContinue(text, offset, env = process.env) {
  try {
    if (!isEnabled(env)) return false;
    if (typeof text !== 'string') return false;
    const n = typeof offset === 'number' ? offset : text.length;
    if (!(n > 0) || n > text.length) return false;
    if (text.charAt(n - 1) !== '\\') return false;
    // 数光标前连续反斜杠个数:奇数 → 最后一个未被转义 = 续行。
    let count = 0;
    let i = n - 1;
    while (i >= 0 && text.charAt(i) === '\\') { count += 1; i -= 1; }
    return (count % 2) === 1;
  } catch {
    return false;
  }
}

module.exports = {
  isEnabled,
  shouldContinue,
  OFF_VALUES,
};
