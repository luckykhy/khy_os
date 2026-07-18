'use strict';

/**
 * visionNoticeDedup.js — 纯叶子:回合内「用户可见中间消息」逐字节去重(治「心灵噪音」刷屏)。
 *
 * 断桥(/goal「同时减少显示的心灵噪音」):纯文本模型 + 带图 → 视觉描述级联在 agentic 工具循环里被
 * **多次迭代**重入(实测 paste-cache 92c0154d:一个回合内 `正在调用 <模型> 请稍候...` 出现 6 次、
 * 大块 `图像识别失败:...` 出现 3 次)。每次 emitAssistantMessage 都是一条 type:'assistant_message'
 * chunk,REPL 逐条渲染 → 同一句话在一个回合里被刷屏三遍。前几层(KHY_VISION_INTERMEDIATE_MESSAGE /
 * KHY_VISION_FAILURE_SUMMARY)治「是否告知」,本层治「同一告知在一个回合里重复几遍」。
 *
 * 判据:一个回合内**逐字节相同**的中间消息,第 2..N 次纯属重复噪音——首次已「明显告知」,后续无新信息。
 * 保留每一条**不同**的中间消息(不同视觉模型名、不同失败真因 → 签名不同 → 全部照常渲染),
 * 只压制逐字节重复。故「减少心灵噪音」与「无感明显告知」两不误。
 *
 * 契约:零 IO、确定性、绝不抛。门控 default-on(去重生效);取 CANON off-word(0/false/off/no)
 *   关闭 → shouldRender 恒真 = 调用方逐字节回退旧「每条都渲染」行为。
 *
 * 用法(REPL assistant_message 分支):
 *   const seen = new Set();                 // 回合作用域闭包变量,横跨工具循环所有迭代
 *   if (msgText && dedup.shouldRender(seen, msgText, process.env)) { ...render... }
 */

const FLAG = 'KHY_VISION_NOTICE_DEDUP';

// 门控:委派 flagRegistry 判定(default-on);require 失败 → 保守回退「仅显式 0/false/off/no 关」。绝不抛。
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const flagRegistry = require('../services/flagRegistry');
    return flagRegistry.isFlagEnabled(FLAG, e);
  } catch {
    const raw = String(e[FLAG] == null ? '' : e[FLAG]).trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
  }
}

// 归一化签名:去首尾空白后原文。逐字节比较——不同模型名 / 不同失败真因天然签名不同,只折叠完全一致的重复。
function signatureOf(msgText) {
  if (typeof msgText !== 'string') return null;
  const s = msgText.trim();
  return s.length ? s : null;
}

/**
 * 判定这条中间消息本回合是否应渲染,并在「应渲染」时把签名记入 seenSet(供后续迭代去重)。
 *   - 门关 → 恒真(逐字节回退:每条都渲染,不触碰 seenSet)。
 *   - 非法入参(seenSet 非 Set / msgText 空)→ 真(交回调用方既有 msgText 守卫,绝不吞掉合法消息)。
 *   - 门开且签名本回合已见 → 假(压制重复噪音)。
 *   - 门开且首见 → 记入 seenSet,返回真。
 * 绝不抛:任何异常 → 真(fail-open,宁可多渲染也不吞消息)。
 */
function shouldRender(seenSet, msgText, env) {
  try {
    if (!isEnabled(env)) return true;
    if (!(seenSet instanceof Set)) return true;
    const sig = signatureOf(msgText);
    if (sig == null) return true;
    if (seenSet.has(sig)) return false;
    seenSet.add(sig);
    return true;
  } catch {
    return true;
  }
}

module.exports = { FLAG, isEnabled, signatureOf, shouldRender };
