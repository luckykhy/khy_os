'use strict';

// OCR 兜底「图片方向自动校正」诚实告诫（第五条正交诚实轴 —— 唯一的「纠正型」轴）。
//
// 前四条(准确性/覆盖率/单图截断/语言包可用性)都只**披露**问题；本条不同：docHelper 在纯文本
// 模型的 OCR 路径上，若正向读取很弱（失败或低置信 —— 侧拍照片会读出「置信度看着不低」的乱码，
// 例如旋转 90° 的发票读成 '9202 AWOV ADIOANI' conf 51），会暴力尝试 90/180/270 三个方向、取
// 置信度最高的可读结果，把文字**真正复原**（旋转后 'INVOICE ACME 2026' conf 91），并在结果里盖
// orientationCorrected=旋转角度。本叶子把「这段文字取自被自动旋正的图像」这一事实显式告知模型，
// 保持透明：模型知道文本来自方向被校正过的图，而非原图方向。
//
// 单一真源：门 KHY_OCR_AUTO_ORIENT（default-on，同时控制 docHelper 的纠正与本告诫）。门关时
// docHelper 根本不做旋转 → 没有 orientationCorrected>0 的数据 → 本叶子自然返回 null，逐字节回退。
// fail-soft：畸形输入绝不抛，一律返回 [] / null。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_AUTO_ORIENT';

function isEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 从每图明细里收集「被自动旋正的角度」：orientationCorrected 为正数才算发生了校正。
// 去重 + 升序；非数组 / 畸形项一律安全跳过，绝不抛。
function computeCorrectedOrientations(details) {
  if (!Array.isArray(details)) return [];
  const degs = new Set();
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    const deg = Number(d.orientationCorrected);
    if (Number.isFinite(deg) && deg > 0) degs.add(deg);
  }
  return Array.from(degs).sort((a, b) => a - b);
}

// 渲染诚实告诫。门关 / 无校正 / 畸形 → null（不注入，逐字节回退）。
function buildOrientationNotice({ corrected, env } = {}) {
  if (!isEnabled(env)) return null;
  if (!Array.isArray(corrected) || corrected.length === 0) return null;
  const list = corrected.map((d) => `${d}°`).join('、');
  return `[提示：以下图片方向不正，OCR 已自动将其旋转校正（${list}）后才成功识别出文字——`
    + `上述文本取自旋正后的图像，而非原图方向。原图方向下的识别结果是不可靠的乱码，已被丢弃。`
    + `请据旋正后的文本作答；若仍有疑问，可改用支持看图的多模态模型复核原图。]`;
}

module.exports = { isEnabled, computeCorrectedOrientations, buildOrientationNotice, FLAG };
