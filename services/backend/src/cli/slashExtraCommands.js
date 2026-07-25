'use strict';

/**
 * slashExtraCommands — 斜杠命令菜单里「不在 commandRegistry 的额外命令」单一真源(SSOT)。
 *
 * 背景(为何存在这个叶子):
 *   khy 有两个交互入口——经典 readline REPL(replSession.js)与 Ink TUI(tui/)。
 *   多数斜杠命令由 commandRegistry.toSlashCommands() / router.SLASH_COMMANDS 统一供给,
 *   两入口都读得到。但历史上有 13 条命令(/study /hud /mind …)**未进 commandRegistry**,
 *   而是硬编码在经典 REPL 的 `_getSlashCommands` 里作 `extras[]` 内联数组。后果:
 *     · 经典 REPL 菜单能显示这 13 条;
 *     · TUI 菜单(useCompletions.computeSlash 只读 router.SLASH_COMMANDS)**完全看不到**;
 *     · 想加/改一条,得记得两处都动——正是「改一处另一处不同步」的分叉源。
 *
 *   本叶子把这份列表抽成两入口共同消费的 SSOT:改这里,经典 REPL 与 TUI 菜单同步生效。
 *
 * 契约(纯叶子·零 IO·确定性·绝不抛·不 mutate 入参):
 *   · SLASH_EXTRA_COMMANDS  — 冻结的额外命令数组(cmd/label/desc[/flag]),顺序即历史顺序。
 *   · mergeExtraCommands(baseCmds) — 把 extras 幂等并入 baseCmds:同名 cmd 已在 baseCmds
 *     则跳过(既有优先,与 replSession extras 合并语义逐字节一致),返回**新数组**,不改入参。
 *
 * === HOW TO EXTEND(给后来的维护者 / 小模型)===
 *   要新增一条两入口菜单都显示的命令:在 SLASH_EXTRA_COMMANDS 里 push 一条
 *   `{ cmd:'/foo', label:'名', desc:'说明'[, flag:'x'] }` 即可——经典 REPL 与 TUI 自动同步。
 *   若该命令已进 commandRegistry(有正式 route 处理),就**不该**放这里(会重复);
 *   这里只装「registry 之外、菜单仍要露出」的命令。改完跑 node --test slashExtraCommands.test.js。
 */

// 顺序与 replSession.js 历史 extras[] 逐条对齐(冻结防意外 mutate)。
const SLASH_EXTRA_COMMANDS = Object.freeze([
  Object.freeze({ cmd: '/study',    label: '学习模式',   desc: '学习模式开关' }),
  Object.freeze({ cmd: '/role',     label: '角色扮演',   desc: '让 AI 扮演角色(本次对话生效,--save 可长期保留)' }),
  Object.freeze({ cmd: '/hud',      label: 'HUD 面板',   desc: '显示 HUD 仪表盘' }),
  Object.freeze({ cmd: '/mind',     label: '思维导图',   desc: '查看 AI 当前任务节点与下一步', flag: 'mind' }),
  Object.freeze({ cmd: '/intent',   label: '意图保护',   desc: '查看意图保护提取结果与调试开关' }),
  Object.freeze({ cmd: '/new',      label: '新会话',     desc: '新建会话（清空当前上下文）' }),
  Object.freeze({ cmd: '/reset',    label: '重置会话',   desc: '重置会话（同 /new）' }),
  Object.freeze({ cmd: '/folded',   label: '折叠明细',   desc: '查看本轮折叠状态明细（等同 Ctrl+O）' }),
  Object.freeze({ cmd: '/think',    label: '思考强度',   desc: '设置思考强度 low|medium|high|max' }),
  Object.freeze({ cmd: '/trace',    label: '追踪开关',   desc: '调试追踪开关 on|off|status' }),
  Object.freeze({ cmd: '/pool',     label: 'Key 池',     desc: '查看 API Key 池状态（多账号轮询）' }),
  Object.freeze({ cmd: '/push',     label: '推送备份',   desc: '推送项目到 GitHub/Gitee 私人仓库备份' }),
  Object.freeze({ cmd: '/optimize', label: '自优化',     desc: 'AI 自我优化（分析经验并改进）' }),
]);

/**
 * 把 extras 幂等并入 baseCmds。既有 cmd 优先:baseCmds 已含同名 cmd 则该 extra 跳过。
 * 返回新数组(baseCmds 副本 + 补位的 extras),不 mutate 入参。baseCmds 非数组时按空处理。
 */
function mergeExtraCommands(baseCmds) {
  const base = Array.isArray(baseCmds) ? baseCmds : [];
  const existing = new Set(base.map((sc) => sc && sc.cmd));
  const merged = base.slice();
  for (const ex of SLASH_EXTRA_COMMANDS) {
    if (!existing.has(ex.cmd)) {
      merged.push(ex);
      existing.add(ex.cmd);
    }
  }
  return merged;
}

module.exports = { SLASH_EXTRA_COMMANDS, mergeExtraCommands };
