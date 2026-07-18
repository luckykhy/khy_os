'use strict';

/**
 * statsConversationLines.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)第一目标「与 CC 相比缺少的 /菜单全部补齐」∩ 第二目标「TUI
 * 缺少的显示多学 CC,但更重背后逻辑」。与 刀101(/status 孪生)、刀102/103(/context
 * 孪生)同属 **router-path vs interactive-twin drift** 缺口家族——同一命令概念在
 * 非交互英文 router 面与交互中文孪生面各有实现,一面富、另一面塌缩。
 *
 * 真缺口:`/stats` 的对话构成(消息按角色分布)在 router `case 'stats'`(router.js:1679)
 * 经 `ai.getConversationStats()` 已 live 呈现(messages.total / user / assistant / tool),
 * 但**两条交互中文 /stats 孪生**——菜单(repl.js:4091 `selected.flag==='stats'`)与
 * 键入(repl.js:4687 `trimmed==='/stats'`)——**都只读 hud.getState() 的计数器**
 * (请求次数 / 令牌用量 / 工具 / 代理),**从不消费 getConversationStats()**,故用户在
 * 交互面永远看不到「这轮会话里我说了几条、助手答了几条、工具跑了几条」的对话构成。
 * = 计算侧 live 且被 router 消费、呈现侧(两交互孪生)未接的 half-wired 孤儿(两处同缺)。
 *
 * 本叶子把「conversation stats → 中文构成行」这段纯格式化抽出单测,给两条中文孪生
 * **同时**补(承 刀103「改多处避免再度 drift」)。门控开 → 返回一行
 * `消息: 共 N 条（用户 a · 助手 b · 工具 c）`;门控关 / total<=0 / 坏输入 → `[]`
 * (两孪生逐字节回退刀104前)。
 *
 * 门控 KHY_STATS_CONVERSATION(默认开;{0,false,off,no} 关)。
 *
 * 诚实边界(刻意):① 只补 CC /stats 中 khy 已备的**对话构成**数据(总数/用户/助手/工具);
 *   effort / studyMode 是**设置/模式**(各由 /effort 等入口显式呈现),非会话构成,不塞进这行
 *   避免语义混杂(honest-NA·router 表格把它俩并列是英文诊断面的刻意差异)。② systemMessages /
 *   otherMessages(系统提示 / 压缩摘要合成载体)是内部记账,不是用户关心的对话构成,故构成行
 *   只列 用户/助手/工具 三类(与 router messages.user/assistant/tool 逐字对齐);总数用
 *   totalMessages 原值(含未列出的 system/other)如实呈现,不臆造「三类之和」。③ 用户计数口径
 *   完全依赖 getConversationStats 内的 isHumanTurn SSOT(其自身独立门控,见 messagePredicates)——
 *   本叶子只格式化不重算,单一真源。④ 门控关 / 坏输入 / total<=0 → [],整体不抛。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否在交互 /stats 追加对话构成行。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function statsConversationEnabled(env = process.env) {
  const raw = env && env.KHY_STATS_CONVERSATION;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 非负整数(负/非有限/非数 → 0)。 */
// 收敛到 utils/toNonNegInt 单一真源(逐字节委托,调用点不变)
const _count = require('../utils/toNonNegInt');

/**
 * 由 getConversationStats 返回对象构造**交互中文面** /stats 的对话构成行。
 *   门控关 / 坏输入 / totalMessages<=0 → []
 *   门控开 → [`消息: 共 N 条（用户 a · 助手 b · 工具 c）`]
 * (纯文本,无缩进无着色,交调用方拼装缩进/着色)
 * @param {object} stats  ai.getConversationStats() 返回对象
 * @param {object} [env]
 * @returns {string[]}
 */
function buildConversationCompositionLines(stats, env = process.env) {
  if (!statsConversationEnabled(env)) return [];
  const s = stats || {};

  const total = _count(s.totalMessages);
  if (total <= 0) return [];

  const user = _count(s.userMessages);
  const assistant = _count(s.assistantMessages);
  const tool = _count(s.toolMessages);

  return [`消息: 共 ${total} 条（用户 ${user} · 助手 ${assistant} · 工具 ${tool}）`];
}

module.exports = {
  statsConversationEnabled,
  buildConversationCompositionLines,
};
