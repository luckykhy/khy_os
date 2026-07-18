'use strict';

/**
 * gitCoAuthorTrailer.js — 纯叶子:提交信息 `Co-Authored-By` 尾注的单一真源。
 *
 * 背景:khyos 用 gitCommit 提交时,提交信息末尾从不追加 AI 协作者尾注(全仓 0 处),
 * 与 Claude Code 的 `Co-Authored-By:` 约定存在差异。用户拍板:加,且默认开启。本叶子
 * 把「尾注文案 + 幂等追加」收敛为唯一真源。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。
 * 逃生阀 `KHY_GIT_COAUTHOR_TRAILER`(默认 on)。**关闭即原样返回**(逐字节,不加尾注)。
 * 覆盖:env `KHY_GIT_COAUTHOR_TRAILER_LINE` 可整行覆盖默认尾注(非法/空 → 回默认)。
 */

const _FALSY = ['0', 'false', 'off', 'no'];

/** 门控:仅当显式置为 0/false/off/no 时关闭,其余(含未设)均开启。 */
function isEnabled(env) {
  const raw = String((env || process.env).KHY_GIT_COAUTHOR_TRAILER || 'on')
    .trim().toLowerCase();
  return !_FALSY.includes(raw);
}

// 默认尾注行。email 用不可路由占位,仅作 AI 协作者标注,不映射真实账号。
const DEFAULT_TRAILER = 'Co-Authored-By: khy <noreply@khy-os.local>';

// 一个合法 `Co-Authored-By:` 尾注行须形如 `Co-Authored-By: Name <email>`。
const TRAILER_LINE_RE = /^Co-Authored-By:\s*.+<.+>\s*$/i;
// 检测正文中是否已存在任意 Co-Authored-By 行(幂等判定)。
const HAS_TRAILER_RE = /^Co-Authored-By:/im;

/** 解析要用的尾注行:env 覆盖(须是合法尾注行)优先,否则默认。 */
function resolveTrailerLine(env) {
  try {
    const override = String((env || process.env).KHY_GIT_COAUTHOR_TRAILER_LINE || '').trim();
    if (override && TRAILER_LINE_RE.test(override)) return override;
  } catch { /* 回默认 */ }
  return DEFAULT_TRAILER;
}

/**
 * 幂等地把 Co-Authored-By 尾注追加到提交信息末尾。
 *  - 门关 → 原样返回(逐字节)。
 *  - message 已含 Co-Authored-By 行 → 原样返回(不重复)。
 *  - 否则在正文后以恰一个空行分隔,追加尾注行。
 * 绝不抛;任何异常 / 非字符串 message → 原样返回入参。
 *
 * @param {string} message
 * @param {object} [env]
 * @returns {string}
 */
function appendCoAuthorTrailer(message, env) {
  try {
    if (typeof message !== 'string') return message;
    if (!isEnabled(env)) return message;
    if (HAS_TRAILER_RE.test(message)) return message;
    const trailer = resolveTrailerLine(env);
    // 去掉正文尾部空白,再以「空行 + 尾注」拼接,保证正文与尾注块间恰一空行。
    const body = message.replace(/\s+$/, '');
    if (!body) return message; // 空正文不塑形,交由上层处理
    return `${body}\n\n${trailer}`;
  } catch {
    return message;
  }
}

module.exports = {
  isEnabled,
  appendCoAuthorTrailer,
  resolveTrailerLine,
  // 暴露常量便于测试断言。
  DEFAULT_TRAILER,
};
