'use strict';

/**
 * attachmentFailurePolicy.js — 「带附件的请求在某通道失败时,这次失败该不该毒化
 * 整条通道 / 该不该给用户一个大方的承认与解决方案」的确定性策略单一真源。
 *
 * 背景(用户目标 2026-06-27 续「给所有模型装上眼睛」之后):khy 此前一遇到上游
 * 读不了的附件(未知/不支持格式的文件、或被错认能识图的图片)就把无法消费的字节
 * 透传给上游 → 上游 HTTP 400 → 网关归为 `bad_request`。而熔断器 `_recordAdapterFailure`
 * 把 `bad_request` 当成**通道健康问题**按 adapterKey 计数,连续几次就 circuitOpen,
 * 随后**连纯文本请求也被 fast-fail** —— 一个坏文件毒死了整个会话。
 *
 * 真相:坏附件导致的 400 是**载荷(payload)级**失败,不是**通道(channel)级**失败
 * —— 通道是健康的,只有「这一次带附件的请求」的内容上游读不了。这与 aiGateway 里
 * 早已把 `empty`(空回复)排除出熔断的哲学完全一致(模型行为 blip ≠ 通道坏)。本叶子
 * 把这条判据补全,并据此:
 *   ① 让 aiGateway 把「载荷级失败」视同 `empty`——不计入熔断、不冷却通道;
 *   ② 当附件无法降级(图像 OCR 也没救回、或本就是文档/未知格式)时,产出一段诚实的
 *      用户可见文案:大方承认「我读不了这个格式」并给出确定性解决方案,而非静默 400。
 *
 * 「什么算模型拒绝 / 不支持格式」复用既有单一真源:
 *   failureExplainer.isModelRejection(结构化 404/400/model_not_found/bad_request)
 *   ⊂ visionOcrFallback.isModelRejectionResult(再加不支持格式的文本兜底正则)。
 * 本叶子只在其上加「本次是否带附件」这一道闸 + 通道毒化策略 + 承认文案,绝不另写一份
 * 404/不支持格式集合。
 *
 * 纯叶子:零 IO、确定性、绝不抛、单一真源(仅引用同目录纯叶子 visionOcrFallback)。
 * env 门控 KHY_ATTACHMENT_FAILURE_POLICY(默认开,仅显式 0/false/off/no 关闭;关闭后
 * isPayloadScopedFailure 恒 false、buildUnreadableAttachmentMessage 恒 null,行为字节
 * 回退到原 400 / 原熔断路径)。env 经入参注入可测。
 */

const { isModelRejectionResult } = require('./visionOcrFallback');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。默认开,仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_ATTACHMENT_FAILURE_POLICY;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 这次失败是否属于「载荷级」失败 —— 即:本次请求带了附件,且失败是上游对该附件
 * 内容的拒绝(模型拒绝 / 不支持格式),因而**不应毒化整条通道**(通道是健康的)。
 *
 * 仅当 ① 门控开 ② hasAttachment 为真 ③ 复用 visionOcrFallback.isModelRejectionResult
 * 判为模型拒绝/不支持格式 三者皆真时返回 true。纯判定,不改任何状态。
 *
 * @param {object} input
 * @param {boolean} input.hasAttachment 本次请求是否携带附件(图像/文档/文件)
 * @param {string}  [input.errorType]   失败错误类型(如 bad_request / model_not_found)
 * @param {string}  [input.error]       失败消息文本
 * @param {number}  [input.statusCode]  失败 HTTP 状态码
 * @param {object}  [input.env]
 * @returns {boolean}
 */
function isPayloadScopedFailure(input = {}) {
  if (!isEnabled(input.env)) return false;
  if (!input.hasAttachment) return false;
  // 合成一个失败结果交给单一真源判定(复用其结构化 + 不支持格式文本兜底)。
  const synthetic = {
    success: false,
    errorType: input.errorType,
    error: input.error,
    statusCode: input.statusCode,
  };
  return isModelRejectionResult(synthetic);
}

// 把内部 kind 归一成给用户看的中文类型名 + 建议转换的目标格式。
const _KIND_LABEL = {
  image: { name: '图片', to: 'PNG / JPG' },
  document: { name: '文档', to: 'PDF / TXT' },
  audio: { name: '音频', to: 'MP3 / WAV' },
  video: { name: '视频', to: 'MP4' },
  file: { name: '文件', to: '纯文本 TXT' },
};

function _describeKinds(kinds) {
  const list = Array.isArray(kinds) ? kinds : [];
  const names = [];
  const targets = [];
  for (const k of list) {
    const label = _KIND_LABEL[String(k || '').trim().toLowerCase()];
    if (!label) continue;
    if (!names.includes(label.name)) names.push(label.name);
    if (!targets.includes(label.to)) targets.push(label.to);
  }
  return { names, targets };
}

function _describeExts(exts) {
  const out = [];
  const list = Array.isArray(exts) ? exts : [];
  for (const e of list) {
    const s = String(e || '').trim().replace(/^\./, '').toLowerCase();
    if (s && /^[a-z0-9]{1,8}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// 文案首行标记,用于去重(调用方据此判断 result.content 是否已含本段)。
const UNREADABLE_MARKER = '我暂时无法直接读取';

/**
 * 产出「大方承认读不了 + 给确定性解决方案」的用户可见文案(诚实、第一人称)。
 * 门控关闭 → 返回 null(调用方据此不改动原内容)。绝不伪造文件内容。
 *
 * @param {object} [input]
 * @param {string[]} [input.kinds] 附件 kind 列表(image/document/audio/video/file)
 * @param {string[]} [input.exts]  附件扩展名列表(用于点名格式)
 * @param {object}   [input.env]
 * @returns {string|null}
 */
function buildUnreadableAttachmentMessage(input = {}) {
  if (!isEnabled(input.env)) return null;

  const { names, targets } = _describeKinds(input.kinds);
  const exts = _describeExts(input.exts);

  const extPart = exts.length ? `(.${exts.join(' / .')})` : '';
  const kindPart = names.length ? names.join('、') : '这个文件';
  const toPart = targets.length ? targets.join('、') : '我能读取的常见格式';

  const lines = [
    `${UNREADABLE_MARKER}${kindPart}${extPart} —— 当前模型/通道读不了这种格式的内容。`,
    '这不是你的问题,也不影响我们继续对话。你可以这样让我「看懂」它:',
    `  ① 把它转成 ${toPart} 后重新发给我;`,
    '  ② 直接把其中的文字复制粘贴到对话里,我就能据此作答;',
    '  ③ 如确需保留原格式,换用支持该格式的模型/通道(运行 `khy gateway model` 选择)。',
    '在此之前我不会编造文件里的内容;你也可以接着问我别的,本次失败不会影响后续请求。',
  ];
  return lines.join('\n');
}

module.exports = {
  isEnabled,
  isPayloadScopedFailure,
  buildUnreadableAttachmentMessage,
  UNREADABLE_MARKER,
};
