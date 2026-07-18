'use strict';

/**
 * ExpandModel Service — KHY 作为可订阅模型
 *
 * 将 KHY 的全部能力（本地确定性 + 订阅模型级联）暴露为标准 AI 模型 API。
 * 外部调用者通过 model: "khy-expand" 调用，系统自动：
 *   1. 尝试本地确定性匹配（天气/汇率/计算/代码检查等 20 种）
 *   2. cooperative 类型 + 有订阅模型 → 注入本地数据让模型增强
 *   3. 无本地匹配 + 有订阅模型 → 直接路由到最佳模型
 *   4. 无本地匹配 + 无订阅模型 → 返回能力菜单
 */

const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const KHY_EXPAND_MODEL_ID = 'khy-expand';
const KHY_EXPAND_VERSION = '1.0';

// ═══════════════════════════════════════════════════════════════════
// Predicates
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a model name refers to ExpandModel.
 */
function isExpandModel(modelName) {
  const n = String(modelName || '').trim().toLowerCase();
  return n === 'khy-expand' || n.startsWith('khy-expand-');
}

// ═══════════════════════════════════════════════════════════════════
// Model Info
// ═══════════════════════════════════════════════════════════════════

/**
 * Returns model metadata for /v1/models listing.
 * Capabilities and upstream status are resolved dynamically.
 */
function getExpandModelInfo() {
  let capabilities = [];
  try {
    capabilities = require('./localBrainService').listCapabilities();
  } catch { /* localBrainService not available */ }

  let upstreamAdapters = [];
  try {
    const gw = require('./gateway/aiGateway');
    if (gw.getStatus) {
      const status = gw.getStatus();
      upstreamAdapters = (status.adapters || [])
        .filter(a => a.available)
        .map(a => a.key || a.name);
    }
  } catch { /* gateway not available */ }

  const hasUpstream = upstreamAdapters.length > 0;

  return {
    id: KHY_EXPAND_MODEL_ID,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'khy',
    name: 'KHY ExpandModel',
    description: `KHY hybrid intelligence model. ${capabilities.length} deterministic local capabilities (zero-token). ` +
      (hasUpstream
        ? `Upstream models: ${upstreamAdapters.join(', ')}. Complex queries route to best available model.`
        : 'No upstream models configured. Local capabilities only.'),
    capabilities,
    upstream: upstreamAdapters,
    version: KHY_EXPAND_VERSION,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract the text content of the last user message from a messages array.
 * Handles both string content and content-block arrays.
 */
function _extractLastUserText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n')
        .trim();
    }
  }
  return '';
}

/**
 * Check if any upstream AI model adapter is available via the gateway.
 */
function _hasUpstreamModel() {
  try {
    const gw = require('./gateway/aiGateway');
    if (!gw._initialized) return false;
    const adapters = gw._adapters || [];
    for (const entry of adapters) {
      if (!entry.enabled) continue;
      try {
        const status = typeof entry.adapter.getStatus === 'function'
          ? entry.adapter.getStatus() : null;
        if (status && status.available) return true;
      } catch { /* skip */ }
    }
  } catch { /* gateway not available */ }
  return false;
}

/**
 * Build an augmented prompt that injects local deterministic data before the original query.
 */
function _buildAugmentedPrompt(originalPrompt, localFormatted, label) {
  return `[KHY 本地能力已获取以下实时数据/分析结果，请基于此数据用自然语言回答用户问题，不要重复原始数据格式]\n\n` +
    `--- ${label} 数据 ---\n${localFormatted}\n---\n\n` +
    `用户原始问题: ${originalPrompt}`;
}

/**
 * Build the capabilities menu when no model is available and no local match.
 */
function _buildCapabilitiesMenu() {
  let caps = [];
  try { caps = require('./localBrainService').listCapabilities(); } catch {}

  const lines = [
    'KHY ExpandModel — 当前可用能力',
    '',
    '本地确定性能力（无需 AI 模型，零 token）：',
    ...caps.map(c => `  • ${c}`),
    '',
    '如需更复杂的 AI 对话能力，请配置上游模型订阅。',
    '运行 khy gateway config 开始配置。',
  ];
  return lines.join('\n');
}

