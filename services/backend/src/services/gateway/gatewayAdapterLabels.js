'use strict';

/**
 * gateway/adapterLabels.js — human-readable adapter source labels for AIGateway.
 *
 * Provides display labels for each adapter key, used in status messages,
 * diagnostics, and UI. Labels can be overridden via the
 * KHY_ADAPTER_SOURCE_LABELS env var (JSON object mapping adapter keys to
 * custom strings).
 *
 * Extracted from services/gateway/aiGateway.js.
 *
 * @module gateway/adapterLabels
 */

// Default labels for each adapter key.
const DEFAULT_ADAPTER_SOURCE_LABELS = {
  // Local model runtimes
  ollama: '本地 · Ollama',
  localLLM: '本地 · llama.cpp',
  // Cloud structured adapters
  kiro: '云端 · Kiro (AWS CodeWhisperer)',
  cursor: '云端 · Cursor',
  cursor2api: '云端 · Cursor (cursor2api)',
  trae: '云端 · Trae',
  claude: '云端 · Anthropic Claude',
  codex: '云端 · OpenAI Codex',
  api: '云端 · 自定义 API',
  // IDE bridges
  windsurf: '云端 · Windsurf',
  vscode: '云端 · VS Code',
  warp: '云端 · Warp',
  relay_api: '云端 · 中转 API',
  // Relay / assist channels
  cli: '本地 · CLI 工具',
  relay: '中继 · 浏览器手动转发',
  clipboard: '中继 · 剪贴板转发',
};

/**
 * Resolve the adapter labels, applying any env overrides.
 *
 * @param {object} [env] - Environment object (defaults to process.env)
 * @returns {object} Map of adapter key → display label
 */
function resolveAdapterSourceLabels(env = process.env) {
  const labels = { ...DEFAULT_ADAPTER_SOURCE_LABELS };
  const raw = String(env.KHY_ADAPTER_SOURCE_LABELS || '').trim();
  if (raw) {
    try {
      const override = JSON.parse(raw);
      if (override && typeof override === 'object') {
        for (const [k, v] of Object.entries(override)) {
          if (v != null) {
            labels[String(k)] = String(v);
          }
        }
      }
    } catch {
      /* malformed env → keep defaults */
    }
  }
  return labels;
}

/**
 * Get the display label for a specific adapter key.
 *
 * @param {string} adapterKey
 * @param {object} [labels] - Pre-resolved label map (optional)
 * @returns {string}
 */
function getAdapterLabel(adapterKey, labels) {
  const key = String(adapterKey || '').toLowerCase();
  if (labels && labels[key]) {
    return labels[key];
  }
  return DEFAULT_ADAPTER_SOURCE_LABELS[key] || key;
}

module.exports = {
  DEFAULT_ADAPTER_SOURCE_LABELS,
  resolveAdapterSourceLabels,
  getAdapterLabel,
};
