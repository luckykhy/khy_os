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
 *
 * 「信号识别 + 文本脱敏/裁剪」的纯辅助函数（_readExplicitCode / _readDenyVerdict /
 * _mapToolErrorCode / _mapKind / _detectKind / _redactedMessage / _safeStack /
 * _snippet / _clip 等）逐字节移至同目录纯叶 classifierSignals.js，本文件按同名标识符
 * require 回来复用，故对外公共面 {classify, classifyCode, _mapToolErrorCode,
 * _mapKind} 保持逐字节等价。
 */

const { getErrorCode, isKnownCode, FALLBACK_CODE } = require('./errorCodes');

const {
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
} = require('./classifierSignals');

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
  if (!isKnownCode(code)) {
    code = FALLBACK_CODE;
  }
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
  if (explicit) {
    return explicit;
  }

  // 1) 显式空响应信号（最常见的"未返回有效回复"根因）。
  const errorType = (input && input.errorType) || ctx.errorType || ctx.kind;
  if (errorType === 'empty_reply' || errorType === 'empty_response' || errorType === 'empty') {
    return 'E01';
  }
  if (errorType === 'schema' || errorType === 'schema_validation') {
    return 'E08';
  }
  // 伪成功拒绝：工具已取回数据，模型却回套话拒绝（toolUseLoop 检出）→ 归内容管控 E02。
  if (errorType === 'pseudo_refusal' || errorType === 'refusal') {
    return 'E02';
  }

  // 2) 审批网关裁决（deny）→ E07，权限拦截优先于通用归类。
  if (_looksLikeDenyVerdict(input) || _looksLikeDenyVerdict(ctx.syscallVerdict)) {
    return 'E07';
  }

  // 3) 依赖缺失 → E05（早于通用 ToolError 分流，语义更精确）。
  if (_looksLikeMissingDependency(input)) {
    return 'E05';
  }

  // 4) finish_reason 内容安全停止 → E02。
  const finish = String(
    (input && input.finish_reason) || (input && input.finishReason) || ctx.finishReason || ''
  ).toLowerCase();
  if (finish && _isSafetyFinish(finish)) {
    return 'E02';
  }

  // 5) ToolError / 结构化结果错误码 → 映射。
  const toolCode = _readToolErrorCode(input);
  if (toolCode) {
    const mapped = _mapToolErrorCode(toolCode);
    if (mapped) {
      return mapped;
    }
  }

  // 6) schema 线索（expected_schema 在场而无更强信号）→ E08。
  if (ctx.expectedSchema || (input && input.expected_schema)) {
    return 'E08';
  }

  // 7) 通用错误分类（errorClassifier 深链探测 + HTTP 状态）。
  const kind = _detectKind(input, ctx);
  const byKind = _mapKind(kind);
  if (byKind) {
    return byKind;
  }

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

  const detail = sensitive ? _sensitiveDetail(code, fields) : _detail(code, input, ctx, bag);

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
    continueHint: def.resumable ? def.continueHint || null : null,
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
    input && input.tool_name,
    input && input.toolName,
    ctx.toolName,
    input && input.tool,
    ctx.tool
  );

  switch (code) {
    case 'E01':
      bag.model = model;
      bag.prompt_tokens = pick(input && input.prompt_tokens, ctx.promptTokens, ctx.prompt_tokens);
      break;
    case 'E02': // 脱敏：只取 model + finish_reason（粗类别，不含命中策略）
      bag.model = model;
      bag.finish_reason =
        pick(input && input.finish_reason, input && input.finishReason, ctx.finishReason) ||
        'content_filter';
      break;
    case 'E03':
      bag.model = model;
      bag.ctx_limit = pick(input && input.ctx_limit, ctx.ctxLimit, ctx.ctx_limit);
      bag.required_tokens = pick(
        input && input.required_tokens,
        ctx.requiredTokens,
        ctx.required_tokens
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
    case 'E07': {
      // 脱敏：tool_name + approval_level（粗级别）+ 归一化的 deny_reason 类别
      bag.tool_name = toolName;
      const verdict = _readDenyVerdict(input) || _readDenyVerdict(ctx.syscallVerdict) || {};
      bag.approval_level = pick(verdict.level, input && input.approval_level, ctx.approvalLevel);
      // 不落原始 reasons：归一化为"[某类管控]"，绝不泄露内部审批逻辑。
      bag.deny_reason = '[已触发系统管控策略]';
      break;
    }
    case 'E08':
      bag.expected_schema = pick(input && input.expected_schema, ctx.expectedSchema);
      bag.raw_output_snippet = _snippet(
        pick(input && input.raw_output_snippet, input && input.raw_output, ctx.rawOutput)
      );
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
    const tool =
      fields.tool_name && fields.tool_name !== 'unknown' ? `【${fields.tool_name}】` : '该操作';
    const lvl =
      fields.approval_level && fields.approval_level !== 'unknown'
        ? `（需 L${fields.approval_level} 授权）`
        : '';
    return `${tool}${lvl}触发了系统管控策略，已被审批网关拦截。请在审批中确认或调整操作。`;
  }
  return getErrorCode(code).reason;
}

module.exports = {
  classify,
  classifyCode,
  // 内部映射导出，便于测试与上层复用。
  _mapToolErrorCode,
  _mapKind,
};