/**
 * Standard response envelope for ExpandModel.
 */
function _makeResponse(content, provider, extra = {}) {
  return {
    success: true,
    content: String(content || ''),
    model: KHY_EXPAND_MODEL_ID,
    provider: provider || 'khy-local',
    adapter: 'expand',
    stopReason: 'end_turn',
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Core Handlers
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle an ExpandModel request (non-streaming).
 *
 * @param {string} userText - The user's query text
 * @param {object} options - { cwd, messages, system, temperature, maxTokens }
 * @returns {{ success, content, model, provider, stopReason }}
 */
async function handleExpandModel(userText, options = {}) {
  const text = String(userText || '').trim();
  if (!text) return _makeResponse(_buildCapabilitiesMenu(), 'khy-local');

  const cwd = options.cwd || process.cwd();
  const localBrain = require('./localBrainService');

  // Phase 1: Try deterministic match
  const plan = localBrain.detectDeterministic(text, { cwd });

  if (plan) {
    // Execute locally
    let result;
    try {
      result = await Promise.resolve(localBrain.executeDeterministic(plan, { cwd }));
    } catch (err) {
      result = { success: false, type: plan.type, error: String(err?.message || err) };
    }

    const formatted = localBrain.formatDeterministicResult(result);

    // Case A: cooperative + upstream available → model-augmented response (with timeout)
    if (plan.cooperative && result && result.success && _hasUpstreamModel()) {
      const label = plan.category || plan.type || 'local-data';
      const augmented = _buildAugmentedPrompt(text, formatted, label);
      const COOPERATIVE_TIMEOUT_MS = parseInt(String(process.env.KHY_COOPERATIVE_TIMEOUT_MS || '15000'), 10) || 15000;
      try {
        const gw = require('./gateway/aiGateway');
        if (!gw._initialized) await gw.init();
        let _timedOut = false;
        const gwPromise = gw.generate(augmented, {
          system: options.system,
          messages: options.messages,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
        });
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => { _timedOut = true; resolve(null); }, COOPERATIVE_TIMEOUT_MS);
        });
        const gwResult = await Promise.race([gwPromise, timeoutPromise]);
        if (!_timedOut && gwResult && gwResult.success && gwResult.content) {
          return _makeResponse(gwResult.content, `khy-expand+${gwResult.provider || gwResult.adapter || 'upstream'}`, {
            tokenUsage: gwResult.tokenUsage,
            upstreamModel: gwResult.model,
          });
        }
        // timeout or failed → fall through to local result
      } catch { /* upstream failed, fall through to local result */ }
    }

    // Case B: non-cooperative / no upstream / upstream failed → direct local result
    return _makeResponse(formatted, 'khy-local');
  }

  // Phase 2: No deterministic match
  if (_hasUpstreamModel()) {
    // Case C: Route to best upstream model
    try {
      const gw = require('./gateway/aiGateway');
      if (!gw._initialized) await gw.init();

      // Build prompt from full messages if available, otherwise use userText
      const prompt = text;
      const gwResult = await gw.generate(prompt, {
        system: options.system,
        messages: options.messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      });
      if (gwResult && gwResult.success) {
        return _makeResponse(gwResult.content, `khy-expand+${gwResult.provider || gwResult.adapter || 'upstream'}`, {
          tokenUsage: gwResult.tokenUsage,
          upstreamModel: gwResult.model,
        });
      }
      // If upstream failed, fall through to capabilities menu
      return _makeResponse(
        `请求处理失败：${gwResult?.error || 'unknown error'}\n\n` + _buildCapabilitiesMenu(),
        'khy-local',
        { success: false },
      );
    } catch (err) {
      return _makeResponse(
        `上游模型调用异常：${err?.message || err}\n\n` + _buildCapabilitiesMenu(),
        'khy-local',
        { success: false },
      );
    }
  }

  // Case D: No match, no upstream → capabilities menu
  return _makeResponse(_buildCapabilitiesMenu(), 'khy-local');
}

