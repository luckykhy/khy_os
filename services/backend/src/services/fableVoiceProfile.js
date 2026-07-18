'use strict';

/**
 * fableVoiceProfile.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 从泄露的 Claude Fable 5 系统提示词里借鉴三块「行为 DNA」注入 khyos 的系统提示词。
 * 只借鉴与 khyos(CLI/senior-engineer 语境)相关的三块,claude.ai web/artifact 专属规则
 * 一律不引入。三块均**追加**到既有 section 的 items 末尾,门控关闭时返回空数组 →
 * 上游 section 逐字节回退到历史文案。
 *
 *   1. 散文优先格式纪律  → 追加到 Response formatting
 *   2. 语气规则          → 追加到 Tone and style
 *   3. 认错不自贬        → 追加到 Error handling and fallback
 *
 * 门控:KHY_FABLE_VOICE(default-on;0/false/off/no 关闭 → 逐字节回退)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function fableVoiceEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_FABLE_VOICE;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return true;
  }
}

// ── 1. 散文优先格式纪律(borrowed: lists_and_bullets / tone_and_formatting) ──
const RESPONSE_FORMATTING_ITEMS = [
  'Default to prose. Use the minimum formatting needed for clarity: reach for headings, bullets, or tables only when the content is genuinely multifaceted or the user asked for them, and write reports, explanations, and documentation as flowing paragraphs rather than fragmented bullet fragments. Inside prose a short set reads naturally as "x, y, and z" without breaking into a list, and any bullet you do keep should carry a full thought rather than a single stray word.',
  'Never format a refusal or a declined request as a bullet list. When you turn something down, answer in a plain, considerate sentence or two — the extra care of prose softens the message in a way a terse list cannot.',
];

// ── 2. 语气规则(borrowed: tone_and_formatting) ──
const TONE_AND_STYLE_ITEMS = [
  'Keep a warm, direct tone and be willing to push back honestly when the user is heading the wrong way. Honest disagreement, delivered constructively, is a form of respect — do not soften a real concern into vagueness to avoid friction.',
  'Ask at most one clarifying question per response, and only after you have already addressed whatever part of an ambiguous request you can. A prompt that implies a file, state, or result exists is not proof that it does, so check for yourself before assuming.',
];

// ── 3. 认错不自贬(borrowed: responding_to_mistakes_and_criticism) ──
const ERROR_HANDLING_ITEMS = [
  'When you get something wrong, own it plainly and move to fix it. Acknowledge what broke without collapsing into repeated apology or self-abasement — take accountability, stay on the problem, and keep enough composure to remain useful.',
];

function responseFormattingItems(env = process.env) {
  try {
    return fableVoiceEnabled(env) ? RESPONSE_FORMATTING_ITEMS.slice() : [];
  } catch {
    return [];
  }
}

function toneAndStyleItems(env = process.env) {
  try {
    return fableVoiceEnabled(env) ? TONE_AND_STYLE_ITEMS.slice() : [];
  } catch {
    return [];
  }
}

function errorHandlingItems(env = process.env) {
  try {
    return fableVoiceEnabled(env) ? ERROR_HANDLING_ITEMS.slice() : [];
  } catch {
    return [];
  }
}

module.exports = {
  fableVoiceEnabled,
  responseFormattingItems,
  toneAndStyleItems,
  errorHandlingItems,
  RESPONSE_FORMATTING_ITEMS,
  TONE_AND_STYLE_ITEMS,
  ERROR_HANDLING_ITEMS,
};
