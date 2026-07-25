'use strict';

/**
 * selfHeal/errorDiagnostician.js — ErrorDiagnostician：原始错误 → 结构化诊断 + 处方。
 *
 * 这是「先救后报」的归因入口。它绝不臆造原因，而是三源合一：
 *   1) failsafe.classify   —— 把任意原始信号归并到 E01–E08 标准码（已脱敏）。
 *   2) resilience.classifyFailure —— 给出降级树用的失败原因（missing-dependency/http-4xx/...）。
 *   3) diagnosisDictionary —— 单一真源的「病因 + 处方 + 风险级别」，处方只来自字典（防注入）。
 *
 * 产出统一诊断对象（供 MicroLoopExecutor / FallbackTreeWithHeal 消费）：
 *   {
 *     error_code,   // E0x（来自 failsafe，脱敏后的稳定码）
 *     reason,       // 降级树口径的失败原因（来自 resilience）
 *     cause,        // 中文病因（来自字典；无字典命中时给安全兜底文案）
 *     risk,         // L0 | L1 | L2 | null（无命中视为不可本地修复 → 降级）
 *     needsConfirm, // L1 是否需用户确认
 *     fixKind,      // inject-defaults | retarget-path | install-dependency |
 *                   // switch-runtime | probe-port | degrade-direct | refuse | null
 *     action,       // 处方动作字符串（仅展示）
 *     capture,      // 抽取的受控标识（dep / command / path / hostPort）
 *     fixable,      // 是否可进入修复微循环并产生真实修复
 *     detail,       // 脱敏后的人读详情（来自 failsafe）
 *   }
 *
 * 防呆：L2（refuse / dangerous / egress）一律 fixable=false——**禁止进入修复微循环**，
 *       直接走降级树。degrade-direct（如 403）也 fixable=false（它的"修复"就是降级本身）。
 */

const diagnosisDictionary = require('./diagnosisDictionary');

let _failsafe = null;
function _getFailsafe() {
  if (_failsafe === undefined) return null;
  if (_failsafe) return _failsafe;
  try { _failsafe = require('../failsafe'); } catch { _failsafe = undefined; return null; }
  return _failsafe;
}

let _resilience = null;
function _classifyFailure(failure) {
  if (_resilience === undefined) return _fallbackClassify(failure);
  if (!_resilience) {
    try { _resilience = require('../resilience'); } catch { _resilience = undefined; return _fallbackClassify(failure); }
  }
  try { return _resilience.classifyFailure(failure); } catch { return _fallbackClassify(failure); }
}

function _fallbackClassify(failure) {
  const msg = _extractText(failure);
  return { code: 'UNKNOWN', reason: 'execution-error', retryable: false, missingDependency: null, message: msg };
}

/** 仅 fixKind 属于"能产生真实本地/受控修复"的种类才进微循环。 */
const FIXABLE_KINDS = Object.freeze(new Set([
  'inject-defaults', 'retarget-path', 'install-dependency', 'switch-runtime', 'probe-port',
]));

/**
 * 把失败信号抽成可匹配文本（兼容 Error / ToolError 结构化结果 / 软失败对象 / 字符串）。
 */
function _extractText(failure) {
  if (!failure) return '';
  if (typeof failure === 'string') return failure;
  const parts = [];
  if (failure instanceof Error || typeof failure.message === 'string') parts.push(failure.message || '');
  if (failure.detail) parts.push(String(failure.detail));
  if (failure.note) parts.push(String(failure.note));
  if (failure.hint) parts.push(String(failure.hint));
  if (failure.reason && typeof failure.reason === 'string') parts.push(failure.reason);
  if (failure.error) {
    if (typeof failure.error === 'string') parts.push(failure.error);
    else if (typeof failure.error === 'object') {
      parts.push(String(failure.error.message || ''));
      parts.push(String(failure.error.hint || ''));
      parts.push(String(failure.error.code || ''));
    }
  }
  if (failure.code && typeof failure.code === 'string') parts.push(failure.code);
  if (failure.stack && typeof failure.stack === 'string') parts.push(failure.stack.split('\n')[0]);
  return parts.filter(Boolean).join(' \n ');
}

