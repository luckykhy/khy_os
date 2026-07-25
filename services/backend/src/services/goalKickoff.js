'use strict';

/**
 * goalKickoff.js — 持久目标「设定即开跑」的 kickoff 文案 + 页脚 elapsed 格式化单一真源。
 *
 * 诉求(goal 2026-07-03「/goal 对齐 Claude Code」·两张截图取证):CC 的 `/goal <condition>`
 * 直接吃 freeform 文本设定目标,并**立即开始执行**(截图显示设定后即 `Crystallizing…`),页脚
 * 常驻 `◎ /goal active (Nm)` 指示器。khy 此前:(1)`/goal <文本>` 丢弃 freeform 文本只显示状态
 * (handlers/goal 死代码回退未被 parser 触达);(2)即便设上也全被动——per-turn 注入
 * (goalStore.advanceActiveGoalDirective)与 stop-gate re-drive(goalStopGate)都只在用户已发起
 * 一轮之后才生效,**没有 idle 自动开跑**。
 *
 * 本叶子补两件纯逻辑:
 *   - buildGoalKickoffMessage:设定目标那一刻要 aiForward 的「首轮驱动」文本(命令模型即刻朝目标
 *     推进、朝有限交付物收敛、达成即调 GoalTool(action=clear))。与 goalStopGate.buildRedriveMessage
 *     语气对齐但区分职责——那是「想停时」的 re-drive,这是「刚设定时」的 kickoff。
 *   - formatGoalElapsed:页脚 `◎ /goal active (Nm)` 里的已持续时长标签(createdAt ISO → '4m'/'1h2m')。
 *
 * 本叶子是**纯叶子**:零 IO、确定性、绝不抛、可单测。活动目标的读取/持久化等 IO 由调用方
 * (handlers/goal 的 set 路径 / FooterBar 的页脚注入)落地。
 *
 * ── 门控 ────────────────────────────────────────────────────────────────
 *   KHY_GOAL_AUTODRIVE  「设定即自动开跑」总开关,默认开(仅显式 0/false/off/no 关)。
 *                        **嵌套父门控 KHY_GOAL**:父关则整个持久目标关,本门也关。关闭后
 *                        buildGoalKickoffMessage 返 null → handlers/goal 只设定不 aiForward
 *                        (逐字节回退到「设定但等用户下一条消息才推进」的旧行为)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 「设定即自动开跑」是否启用。嵌套父门控 KHY_GOAL:父显式关 → 本门也关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isAutoDriveEnabled(env) {
  const e = env || process.env || {};
  if (_off(e.KHY_GOAL)) return false;            // 父门控关 → 整个持久目标关
  return !_off(e.KHY_GOAL_AUTODRIVE);
}

/**
 * 构建「刚设定目标」时要 aiForward 的首轮驱动文本。给模型一条明确起跑令:立即朝目标推进、朝
 * 有限交付物收敛、达成即出报告并调 GoalTool(action=clear) 收尾。门控关 → 返回 null(不自动开跑)。
 * @param {object} goal - 刚设定的活动目标(需 goal.text)
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {string|null}
 */
function buildGoalKickoffMessage(goal, { env } = {}) {
  if (!isAutoDriveEnabled(env)) return null;
  const text = String((goal && goal.text) || '').trim();
  if (!text) return null;
  return [
    '[SYSTEM: 已设定持久目标 —— 现在立即开始朝它推进(对齐 Claude Code /goal:设定即执行,不要等用户再发消息)。',
    `目标:「${text}」`,
    '要求:',
    '① 立即动手 —— 调用工具、执行下一步,不要停在计划或前言上,也不要反问"接下来做什么";',
    '② 朝一个**有限、可验收的交付物**收敛,而不是无边界发散;',
    '③ 目标达成后 —— 给出明确的完成报告(做了什么 / 如何验证 / 结果),并调用 GoalTool(action=clear) 收尾。',
    ']',
  ].join('\n');
}

// 时间单位常量(SSOT)。
const _MS_PER_MIN = 60 * 1000;
const _MIN_PER_HOUR = 60;
const _HOUR_PER_DAY = 24;

/**
 * 页脚 `◎ /goal active (Nm)` 里的已持续时长标签。createdAt ISO → 紧凑标签:
 *   <1 分钟 → '0m';分钟级 → '4m';跨小时 → '1h2m';跨天 → '2d3h'。
 * 非法 / 未来时间 / 缺失 → 返回 '0m'(安全),绝不抛。
 * @param {string} createdAtIso - goal.createdAt(ISO 字符串)
 * @param {number} nowMs - 当前时间戳(由调用方传入,保持可测)
 * @returns {string}
 */
function formatGoalElapsed(createdAtIso, nowMs) {
  let startMs = NaN;
  try { startMs = Date.parse(String(createdAtIso == null ? '' : createdAtIso)); } catch { startMs = NaN; }
  const now = Number(nowMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(now)) return '0m';
  let deltaMin = Math.floor((now - startMs) / _MS_PER_MIN);
  if (!Number.isFinite(deltaMin) || deltaMin < 0) deltaMin = 0;

  if (deltaMin < _MIN_PER_HOUR) return `${deltaMin}m`;
  const totalHours = Math.floor(deltaMin / _MIN_PER_HOUR);
  const mins = deltaMin % _MIN_PER_HOUR;
  if (totalHours < _HOUR_PER_DAY) return `${totalHours}h${mins}m`;
  const days = Math.floor(totalHours / _HOUR_PER_DAY);
  const hours = totalHours % _HOUR_PER_DAY;
  return `${days}d${hours}h`;
}

module.exports = {
  isAutoDriveEnabled,
  buildGoalKickoffMessage,
  formatGoalElapsed,
};
