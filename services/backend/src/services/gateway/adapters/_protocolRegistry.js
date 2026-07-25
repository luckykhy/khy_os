'use strict';

/**
 * _protocolRegistry.js — Adapter protocol metadata and auto-selection.
 *
 * Each adapter declares the protocols it supports and a default.
 * Multi-protocol adapters (trae, relay_api, claude, codex) provide a
 * resolveProtocol(model, options) function for runtime selection.
 *
 * Usage:
 *   const { getProtocolForAdapter, getAdaptersForProtocol } = require('./_protocolRegistry');
 *   const proto = getProtocolForAdapter('cursor', 'gpt-4o', {});  // → 'openai'
 *   const list = getAdaptersForProtocol('anthropic');              // → ['claude', 'relay_api', 'api']
 */

/**
 * Protocol identifiers.
 */
const PROTOCOLS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  CODEWHISPERER: 'codewhisperer',
  CODEX: 'codex',
  RESPONSES: 'responses',
  CLI_STREAM_JSON: 'cli-stream-json',
  TRAE_NATIVE: 'trae-native',
  DIRECT: 'direct',
  MANUAL: 'manual',
};

/**
 * Model name prefixes that hint at a protocol preference.
 * Used by modelRouter and aiGateway for auto-selection.
 */
const MODEL_PROTOCOL_HINTS = {
  'claude-': PROTOCOLS.ANTHROPIC,
  'claude3': PROTOCOLS.ANTHROPIC,
  'gpt-': PROTOCOLS.OPENAI,
  'o4-': PROTOCOLS.OPENAI,
  'o3-': PROTOCOLS.OPENAI,
  'o1-': PROTOCOLS.OPENAI,
  'gemini-': PROTOCOLS.OPENAI,
  'deepseek-': PROTOCOLS.OPENAI,
  'deepseek_': PROTOCOLS.OPENAI,
  'qwen': PROTOCOLS.OPENAI,
  'glm': PROTOCOLS.OPENAI,
  'yi-': PROTOCOLS.OPENAI,
  'mistral': PROTOCOLS.OPENAI,
  'codex-': PROTOCOLS.CODEX,
};

/**
 * Static protocol map for all 16 adapters.
 *
 * Each entry:
 *   protocols: string[]        — all protocols the adapter can speak
 *   default: string            — protocol used when none specified
 *   resolveProtocol?: (model, options) => string  — dynamic selector for multi-protocol adapters
 *
 * @type {Record<string, { protocols: string[], default: string, resolveProtocol?: function }>}
 */
const ADAPTER_PROTOCOL_MAP = {
  cursor:     { protocols: [PROTOCOLS.OPENAI], default: PROTOCOLS.OPENAI },
  vscode:     { protocols: [PROTOCOLS.OPENAI], default: PROTOCOLS.OPENAI },
  windsurf:   { protocols: [PROTOCOLS.OPENAI], default: PROTOCOLS.OPENAI },
  cursor2api: { protocols: [PROTOCOLS.OPENAI], default: PROTOCOLS.OPENAI },
  ollama:     { protocols: [PROTOCOLS.OPENAI], default: PROTOCOLS.OPENAI },
  localLLM:   { protocols: [PROTOCOLS.DIRECT], default: PROTOCOLS.DIRECT },

  claude: {
    protocols: [PROTOCOLS.ANTHROPIC, PROTOCOLS.CLI_STREAM_JSON],
    default: PROTOCOLS.ANTHROPIC,
    resolveProtocol(_model, options) {
      // Bridge mode → CLI stream-json; direct mode → Anthropic Messages API
      if (options?.directMode === false) return PROTOCOLS.CLI_STREAM_JSON;
      // Auto: env-based resolution deferred to adapter's own logic
      const mode = String(process.env.GATEWAY_CLAUDE_MODE || 'auto').toLowerCase();
      if (mode === 'bridge' || mode === 'cli') return PROTOCOLS.CLI_STREAM_JSON;
      if (mode === 'direct') return PROTOCOLS.ANTHROPIC;
      // auto: if Anthropic key available → direct; check env vars
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_API_KEY) {
        return PROTOCOLS.ANTHROPIC;
      }
      return PROTOCOLS.CLI_STREAM_JSON;
    },
  },

  kiro: {
    protocols: [PROTOCOLS.CODEWHISPERER],
    default: PROTOCOLS.CODEWHISPERER,
  },

  trae: {
    protocols: [PROTOCOLS.TRAE_NATIVE, PROTOCOLS.CODEWHISPERER, PROTOCOLS.OPENAI],
    default: PROTOCOLS.OPENAI,
    resolveProtocol(_model, options) {
      // Native mode if nativeToken + nativeHost available
      if (options?._traeToken?.nativeToken && options?._traeToken?.nativeHost) {
        return PROTOCOLS.TRAE_NATIVE;
      }
      // SDK mode env var
      const sdkMode = String(process.env.TRAE_SDK_MODE || 'auto').toLowerCase();
      if (sdkMode === 'force' || sdkMode === 'only') return PROTOCOLS.OPENAI;
      // Default cascade: CW → SDK → HTTP (all OpenAI-compat at the wire level except CW)
      return PROTOCOLS.OPENAI;
    },
  },

  codex: {
    protocols: [PROTOCOLS.CODEX, PROTOCOLS.CLI_STREAM_JSON],
    default: PROTOCOLS.CLI_STREAM_JSON,
    resolveProtocol(_model, options) {
      const mode = String(process.env.GATEWAY_CODEX_MODE || 'cli').toLowerCase();
      if (mode === 'direct') return PROTOCOLS.CODEX;
      // Images force direct mode (CLI stdin is text-only)
      if (Array.isArray(options?.images) && options.images.length > 0) return PROTOCOLS.CODEX;
      return PROTOCOLS.CLI_STREAM_JSON;
    },
  },

  relay_api: {
    protocols: [PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC, PROTOCOLS.RESPONSES],
    default: PROTOCOLS.OPENAI,
    resolveProtocol(_model, options) {
      // Endpoint URL (or explicit serviceType) determines protocol.
      const endpoint = String(options?.apiEndpoint || process.env.RELAY_API_ENDPOINT || '').replace(/\/+$/, '');
      const serviceType = String(options?.serviceType || process.env.RELAY_API_SERVICE_TYPE || '').toLowerCase();
      if (serviceType === 'responses' || endpoint.endsWith('/responses') || endpoint.includes('/responses/')) {
        return PROTOCOLS.RESPONSES;
      }
      if (endpoint.endsWith('/anthropic') || endpoint.includes('/anthropic/')) {
        return PROTOCOLS.ANTHROPIC;
      }
      return PROTOCOLS.OPENAI;
    },
  },

  api: {
    protocols: [PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC],
    default: PROTOCOLS.OPENAI,
  },

  cli:       { protocols: [PROTOCOLS.CLI_STREAM_JSON], default: PROTOCOLS.CLI_STREAM_JSON },
  relay:     { protocols: [PROTOCOLS.MANUAL], default: PROTOCOLS.MANUAL },
  clipboard: { protocols: [PROTOCOLS.MANUAL], default: PROTOCOLS.MANUAL },
  warp:      { protocols: [PROTOCOLS.MANUAL], default: PROTOCOLS.MANUAL },
};

