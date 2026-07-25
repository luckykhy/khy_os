'use strict';

/**
 * plainTextImageDegrade.js — 纯文本模型多模态降级的单一真源。
 *
 * 背景：消息 content 里可能内联图像块（Anthropic `{type:'image',source}` 或
 * OpenAI `{type:'image_url',image_url}`）。当目标适配器/模型只支持纯文本时，
 * 历史行为四种各异：透传报错、OCR 转文本、加英文 Note 降级、或经 flatten 静默丢弃。
 * 最严重的是 contentToText/flattenContent 对 image 块**无分支 → 无声丢弃**，
 * 模型既看不到图也不知道用户发过图。
 *
 * 本模块把"纯文本通道遇到图像如何降级"收口为单一真源：
 * - 占位符常量与生成（消除静默丢弃，让 flatten 后的文本保留"此处有图"信号）
 * - 统一的降级提示文案（替代各适配器散落的英文 Note）
 *
 * 纯叶子：零外部依赖、无副作用、可注入测试（DESIGN-ARCH 风格）。
 */

// 占位符跟随仓库既有惯例（proxyServer.js 的 '[image]'），小写、英文，
// 中英文模型都能理解，且不与正文中文混排造成歧义。
const IMAGE_PLACEHOLDER = '[image]';

/**
 * 判断一个 content 块是否为图像块（同时认 Anthropic 与 OpenAI 两种风格）。
 * @param {*} block
 * @returns {boolean}
 */
function isImageBlock(block) {
  if (!block || typeof block !== 'object') return false;
  return block.type === 'image' || block.type === 'image_url';
}

/**
 * 从图像块提取 MIME 标签（尽力而为，取不到返回空串）。
 * 支持 Anthropic `source.media_type`、data URL 内联类型。
 * @param {*} block
 * @returns {string}
 */
function extractImageMime(block) {
  if (!block || typeof block !== 'object') return '';
  // Anthropic: { type:'image', source:{ type:'base64', media_type:'image/png', data } }
  if (block.source && typeof block.source === 'object') {
    const mt = block.source.media_type || block.source.mediaType;
    if (mt && typeof mt === 'string') return mt.trim().toLowerCase();
  }
  // OpenAI: { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }
  const url = block.image_url && typeof block.image_url === 'object'
    ? block.image_url.url
    : (typeof block.image_url === 'string' ? block.image_url : block.url);
  if (url && typeof url === 'string') {
    const m = url.match(/^data:([^;,]+)?;base64,/i);
    if (m && m[1]) return m[1].trim().toLowerCase();
  }
  return '';
}

/**
 * 为单个图像块生成占位文本。带得到 MIME 时附上类型，便于模型判断。
 * @param {*} block
 * @returns {string} 例如 '[image]' 或 '[image: image/png]'
 */
function describeImagePlaceholder(block) {
  const mime = extractImageMime(block);
  return mime ? `[image: ${mime}]` : IMAGE_PLACEHOLDER;
}

/**
 * 统计一段 content（string 或 Array<block>）中的图像块数量。
 * @param {string|Array|*} content
 * @returns {number}
 */
function countImageBlocks(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (isImageBlock(block)) n += 1;
  }
  return n;
}

/**
 * 统计整组 messages 中的图像块总数。
 * @param {Array<{content?: string|Array}>} messages
 * @returns {number}
 */
function countImagesInMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const msg of messages) {
    if (msg && typeof msg === 'object') n += countImageBlocks(msg.content);
  }
  return n;
}

/**
 * 生成发给纯文本模型的统一降级提示。文案为中文（与仓库 OCR 兜底
 * '[OCR 图像文本识别结果]' 风格一致），告知模型"有图但不可见，请基于文本回答"。
 *
 * @param {number} imageCount - 被降级的图像数量（<=0 返回空串）
 * @returns {string} 形如 '\n\n[注意：用户附带 2 张图片，当前模型不支持视觉，请仅依据文本内容作答。]'
 */
function buildTextModelImageNotice(imageCount) {
  const n = Number.isFinite(imageCount) ? Math.max(0, Math.floor(imageCount)) : 0;
  if (n <= 0) return '';
  return `\n\n[注意：用户附带 ${n} 张图片，当前模型不支持视觉，请仅依据文本内容作答。]`;
}

module.exports = {
  IMAGE_PLACEHOLDER,
  isImageBlock,
  extractImageMime,
  describeImagePlaceholder,
  countImageBlocks,
  countImagesInMessages,
  buildTextModelImageNotice,
};
