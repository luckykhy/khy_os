'use strict';

/**
 * permissionFallback —— 纯叶子(pure leaf):权限被拒后「先尝试替代、最终诚实告知所需权限」
 * 的决策与文案单一真源。
 *
 * 契约:零 IO(不碰 fs/网络/子进程)、确定性、单一真源(拒绝后的决策/所需权限映射/文案
 * 只在本文件)、env 门控默认开(`KHY_PERMISSION_FALLBACK`,仅 0/false/off/no 关闭即字节
 * 回退「拒绝即停止」的既有行为)、fail-soft 绝不抛。
 *
 * 背景:既有行为是权限被拒 → `toolUseLoop` 立即早退「stopping」,模型连换个方法的机会都
 * 没有,且只回「User denied tool execution」不说清到底需要什么权限。本叶子提供三件事,
 * 由 `toolUseLoop` 在 deny 早退点调用:
 *   1) evaluateDeny(priorKeys, key)        —— 决定这次拒绝是「注入引导让模型尝试替代后继续」
 *                                             还是「已重复/超出尝试上限 → 诚实停止」。
 *   2) describeRequiredPermission(tool, r) —— 把被拒操作映射到**具体所需权限 + 授予方式**(单源)。
 *   3) buildDenyGuidance / buildExhaustedMessage —— 分别产「喂给模型的换方法引导」与「最终诚实
 *                                             告知用户需要什么权限」的中文文案。
 *
 * 不变量:本叶子**绝不**自行重试或放宽权限——它只产决策与文案;真正的「再给模型一轮」由调用方
 * 通过不早退、把 guidance 注入被拒结果的 hint 实现。重复发起同一被拒调用 → 立即判定停止
 * (避免反复弹框骚扰用户)。
 */

