'use strict';

/**
 * inlineImageOcrGuardPolicy.js — 「消息里出现了本地图片路径，但本轮并没有图片附件」
 * 时，注入一条禁止模型自己 DIY OCR 死循环的诚实指令的确定性单一真源。
 *
 * 背景（用户目标 2026-06-28「识别图片 / 修复识别图片问题」）：用户在 web/协作通道里
 * 打字粘了一个本地图片路径（例如 clipboard-img2file 截图路径）+「识别图片」。该通道后端
 * 此前从不把消息文本里的路径转成图片附件（只解析上传附件），于是路径以纯文本进 agentic
 * 路径，纯文本模型（如 sensenova-6.7-flash-lite）就反复 Read 路径 + Bash 跑 python/PIL/
 * tesseract 自己 OCR，最终撞上 read-only 循环守卫被 block —— 一次「没附上图」被放大成
 * 可见灾难。
 *
 * Layer 1（aiManagementServer._resolveChatAttachments）补齐了「打字粘路径 → 图片附件」，
 * 让既有视觉/OCR/诚实提示路由接手；本叶子是 Layer 2 —— 与具体通道无关的护栏：只要进到
 * 模型这一层时「消息含可识别图片路径 **且** 本轮没有任何图片附件」，就注入指令命令模型
 * 绝不自己 shell 出去 OCR、绝不反复 Read/Bash 该路径，改用 khy 原生视觉/OCR，或如实告知
 * 看不到图、让用户上传/附图/换视觉模型。覆盖现在与未来所有新 chat 入口。
 *
 * 「消息是否含图片路径」复用既有叶子 cli/repl/imageIntent.extractInlineImageIntent
 * （单一真源；仅匹配 png/jpg/jpeg/gif/webp，不重写正则、安全范围与 REPL 一致）。
 *
 * 纯叶子：零 IO、确定性、绝不抛。env 门控 KHY_INLINE_IMAGE_OCR_GUARD（默认开，仅显式
 * 0/false/off/no 关闭；关闭后 build* 恒返回 null，行为字节回退到无护栏）。env 经 opts
 * 注入可测。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。默认开，仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_INLINE_IMAGE_OCR_GUARD;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 注入文案首行标记，供调用方去重（prompt 已含本段则不重复注入）。
const GUARD_NOTE_MARKER = '[图片路径未附图]';

/**
 * 消息文本里是否含一个可识别的本地图片路径。
 * 复用 imageIntent.extractInlineImageIntent（单一真源），lazy-require + try/catch 兜底，
 * 任何加载/解析异常都视为「未检出」而非抛出。
 * @param {string} message
 * @returns {boolean}
 */
function messageHasImagePath(message) {
  const text = String(message || '');
  if (!text) return false;
  try {
    const { extractInlineImageIntent } = require('../../cli/repl/imageIntent');
    const intent = extractInlineImageIntent(text);
    return !!(intent && intent.filePath);
  } catch {
    return false;
  }
}

/**
 * 产出「消息含图片路径但本轮无图片附件」时注入 prompt 的护栏指令（面向模型）。
 *
 * 仅当 ① 门控开 ② 消息含可识别图片路径 ③ 本轮没有任何图片附件 三者皆真时返回指令字符串，
 * 否则返回 null（调用方据此字节回退、不注入）。
 *
 * 纯字符串构造：零 IO、确定性、绝不抛。
 *
 * @param {object} [input]
 * @param {string} [input.message]            本轮用户消息文本
 * @param {boolean} [input.hasAttachedImage]  本轮是否已带图片附件
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildInlineImageOcrGuardDirective(input = {}) {
  try {
    if (!isEnabled(input.env)) return null;
    if (input.hasAttachedImage) return null;
    if (!messageHasImagePath(input.message)) return null;
    return [
      `${GUARD_NOTE_MARKER} 用户消息里给出了一个本地图片路径，但本轮并没有把图片作为附件传给你，`,
      '你看不到这张图的像素内容。请严格遵守：',
      '  1) 绝不要自己 shell 出去用 python / PIL / pytesseract / tesseract 等对该路径做 OCR，',
      '     也绝不要反复 Read / Bash 这个路径试图「读出」图片——khy 有原生视觉/OCR 路由会处理图片，',
      '     你这样手动 OCR 只会失败并陷入死循环；',
      '  2) 如果你确实拿不到图片内容，就如实告诉用户「我这一侧没有真正收到这张图」，',
      '     并给出可行方案：直接上传/附上图片，或在支持视觉的模型下重发（运行 `khy gateway model` 选择），',
      '     或把图中文字粘贴过来；',
      '  3) 绝不臆测或编造图片里的内容。',
    ].join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  messageHasImagePath,
  buildInlineImageOcrGuardDirective,
  GUARD_NOTE_MARKER,
};
