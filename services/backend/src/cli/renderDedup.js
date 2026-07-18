'use strict';

/**
 * renderDedup.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 渲染去重:杜绝「最终回复被打印两遍」。
 *
 * 复现痛点(用户截图):一回合执行了 shell 工具(`start https://…`)后,那句
 *   「已用 start 命令打开华为应用市场官网(…),默认浏览器应该已经跳转。」
 * 被**连续打印了两遍**。
 *
 * 根因(cli/repl.js):流式文本长度累加进 `streamState._streamedTextLen`,但
 * `streamState` 在**每轮工具循环迭代**都被重建清零。当循环自动续轮、末轮以**非流式**方式
 * 重述同一句结论时,末轮 `_streamedTextLen===0` → repl 的抑制门
 * `loopIterations>1 && finalResponse && _streamedTextLen>0` 不成立 → 不置
 * `responseAlreadyRendered` → 走到「无流式」分支把 `finalResponse` 整段**再渲一遍**。
 * `_streamedTextLen` 是「每迭代」量,无法回答「本回合是否已把这段文本展示给用户过」。
 *
 * 本叶子提供一个跨迭代视角的判据:给定「本回合累计已流式输出的原始文本」与「将要最终渲染
 * 的文本」,判断最终文本**是否已经是屏上内容的尾部**(即纯重复)。是 → 调用方据此抑制重渲。
 *
 * 设计取舍(刻意只判「完全重复」):
 *   - 比较的是 **raw token 文本 ↔ raw finalResponse 文本**(都在 markdown 渲染之前),
 *     故不受着色/换行渲染差异影响。
 *   - 归一化:折叠所有空白(`\s+` → '')后比较,吸收流式分片与最终串之间的空白/换行差异。
 *   - 仅当 `finalNorm` 非空 **且** `streamedNorm.endsWith(finalNorm)` 才判重复。末轮若产出
 *     **新内容**(文本不同 → 非尾部)一律 false → 调用方照常渲染,**绝不误伤**。
 *
 * 门控:KHY_RENDER_DEDUP(默认开)。=0/false/off/no → 关 → finalAlreadyStreamed 恒返回
 * false → 调用方维持历史「按 _streamedTextLen 抑制」逻辑,逐字节回退。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

function renderDedupEnabled(env = process.env) {
  const flag = String((env && env.KHY_RENDER_DEDUP) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

function _norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

/**
 * 最终文本是否已经在本回合流式输出过(纯重复)。
 * 门控关 → 恒 false(逐字节回退历史行为,抑制完全交给调用方既有 _streamedTextLen 逻辑)。
 *
 * @param {string} finalText     将要最终渲染的文本(如 loopResult.finalResponse)
 * @param {string} streamedText  本回合累计已流式输出的原始文本
 * @param {object} [env=process.env]
 * @returns {boolean} true=已展示过(应抑制重渲);false=未展示过或门控关(应正常渲染)
 */
function finalAlreadyStreamed(finalText, streamedText, env = process.env) {
  if (!renderDedupEnabled(env)) return false;
  const finalNorm = _norm(finalText);
  if (!finalNorm) return false;
  const streamedNorm = _norm(streamedText);
  if (!streamedNorm) return false;
  return streamedNorm.endsWith(finalNorm);
}

module.exports = {
  renderDedupEnabled,
  finalAlreadyStreamed,
};
