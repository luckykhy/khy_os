'use strict';

/**
 * textHeuristics.js — 零依赖文本启发式叶子（单一真源）。
 *
 * 收纳两个**纯函数、零状态、领域无关**的文本启发式，历史上依附在 1900 行的
 * khyUpgradeRuntime 升级运行时上纯属巧合，被它一拽，轻量的 inputSanitizer 等
 * 调用方就被拖进巨型 SCC（DESIGN-ARCH-051 §6.9 解环战役）：
 *
 *   - estimateTokens(text) → number   token 估算（优先 contextWasm，退化 len/4）
 *   - isGreeting(input)    → boolean   统一问候识别（中英穷举集）
 *
 * 下沉为叶子后，khyUpgradeRuntime 与 inputSanitizer / localBrainService /
 * inputPreprocessor 等**两侧共同依赖叶子**（依赖倒置），运行时与各调用方对外
 * 契约逐字不变。注意：本文件刻意不在注释里书写 require-调用样式——架构债扫描器
 * 按行匹配该样式、不剔注释，写了会被当成幽灵依赖边（§6.2 同坑）。仅下方对
 * contextWasm（SCC 外的可选叶子）的真实调用是允许的结构外依赖。
 *
 * Dependencies: none（contextWasm 为可选叶子，缺失即退化，不构成结构耦合）。
 */

/**
 * 估算 token 数。优先复用 contextWasm 的启发式；不可用时退化为 len/4。
 * 纯函数（除可选的 contextWasm 委托外无副作用、无状态）。
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  // 移除 1.2x 安全系数 — 安全系数只在 contextRouter 应用一次（A2）。
  try {
    const wasm = require('./contextWasm');
    return wasm.estimateTokens(text);
  } catch { /* fallback to JS */ }
  const len = String(text).length;
  return Math.ceil(len / 4);
}

// ── 统一问候识别 ──
// 全仓库问候识别的单一真源。覆盖：claudeAdapter.looksLikeSimpleGreeting、
// inputPurify filler 路径、inputPreprocessor._inferIntent、routes/ai.js 硬编码检查。
const GREETING_EXACT = new Set([
  // Chinese
  '你好', '您好', '嗨', '哈喽', '在吗', '在么', '嘿', '喂', '早',
  '嗨嗨', '嘿嘿', '你好呀', '你好啊', '嗨呀',
  '早上好', '下午好', '晚上好', '早安', '午安', '晚安',
  // English
  'hi', 'hello', 'hey', 'yo', 'sup', 'hiya', 'howdy',
  'goodmorning', 'goodafternoon', 'goodevening', 'goodnight',
]);

/**
 * 判定输入是否为纯问候语。纯函数、零状态。
 * @param {string} input
 * @returns {boolean}
 */
function isGreeting(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 24) return false;
  // Reject if input contains code / path / special chars
  if (/[\n`$\\/]/.test(raw)) return false;
  const compact = raw.toLowerCase().replace(/[！!。.,，?？\s]/g, '');
  if (!compact) return false;
  return GREETING_EXACT.has(compact);
}

module.exports = { estimateTokens, isGreeting, GREETING_EXACT };
