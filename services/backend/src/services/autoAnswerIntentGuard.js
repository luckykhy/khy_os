'use strict';

// autoAnswerIntentGuard.js — 无人值守自动作答的「不偏离用户本意」纯叶子(零 IO、零随机、绝不抛)。
//
// 诉求(goal 2026-07-11「…还有不会偏离用户的本意」):
//   连续几天无人值守时,unattendedAutoAnswer 会对 AskUserQuestion **确定性地取 index 0** 作答。
//   但 index 0 往往只是「模型恰好第一个列出的选项」——没有任何机制核对它是否符合用户的**原始本意**
//   (持久目标文本 / 原始诉求里的关键锚点)。一次这样的盲选可能把整个多日 run 悄悄带偏。
//   本叶子在自动作答**真正选定前**,用**确定性词法信号**把选择校准回用户本意:
//     · 若某选项标签与「目标文本 ∪ 原始诉求锚点」的词法重叠**唯一地严格更高**,就改选它;
//     · 但**显式标注 (Recommended)/(推荐)** 的选项一律尊重(用户明确要「使用最推荐方案」);
//     · 无锚点材料 / 无信号 / 门关 → **逐字节回退**到基线(index 0),绝不擅自改选。
//
// 这是**词法安全网**而非语义理解:只能拦下/校准到「文字上明显更贴合本意」的选项,不做模型调用。
// 诚实边界:它不保证捕获所有语义偏离,但补上了「代替用户拍板却零本意核对」这唯一确定性缺口。

// HOW-TO-EXTEND: 要加新的本意信号,只在 _tokenize 增词法规则或在 refineChoice 增一条**保守**判定
// (默认保留基线,只有强信号才改选)。绝不在此做 IO / 抛出 / 模型调用。

const ON_FALSY = ['0', 'false', 'off', 'no'];

let _questionQuality = null;
function _qq() {
  if (_questionQuality === null) {
    try { _questionQuality = require('./questionQuality'); } catch { _questionQuality = false; }
  }
  return _questionQuality || null;
}

/**
 * Gate: KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD, default ON (nested under the
 * default-OFF parent KHY_UNATTENDED_AUTOANSWER — it only bites when auto-answer
 * is on). Only an explicit falsy value disables it → byte-identical baseline.
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD;
    const v = (raw == null ? '' : String(raw)).trim().toLowerCase();
    if (v === '') return true;
    return !ON_FALSY.includes(v);
  } catch {
    return true; // conservative = guard on
  }
}

/**
 * Deterministic tokenizer: latin word tokens ([a-z0-9]{2,}) + CJK 2-char
 * shingles (so Chinese goal/option text overlaps meaningfully without a real
 * segmenter). Returns a Set of lowercased tokens. Never throws.
 * @param {string} text
 * @returns {Set<string>}
 */
function _tokenize(text) {
  const out = new Set();
  try {
    const s = String(text == null ? '' : text).toLowerCase();
    if (!s) return out;
    const latin = s.match(/[a-z0-9]{2,}/g) || [];
    for (const w of latin) out.add(w);
    // CJK runs → 2-char shingles (bi-grams). Single-char CJK runs added as-is.
    const cjkRuns = s.match(/[一-鿿]+/g) || [];
    for (const run of cjkRuns) {
      if (run.length === 1) { out.add(run); continue; }
      for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
    }
  } catch { /* fail-soft to whatever accumulated */ }
  return out;
}

/**
 * Build the intent token set from the anchor material available at the call site.
 * @param {{goalText?:string, intentAnchors?:Array, originalMessage?:string}} ctx
 * @returns {Set<string>}
 */
function buildIntentTokens(ctx) {
  const tokens = new Set();
  try {
    if (!ctx || typeof ctx !== 'object') return tokens;
    const push = (t) => { for (const x of _tokenize(t)) tokens.add(x); };
    if (ctx.goalText) push(ctx.goalText);
    if (ctx.originalMessage) push(ctx.originalMessage);
    if (Array.isArray(ctx.intentAnchors)) {
      for (const a of ctx.intentAnchors) {
        if (typeof a === 'string') push(a);
        else if (a && (a.text || a.value || a.label)) push(a.text || a.value || a.label);
      }
    }
  } catch { /* fail-soft */ }
  return tokens;
}

