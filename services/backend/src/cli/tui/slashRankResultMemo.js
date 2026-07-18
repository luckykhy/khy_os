'use strict';

/**
 * slashRankResultMemo — 斜杠命令**整排序结果**按 (命令表身份, filter) 记忆(纯叶子)。
 *
 * 承 [[slashRankIndexMemo]]:那一刀已把「全量命令表逐条 toLowerCase」的小写投影按命令表
 * 身份记忆掉了。本刀收其**上一层**——`rankSlashCommands` 仍在每次按键跑「~173 条评分循环
 * + Array.sort + .map(取 cmd)」。`useCompletions` 的 `useMemo([value, offset])` 已消除**同一
 * 帧/纯重渲**的重算,但**每个不同 filter 值**(逐字符输入、退格回访旧前缀、重复键入)仍付全量
 * 排序。典型输入是前缀递进/退格回访 → 相同 filter 会被重复请求。
 *
 * 修:按命令表数组**身份**维护一个**小 LRU**(filter → 排序后的 cmd 名数组)。命中 → 直接返回
 * 上次排序结果(同一数组引用);未命中 → 现算并存(超过 CAP 淘汰最旧)。命令表变更→新数组身份
 * →新 LRU(旧的随 WeakMap 自动 GC)。CAP 小(16)——斜杠菜单交互里活跃 filter 极少,LRU 只为
 * 退格/重键回访提速,不做无界缓存。
 *
 * 关键正确性:
 *   • 键 = (命令表数组身份 via WeakMap) × (filter 字符串)。命令表原地 push/splice 改长度 → 附
 *     `len` 守卫(与 slashRankIndexMemo 同款)整表失效,杜绝过期读取。
 *   • 返回值是**cmd 名有序数组**(rankSlashCommands(...).map(sc=>sc.cmd) 的等价物);调用方
 *     slashMenuCommandNames 本就 `.map(sc=>sc.cmd)`,故这里直接产名数组逐字节等价。
 *   • 门控关 / 非对象键 / 异常 → `computeFn()` 现算(逐字节回退)。绝不抛。
 *   • env 陈旧权衡:身份键不感知会话内 env 变化(与 render-path 记忆家族一致)。
 *
 * 门控 `KHY_SLASH_RANK_RESULT_MEMO` 默认开;关 → 每键现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const CAP = 16; // 每命令表身份保留的活跃 filter 结果上限(退格/重键回访足够)。

function isEnabled(env = process.env) {
  const raw = env && env.KHY_SLASH_RANK_RESULT_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 命令表数组身份 → { len, lru: Map<filter, cmdNames[]> }。Map 迭代序=插入序,借此实现 LRU。
const _cache = new WeakMap();

function _touch(lru, key, value) {
  // 已存在则先删再插,把它挪到「最新」端(Map 保序)。
  if (lru.has(key)) lru.delete(key);
  lru.set(key, value);
  // 超容量 → 淘汰最旧(迭代首元素)。
  while (lru.size > CAP) {
    const oldest = lru.keys().next().value;
    lru.delete(oldest);
  }
}

/**
 * 记忆 (命令表, filter) → 排序后 cmd 名数组。
 * @param {Array} cmds 命令表(WeakMap 键,须为对象/数组)
 * @param {string} filter 过滤串(含前导 '/')
 * @param {() => string[]} computeFn 现算排序结果(cmd 名数组)的回退/首算函数
 * @param {object} [env]
 * @returns {string[]} 排序后的 cmd 名数组(命中缓存则同一引用)
 */
function getRankedNames(cmds, filter, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !cmds || typeof cmds !== 'object') return computeFn();
    const key = String(filter == null ? '' : filter);
    let slot = _cache.get(cmds);
    if (!slot || slot.len !== cmds.length) {
      slot = { len: cmds.length, lru: new Map() };
      _cache.set(cmds, slot);
    }
    if (slot.lru.has(key)) {
      const hit = slot.lru.get(key);
      _touch(slot.lru, key, hit); // 命中也刷新为最新,LRU 语义
      return hit;
    }
    const result = computeFn();
    _touch(slot.lru, key, result);
    return result;
  } catch {
    try { return computeFn(); } catch { return []; }
  }
}

module.exports = { isEnabled, getRankedNames, OFF_VALUES, CAP };
