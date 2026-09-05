'use strict';

/**
 * gateway/_aiGatewayHelpers.js — 从 aiGateway.js 提取的纯函数助手集。
 *
 * Phase 1 重构目标: 把 aiGateway.js 中可独立单测的纯函数提取为独立模块,
 * 使其无需 mock 整个网关依赖树即可测试。
 */

const { isRetryableError: _ecIsRetryable } = require('../retryWithBackoff');

// ── 常量 ──────────────────────────────────────────────────────────────

const KHY_PROTOCOL_PRIORITY_BLOCK = [
  '# KHY Protocol Priority',
  'The KHY protocol and project instructions have the highest priority within this gateway request.',
  'If KHY project instructions define language behavior, they override lower-priority compat files such as CLAUDE.md and AGENTS.md.',
  'Default to Chinese for user-facing replies unless the user explicitly requests another language.',
].join('\n');

const KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK = [
  '# Language',
  'KHY expected output: Simplified Chinese.',
  'Reply to the user in Simplified Chinese.',
  'The first visible sentence must be in Simplified Chinese.',
  'Do not begin with English.',
].join('\n');

const CODEX_GENERATION_PROBE_PROMPT = '只用一句中文回复：已收到，不要调用工具。';

// ── 错误类型判定 ──────────────────────────────────────────────────────

function shouldUseFastFail(errorType = '') {
  const t = String(errorType || '').toLowerCase();
  return t === 'auth' || t === 'permission' || t === 'unavailable' || t === 'process';
}

function isRetryableResultErrorType(errorType = '') {
  return _ecIsRetryable(String(errorType || '').trim().toLowerCase());
}

// ── 数值解析 ──────────────────────────────────────────────────────────

function parsePositiveInt(raw, fallback, min = 1, max = 16) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function parseNonNegativeInt(raw, fallback, max = 16) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function parseFloat01(raw, fallback, min = 0, max = 1) {
  const parsed = parseFloat(String(raw ?? fallback));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

// ── 字符串处理 ────────────────────────────────────────────────────────

function sanitizeFailureMessage(message, maxLen = 220) {
  const text = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return 'unknown error';
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function normalizeAdapterSig(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) {
    return 'adapter';
  }
  if (s === 'localllm' || s === 'local llm' || s.includes('local (') || s.includes('本地模型')) {
    return 'localllm';
  }
  if (s === 'codex' || s.includes('openai codex')) {
    return 'codex';
  }
  if (s === 'claude' || s.includes('anthropic')) {
    return 'claude';
  }
  if (s === 'ollama' || s.includes('ollama')) {
    return 'ollama';
  }
  if (s === 'api' || s.includes('multifree')) {
    return 'api';
  }
  if (s === 'relay' || s.includes('relay')) {
    return 'relay';
  }
  return s;
}

// ── 协议注入 ──────────────────────────────────────────────────────────

function injectKhyProtocolSystem(system = '') {
  const inherited = String(system || '').trim();
  if (!inherited) {
    return KHY_PROTOCOL_PRIORITY_BLOCK;
  }
  if (inherited.includes('# KHY Protocol Priority')) {
    return inherited;
  }
  return `${KHY_PROTOCOL_PRIORITY_BLOCK}\n\n${inherited}`;
}

function injectKhyExpectedLanguageSystem(system = '', promptText = '', requestOptions = {}, entryKey = '') {
  const inherited = String(system || '').trim();
  const normalizedEntryKey = String(entryKey || '').trim().toLowerCase();
  if (normalizedEntryKey !== 'codex') {
    return inherited;
  }
  if (requestsExplicitEnglishOutput(promptText, requestOptions)) {
    return inherited;
  }
  if (!requestsChineseOutput(promptText, requestOptions)) {
    return inherited;
  }
  if (resolveExpectedKhyLanguage(promptText, requestOptions) !== 'zh') {
    return inherited;
  }
  if (inherited.includes('KHY expected output: Simplified Chinese.')) {
    return inherited;
  }
  if (!inherited) {
    return KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK;
  }
  return `${KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK}\n\n${inherited}`;
}

function requestsExplicitEnglishOutput(promptText = '', requestOptions = {}) {
  const text = String(promptText || '');
  const opts = requestOptions || {};
  const signal = String(opts.language || opts.lang || '').toLowerCase();
  return signal === 'en' || signal === 'english';
}

function requestsChineseOutput(promptText = '', requestOptions = {}) {
  const text = String(promptText || '');
  const opts = requestOptions || {};
  const signal = String(opts.language || opts.lang || '').toLowerCase();
  return signal === 'zh' || signal === 'chinese' || signal === 'cn';
}

function resolveExpectedKhyLanguage(promptText = '', requestOptions = {}) {
  if (requestsExplicitEnglishOutput(promptText, requestOptions)) {
    return 'en';
  }
  if (requestsChineseOutput(promptText, requestOptions)) {
    return 'zh';
  }
  return 'zh';
}

function isLanguageCorrectionEnabled(adapterKey = '') {
  const k = String(adapterKey || '').trim().toLowerCase();
  return k === 'codex' || k === 'claude' || k === 'ollama';
}

function looksLikeChineseScript(text = '') {
  const t = String(text || '');
  if (!t) return false;
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  return cjk > 0 && cjk / t.length > 0.3;
}

function looksLikeEnglishScript(text = '') {
  const t = String(text || '');
  if (!t) return false;
  const ascii = (t.match(/[a-zA-Z]/g) || []).length;
  return ascii > 0 && ascii / t.length > 0.5;
}

function normalizeVisibleChunkText(chunk = null) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  if (chunk.text) return String(chunk.text);
  if (chunk.content) return String(chunk.content);
  return '';
}