/**
 * Handle an ExpandModel request with streaming.
 * Same logic as handleExpandModel but calls onChunk for SSE output.
 *
 * @param {string} userText - The user's query text
 * @param {object} options - { cwd, messages, system, temperature, maxTokens, onChunk }
 * @returns {{ success, content, model, provider, stopReason }}
 */
async function handleExpandModelStream(userText, options = {}) {
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : () => {};
  const text = String(userText || '').trim();

  if (!text) {
    const menu = _buildCapabilitiesMenu();
    onChunk({ type: 'text', text: menu });
    return _makeResponse(menu, 'khy-local');
  }

  const cwd = options.cwd || process.cwd();
  const localBrain = require('./localBrainService');
  const plan = localBrain.detectDeterministic(text, { cwd });

  if (plan) {
    let result;
    try {
      result = await Promise.resolve(localBrain.executeDeterministic(plan, { cwd }));
    } catch (err) {
      result = { success: false, type: plan.type, error: String(err?.message || err) };
    }
    const formatted = localBrain.formatDeterministicResult(result);

    // Case A: cooperative + upstream → stream from model (with timeout)
    if (plan.cooperative && result && result.success && _hasUpstreamModel()) {
      const label = plan.category || plan.type || 'local-data';
      const augmented = _buildAugmentedPrompt(text, formatted, label);
      const COOPERATIVE_TIMEOUT_MS = parseInt(String(process.env.KHY_COOPERATIVE_TIMEOUT_MS || '15000'), 10) || 15000;
      try {
        const gw = require('./gateway/aiGateway');
        if (!gw._initialized) await gw.init();
        let _timedOut = false;
        let _hasStreamed = false;
        const wrappedOnChunk = (chunk) => { _hasStreamed = true; onChunk(chunk); };
        const gwPromise = gw.generate(augmented, {
          system: options.system,
          messages: options.messages,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          onChunk: wrappedOnChunk,
        });
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => { if (!_hasStreamed) { _timedOut = true; resolve(null); } }, COOPERATIVE_TIMEOUT_MS);
        });
        const gwResult = await Promise.race([gwPromise, timeoutPromise]);
        if (!_timedOut && gwResult && gwResult.success) {
          if (!gwResult._streamed && !_hasStreamed) onChunk({ type: 'text', text: gwResult.content });
          return _makeResponse(gwResult.content, `khy-expand+${gwResult.provider || 'upstream'}`, {
            tokenUsage: gwResult.tokenUsage,
            upstreamModel: gwResult.model,
          });
        }
        // timeout or failed → fall through to local
      } catch { /* fall through to local */ }
    }

    // Case B: local only — emit as single chunk
    onChunk({ type: 'text', text: formatted });
    return _makeResponse(formatted, 'khy-local');
  }

  // No deterministic match
  if (_hasUpstreamModel()) {
    // Case C: pure upstream streaming
    try {
      const gw = require('./gateway/aiGateway');
      if (!gw._initialized) await gw.init();
      const gwResult = await gw.generate(text, {
        system: options.system,
        messages: options.messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        onChunk,
      });
      if (gwResult && gwResult.success) {
        if (!gwResult._streamed) onChunk({ type: 'text', text: gwResult.content });
        return _makeResponse(gwResult.content, `khy-expand+${gwResult.provider || 'upstream'}`, {
          tokenUsage: gwResult.tokenUsage,
          upstreamModel: gwResult.model,
        });
      }
    } catch { /* fall through */ }
  }

  // Case D: capabilities menu
  const menu = _buildCapabilitiesMenu();
  onChunk({ type: 'text', text: menu });
  return _makeResponse(menu, 'khy-local');
}

// ═══════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  KHY_EXPAND_MODEL_ID,
  isExpandModel,
  getExpandModelInfo,
  handleExpandModel,
  handleExpandModelStream,
};
