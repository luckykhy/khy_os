'use strict';

/**
 * imageOcrFallbackPolicy.js — 「图片 OCR 何时该动网络、网络失败后已识别的本地文字
 * 该不该保留」的确定性策略单一真源。
 *
 * 背景(用户目标 2026-06-28「不要一识别图片就网络中断就失败,导致接下来换那个模型
 * 都是失败;有无视觉模型时都能正确准确地识别图片内容」):
 *
 *  ① imageOcr 工具本地 OCR 失败后会无条件重入 gateway.generate 做 AI 视觉,而对**非
 *     视觉模型**(如 agnes-2.0-flash),网关会重跑视觉路由、逐个 sibling 适配器试,每个
 *     网络失败吃 60s 冷却 → 累积数百秒,表现为「识别图片后换任何模型都一直失败」。
 *     真相:当根本没有可用视觉模型时,重入网络毫无意义——本地 OCR 已能识别文字图,
 *     非文字图也只能如实告知。于是把「何时才值得动网络」收口为本叶子单一真源。
 *
 *  ② 非视觉模型的聊天路径会先用本地 OCR 把图片文字塞进 prompt(_ocrFallbackApplied),
 *     但随后仍须调远端模型作答;该调用网络失败 → 已识别的文字被丢弃,用户什么都拿不到。
 *     本叶子据此产出「网络暂不可用,以下为本地 OCR 离线识别到的图片文字」诚实降级文案,
 *     让离线已识别的文字不被网络故障吞没。
 *
 * 纯叶子:零 IO、确定性、绝不抛、env 经入参注入可测。两道独立门控,关闭即字节回退:
 *   - KHY_IMAGE_OCR_NO_CASCADE(默认开):decideImageOcrNext / getTotalTimeoutMs 生效;
 *     关闭后调用方应逐字节回退到「本地失败即无条件 AI 视觉、无总超时」的旧路径。
 *   - KHY_OCR_TEXT_ON_NETFAIL(默认开):buildOcrTextOnNetFailNote 生效;关闭后恒 null。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function _gateOn(value) {
  if (value == null) return true; // 默认开
  return !_FALSY.has(String(value).trim().toLowerCase());
}

/**
 * 「不级联 + 有界 + local-OCR 优先」门控(KHY_IMAGE_OCR_NO_CASCADE,默认开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isNoCascadeEnabled(env) {
  return _gateOn((env || process.env || {}).KHY_IMAGE_OCR_NO_CASCADE);
}

const DEFAULT_TOTAL_MS = 60000;
const MIN_TOTAL_MS = 5000;
const MAX_TOTAL_MS = 600000;

/**
 * imageOcr 子进程/视觉调用的硬总时长上限(墙钟),与既有 120s 空闲计时器并存。
 * 经 KHY_IMAGE_OCR_TOTAL_MS 覆盖,夹在 [5s, 600s];非法/缺失 → 默认 60s。
 * @param {object} [env]
 * @returns {number} 毫秒
 */
function getTotalTimeoutMs(env) {
  const raw = (env || process.env || {}).KHY_IMAGE_OCR_TOTAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOTAL_MS;
  return Math.max(MIN_TOTAL_MS, Math.min(MAX_TOTAL_MS, Math.floor(n)));
}

/**
 * 决定本地 OCR 之后该怎么走:用本地结果 / 试一次有界 AI 视觉 / 如实失败(绝不级联)。
 *
 * 决策(确定性,绝不抛):
 *   - forceAi(显式强制 AI 视觉):有视觉模型 → try-vision;无视觉但本地有文字 →
 *     use-local(诚实降级,绝不级联);无视觉且无文字 → fail-honest。
 *   - 非强制:本地充分(成功且有文字且未要求兜底) → use-local;否则(失败/低置信/无文字):
 *       有视觉模型 → try-vision;无视觉但本地有文字 → use-local;无视觉且无文字 → fail-honest。
 *
 * 核心不变量:**无可用视觉模型时永不返回 try-vision**——杜绝重入网关导致的逐适配器
 * 冷却级联(「换模型都失败」)。
 *
 * @param {object} input
 * @param {boolean} input.localSuccess        本地 OCR 是否成功
 * @param {boolean} input.localHasText        本地 OCR 是否产出了文字
 * @param {boolean} input.localNeedsAiFallback 本地 OCR 是否自报「置信度不足,建议 AI 兜底」
 * @param {boolean} input.visionAvailable     当前是否存在可用的视觉模型/原生收图通道
 * @param {boolean} [input.forceAi]           用户是否显式强制 AI 视觉
 * @returns {{action: 'use-local'|'try-vision'|'fail-honest', reason: string}}
 */
