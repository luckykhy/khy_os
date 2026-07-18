'use strict';

/**
 * failsafe/classifier.js — ErrorClassifier：把**任意原始失败信号**归并到 E01–E08。
 *
 * 这是"精准归因"的核心：废除"未返回有效回复 / 未知错误 / 请求失败"等模糊文案。
 * 任何非正常终止都必须落到 E01–E08 之一，并携带该码的必填字段；reason 文案固定取自
 * errorCodes 单一真源，detail 才是动态信息。
 *
 * 入参支持的原始信号（按优先级匹配）：
 *   - 已是 E0x 结构（error_code 字段）→ 原样规范化（幂等）
 *   - errorType:'empty_reply'（toolUseLoop / cli/ai 的空响应信号）→ E01
 *   - errorType:'pseudo_refusal'|'refusal'（工具已取回数据却套话拒绝）→ E02
 *   - 审批网关裁决 {allow:false, decision, level, reasons, tripped}     → E07
 *   - MissingDependencyError / ToolError(MISSING_DEPENDENCY)            → E05
 *   - finish_reason ∈ {content_filter, refusal, stop_violation, safety} → E02
 *   - ToolError(code) / 结构化结果 {success:false,error:{code}}          → E04/E06/E07/E08…
 *   - errorClassifier.detectErrorKindDeep（refusal/context_length/
 *     timeout/network/rate_limit/permission…）                          → E02/E03/E06/E07
 *   - schema 校验失败（context.kind==='schema' 或 expected_schema 在场） → E08
 *   - 兜底：无法归类 → FALLBACK_CODE (E04)，**绝不**返回空
 *
 * 脱敏铁律（防呆）：
 *   E02（安全审查）/ E07（权限拦截）为 sensitive，detail 与 fields **不得泄露**系统
 *   Prompt、内部审批规则、命中的具体安全策略；只告知"触发了[某类管控]"。
 *
 * 输出统一结构：
 *   { status:'failed', error_code, reason, detail, suggestion, retryable,
 *     sensitive, category, fields, attribution_complete }
 */

const { getErrorCode, isKnownCode, FALLBACK_CODE } = require('./errorCodes');
const {
  detectErrorKindDeep,
  extractErrorCode,
  formatErrorMessage,
  redactSensitiveText,
} = require('../errorClassifier');

const MAX_DETAIL = 400;
const MAX_STACK = 1200;
const MAX_SNIPPET = 300;

// ── 公共入口 ─────────────────────────────────────────────────────────

/**
 * 归类任意原始失败信号到 E01–E08 标准结构。
 *
 * @param {*} input  原始信号：Error / ToolError / 结构化结果 / 字符串 / 裁决对象 / 已归因结构
 * @param {object} [context] 旁路上下文：{ model, toolName, endpoint, timeoutMs, retryCount,
 *                           ctxLimit, requiredTokens, promptTokens, finishReason, httpStatus,
 *                           expectedSchema, rawOutput, kind('schema'|'empty_reply'|…) }
 * @returns {{status:'failed', error_code:string, reason:string, detail:string,
 *            suggestion:string, retryable:boolean, sensitive:boolean, category:string,
 *            fields:object, attribution_complete:boolean}}
 */
function classify(input, context = {}) {
  const ctx = context || {};
  let code;
  try {
    code = _classifyToCode(input, ctx);
  } catch {
    // 分类器自身绝不放大故障：任何异常 → 兜底码。
    code = FALLBACK_CODE;
  }
  if (!isKnownCode(code)) code = FALLBACK_CODE;
  return _buildAttribution(code, input, ctx);
}

/**
 * 仅返回归因后的错误码（轻量探针，供需要分流的调用方使用）。
 * @returns {string} E01..E08
 */
function classifyCode(input, context = {}) {
  try {
    const code = _classifyToCode(input, context || {});
    return isKnownCode(code) ? code : FALLBACK_CODE;
  } catch {
    return FALLBACK_CODE;
  }
}

// ── 归类核心：原始信号 → E0x ──────────────────────────────────────────