/** Readable label of an option (string as-is; object → label/value). */
function _optLabel(o) {
  if (typeof o === 'string') return o;
  if (o && (o.label || o.value)) return String(o.label || o.value);
  return '';
}

/** Descriptive text of an option (label + description) for overlap scoring. */
function _optText(o) {
  try {
    const label = _optLabel(o);
    const desc = (o && typeof o === 'object' && o.description) ? String(o.description) : '';
    return `${label} ${desc}`.trim();
  } catch { return ''; }
}

/** Overlap = count of intent tokens present in the option's token set. */
function _overlapScore(optText, intentTokens) {
  try {
    if (!intentTokens || intentTokens.size === 0) return 0;
    const optTokens = _tokenize(optText);
    if (optTokens.size === 0) return 0;
    let n = 0;
    for (const t of optTokens) if (intentTokens.has(t)) n += 1;
    return n;
  } catch { return 0; }
}

/**
 * Refine the auto-answer choice toward the user's original intent.
 *
 * Contract (all fail-soft; NEVER throws):
 *   - Disabled / no options / no baseline → return the baseline unchanged.
 *   - Baseline option is explicitly (Recommended)/(推荐) → honored, kept (user
 *     asked to "use the most recommended option"); reason 'explicit-recommendation'.
 *   - No intent anchor material → keep baseline; reason 'no-anchor'.
 *   - Some option's intent-overlap is UNIQUELY strictly greater than the
 *     baseline's → realign to it; reason 'intent-aligned', realigned:true.
 *   - Otherwise keep baseline; reason 'baseline-aligned' | 'no-intent-signal'.
 *
 * @param {{options:Array, baselineChoice:*, intentContext:object, env?:object}} args
 * @returns {{choice:*, realigned:boolean, reason:string, baselineScore:number, chosenScore:number}}
 */
function refineChoice(args) {
  const a = args || {};
  const options = Array.isArray(a.options) ? a.options : [];
  const baseline = a.baselineChoice;
  const base = { choice: baseline, realigned: false, reason: 'disabled', baselineScore: 0, chosenScore: 0 };
  try {
    if (!isEnabled(a.env)) return base;
    if (options.length === 0 || baseline == null) return { ...base, reason: 'no-options' };

    // Honor an explicit recommendation — "使用最推荐方案" is the user's stated preference.
    const qq = _qq();
    if (qq && typeof qq.isRecommendedOption === 'function') {
      try {
        if (qq.isRecommendedOption(baseline)) {
          return { ...base, reason: 'explicit-recommendation' };
        }
      } catch { /* fall through to intent scoring */ }
    }

    const intentTokens = buildIntentTokens(a.intentContext);
    if (intentTokens.size === 0) return { ...base, reason: 'no-anchor' };

    const baselineScore = _overlapScore(_optText(baseline), intentTokens);
    // Score every option; find the unique max.
    let bestIdx = -1;
    let bestScore = -1;
    let tie = false;
    for (let i = 0; i < options.length; i += 1) {
      const s = _overlapScore(_optText(options[i]), intentTokens);
      if (s > bestScore) { bestScore = s; bestIdx = i; tie = false; }
      else if (s === bestScore) { tie = true; }
    }

    // Realign only on a clear, unique, strictly-better intent signal that isn't
    // already the baseline. Otherwise keep the baseline byte-identically.
    if (bestScore > 0 && !tie && bestScore > baselineScore) {
      const chosen = options[bestIdx];
      if (_optLabel(chosen) && _optLabel(chosen) !== _optLabel(baseline)) {
        return {
          choice: chosen,
          realigned: true,
          reason: 'intent-aligned',
          baselineScore,
          chosenScore: bestScore,
        };
      }
    }
    return {
      choice: baseline,
      realigned: false,
      reason: baselineScore > 0 ? 'baseline-aligned' : 'no-intent-signal',
      baselineScore,
      chosenScore: baselineScore,
    };
  } catch {
    return base; // absolute fail-soft: never let the guard break auto-answer
  }
}

module.exports = {
  ON_FALSY,
  isEnabled,
  buildIntentTokens,
  refineChoice,
  _tokenize,
  _overlapScore,
  _optLabel,
  _optText,
};
