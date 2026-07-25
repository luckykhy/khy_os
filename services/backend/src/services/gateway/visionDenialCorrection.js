'use strict';

// visionDenialCorrection.js — 「图被剥、OCR 又读不出时,模型仍谎称『没收到图片』」的**确定性纠正脚注**
// (OPS-MAN-138,承 OPS-118/120/122「剥图 ⟹ 必留痕」三处不变量 + OPS-126 ocrUsageFootnote 的确定性脚注哲学)。
//
// 背景(2026-07-12 用户实测复现,paste-cache 92c0154d):纯文本模型 + 带图 → 视觉描述级联全 404/socket
// hang up → 落 OCR 兜底,但图是**非文字类**(截图/照片/彩块)或缺字库 → 本地 OCR **读不出任何文字** →
// aiGateway 三处「空 OCR」站点(prep Site1:1626 / prep Site2:1736 / post-failure 救援网:2927)都**无条件
// 剥图**(images: undefined、_ocrFallbackApplied: true)并注入一条面向模型的「收到图但读不出、绝不能说没
// 收到图」诚实底线。**但那只是一条 prompt 指令,模型可以不听**——实测里模型正是无视它,回「我注意到你发了
// 一条结构化提示,但消息里没有附带图片」「当前对话中没有任何图片附件…我无法描述不存在的内容」。
//
// 断桥:finishResult 成功侧本有一整族**确定性真值脚注**(answerVerifier/modelIdentityTruth/cacheMetricsTruth/
// ocrUsageFootnote):无论模型正文怎么写,都在末尾确定性追加真相。唯独 ocrUsageFootnote(:858)只在
// **_ocrImageTextRead === true**(OCR 成功读出文本)时触发——空 OCR 剥图路径只置 _ocrFallbackApplied、
// **不置** _ocrImageTextRead,恰好落在那条脚注的判据之外 → 模型谎称没收到图时,**零确定性纠正**。
//
// 本叶子补上那条缺失的确定性保证:当本轮**确实带图并被剥离**(_ocrFallbackApplied)、**未走 OCR-文本注入**
// (!_ocrImageTextRead)、模型**成功作答却在正文里否认收到图**(detectImageDenial 命中)时,在答复末尾
// **确定性**追加一句用户可见的纠正脚注,明确「你确实上传了图片,只是当前模型看不了、OCR 也没读出文字」,
// 并给出可行方案。模型正文若已诚实承认「收到图但读不出」(未否认)→ 不追加,保持无感、绝不画蛇添足。
//
// 与既有脚注族的分工:
//   · ocrUsageFootnote(KHY_OCR_USAGE_FOOTNOTE):OCR **成功读出文本**、模型没提 OCR **且未否认收到图**
//     → 追加「用了 OCR」;
//   · visionDenialCorrection 空 OCR 变体(KHY_VISION_DENIAL_CORRECTION):OCR **读不出**、模型**否认收到图**
//     → 追加纠正(判据 _ocrFallbackApplied=true && !_ocrImageTextRead);
//   · visionDenialCorrection OCR-成功变体(KHY_VISION_DENIAL_CORRECTION_OCR_READ,OPS-MAN-140,承本发):
//     OCR **成功读出文本**(_ocrImageTextRead=true)、模型**却仍在正文否认收到图** → 追加纠正。
//
// OPS-140 补的正交断桥:OPS-138 的空 OCR 纠正判据 `!_ocrImageTextRead`,恰好把「OCR **成功**但模型仍否认」
// 这格挡在门外;而 ocrUsageFootnote(:858)在该格只会追加「以上关于这张图片的内容是通过 OCR 读取的」——可模型
// 正文根本否认了图片存在,「以上关于这张图片的内容」在否认场景下**不成立**,那句脚注既不自洽也**不纠正否认**。
// 结果:OCR 明明成功,用户看到的却是「当前对话中没有任何图片附件」+ 一句自相矛盾的脚注,零确定性纠正。
// 本变体在该格用一句**否认感知**的纠正取代普通「用了 OCR」脚注(不叠加、不制造心灵噪音):点明「你确实发了图、
// OCR 已成功读出文字、是模型没采用」,并给出「据 OCR 文本重新作答」的出路。门关 → 落回普通脚注,逐字节等价。
//
// 单一真源:门 KHY_VISION_DENIAL_CORRECTION(空 OCR 变体)/ KHY_VISION_DENIAL_CORRECTION_OCR_READ(OCR-成功变体),
// 均 default-on。门关 → buildDenialCorrectionNote 对应变体返 null,finishResult 侧 result.content 逐字节回退。
// fail-soft:畸形输入绝不抛,一律返回 null / 保守值。纯叶子:零 IO、确定性、绝不抛。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_VISION_DENIAL_CORRECTION';
// OCR-成功变体子门(OPS-MAN-140):OCR 已读出文本、模型仍否认收到图时的确定性纠正。与父门 FLAG 正交独立,
// 各自逐字节回退。
const OCR_READ_FLAG = 'KHY_VISION_DENIAL_CORRECTION_OCR_READ';

// 去重标记:仅本脚注会写出,finishResult 侧据此防重复追加(答复被二次后处理时)。两变体各用独立标记,
// 互不误伤、各自去重。
const DENIAL_CORRECTION_MARKER = '［已收到图片·当前通道无法识别］';
const DENIAL_CORRECTION_OCR_READ_MARKER = '［已收到图片·已用 OCR 读出文字］';

