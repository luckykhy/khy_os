'use strict';

/**
 * softWrap.js — 软换行模式：不插入硬换行符，让终端原生处理换行。
 *
 * 背景（[DESIGN-ARCH-079] §11，GitHub 调研 vadimdemedes/ink#883）：
 *   Ink 使用 wrap-ansi 在终端宽度处插入字面 `\n`（硬换行），终端将 `\n` 视为
 *   硬换行符。用户选中复制时，这些 `\n` 会被一并带走——粘贴长命令/段落时
 *   换行符破坏结构（shell 命令被拆成多行无法执行）。
 *
 *   正确行为（对齐 opencode）：全宽文本块（流式输出、已提交消息）输出时**不插入**
 *   `\n`，让终端的 DECAWM（自动换行）处理视觉换行。选中复制时终端会把视觉软换行
 *   合并为单行，粘贴得到干净的原始文本。
 *
 * 门控：KHY_SOFT_WRAP（默认 off，渐进式启用）。
 *   - off（默认）：所有行为与改动前逐字节一致，向后兼容。
 *   - on：全宽纯文本段落（非表格/边框/代码块）不插入硬换行。
 *
 * 设计原则（[DESIGN-ARCH-079] §11.9 Phase 1）：
 *   - 只用于「全宽文本块」——StreamingBlock 流式输出、Transcript 已提交消息、
 *     ChatColumn 聊天区内容。
 *   - 表格、边框、代码块等需要精确布局的组件**不使用**软换行（仍硬换行）。
 *   - 软换行不改变文本内容本身（保留原始 `\n` 段落分隔），只改变「是否由应用层
 *     预折成多行」——让终端决定视觉换行点。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 判断 KHY_SOFT_WRAP 是否启用。
 * 默认 off（渐进式）：只有显式 1/on/true/yes 才开。
 * @param {object} [env] - 门控环境（测试注入，默认 process.env）
 * @returns {boolean}
 */
function isSoftWrapEnabled(env) {
  try {
    const e = env || process.env;
    const raw = e.KHY_SOFT_WRAP;
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

/**
 * 软换行：对于全宽文本块，保留原始文本（含段落 `\n`），不预折行。
 * 终端的 DECAWM 会在视觉宽度处自动换行；复制时合并为原始文本。
 *
 * 与硬换行的差异：
 *   硬换行：wrapAnsi(text, width, {hard:true}) → 每行独立 `\n`，复制破坏粘贴
 *   软换行：直接返回 text → 终端软折行，复制保留完整文本
 *
 * @param {string} text - 全宽文本块内容
 * @param {number} [width] - 目标宽度（软换行模式下不使用，仅为接口一致保留）
 * @param {object} [env] - 门控环境（测试注入）
 * @returns {string} 软换行启用 → 原样返回；否则 → 原样返回（调用方决定是否硬折）
 */
function softWrapText(text, width, env) {
  const s = String(text == null ? '' : text);
  if (!isSoftWrapEnabled(env)) {
    return s; // 门控 off：调用方维持既有硬换行路径
  }
  // 软换行启用：保留原始 `\n`（段落/代码块分隔），不插入额外折行。
  // 终端 DECAWM 处理视觉换行；复制粘贴得到干净文本。
  return s;
}

module.exports = {
  isSoftWrapEnabled,
  softWrapText,
};
