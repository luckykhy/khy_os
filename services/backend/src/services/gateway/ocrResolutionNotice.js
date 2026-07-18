'use strict';

// OCR 兜底「低分辨率图片自动放大」诚实告诫（第六条正交诚实轴 —— 第二条「纠正型」轴）。
//
// 前四条(准确性/覆盖率/单图截断/语言包)只**披露**问题；方向轴(第五条)与本条是**纠正型**：
// docHelper 在纯文本模型的 OCR 路径上，若读取很弱（失败或低置信 —— 分辨率过低时 tesseract 在原始
// 尺寸下常常一个字都读不出：实测 102×10 的 'INVOICE' 裁剪原尺寸返回空，放大 2× 后 conf≈96 完美读出），
// 会暴力尝试 2×/3×/4× 放大（单一固定倍数不可靠：实测 3× 反而漏读而 2×/4× 成功）、取置信度最高的可读
// 结果，把文字**真正复原**，并在结果里盖 upscaledFactor=放大倍数。本叶子把「这段文字取自被自动放大的
// 低分辨率图像」这一事实显式告知模型，保持透明。
//
// 单一真源：门 KHY_OCR_UPSCALE（default-on，同时控制 docHelper 的放大与本告诫）。门关时 docHelper
// 根本不放大 → 没有 upscaledFactor>1 的数据 → 本叶子自然返回 null，逐字节回退。
// fail-soft：畸形输入绝不抛，一律返回 [] / null。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_UPSCALE';

function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 从每图明细里收集「被自动放大的倍数」：upscaledFactor > 1 才算发生了放大恢复。
// 去重 + 升序；非数组 / 畸形项一律安全跳过，绝不抛。
function computeUpscaledFactors(details) {
  if (!Array.isArray(details)) return [];
  const factors = new Set();
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const f = Number(d.upscaledFactor);
    if (Number.isFinite(f) && f > 1) factors.add(f);
  }
  return Array.from(factors).sort((a, b) => a - b);
}

// 渲染诚实告诫。门关 / 无放大 / 畸形 → null（不注入，逐字节回退）。
function buildResolutionNotice({ upscaled, env } = {}) {
  if (!isEnabled(env)) return null;
  if (!Array.isArray(upscaled) || upscaled.length === 0) return null;
  const list = upscaled.map((f) => `${f}×`).join('、');
  return `[提示：以下图片分辨率较低，OCR 在原始尺寸下无法可靠识别；系统已将其自动放大（${list}）后`
    + `才成功提取出文字——上述文本取自放大后的图像。低分辨率图像放大恢复的结果可能仍不完整或有误，`
    + `请谨慎采信；若条件允许，建议改用更高清的原图或支持看图的多模态模型复核。]`;
}

module.exports = { isEnabled, computeUpscaledFactors, buildResolutionNotice, FLAG };