function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// OCR-成功变体子门是否开启(OPS-MAN-140)。fail-soft:异常 → false(不追加,逐字节回退)。
function isOcrReadDenialEnabled(env) {
  try {
    return isFlagEnabled(OCR_READ_FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 「模型否认收到图」的常见表述(命中任一即判为否认)。保守但覆盖实测语料:
//   · 「没有(附带|收到|任何)图片」「没有图片附件」「未收到图片」
//   · 「当前对话中没有…图片」「消息里没有…图片」
//   · 「无法描述不存在的(内容|图片)」「没有(看到|发现)图片」
// 刻意用「否认存在」措辞,避免误伤「我收到了图片但读不出」这类**诚实承认**句(见 acknowledges 下方)。
const _DENIAL_RE = new RegExp(
  [
    '没有(?:任何|附带|收到|看到|发现)?[^。\\n]{0,8}图片',
    '没有图片附件',
    '未(?:收到|附带|检测到)[^。\\n]{0,8}图片',
    '(?:消息|对话|聊天)(?:里|中)[^。\\n]{0,12}没有[^。\\n]{0,8}图片',
    '没有(?:附带|包含)[^。\\n]{0,8}(?:图片|图像|附件)',
    '无法描述不存在的(?:内容|图片|东西)',
    '(?:图片|图像)(?:并?未|没有)(?:成功)?(?:上传|附带|发送)',
  ].join('|'),
  'i',
);

// 模型正文是否**已诚实承认**「收到图但读不出/看不了」——命中即视为合规,不再追加纠正(保持无感)。
// 判据保守:出现「收到(了)?…图」「看不(了|到|清)…图」「读不出/无法识别…图」等承认类表述即算合规。
const _ACK_RE = new RegExp(
  [
    '(?<!没有|没|未|不)收到(?:了)?[^。\\n]{0,10}图(?:片|像)',
    '(?:看|读)不(?:了|到|清|出)[^。\\n]{0,10}图(?:片|像)',
    '无法(?:识别|读取|解析|直接看)[^。\\n]{0,10}图(?:片|像)',
    '当前(?:模型|通道)(?:不支持|无法)[^。\\n]{0,8}(?:视觉|看图|识别图)',
    'OCR',
  ].join('|'),
  'i',
);

// 答复正文是否在**否认收到图片**(命中否认句、且**未**同时出现承认句)。
// 非字符串 / 空 → false(无从判断 → 不追加,保守回退)。同时出现承认+否认(罕见)→ 视为已承认(合规),
// 不追加,避免与模型自己的诚实说明打架。
function detectImageDenial(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  if (!_DENIAL_RE.test(content)) return false;
  if (_ACK_RE.test(content)) return false; // 已诚实承认 → 合规,不纠正
  return true;
}

// 渲染用户可见的确定性纠正脚注。count = 本次被剥离 / 读出的图片张数,仅用于措辞;缺失/畸形 → 退回泛称但仍追加
// (只要对应门开且上游判为需纠正)。
//   · ocrTextRead 缺省 / falsy → 空 OCR 变体:门 KHY_VISION_DENIAL_CORRECTION。措辞「OCR 也未读出文字」。
//   · ocrTextRead === true → OCR-成功变体(OPS-MAN-140):门 KHY_VISION_DENIAL_CORRECTION_OCR_READ。措辞
//     「OCR 已成功读出文字、是模型没采用」,并给出「据 OCR 文本重新作答」的出路。
// 门关 → 对应变体返 null(逐字节回退)。措辞:一行分隔 + 事实纠正 + 一句方案。
function buildDenialCorrectionNote({ count, env, ocrTextRead } = {}) {
  const n = Number(count);
  const hasCount = Number.isFinite(n) && n > 0;
  const noun = hasCount ? (n === 1 ? '1 张图片' : `${n} 张图片`) : '图片';
  if (ocrTextRead === true) {
    // OCR-成功变体:OCR 已读出文字,却被模型无视且否认收到图。纠正为「图收到了、文字读出来了、模型没用」。
    if (!isOcrReadDenialEnabled(env)) return null;
    return `\n\n———\n📎 ${DENIAL_CORRECTION_OCR_READ_MARKER}更正:你确实上传了${noun}。`
      + `当前模型不支持直接看图,但本地 OCR **已成功读出图中文字**并作为上下文提供给我作答——`
      + `图片**已经收到**,并非「没有图片」。若上文未据此展开,是模型未采用已读出的 OCR 文本。`
      + `可行方案:① 直接说「请据 OCR 读出的文字重新作答」,我会据此回答;`
      + `② 或换用支持视觉的模型(运行 \`khy gateway model\` 选择)以原生看图。`;
  }
  // 空 OCR 变体(既有行为,逐字节不变)。
  if (!isEnabled(env)) return null;
  return `\n\n———\n📎 ${DENIAL_CORRECTION_MARKER}更正:你确实上传了${noun}。`
    + `当前模型不支持直接看图,本地 OCR 也未能从图中读出文字(常见于照片/截图/图表等非纯文字图,`
    + `或缺少对应语言的 OCR 字库),所以我没能识别其内容——但图片**已经收到**,并非「没有图片」。`
    + `可行方案:① 换用支持视觉的模型(运行 \`khy gateway model\` 选择);`
    + `② 若图中是文字,确认安装对应语言 OCR 字库后重发;③ 直接把图中文字粘贴过来。`;
}

module.exports = {
  isEnabled,
  isOcrReadDenialEnabled,
  detectImageDenial,
  buildDenialCorrectionNote,
  DENIAL_CORRECTION_MARKER,
  DENIAL_CORRECTION_OCR_READ_MARKER,
  FLAG,
  OCR_READ_FLAG,
};
