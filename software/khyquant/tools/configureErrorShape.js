'use strict';

/**
 * configureErrorShape.js — 纯叶子:Configure 工具失败路径的**结构化错误**单一真源。
 *
 * 背景(khyos 自审报告 #5「Configure 工具不稳定,只返回裸 `Error: Unknown error`」):
 * 旧 `configureCapability.execute` 的 catch 直接 `return 'Configure 执行失败:' +
 * (e.message || String(e))`。三个后果:
 *   ① 返回**字符串**(真值)→ 归一层当成「成功结果·内容=失败文本」,失败被伪装成成功;
 *   ② `e.message` 为空(抛出的普通对象 / fs 错误无 message / reject 非 Error)→ 塌成裸
 *      「Configure 执行失败:」尾部空白,零上下文零恢复指引(报告里的 `Unknown error`);
 *   ③ 与项目既有 `services/toolError.ToolError` 的结构化模型(code + hint + details)脱节。
 *
 * 本叶子把失败塑成 `ToolError.toStructuredResult()` 形状 `{success:false, error:{code,
 * message, hint, recoverable, retryable, details?}}`——toolUseLoop 的结构化分支据 `error.code`
 * 渲染 `[ERROR:code] message` + `Hint:`。**关键**:message **绝不为空、绝不是裸
 * "Unknown error"**:e.message 为空时用调用点上下文(envKey/action/writtenPath 目标)
 * 合成一句「在做什么时失败」;hint 优先 code 默认恢复指引。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、门控。仅 require('../services/toolError')
 * (leaf→leaf 相对依赖,纯确定性,非 IO)。逃生阀 `KHY_CONFIGURE_STRUCTURED_ERROR`
 * (默认 on)。**关闭 → 返回 null**,调用方逐字节回退旧字符串。任何异常 → 同样 null。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 门控:仅显式关闭词关闭,其余(含未设)均开启。 */
function structuredErrorEnabled(env) {
  const v = (env || (typeof process !== 'undefined' ? process.env : undefined) || {}).KHY_CONFIGURE_STRUCTURED_ERROR;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 从调用点上下文合成一句「在做什么时失败」,用于 e.message 为空时兜底,
 * 保证 message **绝不为空、绝不是裸 "Unknown error"**。
 * @param {object} ctx  { action, capability, envKey, target }
 * @returns {string}
 */
function _contextualMessage(ctx) {
  const c = ctx || {};
  const envKey = c.envKey ? String(c.envKey) : '';
  const action = c.action ? String(c.action) : '';
  const cap = c.capability ? String(c.capability) : '';
  // 优先描述「写入哪个键」——这是 Configure 唯一的副作用,最有诊断价值。
  if (envKey && action) return `写入配置 ${envKey}(${action})时失败,且底层未给出具体原因`;
  if (envKey) return `写入配置 ${envKey} 时失败,且底层未给出具体原因`;
  if (cap) return `处理能力「${cap}」时失败,且底层未给出具体原因`;
  return 'Configure 执行失败,且底层未给出具体原因';
}

/**
 * 构建 Configure 失败的结构化结果。
 *
 * 门控关 / 异常 → null(调用方逐字节回退旧字符串)。
 * 门控开 → `{ success:false, error:{ code, message, hint, recoverable, retryable, details? } }`,
 * message 保证非空且非裸 "Unknown error",details 带 { tool:'Configure', ...ctx 的机器字段 }。
 *
 * @param {*} err   捕获到的错误(Error / 字符串 / 任意)
 * @param {object} [ctx]  调用点上下文 { action, capability, envKey, target }
 * @param {object} [opts] { env }
 * @returns {object|null}
 */
function buildConfigureError(err, ctx = {}, opts = {}) {
  try {
    if (!structuredErrorEnabled(opts.env)) return null;

    let ToolError = null;
    try { ({ ToolError } = require('../services/toolError')); } catch { ToolError = null; }

    // 解析一个**保证非空、非裸 Unknown error** 的人类可读 message。
    let rawMsg = '';
    if (err && typeof err === 'object' && typeof err.message === 'string') rawMsg = err.message.trim();
    else if (typeof err === 'string') rawMsg = err.trim();
    const isUseless = !rawMsg || /^unknown error$/i.test(rawMsg);
    const message = isUseless ? _contextualMessage(ctx) : rawMsg;

    // 机器可读上下文:调用点字段 + 原始错误的结构化字段(code/errno/syscall/path)。
    const details = { tool: 'Configure' };
    if (ctx && ctx.envKey) details.envKey = String(ctx.envKey);
    if (ctx && ctx.action) details.action = String(ctx.action);
    if (ctx && ctx.target) details.target = String(ctx.target);
    if (err && typeof err === 'object') {
      for (const k of ['code', 'errno', 'syscall', 'path']) {
        if (err[k] !== undefined && err[k] !== null) details[k] = err[k];
      }
    }

    if (ToolError && typeof ToolError.fromGenericError === 'function') {
      // 复用 SSOT:code 推断 + 默认 hint。传入一个 message 非空的载体,避免 SSOT 内部
      // 回落到字面 "Unknown error"。保留原始 err 的 code/errno 供其分类。
      const carrier = (err && typeof err === 'object') ? err : new Error(message);
      // 若原 err 无可用 message,换用合成 message 但保留其分类字段。
      const carrierMsg = (carrier.message && String(carrier.message).trim() && !/^unknown error$/i.test(String(carrier.message).trim()))
        ? carrier.message
        : message;
      const te = ToolError.fromGenericError(
        Object.assign(Object.create(Object.getPrototypeOf(carrier) || Error.prototype), carrier, { message: carrierMsg }),
        { details },
      );
      const structured = te.toStructuredResult();
      // 确保 message 用我们保证过的版本(SSOT 会原样透传 carrierMsg,这里再兜一层)。
      if (!structured.error.message || /^unknown error$/i.test(String(structured.error.message).trim())) {
        structured.error.message = message;
      }
      // 前缀化,保留 Configure 语境(与旧 `Configure 执行失败:` 呼应但结构化)。
      if (!/^Configure/.test(structured.error.message)) {
        structured.error.message = 'Configure 执行失败:' + structured.error.message;
      }
      return structured;
    }

    // SSOT 不可用:自建等价结构(不抛)。
    return {
      success: false,
      error: {
        code: 'EXECUTION_ERROR',
        message: /^Configure/.test(message) ? message : 'Configure 执行失败:' + message,
        hint: '用 action="list" 查看可控能力与 KHY_* 键;确认能力名/键拼写无误后重试。',
        recoverable: true,
        retryable: false,
        details,
      },
    };
  } catch {
    return null;
  }
}

module.exports = {
  structuredErrorEnabled,
  buildConfigureError,
  _contextualMessage,
};
