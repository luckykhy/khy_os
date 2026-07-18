'use strict';

/**
 * naturalLanguageAliasGuard — 纯叶子:零 IO、确定性、fail-soft 的「保留自然语言短语」判定。
 *
 * 背景:命令别名表(aliases.js)把若干中文短语直接映射到命令(如 `我是谁 → whoami`)。多数
 * 别名是明确的**命令意图**(`登录 → login`、`退出登录 → logout`、`改密码 → passwd`),但极少
 * 数别名恰好是一句**完整的自然语言问句**——`我是谁` 既可理解为「查看登录信息」的命令,也可
 * 理解为用户想让 AI 回答的一句话。用户痛点:在对话框里输入「我是谁」,期望得到自然语言回答,
 * 却被别名劫持成 whoami 命令、弹出登录信息面板。
 *
 * 本叶子把这条边界代码化:只维护一个**保守的**保留短语白名单,`resolveAlias` 在门控开启时对
 * 命中的输入返回 null → 落到既有「未识别命令 → 转发 AI」路径(repl.js:5560)。命令入口不受损:
 * 拼音别名 `woshishui`、显式命令 `/whoami` / `whoami` 仍照常解析。
 *
 * 契约:零 IO、确定性、绝不抛;env 门控 KHY_NL_ALIAS_GUARD 默认开(仅 {0,false,off,no} 关)。
 * 门控关 → isReservedNaturalLanguagePhrase 恒 false → resolveAlias 逐字节回退历史行为。
 *
 * 保守原则:白名单只收「完整自然语言问句且命令意图弱」的短语。祈使式命令别名(登录/退出登录/
 * 改密码/守护…)语义明确,一律不进白名单,避免误伤真实命令入口。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_NL_ALIAS_GUARD 默认开,仅 {0,false,off,no} 关。env 由调用方注入以便测试。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_ALIAS_GUARD;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 保留自然语言短语白名单(规范化为小写 + trim 后的精确匹配集合)。
 * 刻意极小、极保守:只有 `我是谁` 这类「完整问句 + 命令意图弱」的短语。
 */
const RESERVED_NL_ALIAS_PHRASES = Object.freeze(['我是谁']);

const _RESERVED_SET = new Set(RESERVED_NL_ALIAS_PHRASES.map((p) => p.toLowerCase()));

/**
 * 判断输入是否为应转发给 AI 的保留自然语言短语。
 * @param {string} input 原始命令 token / 整行输入
 * @param {object} [env] 注入的环境变量(默认 process.env)
 * @returns {boolean} 门控开且精确命中白名单 → true;否则 false(含任何异常)
 */
function isReservedNaturalLanguagePhrase(input, env = process.env) {
  try {
    if (!isEnabled(env)) return false;
    if (typeof input !== 'string') return false;
    const key = input.trim().toLowerCase();
    if (!key) return false;
    return _RESERVED_SET.has(key);
  } catch {
    return false;
  }
}

module.exports = {
  isEnabled,
  RESERVED_NL_ALIAS_PHRASES,
  isReservedNaturalLanguagePhrase,
};
