'use strict';

/**
 * failsafe/safeResponse.js — SafeResponseWrapper：**零静默失败拦截器基座**。
 *
 * 铁律：所有外部通信 / LLM 调用 / 工具执行的返回，都必须经过本拦截器。任何"空字符串 /
 * undefined / 非法结构 / 软失败"都会被转换为 E01–E08 标准错误结构，**绝不**把空值原样
 * 透传给上层。catch 块里"只 console.error 然后空 return"被本类从结构上禁止——guard() 捕获
 * 的异常一律走 classify() 归因，要么返回结构化错误，绝不返回空。
 *
 * 两种用法：
 *   1) 函数式守卫（推荐用于集成点）：
 *        const w = new SafeResponseWrapper({ kind:'llm', model });
 *        const { ok, value, failure } = await w.guard(() => callModel(...));
 *        // ok=true → value 是原始结果；ok=false → failure 是 E0x 结构（value 同 failure）
 *   2) 继承（"所有外部通信 + LLM 调用继承 SafeResponseWrapper"）：
 *        class FooAdapter extends SafeResponseWrapper { ... this._safeCall(() => fetch()) }
 *
 * 同步校验器（已拿到值时直接判定，不重跑 producer）：
 *   validateLLM(value) / validateTool(value) → 返回 E0x 结构 或 null（合格）。
 */

const { classify } = require('./classifier');

class SafeResponseWrapper {
  /**
   * @param {object} [context] 默认上下文，会与每次 guard 的局部上下文合并。
   *        常用键：kind('llm'|'tool'|'value')、model、toolName、endpoint、timeoutMs、retryCount。
   */
  constructor(context = {}) {
    this.context = context || {};
  }

  /**
   * 守卫一个异步生产者：执行 → 校验 → 归因。**永不**返回空。
   *
   * @param {() => Promise<*>} producer 实际产生返回值的异步函数（LLM 调用 / 工具执行 / 外部请求）
   * @param {object} [localCtx] 本次调用的上下文覆盖
   * @returns {Promise<{ok:boolean, value:*, failure:(object|null), raw:*}>}
   *          ok=true：value 为原始结果，failure=null；
   *          ok=false：failure 为 E0x 结构，value 同 failure，raw 为底层原始值/异常（供日志）。
   */
  async guard(producer, localCtx = {}) {
    const ctx = { ...this.context, ...localCtx };
    let raw;
    try {
      raw = await producer();
    } catch (err) {
      // 防呆：catch 绝不空 return —— 异常一律归因为结构化错误。
      const failure = classify(err, ctx);
      return { ok: false, value: failure, failure, raw: err };
    }
    const failure = this._validate(raw, ctx);
    if (failure) return { ok: false, value: failure, failure, raw };
    return { ok: true, value: raw, failure: null, raw };
  }

  /**
   * 继承用：子类在任意外部调用处包一层，等价于 guard 但直接抛出/返回原值。
   * 成功返回原值；失败抛出携带 .failure 的 Error，确保不会有人"吞掉"空结果。
   * @protected
   */
  async _safeCall(producer, localCtx = {}) {
    const r = await this.guard(producer, localCtx);
    if (r.ok) return r.raw;
    const e = new Error(r.failure.reason);
    e.failure = r.failure;
    e.error_code = r.failure.error_code;
    throw e;
  }

  // ── 同步校验器（已有值时直接判定）─────────────────────────────────

  /**
   * 校验 LLM 结果。空内容（无文本、无工具调用）→ E01；安全停止 → E02；
   * 结构化失败 → 交 classify 归类。合格返回 null。
   * @returns {object|null} E0x 结构 或 null
   */
  validateLLM(value, localCtx = {}) {
    const ctx = { ...this.context, ...localCtx, kind: 'llm' };
    return _validateLLM(value, ctx);
  }

  /**
   * 校验工具结果。null/undefined → E04（视为崩溃）；{success:false} → 按错误码归类；
   * 合格返回 null。
   * @returns {object|null} E0x 结构 或 null
   */
  validateTool(value, localCtx = {}) {
    const ctx = { ...this.context, ...localCtx, kind: 'tool' };
    return _validateTool(value, ctx);
  }

  // ── 内部分派 ──────────────────────────────────────────────────────

  _validate(value, ctx) {
    switch (ctx.kind) {
      case 'llm': return _validateLLM(value, ctx);
      case 'tool': return _validateTool(value, ctx);
      default: return _validateValue(value, ctx);
    }
  }
}

// ── 校验实现 ─────────────────────────────────────────────────────────

function _validateLLM(value, ctx) {
  if (value === null || value === undefined) {
    return classify({ errorType: 'empty_reply', model: ctx.model }, ctx);
  }
  // 安全停止优先（即便有部分内容，finish_reason 安全也按 E02 归因）。
  const finish = String(
    (value && (value.finish_reason || value.finishReason)) || ctx.finishReason || ''
  ).toLowerCase();
  if (finish && _isSafetyFinish(finish)) {
    return classify({ finish_reason: finish, model: value.model || ctx.model }, ctx);
  }
  // 已经是结构化失败（success:false / error_code）→ 交 classify 精确归类。
  if (_isStructuredFailure(value)) {
    return classify(value, ctx);
  }
  if (_isEmptyLLM(value)) {
    return classify({
      errorType: 'empty_reply',
      model: value.model || ctx.model,
      prompt_tokens: _readPromptTokens(value) ?? ctx.promptTokens,
    }, ctx);
  }
  return null;
}

function _validateTool(value, ctx) {
  if (value === null || value === undefined) {
    // 工具返回空 = 视为未捕获崩溃（E04），绝不当作"成功的空结果"放行。
    return classify({ errorType: undefined, tool_name: ctx.toolName, message: 'tool returned empty result' }, { ...ctx, kind: 'tool' });
  }
  if (_isStructuredFailure(value)) {
    return classify(value, ctx);
  }
  return null;
}

function _validateValue(value, ctx) {
  if (_isEmptyValue(value)) {
    return classify({ message: 'empty response', tool_name: ctx.toolName }, ctx);
  }
  if (_isStructuredFailure(value)) {
    return classify(value, ctx);
  }
  return null;
}

// ── 判定助手 ─────────────────────────────────────────────────────────

function _isEmptyLLM(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v !== 'object') return false;
  const text = v.content ?? v.finalResponse ?? v.text ?? v.message ?? '';
  const hasText = typeof text === 'string' ? text.trim() !== '' : !!text;
  if (hasText) return false;
  const tools = v.toolCalls || v.tool_calls || v.tool_use || v.toolCallLog;
  if (Array.isArray(tools) && tools.length > 0) return false;
  return true;
}

function _isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function _isStructuredFailure(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.success === false) return true;
  if (typeof v.error_code === 'string') return true;
  if (v.error && typeof v.error === 'object' && typeof v.error.code === 'string') return true;
  if (v.allow === false && ('decision' in v || 'level' in v || 'tripped' in v)) return true;
  return false;
}

function _isSafetyFinish(finish) {
  return finish === 'content_filter' || finish === 'refusal' || finish === 'safety'
    || finish === 'stop_violation' || finish.includes('filter') || finish.includes('refus');
}

function _readPromptTokens(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (v.prompt_tokens != null) return v.prompt_tokens;
  if (v.tokenUsage && v.tokenUsage.prompt_tokens != null) return v.tokenUsage.prompt_tokens;
  if (v.usage && v.usage.prompt_tokens != null) return v.usage.prompt_tokens;
  return undefined;
}

module.exports = {
  SafeResponseWrapper,
};
