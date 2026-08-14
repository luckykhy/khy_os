'use strict';

/**
 * _responseBuilder.js — Standalone response construction for all adapters.
 *
 * Canonical response shape:
 *   Success: { success, content, provider, adapter, model, tokenUsage, toolUseBlocks, stopReason, attempts }
 *   Failure: { success, content:'', error, errorType, provider, adapter, statusCode, attempts }
 */

const { classifyAdapterError } = require('./_errorClassifiers');

/**
 * Build a canonical success response.
 *
 * @param {string} content - Response text
 * @param {object} meta
 * @param {string} meta.adapter - Adapter name (required)
 * @param {string} [meta.provider] - Display provider name
 * @param {string} [meta.model]
 * @param {object} [meta.tokenUsage] - Token usage stats
 * @param {object} [meta.usage] - Alias for tokenUsage (auto-normalized)
 * @param {Array}  [meta.toolUseBlocks] - Tool use blocks (null/undefined → [])
 * @param {string} [meta.stopReason] - Stop reason (auto-set to 'tool_use' when tools present)
 * @param {string} [meta.thinking] - Thinking/reasoning content
 * @param {Array}  [meta.attempts] - Attempt log
 * @returns {object} Canonical success response
 */
function buildSuccess(content, meta = {}) {
  const {
    usage,
    tokenUsage,
    toolUseBlocks,
    stopReason,
    thinking,
    attempts,
    adapter,
    provider,
    model,
    ...rest
  } = meta;
  const blocks = toolUseBlocks ?? [];
  const hasToolUse = blocks.length > 0;
  return {
    success: true,
    content: content || '',
    provider: provider || adapter || '',
    adapter: adapter || '',
    model: model || null,
    tokenUsage: tokenUsage || usage || null,
    toolUseBlocks: blocks,
    stopReason: stopReason || (hasToolUse ? 'tool_use' : 'end_turn'),
    ...(thinking != null ? { thinking } : {}),
    attempts: attempts || [],
    ...rest,
  };
}

/**
 * Build a canonical failure response.
 * Auto-classifies errorType via _errorClassifiers when not provided.
 *
 * @param {string|Error} error - Error message or Error object
 * @param {object} meta
 * @param {string} meta.adapter - Adapter name (required)
 * @param {string} [meta.provider] - Display provider name
 * @param {string} [meta.errorType] - Pre-classified error type
 * @param {number} [meta.statusCode] - HTTP status code
 * @param {Array}  [meta.attempts] - Attempt log
 * @returns {object} Canonical failure response
 */
function buildFailure(error, meta = {}) {
  const errorMsg = error instanceof Error ? error.message : String(error || 'Unknown error');
  const { errorType: rawType, adapter, provider, statusCode, attempts, ...rest } = meta;
  let errorType = rawType;
  if (!errorType || errorType === 'unknown') {
    errorType = classifyAdapterError(error, { statusCode });
  }
  return {
    success: false,
    content: '',
    error: errorMsg,
    errorType,
    provider: provider || adapter || '',
    adapter: adapter || '',
    statusCode: statusCode || null,
    attempts: attempts || [],
    ...rest,
  };
}

/**
 * Wrap an adapter's generate function with standardized error handling.
 * Catches all exceptions and returns buildFailure() automatically.
 *
 * Batch 2 审计登记(generate() 出口层骨架收敛 — 刻意不收敛):
 * 逐一精读 claude/codex/kiro 及其余 12 个适配器的 generate() try/catch 出口层后,
 * 未发现任意两家逐字段等价的骨架,故不另建 _generateWrapper.js 高阶模块:
 *   - claudeAdapter:catch 内有 recordRuntimeDiagnostics 副作用 + diagnostics 字段
 *     + bridge→direct 回退链,成功分支携带 toolCallLog/thinkingBlocks 等独有字段。
 *   - codexAdapter:catch 内约 130 行多级自愈链(openai 回退/reconnect 自愈重试)
 *     + 内联 errorType 分类梯度(不走 classifyAdapterError)。
 *   - kiroAdapter:catch 内递归重试(_banRetried/_authRetried/_cooldownRetried)
 *     + 部分内容打捞,buildFailure 不传 errorType(依赖自动分类)。
 *   - 其余(cursor/vscode/warp/opencode/cliTool/ollama/windsurf/trae/webRelay/
 *     clipboardRelay/cursor2api/localLLM 等):meta 字段集、attempts 形状、预检分支
 *     互不相同;强行提取的钩子数量 > 骨架本身复杂度(参数爆炸)。
 * 下方 wrapGenerate 即既存的通用包装器(目前零采用),新适配器可 “opt-in”;
 * 存量适配器的出口层保持原样以保障外部行为逐字段不变。
 *
 * @param {string} adapterName - Adapter name for error responses
 * @param {function} fn - The original generate(prompt, options) function
 * @returns {function} Wrapped generate function
 */
function wrapGenerate(adapterName, fn) {
  return async function wrappedGenerate(prompt, options = {}) {
    try {
      return await fn(prompt, options);
    } catch (err) {
      return buildFailure(err, {
        adapter: adapterName,
        provider: adapterName,
        attempts: [{ provider: adapterName, success: false, error: err.message || String(err) }],
      });
    }
  };
}

module.exports = {
  buildSuccess,
  buildFailure,
  wrapGenerate,
};
