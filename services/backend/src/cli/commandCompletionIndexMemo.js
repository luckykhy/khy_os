'use strict';

/**
 * commandCompletionIndexMemo — commandRegistry.getCompletions 的「小写键投影」按注册表身份记忆(纯叶子)。
 *
 * 承 [[slashRankIndexMemo]] / [[completionKeysLazy]] 同族:斜杠补全的另一处每键/每 Tab 重复计算。
 *
 * 根因:`commandRegistry.js::getCompletions(partial)`(斜杠路径实际委托实现,经
 * `router.getCompletions:5675` 达;既是 readline completer 的 Tab 委托,也是 TUI
 * `KHY_TUI_SLASH_SUBSTRING` **关**时的**每键**前缀回退委托)每次调用都遍历**全量**命令 Map,
 * 对每个键 `cmd.toLowerCase()` 后 `startsWith`,再 `matches.sort()`。但命令键的**小写形式**与
 * **排序序**只随注册表增删而变,`partial` 逐键变化时重算整表 toLowerCase 纯属浪费。
 *
 * 修:按命令 Map **对象身份**(module 级 `_commands`,进程内引用稳定)用 WeakMap 记忆一份
 * **按原始 cmd 升序排好**的投影 `[{cmd, cmdLower}]`。每次调用只在该投影上 `cmdLower.startsWith`
 * 收集 `cmd`——因投影已按 cmd 升序,过滤子序列天然有序,**免去每调用的 .sort()**,输出与原
 * `matches.sort()` 逐字节一致。注册表增删 → `size` 变 → 失效重建(Map 无 length,用 `.size` 守卫;
 * 对已存在键 re-set 不改 size 但键字符串不变、投影不变,安全)。
 *
 * 纯叶子纪律:零 IO、确定性、绝不抛;门控关 / 非 Map(无 .size)/ 异常 → `computeFn()`(逐字节
 * 回退今日行为:调用方现算整表 toLowerCase + sort)。
 *
 * 门控 `KHY_COMMAND_COMPLETION_INDEX_MEMO` 默认开;关 → 每次现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMMAND_COMPLETION_INDEX_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 键:命令 Map 对象 → { size, index }。index = 按 cmd 升序的 [{cmd, cmdLower}]。
const _cache = new WeakMap();

/**
 * 取(或首建)注册表的排序小写键投影。
 * @param {Map} commandsMap 命令 Map(WeakMap 键,须有数值 .size)
 * @param {() => Array<{cmd:string, cmdLower:string}>} computeFn 现算排序投影的回退/首算函数
 * @param {object} [env]
 * @returns {Array<{cmd:string, cmdLower:string}>} 按 cmd 升序的投影(命中则同一引用)
 */
function getCompletionIndex(commandsMap, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !commandsMap || typeof commandsMap.size !== 'number') {
      return computeFn();
    }
    const hit = _cache.get(commandsMap);
    if (hit && hit.size === commandsMap.size) return hit.index;
    const index = computeFn();
    _cache.set(commandsMap, { size: commandsMap.size, index });
    return index;
  } catch {
    try { return computeFn(); } catch { return []; }
  }
}

module.exports = { isEnabled, getCompletionIndex, OFF_VALUES };
