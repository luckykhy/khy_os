'use strict';

/**
 * unknownActionView.js — 未知指令安全占位符（任务三 · UI 渲染层 · 红线2）。
 *
 * 红线2（严禁静默吞没）+ UI 渲染层约束：未来模型返回当前无法识别的 action type 时，
 * **绝不**白屏崩溃、**绝不**静默丢弃，而是产出一个永远可渲染的占位描述符，显式声明
 * 「当前版本不支持，可通过扩展实现」，并附带原始数据查看入口（rawDataView）。
 *
 * 该模块只产出**数据描述符**（与 UI 框架无关），由 TUI / Web 安全渲染；后端不持有像素。
 */

const RAW_VIEW_MAX = 4000; // 原始数据视图字符上限，防止超大体把 UI 撑爆

function safeStringifyRaw(raw) {
  let s;
  try {
    s = JSON.stringify(raw, null, 2);
  } catch (_) {
    // 循环引用等：降级为粗略字符串，绝不抛错。
    try { s = String(raw); } catch (_e) { s = '<unrepresentable>'; }
  }
  if (typeof s !== 'string') s = String(s);
  if (s.length > RAW_VIEW_MAX) {
    s = s.slice(0, RAW_VIEW_MAX) + `\n…(已截断，共 ${s.length} 字符)`;
  }
  return s;
}

/**
 * 构造未知动作占位符。任何输入都返回 renderable:true 的结构（严禁白屏）。
 *
 * @param {Object} action 归一化后的动作（含 type / _raw）
 * @returns {{kind, actionType, title, message, canExtend, rawDataView, renderable}}
 */
function buildUnknownActionPlaceholder(action) {
  const actionType = (action && action.type) ? String(action.type) : '<unknown>';
  return {
    kind: 'unknown-action-placeholder',
    actionType,
    title: `未知指令：${actionType}`,
    message: '当前版本不支持该指令，可通过用户扩展轨（user_patch/）实现',
    canExtend: true,
    rawDataView: safeStringifyRaw(action && action._raw !== undefined ? action._raw : action),
    renderable: true,
  };
}

module.exports = { buildUnknownActionPlaceholder, RAW_VIEW_MAX };