function decideImageOcrNext(input) {
  const i = input || {};
  const localSuccess = !!i.localSuccess;
  const localHasText = !!i.localHasText;
  const localNeedsAiFallback = !!i.localNeedsAiFallback;
  const visionAvailable = !!i.visionAvailable;
  const forceAi = !!i.forceAi;

  if (forceAi) {
    if (visionAvailable) return { action: 'try-vision', reason: 'force-ai-vision-available' };
    if (localHasText) return { action: 'use-local', reason: 'force-ai-no-vision-use-local-text' };
    return { action: 'fail-honest', reason: 'force-ai-no-vision-no-text' };
  }

  const adequateLocal = localSuccess && localHasText && !localNeedsAiFallback;
  if (adequateLocal) return { action: 'use-local', reason: 'local-adequate' };

  // 本地不充分(失败 / 低置信 / 无文字)。
  if (visionAvailable) return { action: 'try-vision', reason: 'local-insufficient-vision-available' };
  if (localHasText) return { action: 'use-local', reason: 'no-vision-fallback-to-local-text' };
  return { action: 'fail-honest', reason: 'no-vision-no-text' };
}

/**
 * 无可用视觉模型且本地 OCR 取不到文字时,给用户的诚实失败文案(第一人称,绝不编造图像内容)。
 * @param {object} [input]
 * @param {number} [input.count]  本次图片数量
 * @returns {string}
 */
function buildNoVisionNoTextMessage(input) {
  const n = Number((input || {}).count);
  const head = Number.isFinite(n) && n > 1 ? `这些图片` : `这张图片`;
  return [
    `本地 OCR 没有在${head}里识别到文字,而当前没有可用的视觉模型,我无法描述非文字图像的内容。`,
    '我不会编造图里有什么。你可以这样让我「看懂」它:',
    '  ① 如果图中确有文字却没识别出来,确认清晰度/语言后重发;',
    '  ② 配置一个支持图像输入的视觉模型(运行 `khy gateway model` 选择),再发给我;',
    '  ③ 直接把图里的关键文字打字告诉我,我就能据此作答。',
  ].join('\n');
}

// ── Part B:网络失败保留本地 OCR 文本 ──────────────────────────────────────

/**
 * 网络失败保留已识别文字门控(KHY_OCR_TEXT_ON_NETFAIL,默认开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isOcrTextOnNetFailEnabled(env) {
  return _gateOn((env || process.env || {}).KHY_OCR_TEXT_ON_NETFAIL);
}

// 仅这些错误类型算「值得用离线 OCR 文本降级兜底」的瞬时网络故障。
const _NETFAIL_TYPES = new Set(['network', 'timeout']);

/**
 * 文案首行标记,供调用方对 result.content 去重(避免重复前置)。
 */
const OCR_NETFAIL_MARKER = '网络暂时不可用';

/**
 * 是否应当用「prep 期已提取的本地 OCR 文本」给这次网络失败做降级兜底。
 * 仅当 ① 门控开 ② prep 期确实用过 OCR 兜底(ocrApplied) ③ 错误类型属网络/超时
 * ④ 确有可用的 OCR 文本 四者皆真时返回 true。纯判定,不改状态。
 *
 * @param {object} input
 * @param {boolean} input.ocrApplied  prep 期是否设置过 _ocrFallbackApplied
 * @param {string}  [input.errorType] 失败错误类型
 * @param {boolean} input.hasText     是否存有可用的 _ocrFallbackText
 * @param {object}  [input.env]
 * @returns {boolean}
 */
function shouldApplyOcrTextOnNetFail(input) {
  const i = input || {};
  if (!isOcrTextOnNetFailEnabled(i.env)) return false;
  if (!i.ocrApplied) return false;
  if (!i.hasText) return false;
  return _NETFAIL_TYPES.has(String(i.errorType || '').trim().toLowerCase());
}

/**
 * 产出「网络暂不可用 → 以下为本地离线 OCR 识别到的图片文字」诚实降级文案。
 * 门控关 / 无文本 → 返回 null(调用方据此不改动原内容)。
 *
 * @param {object} [input]
 * @param {string} [input.text]  prep 期已提取的本地 OCR 文本块
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildOcrTextOnNetFailNote(input) {
  const i = input || {};
  if (!isOcrTextOnNetFailEnabled(i.env)) return null;
  const text = String(i.text == null ? '' : i.text).trim();
  if (!text) return null;
  return [
    `${OCR_NETFAIL_MARKER},无法把图片交给远端模型作答;以下是我在本地离线 OCR 识别到的图片文字,供你参考:`,
    '',
    text,
    '',
    '(以上为离线 OCR 文本,可能不含非文字图像的内容;网络恢复后可重发以获得完整识别。)',
  ].join('\n');
}

module.exports = {
  isNoCascadeEnabled,
  getTotalTimeoutMs,
  decideImageOcrNext,
  buildNoVisionNoTextMessage,
  isOcrTextOnNetFailEnabled,
  shouldApplyOcrTextOnNetFail,
  buildOcrTextOnNetFailNote,
  OCR_NETFAIL_MARKER,
  DEFAULT_TOTAL_MS,
};
