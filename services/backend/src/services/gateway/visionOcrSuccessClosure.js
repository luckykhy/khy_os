'use strict';

/**
 * visionOcrSuccessClosure.js — describe-fail → OCR-成功路径的**用户可见闭合消息**(OPS-MAN-144,
 * 承 OPS-142「减少显示的心灵噪音」+ /goal「无感明显告知用户用了 OCR」)。
 *
 * 断桥(2026-07-12 用户实测 paste-cache 92c0154d + 本轮真图复刻确认):纯文本模型 + 带图 →
 * describe-and-return 视觉级联对每个视觉候选发一条 `我无法直接识别图片内容。正在调用 <model>
 * 进行识别，请稍候...`(KHY_VISION_INTERMEDIATE_MESSAGE)。当**全部候选失败**、随后本地 OCR
 * **成功读出**时——
 *   - describe **成功** 路径有闭合:aiGatewayGenerateMethod 发
 *     `视觉识别完成，正在根据识别结果为您作答。`(与「请稍候」承诺呼应);
 *   - describe **失败 → OCR 成功** 路径**没有任何 assistant_message 闭合**:只在 prompt 侧注入
 *     OCR 文本、答复侧加脚注(OPS-126)、实时状态层 emitStatus(OPS-127/132,且 prep 期非 verbose
 *     才发)。于是用户看到 N 条「正在调用...请稍候」**悬空承诺**,却没有一句在**中间消息层**告诉他
 *     「视觉都失败了、已改用本地 OCR 成功识别」——既留下未兑现的「请稍候」(心灵噪音),又缺了
 *     交互当下的「用了 OCR」明显告知。
 *
 * 修复:补齐这条与 describe-成功闭合**对称**的 OCR-成功闭合。只在 `_intermediateEnabled` 为真
 * (即「请稍候」承诺确实发过)时由调用方发射,一个回合至多一条(逐字节稳定 → visionNoticeDedup
 * 跨工具循环重入自然折叠为一)。net:把 N 条悬空「请稍候」收束为一句明确闭合,与失败墙已被 OPS-142
 * 抑制配合,回合更安静**且**更清楚。
 *
 * 契约(与全仓纯叶子一致):零 IO、确定性、绝不抛。default-on 门 KHY_VISION_OCR_SUCCESS_CLOSURE。
 * 门关 → 返 null → 调用方不 emit → 逐字节回退历史「OCR-成功无中间消息闭合」行为。count<=0 /
 * 畸形 → null(只在确有文本读出时才闭合)。
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_VISION_OCR_SUCCESS_CLOSURE';

// 与 visionNoticeDedup 签名折叠一致的稳定前缀标记(便于测试断言 / 未来去重锚点)。
const OCR_SUCCESS_CLOSURE_MARKER = '视觉模型均不可用';

/** 门是否开启(default-on)。异常保守返回 false(不闭合),绝不抛。 */
function isVisionOcrSuccessClosureEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 构造 describe-fail → OCR-成功的用户可见闭合消息;门关 / count 非正 / 畸形 → null
 * (调用方据此决定是否 emitAssistantMessage)。绝不抛。
 * @param {{count?: number, env?: object}} [opts]
 * @returns {string|null}
 */
function buildOcrSuccessClosure({ count, env } = {}) {
  if (!isVisionOcrSuccessClosureEnabled(env)) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const noun = n === 1 ? '图片' : `${n} 张图片`;
  return `${OCR_SUCCESS_CLOSURE_MARKER}，已改用本地 OCR 成功识别${noun}，正在据此作答。`;
}

module.exports = {
  isVisionOcrSuccessClosureEnabled,
  buildOcrSuccessClosure,
  FLAG,
  OCR_SUCCESS_CLOSURE_MARKER,
};
