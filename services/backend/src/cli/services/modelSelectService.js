'use strict';

/**
 * modelSelectService.js — Unified model selection logic for TUI and Classic.
 *
 * This module handles:
 * 1. Listing available models from all adapters
 * 2. Building a model selection request
 * 3. Resolving the user's selection
 *
 * The actual rendering is delegated to the UI adapter layer.
 */

const gateway = require('../../services/gateway/aiGateway');

/**
 * Get all available models from all adapters.
 * @param {object} [opts]
 * @param {boolean} [opts.onlyAvailable=false] - Only return available models
 * @returns {Array<{id: string, adapter: string, model: string, label: string, available: boolean}>}
 */
async function getAvailableModels({ onlyAvailable = false } = {}) {
  const models = [];

  try {
    // Get all adapters
    const adapters = gateway.getAdapters ? gateway.getAdapters() : [];

    for (const adapter of adapters) {
      if (!adapter || !adapter.name) continue;

      // Get models for this adapter
      let adapterModels = [];
      try {
        if (typeof adapter.listModels === 'function') {
          adapterModels = await adapter.listModels();
        }
      } catch {
        // Adapter failed, skip
        continue;
      }

      for (const m of adapterModels || []) {
        const modelId = m.id || m.name || '';
        if (!modelId) continue;

        const item = {
          id: modelId,
          adapter: adapter.name,
          model: modelId,
          label: formatModelLabel(modelId),
          available: m.available !== false,
          description: m.description || m.contextWindow ? `${m.contextWindow} tokens` : '',
        };

        if (!onlyAvailable || item.available) {
          models.push(item);
        }
      }
    }
  } catch {
    /* fallback to empty list */
  }

  return models;
}

/**
 * Build a model selection request.
 * @param {object} opts
 * @param {Array} [opts.models] - Pre-fetched models list
 * @param {string} [opts.currentModel] - Currently selected model
 * @param {string} [opts.title] - Selection title
 * @returns {Promise<object>} Response object for the UI adapter
 */
async function buildModelSelectRequest({ models, currentModel, title }) {
  const modelList = models || await getAvailableModels();

  const items = modelList.map((m) => ({
    id: `${m.adapter}/${m.model}`,
    label: m.label,
    description: `${m.adapter}${m.description ? ' · ' + m.description : ''}${m.adapter === currentModel ? ' (当前)' : ''}`,
    disabled: !m.available,
  }));

  return {
    type: 'modelSelect',
    title: title || '选择模型',
    message: '请选择一个模型',
    items,
    currentModel,
    timestamp: Date.now(),
  };
}

/**
 * Resolve a model selection response.
 * @param {string} selection - User's selection (format: "adapter/model")
 * @returns {{adapter: string, model: string}|null}
 */
function resolveModelSelection(selection) {
  if (!selection || typeof selection !== 'string') {
    return null;
  }

  const parts = selection.split('/');
  if (parts.length >= 2) {
    return {
      adapter: parts[0],
      model: parts.slice(1).join('/'),
    };
  }

  return null;
}

/**
 * Format a model name for display (e.g., "claude-3-5-sonnet" → "Claude Sonnet 3.5").
 * @param {string} modelId
 * @returns {string}
 */
function formatModelLabel(modelId) {
  if (!modelId) return 'Unknown';

  // Try to use ccModelName formatter if available
  try {
    const { formatModelLabel } = require('../ccModelName');
    if (typeof formatModelLabel === 'function') {
      return formatModelLabel(modelId);
    }
  } catch {
    /* fallback */
  }

  // Simple formatting: replace dashes and capitalize
  return modelId
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  getAvailableModels,
  buildModelSelectRequest,
  resolveModelSelection,
  formatModelLabel,
};
