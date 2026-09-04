'use strict';

/**
 * hookContribSeams.js — Block B「插件注册点」:把 dsh(deepseek-harness / Cordis 系)
 * 的「插件在明确接缝上注册能力」思路接入 Khy-OS 的既有 hookSystem,新增两个事件:
 *
 *   ToolPermission — 权限裁决**只能收紧**的注册点(monotonic-tighten)。
 *   PromptSection  — 系统提示词**追加一段**的注册点(只增不改既有指令)。
 *
 * 为什么是「纯叶子 + 两个函数」而不是散写进调用点:
 *   两个接缝分别位于 toolCallingPermissions.requestPermission 与 aiChatCore 的系统提示词
 *   装配段。把「触发 hook + 归一化结果 + 单调性校验」收在本文件,调用点只多一次 await,
 *   保证「怎么收紧」这条语义只有一处真源(铁律2 零硬编码)。
 *
 * 铁律对齐:
 *   - **单调收紧(核心不变式)**:ToolPermission 的 handler 永远无法把裁决放松。基线裁决
 *     与 handler 提议裁决在 STRATEGIES(auto<confirm<deny,借自 permissionPolicy/config
 *     的既有真源)上取**更严者**。handler 说 'auto' 而基线是 'confirm' → 仍是 'confirm'。
 *     这与调用点原有注释「It can only ADD protection, never relax it」逐字同构。
 *   - **绝不抛**:任何 hook 崩溃/超时/坏返回 → 回落基线裁决(权限)或空串(提示词),
 *     即「等价于没有注册任何 hook」,fail-soft 且 fail-closed 方向一致。
 *   - **门控可逐字节回退**:KHY_HOOK_TOOL_PERMISSION / KHY_HOOK_PROMPT_SECTION 均默认开,
 *     关 → 本文件的两个函数在门控判定处短路,调用点行为与接线前逐字节一致。
 *   - **纯叶子无环**:只 require hookSystem、flagRegistry、permissionPolicy/config(常量),
 *     三者都不 require 本文件,也不 require toolCallingPermissions。
 *
 * @module services/hooks/hookContribSeams
 */

const flagRegistry = require('../../../flagRegistry');

const GATE_TOOL_PERMISSION = 'KHY_HOOK_TOOL_PERMISSION';
const GATE_PROMPT_SECTION = 'KHY_HOOK_PROMPT_SECTION';

const EVENT_TOOL_PERMISSION = 'ToolPermission';
const EVENT_PROMPT_SECTION = 'PromptSection';

// 单调收紧格(lattice)的唯一真源:借用 permissionPolicy/config 既有的 STRATEGIES,
// 它已是「auto < confirm < deny」升序严格度的规范列表。绝不在此另立一份顺序(铁律2)。
function _strategies() {
  try {
    const { STRATEGIES } = require('../../security/permissionPolicy/config');
    if (Array.isArray(STRATEGIES) && STRATEGIES.length) {
      return STRATEGIES;
    }
  } catch {
    /* 常量叶子不可用 → 用下方保守兜底 */
  }
  // 兜底与上游同序;仅在 require 失败时生效,保证本叶子绝不抛。
  return ['auto', 'confirm', 'deny'];
}

/**
 * 取两个裁决中的**更严者**。未知/缺失裁决按「不表态」处理(返回另一方),
 * 因此一个坏 handler 既不能放松也不能意外收紧。
 * @param {string} base     基线裁决(policy 已算出的)
 * @param {string} proposed hook 提议裁决
 * @returns {string} 更严的那个(仍属 STRATEGIES)
 */
function tighten(base, proposed) {
  const order = _strategies();
  const bi = order.indexOf(base);
  const pi = order.indexOf(proposed);
  if (bi < 0 && pi < 0) {
    return base;
  }
  if (bi < 0) {
    return proposed;
  }
  if (pi < 0) {
    return base;
  }
  return pi > bi ? proposed : base;
}

function _hookSystem() {
  return require('../../../../cli/hooks/hookSystem');
}

/**
 * 触发 ToolPermission,并把结果**单调收紧**到基线裁决上。
 *
 * handler 表达收紧的两种方式(与 hookRunner 既有契约一致,不新增协议):
 *   1. `{ action: 'block' }`  → blocked:true → 视为最严裁决(STRATEGIES 末位 'deny')。
 *   2. `{ action: 'modify', decision: 'confirm'|'deny'|'auto' }` → 参与 tighten。
 *
 * @param {string} baseDecision 基线裁决('auto'|'confirm'|'deny')
 * @param {object} context      { toolName, params, category, isReadOnly, isDestructive }
 * @returns {Promise<string>} 收紧后的裁决;门控关或任何异常 → 原样返回 baseDecision
 */
async function applyToolPermissionHooks(baseDecision, context = {}) {
  try {
    if (!flagRegistry.isFlagEnabled(GATE_TOOL_PERMISSION, process.env)) {
      return baseDecision;
    }
    const hookSystem = _hookSystem();
    if (typeof hookSystem.isInitialized === 'function' && !hookSystem.isInitialized()) {
      return baseDecision;
    }
    const res = await hookSystem.trigger(EVENT_TOOL_PERMISSION, context);
    if (!res) {
      return baseDecision;
    }
    const order = _strategies();
    if (res.blocked) {
      // block 是最强表态 → 取格上最严者(仍走 tighten,故基线已更严时不变)。
      return tighten(baseDecision, order[order.length - 1]);
    }
    const proposed = res.context && res.context.decision;
    if (typeof proposed !== 'string' || !proposed) {
      return baseDecision;
    }
    return tighten(baseDecision, proposed);
  } catch {
    // 绝不抛:hook 生态出问题绝不能让权限裁决本身失败 → 回落基线。
    return baseDecision;
  }
}

/**
 * 触发 PromptSection,收集 handler 追加的提示词段落。
 *
 * handler 通过 `{ action:'modify', sections:[...] }` 或 `{ action:'modify', section:'...' }`
 * 追加文本;只**新增**段落,永不改写既有指令(调用点把返回值作为一条新 entry 交给
 * directiveComposer,由整合层按 tier 排序)。
 *
 * @param {object} context 触发上下文(供 handler 判断是否追加)
 * @returns {Promise<string>} 拼好的段落文本;门控关/无 hook/任何异常 → 空串
 */
async function collectPromptSections(context = {}) {
  try {
    if (!flagRegistry.isFlagEnabled(GATE_PROMPT_SECTION, process.env)) {
      return '';
    }
    const hookSystem = _hookSystem();
    if (typeof hookSystem.isInitialized === 'function' && !hookSystem.isInitialized()) {
      return '';
    }
    const res = await hookSystem.trigger(EVENT_PROMPT_SECTION, context);
    const ctx = (res && res.context) || {};
    const raw = Array.isArray(ctx.sections)
      ? ctx.sections
      : ctx.section !== undefined
        ? [ctx.section]
        : [];
    const parts = [];
    for (const s of raw) {
      const text = typeof s === 'string' ? s.trim() : '';
      if (text) {
        parts.push(text);
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

module.exports = {
  applyToolPermissionHooks,
  collectPromptSections,
  tighten,
  EVENT_TOOL_PERMISSION,
  EVENT_PROMPT_SECTION,
  GATE_TOOL_PERMISSION,
  GATE_PROMPT_SECTION,
};
