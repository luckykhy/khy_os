'use strict';

/**
 * imageRecognitionIntent.js — 「有识图意图但没附任何图」的确定性守卫。
 *
 * 背景(goal「让 khy 可以正确识别图片，即使没有模型也能 ocr 兜底」):用户在 TUI/REPL
 * 里裸输入「图片识别」时,context 里没有图片、消息里也没有路径,既有的内联图接缝
 * (repl.js `extractInlineImageIntent` / tui `resolveInlineImageSubmit`)都不命中,消息
 * 直接落进 agentic loop —— 模型无图可依,只能盲目 Glob 桌面找图片文件空跑。本接缝在
 * 落入 loop 之前拦截这种「识图意图 + 无图」的输入,给出确定性处置:
 *   ① 剪贴板里有图 → 自动取用送识别(与 `/paste` 同一视觉/OCR 路由);
 *   ② 哪里都没有图 → 返回确定性引导回复(不调模型、零 token、零 glob)。
 *
 * 与 `imageIntent.js`(纯检测)/`inlineImageSubmit.js`(注入 IO 的薄壳)同族:
 * 本文件 = 纯叶子检测 + 提示词构造 + 一个注入 IO 的薄壳解析器 `resolveImageRecognitionAssist`。
 *
 * 判据**保守**(宁漏勿误):长度上限 + 开发语境词排除 + 能力提问词排除,绝不劫持
 * 「写个图片识别功能」「如何实现图片识别」这类真开发请求,也绝不劫持「哪些模型支持图像
 * 识别」「你是多模态模型吗」这类**问能力**的自然对话。薄壳**绝不抛**:任何异常 →
 * `{ handled:false }` 退回今日行为。env 门控 `KHY_IMAGE_INTENT_GUARD`(默认开,仅显式
 * 0/false/off/no/disable/disabled 关闭;关闭后逐字节回退到「不拦截」)。env / imageService
 * 经 opts 注入可测。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

// 开发语境词:命中即判「不是纯识图指令」——避免劫持「写个图片识别功能」「如何实现图片识别」。
const _DEV_CONTEXT_RE = /(写|编写|代码|功能|实现|函数|组件|程序|开发|如何|怎么|怎样|教程|文档|集成|接入|模块|框架|api|sdk|build|implement|function|component|feature|develop|integrate|library|framework)/i;

// 「关于识图能力/模型」的元提问词:命中即判非识图指令。这类是自然对话在**问**能力
// (「你支持图像识别吗」「哪些模型支持图像识别」「你是多模态模型吗」),而非**命令**识别
// 某张图。若不排除,含「图像识别/识别图片」片段的能力提问会被误当识图请求,弹出确定性
// 「未检测到图片」引导,污染正常聊天(用户实测:自然聊天被当成图像识别)。判据保守——
// 这些词绝不会出现在真的「识别这张图」指令里(「识别这张图片里的文字」等均不含),故排除它们
// 只会让边界情形回退到「不拦截 → 正常送模型」这一**更安全**的方向,不会漏拦真识图指令。
const _META_QUESTION_RE = /(支持|多模态|哪些|那些|是不是|是否|能不能|能否|可不可以|有没有|模型|support|multimodal|which\s+model|are\s+you|do\s+you|does\s+it|\bmodels\b)/i;

// 识图核心意图:图片识别 / 识别文字 / OCR / 提取文字 等。
const _RECOGNIZE_INTENT_RE = /(图片识别|识别图片|识别图像|图像识别|图文识别|识别文字|文字识别|文字提取|提取文字|ocr|识别一下(?:这)?(?:张)?图|识别(?:这)?(?:张)?图片?|图片(?:里|中)的文字|recogni[sz]e\s+(?:this\s+)?(?:image|picture|photo|screenshot)|read\s+(?:the\s+)?text\s+from|extract\s+text)/i;

/**
 * 门控判定。默认开,仅显式关闭词关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function imageIntentGuardEnabled(env) {
  const v = (env || process.env || {}).KHY_IMAGE_INTENT_GUARD;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 保守判定「整条消息本质就是识图指令」。
 * 长度上限(防长句夹带)+ 开发语境词排除 + 识图核心意图三重与。
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeImageRecognitionRequest(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (s.length > 60) return false;            // 长句 → 更可能是复杂请求而非纯识图指令
  if (_DEV_CONTEXT_RE.test(s)) return false;  // 不劫持「写个图片识别功能」等开发请求
  if (_META_QUESTION_RE.test(s)) return false; // 不劫持「哪些模型支持图像识别」等能力提问
  return _RECOGNIZE_INTENT_RE.test(s);
}

/**
 * 自动取用剪贴板图片时(Q1)配套的识别提示词。
 * @param {string} text 用户原始输入
 * @returns {string}
 */