function normalizeLanguageAdapterKey(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.toLowerCase();
  if (entry.adapterKey) return String(entry.adapterKey).toLowerCase();
  if (entry.provider) return String(entry.provider).toLowerCase();
  if (entry.key) return String(entry.key).toLowerCase();
  return String(entry).toLowerCase();
}

function formatRouteAgeMs(ageMs = 0) {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

function adapterMayOverridePromptDownstream(adapterKey = '') {
  const k = String(adapterKey || '').trim().toLowerCase();
  return k === 'codex' || k === 'claude' || k === 'ollama';
}

function getKhyProtocolPriorityRisk(adapterLike = null) {
  if (!adapterLike) return 'unknown';
  const k = typeof adapterLike === 'string' ? adapterLike.toLowerCase() : String(adapterLike.provider || adapterLike.adapterKey || '').toLowerCase();
  if (k === 'codex') return 'high';
  if (k === 'claude') return 'low';
  if (k === 'ollama') return 'low';
  return 'medium';
}

// ── 导出 ──────────────────────────────────────────────────────────────

module.exports = {
  shouldUseFastFail,
  isRetryableResultErrorType,
  parsePositiveInt,
  parseNonNegativeInt,
  parseFloat01,
  sanitizeFailureMessage,
  normalizeAdapterSig,
  injectKhyProtocolSystem,
  injectKhyExpectedLanguageSystem,
  requestsExplicitEnglishOutput,
  requestsChineseOutput,
  resolveExpectedKhyLanguage,
  isLanguageCorrectionEnabled,
  looksLikeChineseScript,
  looksLikeEnglishScript,
  normalizeVisibleChunkText,
  normalizeLanguageAdapterKey,
  formatRouteAgeMs,
  adapterMayOverridePromptDownstream,
  getKhyProtocolPriorityRisk,
  KHY_PROTOCOL_PRIORITY_BLOCK,
  KHY_EXPECTED_CHINESE_LANGUAGE_BLOCK,
  CODEX_GENERATION_PROBE_PROMPT,
};