function _classifyToCode(input, ctx) {
  // 0) 已归因（幂等）：上游已经给了 E0x，原样沿用。
  const explicit = _readExplicitCode(input) || _readExplicitCode(ctx);
  if (explicit) return explicit;

  // 1) 显式空响应信号（最常见的"未返回有效回复"根因）。
  const errorType = (input && input.errorType) || ctx.errorType || ctx.kind;
  if (errorType === 'empty_reply' || errorType === 'empty_response' || errorType === 'empty') return 'E01';
  if (errorType === 'schema' || errorType === 'schema_validation') return 'E08';
  // 伪成功拒绝：工具已取回数据，模型却回套话拒绝（toolUseLoop 检出）→ 归内容管控 E02。
  if (errorType === 'pseudo_refusal' || errorType === 'refusal') return 'E02';

  // 2) 审批网关裁决（deny）→ E07，权限拦截优先于通用归类。
  if (_looksLikeDenyVerdict(input) || _looksLikeDenyVerdict(ctx.syscallVerdict)) return 'E07';

  // 3) 依赖缺失 → E05（早于通用 ToolError 分流，语义更精确）。
  if (_looksLikeMissingDependency(input)) return 'E05';

  // 4) finish_reason 内容安全停止 → E02。
  const finish = String(
    (input && input.finish_reason) || (input && input.finishReason) || ctx.finishReason || ''
  ).toLowerCase();
  if (finish && _isSafetyFinish(finish)) return 'E02';

  // 5) ToolError / 结构化结果错误码 → 映射。
  const toolCode = _readToolErrorCode(input);
  if (toolCode) {
    const mapped = _mapToolErrorCode(toolCode);
    if (mapped) return mapped;
  }

  // 6) schema 线索（expected_schema 在场而无更强信号）→ E08。
  if (ctx.expectedSchema || (input && input.expected_schema)) return 'E08';

  // 7) 通用错误分类（errorClassifier 深链探测 + HTTP 状态）。
  const kind = _detectKind(input, ctx);
  const byKind = _mapKind(kind);
  if (byKind) return byKind;

  // 8) 兜底：无法精确归类，落兜底码（绝不返回空）。
  return FALLBACK_CODE;
}

// ── 结构构建 + 字段填充 + 脱敏 ────────────────────────────────────────

function _buildAttribution(code, input, ctx) {
  const def = getErrorCode(code);
  const sensitive = !!def.sensitive;

  // 收集原始字段袋（脱敏在写入 fields/detail 时进行）。
  const bag = _collectFields(code, input, ctx);

  // 必填字段：逐项填充，缺失填 'unknown'（归因仍可用，但标记不完整）。
  const fields = {};
  let complete = true;
  for (const key of def.requiredFields) {
    const v = bag[key];
    if (v === undefined || v === null || v === '') {
      fields[key] = 'unknown';
      complete = false;
    } else {
      fields[key] = v;
    }
  }

  const detail = sensitive
    ? _sensitiveDetail(code, fields)
    : _detail(code, input, ctx, bag);

  return {
    status: 'failed',
    error_code: def.code,
    reason: def.reason,
    detail,
    suggestion: def.suggestion,
    retryable: !!def.retryable,
    // 续接策略（单一真源 errorCodes）：resumable=能否说「继续」推进，
    // continueHint=如何继续的一句话。安全/权限/上下文溢出码 resumable=false。
    resumable: !!def.resumable,
    continueHint: def.resumable ? (def.continueHint || null) : null,
    sensitive,
    category: def.category,
    fields,
    attribution_complete: complete,
  };
}

/**
 * 采集各码的字段袋。**脱敏码（E02/E07）只采集白名单字段**——
 * 绝不把 reasons/系统 Prompt/审批细节放进袋，从源头杜绝泄露。
 */
