'use strict';

// OCR 兜底「使用 OCR 透明告知」——OCR **成功路径**上的用户可见披露(与前六条正交)。
//
// 前六条诚实轴(准确性/覆盖率/单图截断/语言包/方向/分辨率)全部是**条件型**告诫:只在 OCR 结果
// 出现某种缺陷(低置信、超上限、被截断、语言窄化、被旋正、被放大)时才追加。当 OCR **干净成功**、
// 图片文字被准确读出时,这六条一条都不触发 → 注入 prompt 的只有一个面向**模型**的「以下为图片
// OCR 识别文本,请据此作答」头,它让模型据 OCR 文本作答,却从不要求模型**告诉用户**这段内容是
// 经 OCR 读取而非原生看图 → 模型往往像自己「亲眼看图」一样作答 → 用户全程不知道用了 OCR。
//
// 本叶子补上这条缺口:在 OCR 成功注入文本时**无条件**追加一句面向模型的指令,要求模型在正常作答
// 的同时,用一句自然、简短的话向用户**明确**说明「本次图片内容是通过 OCR 文字识别读取的」——
// 无感(不长篇、不影响正文)但明显(用户务必清楚知道用了 OCR)。直击本轮目标「Khy 无法正确读图
// 降级到 OCR,要能无感明显告知用户用了 OCR 但能正确识别图片」。
//
// 单一真源:门 KHY_OCR_USAGE_DISCLOSURE(default-on)。门关 → 返回 null,不注入,逐字节回退到
// 历史「模型据 OCR 文本作答但不向用户披露」的行为。fail-soft:畸形输入绝不抛,一律返回 null。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_USAGE_DISCLOSURE';

function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 渲染面向模型的「用 OCR 透明告知」指令。门关 / 无有效图片计数(count 非正整数)/ 畸形 → null
// (不注入,逐字节回退)。count = 本次成功提取到 OCR 文本的图片数,仅用于措辞,缺失时用泛称。
function buildUsageDisclosure({ count, env } = {}) {
  if (!isEnabled(env)) return null;
  const n = Number(count);
  const hasCount = Number.isFinite(n) && n > 0;
  if (!hasCount) return null;
  const noun = n === 1 ? '这张图片' : `这 ${n} 张图片`;
  return `[系统提示:上述${noun}的内容并非由多模态视觉模型直接「看」到,而是通过 OCR 文字识别`
    + `从图像中提取所得。请在正常回答用户问题的同时,用一句自然、简短的话向用户明确说明「本次`
    + `图片内容是通过 OCR 文字识别读取的」——不要长篇解释、不要影响正文回答,但务必让用户清楚`
    + `知道这次用的是 OCR 而非原生看图。]`;
}

module.exports = { isEnabled, buildUsageDisclosure, FLAG };
