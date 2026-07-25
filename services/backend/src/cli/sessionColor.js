'use strict';

/**
 * sessionColor.js — 纯叶子(zero-IO,确定性):`/color` 命令背后的全部纯逻辑。
 *
 * 对齐 Claude Code `/color`(src/commands/color/color.ts):给**当前会话**设一个
 * 显示强调色(per-session),用于在多会话/多 agent 场景下一眼区分。CC 把颜色存进
 * transcript 并即时更新 AppState;khy 对应物 = 存进会话元数据(持久),并喂给 Ink TUI
 * 输入框 `PromptFrame` 既有的 `accent` 入参(边框 + `❯` 标记的颜色)。
 *
 * **背后逻辑**(调色板校验、reset 别名识别、参数解析、accent 解析优先级、措辞)全在
 * 这里,确定性、零 IO、零业务 require。当前会话 id、读写会话元数据是副作用,留在薄壳
 * `handlers/color.js`;TUI 消费侧只把 `resolveAccent` 的结果当 accent 用。
 *
 * 门控 KHY_SESSION_COLOR 默认开;关 → resolveAccent 忽略 sessionColor(TUI accent 字节
 * 回退到 mode 驱动/cyan),命令侧也不接管。
 */

// 调色板与 khy agent 颜色一致(src/agents/types.js 的 AGENT_COLORS),叶子内联避免业务 require。
const AGENT_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'cyan', 'yellow', 'magenta'];

// reset 别名(对齐 CC RESET_ALIASES,补 khy 习惯)。命中 → 清除会话色回到默认。
const RESET_ALIASES = ['default', 'reset', 'none', 'gray', 'grey', '默认', '重置'];

function isEnabled(env) {
  const raw = env && env.KHY_SESSION_COLOR;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 归一输入:小写 trim;空 → ''。 */
function normalizeColor(input) {
  return String(input == null ? '' : input).trim().toLowerCase();
}

function isReset(input) {
  return RESET_ALIASES.includes(normalizeColor(input));
}

function isValidColor(input) {
  return AGENT_COLORS.includes(normalizeColor(input));
}

/** 从 token 数组取第一个非空作为颜色参数(其余忽略,对齐 CC 单参语义)。 */
function parseColorArgs(tokens) {
  const list = Array.isArray(tokens) ? tokens : [tokens];
  for (const t of list) {
    const s = normalizeColor(t);
    if (s) return s;
  }
  return '';
}

/**
 * 解析 TUI 输入框 accent(消费侧单一真源)。优先级对齐 App.js 既有逻辑:
 *   bashMode(`!`) → 'magenta';memoryMode(`#`) → 'green';
 *   否则门控开且会话色有效 → 会话色;否则 null(= PromptFrame 默认 cyan)。
 * 门控关 → 完全忽略 sessionColor → 与历史逐字节一致。
 */
function resolveAccent(p = {}) {
  if (p.bashMode) return 'magenta';
  if (p.memoryMode) return 'green';
  if (!isEnabled(p.env)) return null;
  const c = normalizeColor(p.sessionColor);
  if (c && isValidColor(c) && !isReset(c)) return c;
  return null;
}

function formatList() {
  return '请提供颜色。可用颜色:' + AGENT_COLORS.join('、') + '、default(重置)。\n用法:/color <颜色> · /color default(重置)。';
}

function formatInvalid(input) {
  return '无效颜色「' + normalizeColor(input) + '」。可用颜色:' + AGENT_COLORS.join('、') + '、default(重置)。';
}

function formatSet(color) {
  return '已将当前会话强调色设为:' + normalizeColor(color) + '(输入框边框与 ❯ 标记即时生效,并随会话持久化)。';
}

function formatReset() {
  return '已将当前会话强调色重置为默认(cyan)。';
}

module.exports = {
  AGENT_COLORS,
  RESET_ALIASES,
  isEnabled,
  normalizeColor,
  isReset,
  isValidColor,
  parseColorArgs,
  resolveAccent,
  formatList,
  formatInvalid,
  formatSet,
  formatReset,
};
