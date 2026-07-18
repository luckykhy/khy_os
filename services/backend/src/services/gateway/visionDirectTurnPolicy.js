'use strict';

/**
 * visionDirectTurnPolicy.js — 「带内联图片的 agentic 直连轮该如何对待工具」的单一真源。
 *
 * 背景:codex direct 模式(Responses API)的 agentic 循环对**第一轮**强制
 * `tool_choice:'required'`(见 codexAdapter `runCodexDirect`),目的是逼「编码任务」
 * 立刻动手调工具、而不是只回纯文本说明。但当用户只是**附了一张图、要求描述/分析**时,
 * 纯文本回答恰恰是正确的——强制工具调用会让模型**幻觉**出一个磁盘文件名
 * (如 `sample_inspect.png`)去 Read,得到 ENOENT 后继续乱找,做了一堆多余的事。
 * 而且图片是作为内联 `input_image` 块直接送进上下文的,旁边**没有任何文字说明**告诉
 * 模型「图已内联、直接看就行、磁盘上没有对应文件」。
 *
 * 本叶子把两条决策收口为单一真源:
 *   1. shouldForceFirstToolCall —— 带图的第一轮**不强制**工具调用(改 'auto',仍允许
 *      模型在文本确实需要时自行调工具,如「看这张截图修 app.js 的 bug」),从而纯描述
 *      请求可直接出文本答案。
 *   2. buildInlineImageNote —— 生成一条简短说明,前置到用户文本里,告诉模型图已内联、
 *      不要用 Read/Glob 去当文件打开。
 *
 * 纯叶子:零外部依赖、无副作用、env 经 opts 注入可测、绝不抛、门控关即字节回退。
 */

// 门控关闭判据(沿用全网关惯例:仅这些值算「关」,其余一律默认开)。
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控是否开启(默认开;仅 KHY_VISION_DIRECT_DESCRIBE ∈ {0,false,off,no} 时关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env;
  const raw = e && e.KHY_VISION_DIRECT_DESCRIBE;
  if (raw == null) return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * 该轮是否应强制工具调用(tool_choice:'required')。
 *
 * 既有 legacy 行为:仅第一轮(iteration===0)强制。门控开且本轮带内联图片时,**不**强制
 * (让纯描述请求能直接出文本;带图的真编码请求用 'auto' 仍可自行调工具)。
 *
 * @param {{iteration:number, hasImage:boolean, env?:object}} params
 * @returns {boolean}  true → 强制 'required';false → 'auto'
 */
function shouldForceFirstToolCall(params = {}) {
  const iteration = Number(params.iteration);
  const isFirstRound = iteration === 0;
  const env = params.env || process.env;

  // 门控关 → 逐字节回退到 legacy:仅第一轮强制。
  if (!isEnabled(env)) return isFirstRound;

  // 门控开 → 第一轮且**无**内联图片时才强制;带图则放手(返回 false → 'auto')。
  return isFirstRound && !params.hasImage;
}

/**
 * 生成「图片已内联」的简短说明,前置到用户文本,阻止模型把内联图当磁盘文件去 Read。
 *
 * @param {{count:number, env?:object}} params
 * @returns {string|null}  门控关 / count<=0 → null(不注入,字节回退)
 */
function buildInlineImageNote(params = {}) {
  const env = params.env || process.env;
  if (!isEnabled(env)) return null;

  const count = Number(params.count);
  if (!Number.isFinite(count) || count <= 0) return null;

  const n = Math.floor(count);
  const noun = n === 1 ? '一张图片' : `${n} 张图片`;
  return (
    `[图片说明] 用户已随本条消息内联附加了${noun},它们已作为图像直接呈现、你能直接看到其内容。`
    + `请直接观察并据此回答;这些是内联图像,磁盘上没有对应文件——`
    + `不要用 Read / Glob / Bash 等工具去打开、读取或查找它们。`
  );
}

module.exports = {
  isEnabled,
  shouldForceFirstToolCall,
  buildInlineImageNote,
};
