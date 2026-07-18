'use strict';

// chatChords.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:把「CC 对齐的 Chat/Global 级快捷键 → 动作名」这条决策收敛成**单一真源纯叶子**,供
// Ink TUI 全局输入链(App.js)薄壳分派。叶子只做「按键 → 动作名」的纯映射,绝不执行动作
// (打开 ModelPicker / 切 fast/thinking / 显隐任务面板都涉及 React 状态与 ai() 副作用,留薄壳)。
//
// 背景(对齐 Claude Code keybindings/defaultBindings.ts):
//   Chat 上下文里 CC 定义了一组「功能级」chord:
//     - meta+p → chat:modelPicker     (打开模型选择器)
//     - meta+o → chat:fastMode        (切换快速模式)
//     - meta+t → chat:thinkingToggle  (切换扩展思考)
//   Global 上下文:
//     - ctrl+t → app:toggleTodos      (显隐任务/待办清单面板)
//   khy 这四个动作背后的功能**都已存在**(openModelPicker / handleFlag('fast') /
//   handleFlag('thinking') / 任务清单面板),此前只缺这组**键位入口**——本叶子补齐这条缺口
//   (goal「缺少的补全」),且与 CC 的键位逐一对应(goal「与 CC 对齐」)。
//
// 诚实边界(刻意不纳入,均为 khy 暂无对应功能或会引入假功能):
//   - CC ctrl+g/ctrl+x ctrl+e=externalEditor、ctrl+s=stash、ctrl+_=undo、meta+y=yank-pop:
//     khy 无对应功能/无 undo 栈/无 yank-pop 链 → 造半成品违背诚实红线,列为 deferred(见 GUARDS)。
//   - CC ctrl+r=history:search(反向增量历史搜索)**已实现**:不在本叶子(它只映射 Chat/Global
//     功能级 chord),而由 App.js 顶层 useInput + 纯叶子 services/keybindings/historyReverseSearch
//     驱动(门控 KHY_HISTORY_REVERSE_SEARCH),复用既有 ~/.khyquant_history 持久化,故此处不再列为 deferred。
//   - CC ctrl+o=toggleTranscript 与 khy ctrl+o=展开过程组/工具输出语义不同,khy 的是既有合理功能,
//     不为「对齐」而破坏它(honest-NA)。
//
// 门控 KHY_CHAT_CHORDS 默认开;关 → resolveChatChord 恒返 null → 这些键逐字节回退为「落到
// textInput」的历史行为(meta+p/o/t、ctrl+t 此前在 textInput 链均为 no-op,故关 = 字节回退现状)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 平台相关:Windows 上 Alt+V(meta+v)是图片粘贴键(Ctrl+V 是系统粘贴),与 meta+o/p/t 同族但
// 由 App.js 既有图片粘贴分支先行处理,本叶子不碰 'v'。

/**
 * CC 对齐的 Chat/Global 级 chord 默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_CHAT_CHORDS;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 把一次按键解析成 CC 对齐的动作名(纯映射,绝不执行)。
 *
 * @param {{ key?: object, input?: string }} ev - ink useInput 的 (input, key)
 *   - key.meta / key.ctrl / key.shift 修饰位;input 为字符(ink 对 Alt+letter 给 meta+letter)。
 * @param {object} [env]
 * @returns {('modelPicker'|'fastMode'|'thinkingToggle'|'toggleTasks'|null)}
 *   命中返回动作名,否则 null(含门控关、缺参、带 ctrl/shift 干扰位的 meta 组合)。
 */
function resolveChatChord(ev = {}, env = process.env) {
  if (!isEnabled(env)) return null;
  const e = (ev && typeof ev === 'object') ? ev : {};
  const key = (e.key && typeof e.key === 'object') ? e.key : {};
  const input = typeof e.input === 'string' ? e.input.toLowerCase() : '';
  if (!input) return null;

  const meta = !!key.meta;
  const ctrl = !!key.ctrl;
  const shift = !!key.shift;

  // Meta(Alt/Option)+ 字母 —— 必须是「纯 meta」(不带 ctrl,避免与其他组合冲突)。
  // shift 不计较(部分终端 Alt 组合带 shift 位),但 ctrl 同时按下则不是这组 chord。
  if (meta && !ctrl) {
    if (input === 'p') return 'modelPicker';     // CC chat:modelPicker
    if (input === 'o') return 'fastMode';        // CC chat:fastMode
    if (input === 't') return 'thinkingToggle';  // CC chat:thinkingToggle
    return null;
  }

  // Ctrl+T —— 纯 ctrl(不带 meta/shift),显隐任务清单面板。CC app:toggleTodos。
  if (ctrl && !meta && !shift && input === 't') return 'toggleTasks';

  return null;
}

module.exports = {
  isEnabled,
  resolveChatChord,
  OFF_VALUES,
};