function _enabled() {
  const v = String(process.env.KHY_PERMISSION_FALLBACK || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// 允许模型尝试的「替代方法」最多几次(distinct 被拒调用数超过即停止并诚实告知)。
// 1 = 首次拒绝注入引导让模型换一种方法;若替代方法又被拒 → 停止。最多两次弹框。
const MAX_ALTERNATIVE_ATTEMPTS = 1;

/** 稳定参数签名(键排序后 JSON),用于识别「同一被拒调用」。fail-soft 返回 ''。 */
function paramSignature(params) {
  try {
    if (!params || typeof params !== 'object') return '';
    const keys = Object.keys(params).filter((k) => !k.startsWith('_')).sort();
    const flat = {};
    for (const k of keys) {
      const v = params[k];
      flat[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v;
    }
    return JSON.stringify(flat);
  } catch {
    return '';
  }
}

/** 由工具名 + 参数生成稳定 key,用于跨轮识别重复被拒调用。 */
function denyKey(toolName, params) {
  return `${String(toolName || 'unknown')}::${paramSignature(params)}`;
}

/**
 * 决定这次拒绝该「继续尝试替代」还是「诚实停止」。纯函数:只看历史 key 列表与本次 key。
 *
 * @param {string[]} priorKeys  本轮此前已被拒调用的 key 列表(调用方维护)
 * @param {string} key          本次被拒调用的 key
 * @returns {{stop:boolean, isRepeat:boolean, attempt:number}}
 *   stop=true → 调用方应停止并用 buildExhaustedMessage 诚实告知;
 *   stop=false → 调用方注入 buildDenyGuidance 到结果 hint 后**继续循环**让模型换方法。
 */
function evaluateDeny(priorKeys, key) {
  try {
    if (!_enabled()) return { stop: true, isRepeat: false, attempt: 0 };
    const prior = Array.isArray(priorKeys) ? priorKeys : [];
    const isRepeat = prior.includes(key);
    // 已尝试过的 distinct 替代次数(不含本次重复)。
    const distinctPrior = prior.filter((k, i) => prior.indexOf(k) === i).length;
    // 重复同一被拒调用 → 立即停止(别再弹框);否则超出尝试上限 → 停止。
    const stop = isRepeat || distinctPrior >= MAX_ALTERNATIVE_ATTEMPTS;
    return { stop, isRepeat, attempt: distinctPrior + (isRepeat ? 0 : 1) };
  } catch {
    return { stop: true, isRepeat: false, attempt: 0 }; // fail-soft:退回既有「拒绝即停」
  }
}

// 工具名关键词 → 权限类别(零启发式:按词命中,缺省泛化)。
const _TOOL_PERMISSION_RULES = [
  { re: /(write|edit|create|mkdir|append|save)/i, perm: '文件写入权限', how: '在权限框选择「允许本次」或「本会话内同类免审」;或确认该工具可写入当前工作区。' },
  { re: /(delete|remove|\brm\b|erase|unlink|rmdir)/i, perm: '文件删除权限', how: '在权限框选择「允许本次」(删除属高危,请确认目标无误后再授予)。' },
  { re: /(bash|shell|exec|command|\brun\b|spawn|process)/i, perm: '命令执行权限', how: '在权限框选择「允许本次」;高危命令需在 L2 框中输入确认词执行。' },
  { re: /(http|fetch|curl|web|network|download|request|url)/i, perm: '网络访问权限', how: '在权限框选择「允许本次」;或设置允许联网的相关开关。' },
  { re: /(desktop|screenshot|screen|click|type|mouse|keyboard|control)/i, perm: '桌面控制权限', how: '在权限框选择「允许本次」,并确保桌面控制已开启(KHY_DESKTOP_CONTROL=on)。' },
  { re: /(database|\bsql\b|query|\bdb\b)/i, perm: '数据库访问权限', how: '在权限框选择「允许本次」;并确认已配置数据库连接(KHY_DB_DIALECT / KHY_DB_URL)。' },
  { re: /(git|commit|push|merge)/i, perm: '版本库写入权限', how: '在权限框选择「允许本次」(提交/推送会改动版本库,请确认)。' },
];

/**
 * 把被拒操作映射到「完成它 khyos 必须拥有的具体权限 + 授予方式」(单一真源)。
 *
 * @param {string} toolName
 * @param {object} [denyResult]  被拒结果(可带 _gatewayBlocked/_capabilityFloorBlocked/
 *                               _hookBlocked/_planModeBlocked/_planReadOnlyBlocked 标记)
 * @returns {{permission:string, howToGrant:string}}
 */
function describeRequiredPermission(toolName, denyResult = {}) {
  try {
    const r = denyResult || {};
    if (r._planReadOnlyBlocked || r._planModeBlocked) {
      return { permission: '退出「计划模式」(计划模式下仅允许只读操作)', howToGrant: '先退出 plan/计划模式,再让我重试这一步。' };
    }
    if (r._hookBlocked) {
      return { permission: '通过 PreToolUse 钩子放行', howToGrant: '检查并调整本仓 PreToolUse 钩子策略,使该操作被允许。' };
    }
    if (r._capabilityFloorBlocked) {
      return { permission: '满足「能力地板」所要求的最低能力授权', howToGrant: '在权限/能力设置中为该操作授予所需的最低能力。' };
    }
    if (r._gatewayBlocked) {
      return { permission: '高危系统调用执行权限(syscall 网关 L2)', howToGrant: '重新运行并在权限框选择「确认执行此高危操作」并输入确认词;反复被拒会触发熔断,稍后再试。' };
    }
    // 普通用户拒绝:按工具名归类。
    const name = String(toolName || '');
    for (const rule of _TOOL_PERMISSION_RULES) {
      if (rule.re.test(name)) return { permission: rule.perm, howToGrant: rule.how };
    }
    return { permission: `执行「${name || '该操作'}」的授权`, howToGrant: '在权限框选择「允许本次」或「本会话内同类免审」。' };
  } catch {
    return { permission: '完成该操作所需的授权', howToGrant: '在权限框选择「允许本次」。' };
  }
}

/**
 * 产「喂给模型」的换方法引导(注入被拒结果的 hint),指示模型不要重复同一被拒调用、改用
 * 其它方式达成目标,实在不行再诚实告知所需权限。
 *
 * @param {string} toolName
 * @param {object} [denyResult]
 * @returns {string}
 */
function buildDenyGuidance(toolName, denyResult = {}) {
  if (!_enabled()) return '';
  try {
    const { permission, howToGrant } = describeRequiredPermission(toolName, denyResult);
    return [
      `用户拒绝了对「${String(toolName || '该操作')}」的授权。请不要重复发起同一个被拒的调用——那只会再次被拦。`,
      '改用其它方式达成同一目标,例如:① 用只读 / 更低权限的方式获取所需信息;② 把需要高权限的步骤拆成可由用户手动执行的明确指引;③ 换一个不需要该权限的工具或路径。',
      `若确实没有任何替代方案能完成,请如实告知用户:完成此任务 khyos 必须拥有「${permission}」,授予方式:${howToGrant} 不要假装已完成,也不要把失败归因模糊。`,
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * 产「最终诚实告知用户」的文案:已尝试替代仍无法完成时,逐条列出所需权限与授予方式。
 *
 * @param {Array<{tool:string, denyResult?:object}>} deniedList  本轮被拒的(工具+结果)清单
 * @returns {string}
 */
function buildExhaustedMessage(deniedList) {
  try {
    const list = Array.isArray(deniedList) ? deniedList : [];
    // 按 (permission+howToGrant) 去重,避免重复列同一权限。
    const seen = new Set();
    const lines = [];
    for (const item of list) {
      const { permission, howToGrant } = describeRequiredPermission(item && item.tool, item && item.denyResult);
      const k = `${permission}||${howToGrant}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`- 「${permission}」:${howToGrant}`);
    }
    const permBlock = lines.length ? lines.join('\n') : '- 完成该操作所需的授权:在权限框选择「允许本次」。';
    return [
      '⚠ 我已尝试用其它方法完成这一步,但在当前权限下仍无法做到。',
      '',
      '要完成此任务,khyos 必须拥有以下权限:',
      permBlock,
      '',
      '你可以授予上述权限后让我重试;若不便授予,我也可以改给出由你手动执行的步骤。',
    ].join('\n');
  } catch {
    return '⚠ 当前权限不足以完成此任务。请在权限框选择「允许本次」后让我重试,或让我给出手动步骤。';
  }
}

module.exports = {
  paramSignature,
  denyKey,
  evaluateDeny,
  describeRequiredPermission,
  buildDenyGuidance,
  buildExhaustedMessage,
  MAX_ALTERNATIVE_ATTEMPTS,
  _enabled,
};
