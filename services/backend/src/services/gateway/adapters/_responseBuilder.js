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
  const { usage, tokenUsage, toolUseBlocks, stopReason, thinking, attempts, adapter, provider, model, ...rest } = meta;
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
