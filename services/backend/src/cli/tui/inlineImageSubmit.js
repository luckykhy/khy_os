'use strict';

/**
 * inlineImageSubmit.js — TUI 提交期「打字/粘贴本地图片路径 → 图片附件」的接缝。
 *
 * 背景(goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐」):classic
 * readline REPL 在提交时会用 `extractInlineImageIntent` 把消息里的本地图片路径
 * (`file:///…png`、`C:\…\shot.png`、`/path/img.jpg`)抽出来,经 `imageService.readImageFromFile`
 * 转成图片附件走视觉/OCR 路由(repl.js:5003-5022)。Ink TUI 的 `handleSubmit` 从不做这步,
 * 粘的路径原样当纯文本发给模型——正是「模型谎称没收到图」类问题在 TUI 通道的复现入口。
 * 本接缝把 TUI 拉齐到与 REPL、web 通道(aiManagementServer._resolveChatAttachments)同一行为。
 *
 * 「消息是否含图片路径 / 提示词怎么写」**复用既有单一真源** `cli/repl/imageIntent`
 * (`extractInlineImageIntent`,仅匹配 png/jpg/jpeg/gif/webp,安全范围与 REPL 一致,不重写正则);
 * 读图复用 `services/imageService.readImageFromFile`(含引号剥离 / file:// / 大小 / 魔数格式校验)。
 *
 * 薄 IO(读一次图片文件):确定性、**绝不抛**。失败一律退回「原文不动、无图」,与 REPL
 * `repl.js:5020` catch 分支同语义。env 门控 `KHY_TUI_INLINE_IMAGE_PATH`(默认开,仅显式
 * 0/false/off/no 关闭;关闭后逐字节回退到「不提取」)。env 经 opts 注入可测。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。默认开,仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_TUI_INLINE_IMAGE_PATH;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 解析一次提交文本里的内联图片路径。
 *
 * 命中且读图成功 → 返回 `{ text: <提示词>, images: [{ base64, mimeType }] }`
 * (路径已从提示里剥掉,prompt 由 imageIntent 的上下文构造给出)。
 * 门控关 / 无路径 / 读图失败 → 返回 `{ text: <原文>, images: [] }`,绝不抛。
 *
 * @param {string} text                  本轮提交的原始文本
 * @param {object} [opts]
 * @param {object} [opts.env]            注入 env(测试用)
 * @returns {{ text: string, images: Array<{base64:string, mimeType:string}> }}
 */
function resolveInlineImageSubmit(text, opts = {}) {
  const original = String(text == null ? '' : text);
  try {
    if (!isEnabled(opts.env)) return { text: original, images: [] };
    const { extractInlineImageIntent } = require('../repl/imageIntent');
    const intent = extractInlineImageIntent(original);
    if (!intent || !intent.filePath) return { text: original, images: [] };
    const { readImageFromFile } = require('../../services/imageService');
    const image = readImageFromFile(intent.filePath);
    if (!image || !image.base64) return { text: original, images: [] };
    return {
      text: intent.prompt || '请描述这张图片',
      images: [{ base64: image.base64, mimeType: image.mimeType }],
    };
  } catch {
    // parity with repl.js:5020 — 读不出就当纯文本发,绝不打断提交。
    return { text: original, images: [] };
  }
}

module.exports = {
  isEnabled,
  resolveInlineImageSubmit,
};
