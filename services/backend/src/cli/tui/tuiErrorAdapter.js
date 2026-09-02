'use strict';

/**
 * tuiErrorAdapter.js — TUI 错误推流的适配层。
 *
 * 目的：把 TUI 内部 20+ 处 `push('error', msg)` 收敛到结构化错误通道，
 * 让 TUI 消息体本身就带 category / severity 前缀与可执行的「下一步」。
 *
 * 设计取舍：TUI 是单向消息流（message → transcript），没有面板空间，
 * 所以这里用**单行 + 前缀**的形式：
 *   [error] 配置问题 · MODEL_NOT_FOUND · 模型标识不存在
 *   ℹ 提示：用 /models 刷新列表后重试
 *
 * 调用方不直接 push('error', ...) 了；改 push('error', tuiErrorOf(err, ctx))
 * —— ctx = { action?, target?, progress? }。
 *
 * 集成方式：
 *   - 不引入新依赖，共享 reportKhyError 的归类能力，但避开其打印逻辑
 *     （TUI 不走 stdout，让 ink-components 渲染）。
 *   - 不破坏既有 push('error', string) 签名 —— 给一个字符串工厂函数，
 *     调用方改 push('error', tuiErrorOf(err)) 而非 push('error', err.message)。
 */

const { ensureKhyError } = require('../../utils/classifyKhyError');
const { getCategorySpec } = require('../../utils/khyErrorCategory');
const { redactSensitiveText } = require('../../services/errorClassifier');

/**
 * 把任意错误规整成 TUI 消息流可消化的「带前缀单行」。
 * 始终返回 string，不返回对象 —— TUI 现有消息流按字符串渲染。
 *
 * @param {*} err
 * @param {object} [ctx]
 * @param {string} [ctx.action]
 * @param {string} [ctx.target]
 * @param {string} [ctx.progress]
 * @returns {string}
 */
function tuiErrorOf(err, ctx = {}) {
  const env = ensureKhyError(err);
  const sev = env.severity || 'error';
  const cat = getCategorySpec(env.category);
  const code = env.code || 'UNKNOWN';
  const safeMessage = redactSensitiveText(env.message || code);
  const safeHint = env.hint ? redactSensitiveText(env.hint) : '';
  const ctxTag = _ctxTag(ctx);
  // 单行格式：[{severity}] [{category}] [{code}]{ctxTag} {message} | 提示：{hint}
  // TUI 气泡组件会按 `|` 拆成主行 + 副行，主行加粗、副行 dim。
  const main = `[${sev}] ${cat.label} · ${code}${ctxTag} ${safeMessage}`;
  const sub = safeHint ? `提示：${safeHint}` : '';
  return sub ? `${main} | ${sub}` : main;
}

/**
 * 简短上下文标签：把 action/target/progress 压成 ` ·刷新模型 ·Claude ·第2/3次`。
 * 缺字段就跳过；整体空就返回空串。
 */
function _ctxTag(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  if (ctx.action) parts.push(String(ctx.action));
  if (ctx.target) parts.push(String(ctx.target));
  if (ctx.progress) parts.push(String(ctx.progress));
  return parts.length ? ` · ${parts.join(' · ')} ` : '';
}

module.exports = {
  tuiErrorOf,
  _internals: { _ctxTag },
};