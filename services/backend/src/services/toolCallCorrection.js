'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO、确定性、绝不抛（坏输入返 null）、可单测。
//   判定全在叶子里；改写调用（IO 侧效果）由接线处（toolUseLoopCore 解析汇合点）施加。
//   形状对齐 taskClosure.js / toolFailureRecovery.js —— 单一职责叶子 + 接线处 fail-soft。

/**
 * toolCallCorrection.js — 工具调用名**执行前确定性纠正**（准确性分支）。
 *
 * ── 根因（为什么近似错误的工具名浪费一整轮）────────────────────────────────
 * 模型（尤其弱模型）会发明近乎正确的工具名：`read_fiel` / `web_serch` / `ReadFile` /
 * `web-search`。此前这些名字原样进 executeTool → TOOL_UNAVAILABLE 失败 → 错误文本回灌
 * 模型 → 模型要花一整轮才能自行纠正。而已知工具名集合（含别名/变体）在循环里早已算出，
 * 却只用于 loopDetector 的「未知检测」，从不用于「执行前纠正」。
 *
 * ── 纠错阶梯（保守优先：宁可放行给失败分支，绝不猜歧义名）──────────────────
 *   L1 键匹配   : normalizeToolKey（去分隔符+小写）两侧相等 → 返回已注册的规范名。
 *                 覆盖 `ReadFile`→`read_file`、`WEB-FETCH`→`web_fetch` 这类大小写/分隔符偏差。
 *   L2 编辑距离 : 键空间上 Levenshtein ≤ 阈值（短名 ≤5 字符取 1，长名取 2），且**唯一**
 *                 最小命中 → 返回该名。并列最小（歧义）→ null，绝不猜。
 *   L3 放行     : 其余 → null。调用照原样执行，失败走既有恢复分支（意图等价替换 /
 *                 Branch R/H / unknown exploration），错误信号不丢失。
 *
 * 键空间按 normalizeToolKey 去重（`read_file`/`readFile`/`readfile` 同键不互相打架），
 * 代表名取已知清单中的首个注册形态（确定性）。
 */

const _str = require('../utils/toStr').toStr;

const { normalizeToolKey } = require('./toolCallParser');

function _levenshtein(a, b) {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function _threshold(len) {
  return len <= 5 ? 1 : 2;
}

/**
 * 工具调用名纠正。纯函数、绝不抛。
 *
 * @param {string} rawName    - 模型给出的原始工具名
 * @param {Array<string>} knownNames - 已知工具名清单（含别名/变体；接线处经
 *   `_resolveKnownToolNames(allTools)` 提供）
 * @returns {string|null} 纠正后的工具名；无需纠正或无法唯一确定 → null
 */
function correctToolName(rawName, knownNames) {
  const original = _str(rawName);
  const raw = original.trim();
  const known = Array.isArray(knownNames) ? knownNames.filter(Boolean) : [];
  if (!raw || known.length === 0) {
    return null;
  }

  // 键 → 代表名（首个注册形态）；同时记录键数组用于距离匹配。
  const keyMap = new Map();
  for (const name of known) {
    const key = normalizeToolKey(name);
    if (key && !keyMap.has(key)) {
      keyMap.set(key, name);
    }
  }

  const rawKey = normalizeToolKey(raw);
  if (!rawKey) {
    return null;
  }

  // L1: 键精确匹配 → 返回已注册代表名（大小写/分隔符/首尾空白归一）。
  // 与**未裁剪原值**比较：'  grep  ' → 'grep' 也算纠正（原样执行会因空白失败）。
  if (keyMap.has(rawKey)) {
    const canonical = keyMap.get(rawKey);
    return canonical === original ? null : canonical;
  }

  // L2: 唯一编辑距离命中（键空间去重后比较，杜绝同工具变体互相顶票）。
  const threshold = _threshold(rawKey.length);
  let bestKey = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const key of keyMap.keys()) {
    const dist = _levenshtein(rawKey, key);
    if (dist > threshold) {
      continue;
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = key;
      tie = false;
    } else if (dist === bestDist) {
      tie = true;
    }
  }
  if (bestKey && !tie) {
    return keyMap.get(bestKey);
  }
  return null;
}

/** 纠错总开关（默认开）。显式 0/false/off/no 关 → 接线处整段跳过。 */
function isCorrectionEnabled(env) {
  const e = env || process.env || {};
  return !['0', 'false', 'off', 'no'].includes(
    String(e.KHY_TOOL_NAME_CORRECTION == null ? '' : e.KHY_TOOL_NAME_CORRECTION)
      .trim()
      .toLowerCase()
  );
}

module.exports = {
  correctToolName,
  isCorrectionEnabled,
};
