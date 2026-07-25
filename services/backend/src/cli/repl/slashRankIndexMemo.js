'use strict';

/**
 * slashRankIndexMemo — 斜杠命令排序的「小写投影」按命令表身份记忆(纯叶子)。
 *
 * 根因:`slashCommandFilter.rankSlashCommands` 在 TUI 斜杠菜单(`computeSlash`)与经典
 * REPL `_filterSlashCommands` 里**每次按键**都被调用一次(useMemo 键含 value,逐字符变
 * 化→每键真重算),而其内层循环对全量命令表(~173 条)逐条 `String(sc.cmd/label/desc)
 * .toLowerCase()`——即每次按键分配约 3×N≈519 个一次性小写字符串。但 `cmd/label/desc`
 * 是**每命令静态**的,键与键之间只有 `filter` 变;把整表小写化重复做纯属浪费,恰是
 * 打开斜杠菜单后逐字符输入延迟的一处来源。
 *
 * 修:按命令表**数组身份**(`router.SLASH_COMMANDS` 是模块级常量数组,进程内引用稳定)
 * 用 WeakMap 记忆其小写投影 `[{sc, cmdLower, labelLower, descLower}, …]`,连续按键复用
 * 一次投影;命令表变更→新数组身份→自然失效重算。附 `len` 守卫防原地 push/splice 造成
 * 的过期读取(极不可能,但廉价即加)。WeakMap 自动 GC,无淘汰逻辑。
 *
 * 纯叶子纪律:零 IO、确定性、绝不抛;门控关 / 非对象键 / 异常 → 直接 `computeFn()`
 * 现算投影,**逐字节回退**(rankSlashCommands 的评分与稳定排序完全不变,唯一差异是小写
 * 串来自缓存还是现算,返回的命令有序列表逐条一致)。
 *
 * env 陈旧权衡:与本仓 render-path 记忆家族(toolTargetMemo/toolDiffRowsMemo/
 * toolHeaderSummaryMemo…)一致——身份键不感知会话内 env 变化(env 会话内稳定)。
 *
 * 门控 `KHY_SLASH_RANK_INDEX_MEMO` 默认开;关 → 每次现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_SLASH_RANK_INDEX_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 命令表数组身份 → { len, index }。index 与命令表等长同序,保持 rankSlashCommands 的
// 原始下标语义(稳定排序依赖 idx=原序)。
const _cache = new WeakMap();

/**
 * @param {Array} cmds 命令表(WeakMap 键,须为对象/数组)
 * @param {() => Array} computeFn 现算小写投影的回退/首算函数
 * @param {object} [env]
 * @returns {Array} 小写投影数组(命中缓存则同一引用)
 */
function getRankIndex(cmds, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !cmds || typeof cmds !== 'object') return computeFn();
    const hit = _cache.get(cmds);
    if (hit && hit.len === cmds.length) return hit.index;
    const index = computeFn();
    _cache.set(cmds, { len: cmds.length, index });
    return index;
  } catch {
    try { return computeFn(); } catch { return []; }
  }
}

module.exports = { isEnabled, getRankIndex, OFF_VALUES };