function _collectFields(code, input, ctx) {
  const bag = {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

  const model = pick(input && input.model, ctx.model);
  const toolName = pick(
    input && input.tool_name, input && input.toolName, ctx.toolName,
    input && input.tool, ctx.tool
  );

  switch (code) {
    case 'E01':
      bag.model = model;
      bag.prompt_tokens = pick(input && input.prompt_tokens, ctx.promptTokens, ctx.prompt_tokens);
      break;
    case 'E02': // 脱敏：只取 model + finish_reason（粗类别，不含命中策略）
      bag.model = model;
      bag.finish_reason = pick(
        input && input.finish_reason, input && input.finishReason, ctx.finishReason
      ) || 'content_filter';
      break;
    case 'E03':
      bag.model = model;
      bag.ctx_limit = pick(input && input.ctx_limit, ctx.ctxLimit, ctx.ctx_limit);
      bag.required_tokens = pick(
        input && input.required_tokens, ctx.requiredTokens, ctx.required_tokens
      );
      break;
    case 'E04':
      bag.tool_name = toolName;
      bag.raw_error_stack = _safeStack(input, ctx);
      break;
    case 'E05':
      bag.tool_name = toolName;
      bag.missing_dep = _readMissingDep(input, ctx);
      break;
    case 'E06':
      bag.endpoint = pick(input && input.endpoint, ctx.endpoint);
      bag.timeout_ms = pick(input && input.timeout_ms, ctx.timeoutMs, ctx.timeout_ms);
      bag.retry_count = pick(input && input.retry_count, ctx.retryCount, ctx.retry_count);
      break;
    case 'E07': { // 脱敏：tool_name + approval_level（粗级别）+ 归一化的 deny_reason 类别
      bag.tool_name = toolName;
      const verdict = _readDenyVerdict(input) || _readDenyVerdict(ctx.syscallVerdict) || {};
      bag.approval_level = pick(
        verdict.level, input && input.approval_level, ctx.approvalLevel
      );
      // 不落原始 reasons：归一化为"[某类管控]"，绝不泄露内部审批逻辑。
      bag.deny_reason = '[已触发系统管控策略]';
      break;
    }
    case 'E08':
      bag.expected_schema = pick(input && input.expected_schema, ctx.expectedSchema);
      bag.raw_output_snippet = _snippet(pick(
        input && input.raw_output_snippet, input && input.raw_output, ctx.rawOutput
      ));
      break;
    default:
      break;
  }
  return bag;
}

// ── detail 文案（非脱敏码：可含已脱敏的具体信息）─────────────────────

function _detail(code, input, ctx, bag) {
  const msg = _redactedMessage(input, ctx);
  switch (code) {
    case 'E01':
      return `模型 ${bag.model || '未知通道'} 返回了空内容（无文本、无工具调用）。`;
    case 'E03': {
      const need = bag.required_tokens ? `约 ${bag.required_tokens} tokens` : '当前请求';
      const lim = bag.ctx_limit ? `（上限 ${bag.ctx_limit}）` : '';
      return `${need} 超出模型 ${bag.model || ''} 的上下文窗口${lim}。`;
    }
    case 'E04':
      return `工具 ${bag.tool_name || '未知工具'} 执行时抛出未捕获异常：${msg || '（无消息）'}`;
    case 'E05':
      return `工具 ${bag.tool_name || ''} 缺少依赖 ${bag.missing_dep || '（未识别）'}，需安装后才能继续。`;
    case 'E06': {
      const ep = bag.endpoint ? `端点 ${bag.endpoint} ` : '';
      const rc = bag.retry_count ? `（已重试 ${bag.retry_count} 次）` : '';
      return `${ep}网络请求失败或超时${rc}：${msg || '连接不可达'}`;
    }
    case 'E08':
      return `模型输出不符合预期结构：${bag.raw_output_snippet || msg || '（无法解析的输出）'}`;
    default:
      return msg || getErrorCode(code).reason;
  }
}

/**
 * 脱敏 detail：固定模板，**不含**任何原始报错文本 / 命中策略 / 审批细节。
 */
function _sensitiveDetail(code, fields) {
  if (code === 'E02') {
    return '本次请求触发了内容安全管控，模型响应已被强制终止。请调整请求内容后重试。';
  }
  if (code === 'E07') {
    const tool = fields.tool_name && fields.tool_name !== 'unknown' ? `【${fields.tool_name}】` : '该操作';
    const lvl = fields.approval_level && fields.approval_level !== 'unknown'
      ? `（需 L${fields.approval_level} 授权）` : '';
    return `${tool}${lvl}触发了系统管控策略，已被审批网关拦截。请在审批中确认或调整操作。`;
  }
  return getErrorCode(code).reason;
}

// ── 信号识别助手 ─────────────────────────────────────────────────────

function _readExplicitCode(o) {
  if (!o || typeof o !== 'object') return null;
  const c = o.error_code || o.errorCode;
  if (typeof c === 'string' && isKnownCode(c)) return c;
  if (o.error && typeof o.error === 'object') {
    const ec = o.error.error_code || o.error.errorCode;
    if (typeof ec === 'string' && isKnownCode(ec)) return ec;
  }
  return null;
}

/** 审批网关裁决形状：{allow:false, decision/level/reasons/tripped}。 */
function _looksLikeDenyVerdict(o) {
  return !!_readDenyVerdict(o);
}

function _readDenyVerdict(o) {
  if (!o || typeof o !== 'object') return null;
  const denied = o.allow === false
    || o.decision === 'deny' || o.decision === 'denied' || o.decision === 'block'
    || o.tripped === true;
  if (!denied) return null;
  // 至少要有审批语境特征，避免误吞普通 {allow:false}。
  const hasCtx = ('decision' in o) || ('level' in o) || ('reasons' in o) || ('tripped' in o)
    || ('approval_level' in o) || ('deny_reason' in o);
  return hasCtx ? o : null;
}

function _looksLikeMissingDependency(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.name === 'MissingDependencyError' || o.depId) return true;
  const code = _readToolErrorCode(o);
  return code === 'MISSING_DEPENDENCY';
}

