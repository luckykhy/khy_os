'use strict';

/**
 * promptCacheOrder.js — 纯叶子:把系统提示里「每轮/每分钟变」的动态段重排到尾部,
 * 让中转(relay)/DeepSeek 路径的 provider 最长前缀自动匹配能覆盖到整份静态内容,提升
 * prompt 前缀缓存命中率(DESIGN-ARCH-047 的后续)。
 *
 * 背景:relay 路径不发 Anthropic cache_control(边界标记在 _messageBuilder 被剥掉,系统提示
 * 拼成一整串),命中率完全依赖 provider「匹配到第一个变了的字节为止」的最长前缀匹配。而 khy 把
 * env_info 里的实时时钟(每分钟变)、task_memory(每轮变)、mcp_instructions、git_status、
 * project_structure、以及按需能力胶囊(每轮按用户意图重选)都放在靠前位置 → 前缀早早断裂,
 * 命中率天花板极低。本叶子提供「稳定/易变」分区,由 prompts.js 的 getSystemPrompt 据此把易变段
 * 挪到尾部(易变内容 dead-last),稳定前缀最大化。
 *
 * 契约:零 I/O(只读 env 门控,委派 flagRegistry 判定)、确定性(无时钟/随机)、绝不抛
 * (fail-soft:坏输入 / 门控关 → 原样返回 { stableSections: sections, volatileSections: [] },
 * 供调用方逐字节回退今日顺序)。
 *
 * 门控:
 *  - KHY_PROMPT_CACHE_ORDER     (杠杆 B)默认开:动态区易变段重排到尾部;关 → 不分区。
 *  - KHY_ONDEMAND_OUT_OF_PREFIX (杠杆 A)默认开:按需胶囊移到绝对尾部;由调用方读取本判定。
 *
 * @module constants/promptCacheOrder
 */

/**
 * 动态区里「每轮/每分钟都可能变」的段 id(有序,反映今日在 dynamicSections 里的相对出现顺序)。
 * 重排时保持组内相对序不变,只把整组挪到尾部。
 *  - task_memory        : DANGEROUS_uncached,任务板每轮变(创建/推进/完成)
 *  - env_info           : 含实时时钟,时间桶(默认 60s)每分钟刷新一次
 *  - mcp_instructions   : DANGEROUS_uncached,MCP 连接状态每轮可变
 *  - git_status         : 工作树一变即变
 *  - project_structure  : cacheKey 折入 cwd mtime,顶层增删即变
 * 故意排除 'memory'(全局 MEMORY.md 会话内极少变)以最小化改动面。
 */
const VOLATILE_SECTION_IDS = Object.freeze([
  'task_memory',
  'env_info',
  'mcp_instructions',
  'git_status',
  'project_structure',
]);

const _VOLATILE_SET = new Set(VOLATILE_SECTION_IDS);

/** 委派 flagRegistry 判定;require 失败 → 保守回退「仅显式 0/false/off/no 关」。绝不抛。 */
const _gateOn = require('../utils/gateOn');

/** 杠杆 B:动态区易变段是否重排到尾部。门控 KHY_PROMPT_CACHE_ORDER,默认开。 */
function isReorderEnabled(env) {
  return _gateOn('KHY_PROMPT_CACHE_ORDER', env);
}

/** 杠杆 A:按需能力胶囊是否移出静态前缀、置于绝对尾部。门控 KHY_ONDEMAND_OUT_OF_PREFIX,默认开。 */
function isOnDemandRelocationEnabled(env) {
  return _gateOn('KHY_ONDEMAND_OUT_OF_PREFIX', env);
}

/**
 * 把动态段数组稳定分区:非易变段(保持原相对序)+ 易变段(保持原相对序)。绝不抛。
 *
 * 门控关 / 非数组 / 分区后无易变段 → 原样返回 { stableSections: sections, volatileSections: [] }
 * (引用原样,调用方拼接后逐字节等于今日顺序)。
 *
 * @param {Array<{id?:string}>} sections  dynamicSections(systemPromptSection 描述对象数组)
 * @param {object} [env]                  默认 process.env
 * @returns {{ stableSections: Array, volatileSections: Array }}
 */
function partitionDynamicSections(sections, env) {
  const passthrough = { stableSections: sections, volatileSections: [] };
  try {
    if (!Array.isArray(sections)) return passthrough;
    if (!isReorderEnabled(env)) return passthrough;

    const stable = [];
    const volatile = [];
    for (const s of sections) {
      const id = s && typeof s === 'object' ? s.id : undefined;
      if (id && _VOLATILE_SET.has(id)) volatile.push(s);
      else stable.push(s);
    }
    // 无易变段命中 → 原样回退(避免制造与今日不同的新引用形态)。
    if (volatile.length === 0) return passthrough;
    return { stableSections: stable, volatileSections: volatile };
  } catch {
    return passthrough;
  }
}

module.exports = {
  VOLATILE_SECTION_IDS,
  isReorderEnabled,
  isOnDemandRelocationEnabled,
  partitionDynamicSections,
};
