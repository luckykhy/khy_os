'use strict';

/**
 * slashMenuFilter — TUI 斜杠命令菜单的「过滤/排序」决策 SSOT(刀24)。
 *
 * 对齐 CC `src/utils/suggestions/commandSuggestions.ts::generateCommandSuggestions`:
 * CC 用 Fuse 索引,键含 `commandName`(w3)、**`partKey`=命令名按 `[:_-]` 切分**(w2)、
 * `aliasKey`(w2)、`descriptionKey`(w0.5),再按 exact>prefix>fuzzy 排序——即**子串/分段/
 * 描述**都能命中,不止前缀。
 *
 * 真缺口=Khy **TUI** 菜单(`tui/hooks/useCompletions.js::computeSlash`)历史走
 * `router.getCompletions` → `commandRegistry.getCompletions` 的**仅前缀** `startsWith`
 * + 字母序 `.sort()`。对 Khy 的 20+ 连字符命令(`/autofix-pr`/`/commit-push-pr`/
 * `/subscribe-pr`…),键 `/pr` 在 TUI **完全搜不到**这些命令(菜单甚至整个消失),而
 * **Khy 自己的经典 REPL** 早已用 `repl/slashCommandFilter.js::rankSlashCommands`
 * 做「前缀>命令子串>标签/描述子串」匹配(`/pr` 经子串命中 `/autofix-pr`)→ **TUI 退化
 * 到比 Khy 自家 CLI 还差**,也比 CC 差。
 *
 * 修(SSOT 纪律,消费既有叶子而非另起算法)=本叶子门控开时把 TUI 菜单路由到既有
 * `rankSlashCommands`(同一排序内核,与经典 REPL 收敛);门控关时**注入式**回退到原
 * `getCompletionsFn(value)`(仅前缀),逐字节等价。
 *
 * 诚实边界(刻意不纳入):
 *  ① **不碰** `commandRegistry.getCompletions` 本身——它另喂经典 readline `completer`
 *     (`repl.js:846`),那里 readline 要靠「候选共同前缀」补全,**前缀语义是对的**,
 *     换成子串会破坏 readline 补全。故本刀只治 TUI 菜单这一支,不动 readline 路径。
 *  ② 排序/分词/打分**全部委托** `rankSlashCommands`(prefix=3/cmd-substring=2/
 *     label|desc-substring=1·稳定排序),本叶子不自造评分(否则即重复 SSOT)。
 *  ③ 只产**命令名有序列表**,菜单项的 label/desc 由调用方(useCompletions)按既有
 *     `slashDescription` 装配——保证与门控关路径对同一命令渲染**完全一致**,唯一发散
 *     =菜单出现的命令**集合与顺序**,非其渲染外观。
 *
 * 门控 `KHY_TUI_SLASH_SUBSTRING` 默认开;关 → 注入式前缀回退,逐字节等价历史。
 */

const { rankSlashCommands } = require('../repl/slashCommandFilter');
// 整排序结果按 (命令表身份, filter) 记忆,收退格/重键回访的重复全量排序;门控关 → 现算(逐字节回退)。
const _slashRankResultMemo = require('./slashRankResultMemo');

function slashSubstringEnabled(env = process.env) {
  const flag = String((env && env.KHY_TUI_SLASH_SUBSTRING) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 给定输入串 `value`(形如 "/pr",含前导 '/')与注入的命令源,返回 TUI 斜杠菜单应展示
 * 的**命令名有序列表**。
 * @param {string} value 当前输入(含前导 '/')
 * @param {object} deps
 * @param {Array<{cmd:string,label?:string,desc?:string}>} deps.slashCommands 全量命令表(=router.SLASH_COMMANDS)
 * @param {(v:string)=>string[]} [deps.getCompletionsFn] 门控关时的前缀回退源(=router.getCompletions)
 * @param {object} [env]
 * @returns {string[]} 命令名有序列表
 */
function slashMenuCommandNames(value, deps = {}, env = process.env) {
  const { slashCommands, getCompletionsFn } = deps;
  if (!slashSubstringEnabled(env)) {
    // 逐字节回退:历史前缀路径(注入,不在叶子内重写前缀逻辑)。
    return (typeof getCompletionsFn === 'function' ? getCompletionsFn(value) : []) || [];
  }
  const list = Array.isArray(slashCommands) ? slashCommands : [];
  // 按 (命令表身份, value) 记忆整排序结果;未命中/门控关 → 现算 rankSlashCommands(...).map(cmd)。
  return _slashRankResultMemo.getRankedNames(
    list,
    value,
    () => rankSlashCommands(list, value).map((sc) => sc.cmd),
    env,
  );
}

module.exports = { slashSubstringEnabled, slashMenuCommandNames };
