'use strict';

/**
 * unknownCommandHint.js — 纯叶子:当用户**显式用了命令语法**(`/x`)却没有任何命令/技能/插件
 * 匹配时,生成一条 TUI 安全(非交互)的「未知命令 + 你是不是想执行…」提示。
 *
 * 定位(GOAL「教会 khyos 怎么处理用户的未知指令或者未知问题」):
 *   router.js 的 default 分支在把无法识别的输入交给 AI 之前(`return false`),已有一层
 *   G1/G2 交互式模糊纠错(inquirer 确认「你是否想执行 X?」),但它被 `&& !isTui` 门住——
 *   **在正常的 TUI/REPL 交互里整块被跳过**(inquirer 与 alternate screen 冲突)。结果:用户
 *   显式敲了 `/deploy`(命令语法)却没有任何命令匹配时,literal `/deploy` 被**静默转发给 AI**
 *   当作聊天,用户得不到「这是个未知命令」的任何反馈,AI 也只能困惑地复述。
 *
 * 本叶子补一条**非交互、两种模式都安全**的提示,由 router 在 `return false` 之前打印,再照常
 * fall through 给 AI(不阻断 AI 兜底)。
 *
 * 关键取舍——只对「显式命令语法」发声:
 *   • `/x` 开头 = 用户明确用了命令调用语法 → 未匹配时值得提示「未知命令」并给出近似候选。
 *   • 裸词 / 自然语言问句(无 `/`)→ **返回 null**,不打断、不数落:它们本就是合法的「未知问题」,
 *     应无声交给 AI 作答。这正是「未知指令」与「未知问题」的分界:前者给命令向导,后者交 AI。
 *
 * 契约:零 IO(只读 env 做门控)、确定性、绝不抛(异常/非法输入 → null,router 侧照常 fall through)。
 */

// ── 门控(KHY_UNKNOWN_COMMAND_HINT,default-on,CANON off:4 词)────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 是否启用。flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_UNKNOWN_COMMAND_HINT', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_UNKNOWN_COMMAND_HINT;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * rawToken 是否是「显式斜杠命令」:以 `/` 开头且其后至少有一个非空白、非 `/` 字符。
 * 纯 `/`、`//`、`/ ` 之类不算(避免把无意义输入当命令数落)。
 * @param {string} rawToken
 * @returns {boolean}
 */
function isExplicitSlashCommand(rawToken) {
  if (typeof rawToken !== 'string') return false;
  return /^\/[^\s/]/.test(rawToken.trim());
}

/**
 * 把 `_findClosestCommands` 的候选({label, dist})格式化成带斜杠的引用串(最多取 2 个)。
 * 用户敲的是 `/x`,候选显示成 `/label` 与之呼应。
 * @param {Array<{label:string}>} suggestions
 * @returns {string} 例:`"/cost"` 或 `"/cost" 或 "/clear"`;无候选 → ''
 */
function _formatSuggestions(suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return '';
  const labels = [];
  for (const s of suggestions) {
    const label = s && typeof s.label === 'string' ? s.label.trim() : '';
    if (!label) continue;
    const withSlash = label.startsWith('/') ? label : `/${label}`;
    labels.push(`"${withSlash}"`);
    if (labels.length >= 2) break;
  }
  return labels.join(' 或 ');
}

/**
 * 构造未知斜杠命令的提示串。仅对显式斜杠命令发声;否则返回 null。
 * @param {{ rawToken?: string, suggestions?: Array<{label:string, dist?:number}> }} input
 * @returns {string|null}
 */
function buildUnknownCommandHint(input) {
  try {
    const rawToken = input && typeof input.rawToken === 'string' ? input.rawToken.trim() : '';
    if (!isExplicitSlashCommand(rawToken)) return null;

    const suggestList = _formatSuggestions(input && input.suggestions);
    let msg = `未知命令 "${rawToken}"。`;
    if (suggestList) msg += `你是不是想执行 ${suggestList}?`;
    msg += '输入 `khy help` 查看全部命令;若这是想问我的问题,我会直接作答。';
    return msg;
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  isExplicitSlashCommand,
  buildUnknownCommandHint,
  _formatSuggestions,
  _FALSY,
};