/**
 * Get the resolved protocol for a given adapter, model, and options.
 *
 * @param {string} adapterKey - Adapter identifier (e.g., 'cursor', 'claude')
 * @param {string} [model] - Model identifier (for multi-protocol resolution)
 * @param {object} [options] - Adapter options (for runtime state-based resolution)
 * @returns {string} Protocol identifier
 */
function getProtocolForAdapter(adapterKey, model, options) {
  const entry = ADAPTER_PROTOCOL_MAP[adapterKey];
  if (!entry) return PROTOCOLS.OPENAI;
  if (typeof entry.resolveProtocol === 'function') {
    return entry.resolveProtocol(model, options) || entry.default;
  }
  return entry.default;
}

/**
 * Get all adapter keys that support a given protocol.
 *
 * @param {string} protocol - Protocol identifier
 * @returns {string[]} Array of adapter keys
 */
function getAdaptersForProtocol(protocol) {
  return Object.entries(ADAPTER_PROTOCOL_MAP)
    .filter(([, entry]) => entry.protocols.includes(protocol))
    .map(([key]) => key);
}

/**
 * Check whether an adapter supports a given protocol.
 *
 * @param {string} adapterKey - Adapter identifier
 * @param {string} protocol - Protocol identifier
 * @returns {boolean}
 */
function isProtocolSupported(adapterKey, protocol) {
  const entry = ADAPTER_PROTOCOL_MAP[adapterKey];
  return entry ? entry.protocols.includes(protocol) : false;
}

/**
 * Get the list of all protocols an adapter supports.
 *
 * @param {string} adapterKey - Adapter identifier
 * @returns {string[]}
 */
function getAdapterProtocols(adapterKey) {
  const entry = ADAPTER_PROTOCOL_MAP[adapterKey];
  return entry ? [...entry.protocols] : [];
}

// Pre-projected prefix→protocol pairs. Hoisted to a module constant (Ch2「不要每轮
// 重建可复用结构」): inferProtocolFromModel runs once per route resolution / round-trip
// and rebuilt this Object.entries() array on every call. MODEL_PROTOCOL_HINTS is a
// module constant (never mutated; not exported for mutation), so the projection is
// stable and can be computed once at load. The scan reads it without mutating.
const _MODEL_PROTOCOL_HINT_ENTRIES = Object.entries(MODEL_PROTOCOL_HINTS);

/**
 * Infer a protocol hint from a model name.
 * Returns null if no strong hint is found.
 *
 * @param {string} model - Model identifier (e.g., 'claude-sonnet-4-6', 'gpt-4o')
 * @returns {string|null} Protocol hint or null
 */
function inferProtocolFromModel(model) {
  if (!model || typeof model !== 'string') return null;
  const lower = model.toLowerCase();
  for (const [prefix, protocol] of _MODEL_PROTOCOL_HINT_ENTRIES) {
    if (lower.startsWith(prefix)) return protocol;
  }
  return null;
}

module.exports = {
  PROTOCOLS,
  MODEL_PROTOCOL_HINTS,
  ADAPTER_PROTOCOL_MAP,
  getProtocolForAdapter,
  getAdaptersForProtocol,
  isProtocolSupported,
  getAdapterProtocols,
  inferProtocolFromModel,
};
