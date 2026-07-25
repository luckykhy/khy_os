'use strict';

/**
 * visionDescribeReturn.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 背景(用户诉求):纯文本模型直接收到图片时,khy 透明视觉路由既有两条路——
 *   ① switch-model:把 options.model **替换**成视觉模型,视觉模型直接接管整轮作答
 *      (原文本模型这一轮不参与,视觉答案只在下一轮才作为历史被文本模型看到);
 *   ② ocr-fallback:本地 OCR 抽文字注入 prompt,原文本模型据此作答。
 * 用户期望的是「视觉模型**只负责看图并描述**,把描述**回传给原文本模型**,由用户
 * 选定的(往往更强的)文本模型据此作答」——即 describe-and-return。这一语义在
 * RecognizeImage 工具里已存在,但需模型**主动调工具**;透明自动路由缺此路。
 *
 * 本叶子把 describe-and-return 的**纯**部分收口为单一真源:
 *   - 门控判定(KHY_VISION_DESCRIBE_RETURN,默认开);
 *   - 送给视觉模型的**中性描述指令**(只描述、不作答,好让随后文本模型才是真正作答者);
 *   - 把描述注入回原 prompt 的**文本块格式**(措辞对齐既有 OCR 注入块)。
 * 真正的「调用视觉模型」这一 IO 步骤留在 aiGateway(不可纯化),本叶子只出纯文本。
 *
 * 门控 KHY_VISION_DESCRIBE_RETURN(默认开):关(0/false/off/no)→
 * isVisionDescribeReturnEnabled 恒 false → aiGateway **逐字节回退**到既有
 * switch-model 替换行为。绝不抛:异常一律回退关门语义(false)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控是否开启(默认开;仅 KHY_VISION_DESCRIBE_RETURN ∈ {0,false,off,no} 时关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isVisionDescribeReturnEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_VISION_DESCRIBE_RETURN;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 送给视觉模型的中性描述指令。刻意要求「只客观描述、不评价、不作答」,使随后由
 * 原文本模型据描述作答——文本模型才是真正的回答者,视觉模型仅当「眼睛」。
 * @returns {string}
 */
function buildDescribePrompt() {
  return [
    '请客观、详细地描述这张(些)图片的**全部**内容,供另一个模型据此作答。',
    '需覆盖:场景与整体布局、可见对象、其中出现的**所有文字(逐字抄录,勿概括)**、',
    '图表/表格的数据、UI 元素与状态、代码或公式(逐字)、以及任何可辨识的细节。',
    '只输出**描述本身**:不要评价、不要提问、不要替用户回答问题、不要附加结论。',
  ].join('\n');
}

/**
 * 把视觉模型产出的描述,格式化为注入回原 prompt 的文本块。措辞对齐既有 OCR 注入块
 * (「[当前模型不支持视觉,以下为图片 OCR 识别文本,请据此作答]」),便于文本模型理解
 * 这段文字是「图片的替代表述」。
 *
 * @param {string[]} descriptions  每张图一段描述(通常一段总描述,亦支持多段)
 * @param {{model?: string}} [opts] 视觉模型 id(用于标注来源,可省)
 * @returns {string}  注入块(空输入 → 空串,调用方据此决定是否回退)
 */
function buildDescriptionInjection(descriptions, opts = {}) {
  const list = Array.isArray(descriptions) ? descriptions : [descriptions];
  const cleaned = list
    .map((d) => (d == null ? '' : String(d).trim()))
    .filter((d) => d.length > 0);
  if (cleaned.length === 0) return '';
  const model = opts && opts.model ? String(opts.model).trim() : '';
  const label = model
    ? `[以下为视觉模型「${model}」对图片的识别描述,请据此作答]`
    : '[以下为视觉模型对图片的识别描述,请据此作答]';
  const body = cleaned.length === 1
    ? cleaned[0]
    : cleaned.map((d, i) => `【图片${i + 1} 描述】\n${d}`).join('\n\n');
  return `${label}\n${body}`;
}

module.exports = {
  isVisionDescribeReturnEnabled,
  buildDescribePrompt,
  buildDescriptionInjection,
};