/** 从失败信号里抽一个归一化错误码，喂给字典做精确命中（HTTP_403 / EROFS / ECONNREFUSED / ...）。 */
function _normalizedCode(failure, classified) {
  // 1) 显式结构化码
  const explicit = (failure && (failure.code || (failure.error && failure.error.code)))
    || (classified && classified.error_code);
  if (explicit && typeof explicit === 'string') {
    const up = explicit.toUpperCase();
    if (/^E0[1-8]$/.test(up)) {
      // E0x 是 failsafe 码，不直接当字典 code 用；交给文本命中。
    } else {
      return up;
    }
  }
  // 2) 从文本派生常见系统码
  const t = _extractText(failure);
  let m = t.match(/\b(EROFS|ECONNREFUSED|EACCES|ENOENT|ETIMEDOUT|ENOTFOUND)\b/i);
  if (m) return m[1].toUpperCase();
  m = t.match(/\bhttp[\s_]?(\d{3})\b|\b(40[13]|429|5\d\d)\b\s*(?:forbidden|unauthorized|error)?/i);
  if (m) {
    const status = m[1] || m[2];
    if (status) return `HTTP_${status}`;
  }
  if (/modulenotfounderror|cannot find module|no module named/i.test(t)) return 'MISSING_DEPENDENCY';
  return '';
}

class ErrorDiagnostician {
  /**
   * @param {object} [opts]
   * @param {object} [opts.dictionary]  诊断字典（默认内置单一真源）
   */
  constructor(opts = {}) {
    this.dictionary = opts.dictionary || diagnosisDictionary;
  }

  /**
   * 诊断一个原始错误。
   * @param {Error|object|string} rawError
   * @param {object} [context]  { params, path, model, tool, ... } 供路径类抽取/脱敏
   * @returns {object} 见文件头注释的统一诊断对象
   */
  diagnose(rawError, context = {}) {
    // 1) failsafe 标准码 + 脱敏详情（绝不把原始 Error 直抛）。
    let classified = null;
    const fs = _getFailsafe();
    if (fs && typeof fs.classify === 'function') {
      try { classified = fs.classify(rawError, { ...context, kind: context.kind || 'tool' }); } catch { classified = null; }
    }
    const error_code = (classified && classified.error_code) || 'E04';
    const detail = (classified && classified.detail) || _safeDetail(rawError);

    // 2) resilience 失败原因（降级树口径）。
    const failure = _classifyFailure(rawError);
    const reason = (failure && failure.reason) || 'execution-error';

    // 3) 字典命中：病因 + 处方 + 风险级别（单一真源；处方只来自字典）。
    const text = _extractText(rawError);
    const code = _normalizedCode(rawError, classified);
    let dx = null;
    try { dx = this.dictionary.diagnose(text, code, context); } catch { dx = null; }

    if (!dx) {
      // 无字典命中 → 不可本地修复，交降级树。归因仍完整（病因取 failsafe 分类）。
      return {
        error_code, reason,
        cause: (classified && classified.category) || '未归类的执行失败',
        risk: null, needsConfirm: false, fixKind: null, action: null, capture: {},
        fixable: false, detail,
        missingDependency: (failure && failure.missingDependency) || null,
      };
    }

    const fixable = dx.risk !== this.dictionary.RISK.L2
      && FIXABLE_KINDS.has(dx.fixKind);

    // 字典命中比 failsafe 文本归类更精准时，校正错误码（保持与 E01–E08 单一真源一致）：
    //   依赖缺失 → E05（即便原始 Error 无结构化码，文本派生为 E04）。
    let code2 = error_code;
    if (dx.fixKind === 'install-dependency' && code2 === 'E04') code2 = 'E05';
    if (dx.id === 'http-forbidden' && (code2 === 'E04')) code2 = 'E07';

    return {
      error_code: code2, reason,
      cause: dx.cause,
      risk: dx.risk,
      needsConfirm: !!dx.needsConfirm,
      fixKind: dx.fixKind,
      action: dx.action,
      capture: dx.capture || {},
      fixable,
      detail,
      missingDependency: (failure && failure.missingDependency)
        || (dx.capture && dx.capture.dep) || null,
    };
  }
}

/** 兜底详情：失败信号转一句安全人读文案（不含栈/密钥风险时也截断）。 */
function _safeDetail(rawError) {
  const t = _extractText(rawError);
  if (!t) return '工具执行失败（无可读详情）。';
  return t.replace(/\s+/g, ' ').trim().slice(0, 300);
}

module.exports = {
  ErrorDiagnostician,
  FIXABLE_KINDS,
  _extractText,
  _normalizedCode,
};
