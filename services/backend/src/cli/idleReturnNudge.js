'use strict';

/**
 * idleReturnNudge.js — 久别重返轻提示的决策与文案。**纯叶子**（零 IO、确定性、
 * 绝不抛、门控字节回退）。移植 Claude Code idle-return「背后的逻辑」：
 *
 *   CC src/screens/REPL.tsx:4160-4183      提交时判定
 *   CC src/components/IdleReturnDialog.tsx  文案 + formatIdleDuration
 *
 * CC 逻辑：用户提交新输入时，若「距上次回合完成的空闲分钟数 >= 阈值(默认 75)」且
 * 「当前对话输入侧 token >= 阈值(默认 100k)」且未被「不再提醒」关闭，则提示重开会话
 * （缓存已凉，新任务 /clear 更快更省）。CC 的 tengu_willow_mode 有 'dialog'(阻塞)/
 * 'hint'(通知)/'off' 三档。
 *
 * khy 移植取 **'hint' 档**（CC 自身认可的轻量档）：不阻塞、不改写/不拦截用户提交，
 * 只在提交旁浮现一行一次性通知。放弃 CC 的阻塞对话框（khy Ink TUI 无阻塞对话基建，
 * 且非阻塞更契合「不打断」）——诚实分歧。thresholds 由 env 覆盖，语义对齐 CC 同键。
 *
 * 本叶子只做**决策 + 文案**：lastCompletionMs / nowMs / totalInputTokens / input 全由
 * 调用方（useQueryBridge）传入，绝不读时钟/读盘。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const GATE = 'KHY_IDLE_RETURN_NUDGE';
const DEFAULT_IDLE_MIN = 75;
const DEFAULT_TOKEN_THRESHOLD = 100000;

function idleReturnEnabled(env) {
  const raw = env && env[GATE];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

function _threshold(env, key, def) {
  const raw = env && env[key];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// CC formatIdleDuration 的中文对应：<1→「不到 1 分钟」，<60→「N 分钟」，
// 整点→「N 小时」，否则「N 小时 M 分钟」。
function formatIdleDuration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 1) return '不到 1 分钟';
  if (m < 60) return `${Math.floor(m)} 分钟`;
  const hours = Math.floor(m / 60);
  const rem = Math.floor(m % 60);
  return rem === 0 ? `${hours} 小时` : `${hours} 小时 ${rem} 分钟`;
}

/**
 * 判定是否应在本次提交旁浮现重返提示。返回 {idleMinutes, tokens} 或 null。
 * 镜像 CC REPL.tsx 的条件链（去掉 tengu_willow_mode 特性开关，改 khy env 门控）。
 * @param {Object} state {input, lastCompletionMs, nowMs, totalInputTokens}
 * @param {Object} env
 */
function shouldNudgeOnReturn(state, env) {
  try {
    if (!idleReturnEnabled(env)) return null;
    if (!state || typeof state !== 'object') return null;
    const input = typeof state.input === 'string' ? state.input : '';
    const trimmed = input.trim();
    // 空输入 / 斜杠命令 不提示（对齐 CC !input.trim().startsWith('/')）。
    if (!trimmed || trimmed.startsWith('/')) return null;
    const lastCompletionMs = Number(state.lastCompletionMs);
    if (!Number.isFinite(lastCompletionMs) || lastCompletionMs <= 0) return null;
    const nowMs = Number(state.nowMs);
    if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
    const tokens = Number(state.totalInputTokens);
    const tokenThreshold = _threshold(env, 'KHY_IDLE_TOKEN_THRESHOLD', DEFAULT_TOKEN_THRESHOLD);
    if (!Number.isFinite(tokens) || tokens < tokenThreshold) return null;
    const idleMinutes = (nowMs - lastCompletionMs) / 60000;
    const minThreshold = _threshold(env, 'KHY_IDLE_THRESHOLD_MINUTES', DEFAULT_IDLE_MIN);
    if (!(idleMinutes >= minThreshold)) return null;
    return { idleMinutes, tokens };
  } catch {
    return null;
  }
}

/**
 * 由决策产出一行提示文案；无决策 → null。token 数走 ccFormat SSOT（门控关/不可用 → 裸数回退）。
 */
function buildIdleReturnHint(decision, env) {
  try {
    if (!decision || typeof decision !== 'object') return null;
    const idleMinutes = Number(decision.idleMinutes);
    const tokens = Number(decision.tokens);
    if (!Number.isFinite(idleMinutes) || !Number.isFinite(tokens)) return null;
    let tokStr = `${tokens}`;
    try {
      // eslint-disable-next-line global-require
      const { ccFormatTokensOr } = require('./ccFormat');
      if (typeof ccFormatTokensOr === 'function') {
        tokStr = ccFormatTokensOr(tokens, `${tokens}`, env) || `${tokens}`;
      }
    } catch {
      /* SSOT 不可用 → 裸数回退 */
    }
    return `你已离开 ${formatIdleDuration(idleMinutes)} · 当前对话约 ${tokStr} tokens。若这是新任务，用 /clear 清空上下文会更快更省。`;
  } catch {
    return null;
  }
}

/**
 * 顶层便捷：判定 + 文案一步到位。返回提示串或 null。
 */
function idleReturnHintFor(state, env) {
  const decision = shouldNudgeOnReturn(state, env);
  if (!decision) return null;
  return buildIdleReturnHint(decision, env);
}

module.exports = {
  idleReturnEnabled,
  formatIdleDuration,
  shouldNudgeOnReturn,
  buildIdleReturnHint,
  idleReturnHintFor,
};