function _readMissingDep(input, ctx) {
  if (input && typeof input === 'object') {
    if (input.depId) return input.depId;
    if (input.missing_dep) return input.missing_dep;
    if (input.error && input.error.depId) return input.error.depId;
  }
  return ctx.missingDep || ctx.depId || undefined;
}

function _readToolErrorCode(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.code === 'string' && /^[A-Z_]+$/.test(o.code)) return o.code;
  if (o.error && typeof o.error === 'object' && typeof o.error.code === 'string') return o.error.code;
  return null;
}

function _mapToolErrorCode(code) {
  switch (code) {
    case 'MISSING_DEPENDENCY': return 'E05';
    case 'PERMISSION_DENIED': return 'E07';
    case 'TIMEOUT':
    case 'NETWORK_ERROR': return 'E06';
    case 'EXECUTION_ERROR':
    case 'TOOL_UNAVAILABLE':
    case 'INVALID_ARGS':
    case 'RESOURCE_NOT_FOUND': return 'E04';
    default: return null;
  }
}

function _isSafetyFinish(finish) {
  return finish === 'content_filter' || finish === 'refusal' || finish === 'safety'
    || finish === 'stop_violation' || finish.includes('filter') || finish.includes('refus');
}

function _detectKind(input, ctx) {
  const status = ctx.httpStatus || (input && (input.status || input.statusCode));
  const probe = (input && typeof input === 'object')
    ? input
    : { message: String(input || '') };
  if (status && typeof probe.code === 'undefined' && typeof probe.status === 'undefined') {
    probe.code = status;
  }
  return detectErrorKindDeep(probe) || undefined;
}

function _mapKind(kind) {
  switch (kind) {
    case 'refusal': return 'E02';
    case 'context_length': return 'E03';
    case 'permission': return 'E07';
    case 'timeout':
    case 'network':
    case 'rate_limit':
    case 'overloaded':
    case 'server_error': return 'E06';
    default: return null;
  }
}

// ── 文本/栈脱敏与裁剪 ────────────────────────────────────────────────

function _redactedMessage(input, ctx) {
  let raw = '';
  if (input instanceof Error) raw = formatErrorMessage(input);
  else if (typeof input === 'string') raw = input;
  else if (input && typeof input === 'object') {
    raw = input.message
      || (input.error && (input.error.message || input.error)) // 结构化结果
      || ctx.message || '';
    if (typeof raw === 'object') raw = formatErrorMessage(raw);
  } else {
    raw = String(input || '');
  }
  return _clip(redactSensitiveText(String(raw || '')), MAX_DETAIL);
}

function _safeStack(input, ctx) {
  let stack = '';
  if (input instanceof Error && input.stack) stack = input.stack;
  else if (input && typeof input === 'object' && input.stack) stack = input.stack;
  else if (ctx.stack) stack = ctx.stack;
  else stack = _redactedMessage(input, ctx);
  return _clip(redactSensitiveText(String(stack || '')), MAX_STACK);
}

function _snippet(v) {
  if (v === undefined || v === null) return undefined;
  let s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return _clip(redactSensitiveText(s), MAX_SNIPPET);
}

function _clip(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

module.exports = {
  classify,
  classifyCode,
  // 内部映射导出，便于测试与上层复用。
  _mapToolErrorCode,
  _mapKind,
};
