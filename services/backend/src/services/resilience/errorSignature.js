'use strict';

/**
 * resilience/errorSignature.js — 调用签名 + 错误归类。
 *
 * 这是「死循环检测」与「同类错误去重」共用的地基，两件事都需要稳定可比的指纹：
 *
 *   callSignature(tool, params)  把一次工具调用压成稳定短串（与键序无关、忽略
 *                                Symbol 键），用于判断「这次调用和上次是不是同一发子弹」。
 *
 *   classifyFailure(failure)     把任意失败信号（Error / 结构化结果 / 纯文本）归一为
 *                                一个**短原因码**（如 missing-dependency / http-403 /
 *                                timeout），既喂给兜底协议的 attempted_paths.reason，
 *                                也用于判断「同类错误」——同一 Plan 不得在同类错误上反复重试。
 *
 * 纯函数、零副作用、零 require（除本地），任何输入都不抛错（防呆：归类器自身绝不成为新的故障源）。
 */

/** 与键序无关的稳定 JSON 序列化（忽略 Symbol 键，避免 EXEC_APPROVED 之类污染签名）。 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'function') return '"[fn]"';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => typeof k === 'string').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return '"[unknown]"';
}

/** djb2 — 把任意串压成短的 base36 指纹（碰撞概率对本用途足够低）。 */
function _djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 一次工具调用的稳定签名：`<tool小写>#<params指纹>`。
 * 同 tool 同 params ⇒ 同签名 ⇒ 视为「同一发子弹」。
 */
function callSignature(tool, params = {}) {
  const name = String(tool || '').trim().toLowerCase();
  let body;
  try { body = stableStringify(params || {}); } catch { body = String(params); }
  return `${name}#${_djb2(body)}`;
}

// ── 失败文本/错误码抽取 ─────────────────────────────────────────────

function _failureText(failure) {
  if (!failure) return '';
  if (typeof failure === 'string') return failure;
  if (failure instanceof Error) return failure.message || '';
  if (typeof failure === 'object') {
    if (failure.error && typeof failure.error === 'object') {
      return failure.error.message || failure.error.code || '';
    }
    if (typeof failure.error === 'string') return failure.error;
    if (typeof failure.message === 'string') return failure.message;
    if (typeof failure.note === 'string') return failure.note;
  }
  return '';
}

function _failureCode(failure) {
  if (failure && typeof failure === 'object') {
    if (failure.error && typeof failure.error === 'object' && failure.error.code) return failure.error.code;
    if (failure.code) return failure.code;
  }
  return '';
}

/**
 * 把任意失败信号归类为结构化短原因。
 *
 * @param {*} failure  Error / {success:false,error} / 纯文本 / null
 * @returns {{
 *   code: string,                 // 归一化错误码（沿用 toolError 的 ERROR_CODES 词表 + HTTP_xxx）
 *   reason: string,               // 给人/兜底 JSON 看的短原因（missing-dependency / http-403 / timeout …）
 *   retryable: boolean,           // 是否「换了输入/瞬态」才值得重试一次（同类错误本身不算）
 *   missingDependency: string|null,
 *   message: string,              // 原始细节
 * }}
 */
function classifyFailure(failure) {
  const text = _failureText(failure);
  const lc = text.toLowerCase();
  const explicit = String(_failureCode(failure) || '').toUpperCase();

  // HTTP 状态码（4xx/5xx）——优先从结构化字段取，退回正则。
  let http = '';
  if (failure && typeof failure === 'object') {
    const s = failure.status || failure.statusCode
      || (failure.error && typeof failure.error === 'object' ? failure.error.status : '');
    if (s && /^[45]\d\d$/.test(String(s))) http = String(s);
  }
  if (!http) {
    const m = text.match(/\b([45]\d\d)\b/);
    if (m) http = m[1];
  }

  let code = explicit || 'EXECUTION_ERROR';
  let reason = 'execution-error';
  let missingDependency = null;

  const depMatch = lc.match(/\b(?:install|installing)\s+(puppeteer|playwright|ffmpeg|whisper|sox|python3?|torch|chromium|chrome)\b/);
  const looksMissingDep = explicit === 'MISSING_DEPENDENCY'
    || /\bnot installed\b/.test(lc)
    || /\binstall with\b/.test(lc)
    || /\b(?:npm i+|pip3?|apt-get|brew|winget)\s+install\b/.test(lc)
    || !!depMatch;

  if (looksMissingDep) {
    code = 'MISSING_DEPENDENCY';
    reason = 'missing-dependency';
    missingDependency = (depMatch && depMatch[1])
      || (failure && failure.missingDependency)
      || (failure && failure._depHealing && failure._depHealing.missingDependency)
      || null;
  } else if (http) {
    code = `HTTP_${http}`;
    reason = `http-${http}`;
  } else if (explicit === 'TIMEOUT' || /\btimed?\s*out\b|etimedout|esockettimedout/.test(lc)) {
    code = 'TIMEOUT';
    reason = 'timeout';
  } else if (explicit === 'NETWORK_ERROR' || /\bnetwork\b|econnrefused|enotfound|eai_again|fetch failed|dns/.test(lc)) {
    code = 'NETWORK_ERROR';
    reason = 'network';
  } else if (explicit === 'PERMISSION_DENIED' || /permission denied|eacces|eperm|forbidden|unauthorized/.test(lc)) {
    code = 'PERMISSION_DENIED';
    reason = 'permission';
  } else if (explicit === 'RESOURCE_NOT_FOUND' || /\bnot found\b|enoent|no such file/.test(lc)) {
    code = 'RESOURCE_NOT_FOUND';
    reason = 'not-found';
  } else if (explicit && explicit !== 'EXECUTION_ERROR') {
    // 透传未知但显式的错误码（如自定义工具码），原因取小写化。
    reason = explicit.toLowerCase().replace(/_/g, '-');
  }

  // 仅「瞬态」类错误才有重试价值；missing-dependency/4xx/permission 属「换了输入才该重试」。
  const retryable = code === 'TIMEOUT' || code === 'NETWORK_ERROR';

  return { code, reason, retryable, missingDependency, message: text || '(no detail)' };
}

module.exports = {
  callSignature,
  classifyFailure,
  stableStringify,
};
