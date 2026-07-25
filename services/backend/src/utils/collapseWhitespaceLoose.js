'use strict';

/**
 * collapseWhitespaceLoose.js — 「空白折叠 + 去首尾」falsy 强转变体单一真源(纯)。
 *
 * 收敛 src/ 下 5 处 body 逐字节相同、仅函数名/默认参不同的
 *   `String(x || '').replace(/\s+/g, ' ').trim()`
 * (quickTaskService._cleanInput · localBrainService._cleanInput ·
 *  localBrainSessionContext._cleanInput · ragRetrievalService._normalizeSpace ·
 *  cli/errorSummary._normalizeSpace):
 *   falsy(''/0/false/null/undefined)→ ''、连续空白折叠单空格、去首尾。
 *
 * **与 collapseWhitespace(R34,nullish `x==null?'':x` 变体)刻意分开**:
 *   二者仅在 falsy 非 nullish 值上分叉——`0`/`false` 经本函数 → ''(String(0||'')),
 *   经 collapseWhitespace → '0'/'false'(String(0==null?'':0))。语义不同,不合并(C組纪律)。
 *
 * 契约:纯函数(确定性、无 IO、不 mutate)。`/\s+/g` 的 g 是 replace 全替所需,非 test/exec 无状态隐患。
 * 无参调用 → String(undefined||'')→'',与各消费方 `(x='')` 默认参等价。
 *
 * 各消费方保留同名本地 `const _xxx = require('.../utils/collapseWhitespaceLoose')` → 调用点逐字节不变。
 */

function collapseWhitespaceLoose(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

module.exports = collapseWhitespaceLoose;
