'use strict';

/**
 * interruptionMarker.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)用户明确点名的 ESC 例子——「esc 按下会不会询问 khy 做什么来代替」,
 * 即**中断后的背后逻辑**:CC 在用户 ESC 打断一次回复时,会把
 * `[Request interrupted by user]` 记进对话历史(必要时连同已生成的部分回复),这样用户
 * 紧接着说「改用 X」时,模型**看得到自己上一次是被用户打断的**,能正确承接。
 *
 * 真缺口(先核实):khy 的 `ai.chat()` 在生成阶段被 ESC/`/i` 中断时抛 AbortError,而
 * chat() 顶层**没有** try 包住生成调用 → AbortError 直接冒出,**跳过**结尾
 * `_messages.push({role:'assistant',...})`(ai.js:6226)。于是模型可见历史停在一条**悬空的
 * user 回合**(user 消息 ai.js:5019 已 push、assistant 从未落),且**没有任何「被中断」标记**。
 * 下一句「改用 X」进来后历史成了两条连续 user、模型无从得知上一轮是被用户打断的
 * = 计算侧(部分回复在 liveRef 里)存在、模型可见历史侧未接的 half-wired 缺口。
 *
 * 本叶子只做**中断标记文案 + 是否记录的判定**,零 IO:调用方(cli/tui/hooks/useQueryBridge.js
 * 的 abort 分支、以及后续经 ai.recordInterruption 的其它路径)把部分回复文本注入,叶子产出
 * 要落进 assistant 回合的 content(有部分回复 → 部分回复 + 换行 + 标记;无 → 仅标记);
 * push 到 _messages / 持久化 / 竞态守卫一律留给调用方(ai.recordInterruption)。
 *
 * 门控 KHY_INTERRUPT_MARKER(默认开;{0,false,off,no} 关)。关 → buildInterruptedAssistantContent
 * 返回 null,调用方 no-op → 逐字节回退今日行为(悬空 user、无中断标记)。
 *
 * 诚实边界(刻意):① 只补「模型可见历史里记一条中断标记」这一 CC 背后逻辑;是否在 UI 上再问
 *   用户「要做什么」是 TUI 交互层的事(ESC 分级/回溯已由 App.js + rewindControl 覆盖),本叶子不越界。
 *   ② 部分回复文本由调用方从 liveRef 抓取注入(叶子零 IO,不读流状态);抓不到 → 仅记标记(仍是
 *   有效的中断信号,不假装有正文)。③ 标记用中文口径 `[用户已中断本次回复]`,语义对齐 CC 的
 *   `[Request interrupted by user]`。④ 门控关 / 坏输入 → null,整体不抛。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_INTERRUPT_MARKER 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function interruptionMarkerEnabled(env = process.env) {
  const raw = env && env.KHY_INTERRUPT_MARKER;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 中断标记文案(语义对齐 CC 的 [Request interrupted by user])。 */
const INTERRUPTION_NOTE = '[用户已中断本次回复]';

/**
 * 构造中断时应落进 assistant 回合的 content。
 *   门控关 → null(调用方 no-op,逐字节回退今日行为)
 *   门控开 → 有部分回复 → `${部分回复}\n\n${标记}`;无部分回复 → 仅 `${标记}`
 * @param {string} [partialText] 中断时已生成的部分回复(调用方从 liveRef 抓取注入)
 * @param {object} [env]
 * @returns {string|null}
 */
function buildInterruptedAssistantContent(partialText, env = process.env) {
  if (!interruptionMarkerEnabled(env)) return null;
  const partial = partialText == null ? '' : String(partialText).trim();
  if (partial) return `${partial}\n\n${INTERRUPTION_NOTE}`;
  return INTERRUPTION_NOTE;
}

module.exports = {
  interruptionMarkerEnabled,
  buildInterruptedAssistantContent,
  INTERRUPTION_NOTE,
};
