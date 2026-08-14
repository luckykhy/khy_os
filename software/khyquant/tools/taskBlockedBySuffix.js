'use strict';

/**
 * taskBlockedBySuffix.js — 纯叶子:为任务清单行构造「blocked by」后缀,只列**仍未完成**
 * 的阻塞依赖(对齐 CC `src/components/TaskListV2.tsx` 的 `openBlockers`)。
 *
 * 关键后端逻辑(CC):`unresolvedTaskIds = new Set(tasks.filter(t => t.status !== 'completed'))`,
 * `openBlockers = task.blockedBy.filter(id => unresolvedTaskIds.has(id))`,`isBlocked && (…)`——
 * 即**依赖一旦完成就从「blocked by」行剔除**,全部完成则整行注解消失,展示的永远是**当前仍在
 * 阻塞**的依赖;并 `sort((a,b)=>parseInt(a)-parseInt(b)).map(id=>'#'+id).join(', ')` 数字序 + `#` 前缀。
 *
 * Khy 历史缺口:`_taskStore.snapshot()` 把原始 `blockedBy` 数组 `join(',')` **原样**铺出,
 * 依赖完成后仍显示 `[blocked by: 1,3]`(过期、误导)。本叶子收敛该后缀构造,复用 snapshot
 * 已持有的「已完成任务 id 集合」过滤掉**已完成**的阻塞。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源。env 仅用于门控。
 *
 * 诚实边界:① 只剔除**确已完成**的依赖(`completedIds` 命中);**缺失/不存在**的依赖 id
 *   保留显示(与 khy 自家 `canStart()` 的「missing dep = blocked」语义一致,且对悬空依赖是
 *   有用告警——这是相对 CC `unresolvedTaskIds` 只含存在任务的**刻意诚实分歧**,绝不静默吞掉
 *   悬空依赖)。② 门控关 → 逐字节回退历史 `[blocked by: ${blockedBy.join(',')}]`(未过滤、
 *   无 `#`、逗号无空格)。③ 非数组/空数组 → ''(行无后缀,与历史一致)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 子门控(默认开,值为 0/false/off/no 时关)。关 → 逐字节回退历史未过滤后缀。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function blockedBySuffixEnabled(env = process.env) {
  const flag = String((env && env.KHY_TASK_BLOCKED_BY_FILTER) || '').trim().toLowerCase();
  return !_FALSY.has(flag);
}

/**
 * 构造任务行的「blocked by」后缀。
 *
 * @param {Array<string|number>} blockedBy - 该任务声明的阻塞依赖 id 列表
 * @param {Set<string>|Array<string|number>} completedIds - 已完成任务的 id 集合(snapshot 提供)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} ` [blocked by: #1, #3]`(门控开·仅未完成依赖);
 *                   ` [blocked by: 1,3]`(门控关·逐字节回退历史);'' 表示无阻塞后缀
 */
function buildBlockedBySuffix(blockedBy, completedIds, env = process.env) {
  if (!Array.isArray(blockedBy) || blockedBy.length === 0) return '';

  // 门控关:逐字节回退历史(原始未过滤 join(',')，无 `#`、逗号无空格)。
  if (!blockedBySuffixEnabled(env)) {
    return ` [blocked by: ${blockedBy.join(',')}]`;
  }

  const completed = completedIds instanceof Set
    ? completedIds
    : new Set(Array.isArray(completedIds) ? completedIds.map((x) => String(x)) : []);

  // 只保留**仍未完成**的依赖(缺失/不存在的 id 保留显示——刻意诚实分歧,见文件头)。
  const open = blockedBy.filter((id) => !completed.has(String(id)));
  if (open.length === 0) return ''; // 全部依赖已完成 → 后缀整段消失(对齐 CC isBlocked=false)

  // CC openBlockers 数字序 + `#` 前缀(与 khy 自家行内 `#${t.id}` id 约定一致)。
  // 非数字 id(khy 可有 `t-xxx` 形)退化到稳定的字典序,绝不因 NaN 比较乱序。
  const sorted = open.slice().sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });

  return ` [blocked by: ${sorted.map((id) => `#${id}`).join(', ')}]`;
}

module.exports = { blockedBySuffixEnabled, buildBlockedBySuffix };
