'use strict';

// OCR 兜底「使用 OCR」确定性脚注——OCR 成功路径上的**确定性**用户可见披露(与 OPS-124 正交)。
//
// OPS-124(ocrUsageNotice)已在 OCR 成功注入文本时**无条件**追加一句面向**模型**的指令,要求
// 模型在正文里自然、简短地告诉用户「本次用了 OCR」。但那是一条**建议**:模型完全可能忽略它,
// 于是正文里对 OCR 只字不提 → 用户全程不知道用了 OCR → 目标里的「**明显**告知用户」失守。网关
// finishResult 成功侧本就有一整族**确定性真值脚注**(answerVerifier/modelIdentityTruth/
// cacheMetricsTruth):无论模型正文怎么写,都在末尾**确定性**地追加真值,保证真相触达用户。唯独
// 「本次用了 OCR」这条透明性没有对应的确定性脚注 → 只靠 OPS-124 的模型指令,合规与否全凭模型。
//
// 本叶子补上这条确定性保证:当**确有 OCR 文本被读出并注入**、模型也**成功作答**、且正文里
// **尚未**提到 OCR(说明模型忽略了 OPS-124 的指令)时,在答复末尾**确定性**追加一句极简、
// 用户可见的脚注,明确「本次图片内容是通过本地 OCR 文字识别读取的」。
//
// 与 OPS-124 的分工(belt-and-suspenders,直击「无感**且**明显」):
//   · OPS-124(模型指令,门 KHY_OCR_USAGE_DISCLOSURE):模型合规时**无感**——披露自然融进正文;
//   · OPS-125(确定性脚注,门 KHY_OCR_USAGE_FOOTNOTE):模型忽略指令时兜底**明显**——保证触达。
// 两者去重协同:模型正文已提 OCR(合规)→ answerAlreadyDisclosesOcr 命中 → **不追加**脚注
// (保持无感、绝不重复披露);模型正文只字未提(不合规)→ 追加脚注(保证明显)。
//
// 单一真源:门 KHY_OCR_USAGE_FOOTNOTE(default-on)。门关 → buildOcrUsageFootnote 返回 null,
// finishResult 侧 result.content 逐字节回退。fail-soft:畸形输入绝不抛,一律返回 null / 保守值。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_USAGE_FOOTNOTE';

// 去重标记:仅本脚注会写出,finishResult 侧据此防重复追加(答复被二次后处理时)。
const OCR_USAGE_FOOTNOTE_MARKER = '［本次图片经 OCR 识别］';

function isFootnoteEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 答复正文是否**已经**披露了「用了 OCR」。命中 → 模型已合规(OPS-124 指令生效)→ 无需脚注,
// 保持无感、不重复披露。判据保守:命中任一常见 OCR 表述(拉丁 OCR 大小写、光学/文字识别)即视为
// 已披露。非字符串 / 空 → 视为未披露(false),让确定性脚注兜底。
function answerAlreadyDisclosesOcr(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  // 拉丁「OCR」大小写不敏感;或中文「光学字符识别 / 文字识别 / 光学识别」。
  if (/ocr/i.test(content)) return true;
  if (/光学字符识别|光学识别|文字识别/.test(content)) return true;
  return false;
}

// 渲染用户可见的确定性脚注。门关 / count 非正整数 → null(不追加,逐字节回退)。
// count = 本次成功读出 OCR 文本的图片数,仅用于措辞;缺失/畸形时退回单数泛称但仍追加
// (只要 isFootnoteEnabled 且未被上游判为无需)。措辞极简:一行分隔 + 一句说明,做到无感而明显。
function buildOcrUsageFootnote({ count, env } = {}) {
  if (!isFootnoteEnabled(env)) return null;
  const n = Number(count);
  const hasCount = Number.isFinite(n) && n > 0;
  if (!hasCount) return null;
  const noun = n === 1 ? '这张图片' : `这 ${n} 张图片`;
  return `\n\n———\n📄 ${OCR_USAGE_FOOTNOTE_MARKER}当前模型不支持直接看图,以上关于${noun}的内容`
    + `是通过本地 OCR 文字识别读取的(而非原生看图)。`;
}

module.exports = {
  isFootnoteEnabled,
  answerAlreadyDisclosesOcr,
  buildOcrUsageFootnote,
  OCR_USAGE_FOOTNOTE_MARKER,
  FLAG,
};
