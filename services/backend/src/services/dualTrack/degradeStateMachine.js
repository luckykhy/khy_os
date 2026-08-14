'use strict';

/**
 * degradeStateMachine.js — 安全降级状态机（任务三 · 状态机流转 · 红线2/3）。
 *
 * 把「动作解析结果」映射到一个明确的流转状态，杜绝两种失败模式：
 *   - 白屏 / 崩溃（红线3：所有分支必有 default 兜底）。
 *   - 静默丢弃（红线2：未知指令必须显式占位 + 交还控制权）。
 *
 * 状态语义：
 *   - PROCEED          已知且可执行 → 自动执行（control='auto'）。
 *   - MANUAL_CONFIRM   未知 / 未定义指令状态 → 降级为「人工确认」，交还控制权
 *                      （control='human'），**绝不**自主执行、**绝不**静默丢弃。
 */

const { buildUnknownActionPlaceholder } = require('./unknownActionView');

const STATES = Object.freeze({
  PROCEED: 'PROCEED',
  MANUAL_CONFIRM: 'MANUAL_CONFIRM',
});

/**
 * 依据注册表解析结果决定流转。永不返回 undefined（红线3 默认分支）。
 *
 * @param {{isKnown:boolean, handler:(Function|null), origin:string}} resolution
 * @param {Object} action 归一化动作
 * @returns {{state, control:'auto'|'human', action, handler, placeholder, message, origin}}
 */
function decideFlow(resolution, action) {
  // 防御：解析结果缺失也要兜底，绝不崩。
  const res = resolution || { isKnown: false, handler: null, origin: 'unknown' };

  if (res.isKnown && typeof res.handler === 'function') {
    return {
      state: STATES.PROCEED,
      control: 'auto',
      action,
      handler: res.handler,
      placeholder: null,
      message: null,
      origin: res.origin,
    };
  }

  // default 分支：未知 / 无 handler / 未定义状态 → 人工确认，交还控制权。
  const placeholder = buildUnknownActionPlaceholder(action);
  return {
    state: STATES.MANUAL_CONFIRM,
    control: 'human',
    action,
    handler: null,
    placeholder,
    message: placeholder.message,
    origin: 'unknown',
  };
}

module.exports = { decideFlow, STATES };