function buildClipboardRecognitionPrompt(text) {
  const s = String(text == null ? '' : text).trim();
  const base = '请识别这张图片中的内容与文字，并整理成要点。';
  return s ? `${base}\n\n用户原始请求：${s}` : base;
}

/**
 * 哪里都没有图时(Q2)的确定性引导回复。不调模型。
 * @returns {string}
 */
function buildNoImageGuidanceReply() {
  return [
    '未检测到图片：你想识别图片，但当前没有附带任何图片，剪贴板里也没有图片。',
    '',
    '可以用以下任一方式提供图片：',
    '  1. 直接把图片拖进终端，或输入  /image <图片路径>',
    '  2. 直接给出图片的完整路径（如 /path/to/shot.png 或 C:\\Users\\you\\shot.png）',
    '  3. 先把图片复制到剪贴板，再重新输入「图片识别」——会自动取用剪贴板里的图片',
    '',
    '提示：即使当前没有可用的视觉模型，也会自动使用本地 OCR（Tesseract）识别图片中的文字。',
  ].join('\n');
}

/**
 * 解析一次提交:识图意图 + 无附图 → 剪贴板自动取用 / 无图确定性回复。
 *
 * 门控关 / 已附图 / 非识图意图 → `{ handled:false }`(字节回退,原路径不变)。
 * 识图意图 + 无附图:
 *   - 剪贴板有图 → `{ handled:true, action:'clipboard-image', text, images:[{base64,mimeType}] }`
 *   - 无图 / 读取失败 → `{ handled:true, action:'no-image-reply', reply }`
 * **绝不抛**:任何异常 → `{ handled:false }`。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.hasImages]        本轮是否已附带图片(附了就不介入)
 * @param {object}  [opts.env]              注入 env(测试用)
 * @param {object}  [opts.imageService]     注入 imageService(测试用)
 * @returns {{handled:false}
 *          | {handled:true, action:'clipboard-image', text:string, images:Array}
 *          | {handled:true, action:'no-image-reply', reply:string}}
 */
function resolveImageRecognitionAssist(text, opts = {}) {
  const original = String(text == null ? '' : text);
  try {
    if (!imageIntentGuardEnabled(opts.env)) return { handled: false };
    if (opts.hasImages) return { handled: false };
    if (!looksLikeImageRecognitionRequest(original)) return { handled: false };

    let svc = opts.imageService;
    if (!svc) {
      try { svc = require('../../services/imageService'); } catch { svc = null; }
    }
    if (svc && typeof svc.isClipboardImageAvailable === 'function'
        && typeof svc.readImageFromClipboard === 'function') {
      let hasClip = false;
      try { hasClip = !!svc.isClipboardImageAvailable(); } catch { hasClip = false; }
      if (hasClip) {
        try {
          const image = svc.readImageFromClipboard();
          if (image && image.base64) {
            return {
              handled: true,
              action: 'clipboard-image',
              text: buildClipboardRecognitionPrompt(original),
              images: [{ base64: image.base64, mimeType: image.mimeType }],
            };
          }
        } catch { /* fall through to no-image guidance */ }
      }
    }
    return { handled: true, action: 'no-image-reply', reply: buildNoImageGuidanceReply() };
  } catch {
    // 绝不打断提交:任何意外都退回今日行为。
    return { handled: false };
  }
}

module.exports = {
  imageIntentGuardEnabled,
  looksLikeImageRecognitionRequest,
  buildClipboardRecognitionPrompt,
  buildNoImageGuidanceReply,
  resolveImageRecognitionAssist,
};
