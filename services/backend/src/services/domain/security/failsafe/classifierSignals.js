'use strict';

/**
 * failsafe/classifierSignals.js — ErrorClassifier 的「信号识别 + 文本脱敏/裁剪」层
 * （纯函数、无状态），从 classifier.js 逐字节抽出（棘轮第 15 次翻档的前驱切片）。
 *
 * 只包含不回调 classifier 核心的辅助函数：把任意原始信号识别成 E0x 的谓词
 * （_readExplicitCode / _readDenyVerdict / _readToolErrorCode / _isSafetyFinish /
 * _detectKind …）、码映射（_mapToolErrorCode / _mapKind），以及把原始报错文本脱敏
 * 裁剪的三件套（_redactedMessage / _safeStack / _snippet + _clip）。
 *
 * 依赖方向单向：本叶 require('../../../errorClassifier')（legacy 深链探测/脱敏）与
 * './errorCodes'（isKnownCode）；classifier 核心 require 本叶。二者不成环
 * （errorCodes 零 require，errorClassifier 不回指 failsafe）。
 *
 * 输出结构与脱敏铁律见 classifier.js 头注：E02/E07 为 sensitive，detail/fields
 * 只承载粗类别，绝不泄露系统 Prompt / 审批规则 / 命中策略。
 */

const {
  detectErrorKindDeep,
  formatErrorMessage,
  redactSensitiveText,
} = require('../../../errorClassifier');

const { isKnownCode } = require('./errorCodes');

const MAX_DETAIL = 400;
const MAX_STACK = 1200;
const MAX_SNIPPET = 300;

// ── 信号识别助手 ─────────────────────────────────────────────────────

function _readExplicitCode(o) {
  if (!o || typeof o !== 'object') {
    return null;
  }
  const c = o.error_code || o.errorCode;
  if (typeof c === 'string' && isKnownCode(c)) {
    return c;
  }
  if (o.error && typeof o.error === 'object') {
    const ec = o.error.error_code || o.error.errorCode;
    if (typeof ec === 'string' && isKnownCode(ec)) {
      return ec;
    }
  }
  return null;
}

/** 审批网关裁决形状：{allow:false, decision/level/reasons/tripped}。 */
function _looksLikeDenyVerdict(o) {
  return !!_readDenyVerdict(o);
}

function _readDenyVerdict(o) {
  if (!o || typeof o !== 'object') {
    return null;
  }
  const denied =
    o.allow === false ||
    o.decision === 'deny' ||
    o.decision === 'denied' ||
    o.decision === 'block' ||
    o.tripped === true;
  if (!denied) {
    return null;
  }
  // 至少要有审批语境特征，避免误吞普通 {allow:false}。
  const hasCtx =
    'decision' in o ||
    'level' in o ||
    'reasons' in o ||
    'tripped' in o ||
    'approval_level' in o ||
    'deny_reason' in o;
  return hasCtx ? o : null;
}

function _looksLikeMissingDependency(o) {
  if (!o || typeof o !== 'object') {
    return false;
  }
  if (o.name === 'MissingDependencyError' || o.depId) {
    return true;
  }
  const code = _readToolErrorCode(o);
  return code === 'MISSING_DEPENDENCY';
}

function _readMissingDep(input, ctx) {
  if (input && typeof input === 'object') {
    if (input.depId) {
      return input.depId;
    }
    if (input.missing_dep) {
      return input.missing_dep;
    }
    if (input.error && input.error.depId) {
      return input.error.depId;
    }
  }
  return ctx.missingDep || ctx.depId || undefined;
}

function _readToolErrorCode(o) {
  if (!o || typeof o !== 'object') {
    return null;
  }
  if (typeof o.code === 'string' && /^[A-Z_]+$/.test(o.code)) {
    return o.code;
  }
  if (o.error && typeof o.error === 'object' && typeof o.error.code === 'string') {
    return o.error.code;
  }
  return null;
}

function _mapToolErrorCode(code) {
  switch (code) {
    case 'MISSING_DEPENDENCY':
      return 'E05';
    case 'PERMISSION_DENIED':
      return 'E07';
    case 'TIMEOUT':
    case 'NETWORK_ERROR':
      return 'E06';
    case 'EXECUTION_ERROR':
    case 'TOOL_UNAVAILABLE':
    case 'INVALID_ARGS':
    case 'RESOURCE_NOT_FOUND':
      return 'E04';
    default:
      return null;
  }
}

function _isSafetyFinish(finish) {
  return (
    finish === 'content_filter' ||
    finish === 'refusal' ||
    finish === 'safety' ||
    finish === 'stop_violation' ||
    finish.includes('filter') ||
    finish.includes('refus')
  );
}

function _detectKind(input, ctx) {
  const status = ctx.httpStatus || (input && (input.status || input.statusCode));
  const probe = input && typeof input === 'object' ? input : { message: String(input || '') };
  if (status && typeof probe.code === 'undefined' && typeof probe.status === 'undefined') {
    probe.code = status;
  }
  return detectErrorKindDeep(probe) || undefined;
}

function _mapKind(kind) {
  switch (kind) {
    case 'refusal':
      return 'E02';
    case 'context_length':
      return 'E03';
    case 'permission':
      return 'E07';
    case 'timeout':
    case 'network':
    case 'rate_limit':
    case 'overloaded':
    case 'server_error':
      return 'E06';
    default:
      return null;
  }
}

// ── 文本/栈脱敏与裁剪 ────────────────────────────────────────────────

function _redactedMessage(input, ctx) {
  let raw = '';
  if (input instanceof Error) {
    raw = formatErrorMessage(input);
  } else if (typeof input === 'string') {
    raw = input;
  } else if (input && typeof input === 'object') {
    raw =
      input.message ||
      (input.error && (input.error.message || input.error)) || // 结构化结果
      ctx.message ||
      '';
    if (typeof raw === 'object') {
      raw = formatErrorMessage(raw);
    }
  } else {
    raw = String(input || '');
  }
  return _clip(redactSensitiveText(String(raw || '')), MAX_DETAIL);
}

function _safeStack(input, ctx) {
  let stack = '';
  if (input instanceof Error && input.stack) {
    stack = input.stack;
  } else if (input && typeof input === 'object' && input.stack) {
    stack = input.stack;
  } else if (ctx.stack) {
    stack = ctx.stack;
  } else {
    stack = _redactedMessage(input, ctx);
  }
  return _clip(redactSensitiveText(String(stack || '')), MAX_STACK);
}

function _snippet(v) {
  if (v === undefined || v === null) {
    return undefined;
  }
  const s =
    typeof v === 'string'
      ? v
      : (() => {
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        })();
  return _clip(redactSensitiveText(s), MAX_SNIPPET);
}

function _clip(s, max) {
  if (typeof s !== 'string') {
    return s;
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

module.exports = {
  _readExplicitCode,
  _looksLikeDenyVerdict,
  _readDenyVerdict,
  _looksLikeMissingDependency,
  _readMissingDep,
  _readToolErrorCode,
  _mapToolErrorCode,
  _isSafetyFinish,
  _detectKind,
  _mapKind,
  _redactedMessage,
  _safeStack,
  _snippet,
  _clip,
};
