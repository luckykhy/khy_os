'use strict';

/**
 * loop/toolOutput.js — tool-result extraction + active-model context-window
 * probe, carved out of toolUseLoopCore.js (T-021 god-file split, pure-leaf slice).
 *
 *   - _extractToolOutput            pull a readable payload out of a heterogeneous
 *                                   tool result object (many field-name dialects)
 *   - _getActiveModelContextWindow  best-effort context-window size from the gateway
 *
 * Pure leaf: reached only via LAZY require re-based for this dir, NO core back-edge
 * (M6 cycles stay 0). The core re-requires + rebinds both names so the existing
 * `setToolUseLoopHelpersDeps({ _extractToolOutput, _getActiveModelContextWindow, … })`
 * injection is unchanged. Bodies byte-identical to the former core functions.
 */

/**
 * Extract meaningful output from a tool result object.
 * Tools return results in many different field names — this function
 * checks known fields first, then falls back to JSON.stringify of all
 * non-meta fields so nothing is silently lost.
 */
function _extractToolOutput(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  // Safety net: if content is an MCP-style array [{type:"text", text:...}] that
  // somehow bypassed normalization, extract text instead of returning the raw array.
  if (Array.isArray(result.content) && result.content.length > 0) {
    const first = result.content[0];
    if (
      first &&
      typeof first === 'object' &&
      (first.type === 'text' || first.type === 'image' || first.type === 'resource')
    ) {
      const texts = result.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (texts.length > 0) {
        return texts.join('\n');
      }
      // Images/resources only — return placeholder
      return result.content.map((b) => `[${b.type}]`).join(', ');
    }
  }

  // Priority 1: well-known text output fields
  const direct = result.output || result.content || result.result;
  if (direct != null && direct !== '') {
    return direct;
  }

  // Priority 2: common structured data fields
  const structured =
    result.message ||
    result.answer ||
    result.data ||
    result.matches ||
    result.files ||
    result.results ||
    result.locations ||
    result.diagnostics ||
    result.resources ||
    result.skills ||
    result.task ||
    result.hover ||
    result.symbols ||
    result.items ||
    result.edits ||
    result.actions ||
    result.signatures ||
    result.counts ||
    result.entries ||
    result.selected;
  if (structured != null && structured !== '') {
    return structured;
  }

  // Priority 3: fall back to JSON of all non-meta fields
  // (strip success, _internal fields, and error to avoid noise)
  const payload = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'success' || k === 'error' || k.startsWith('_')) {
      continue;
    }
    if (v != null && v !== '' && v !== false) {
      payload[k] = v;
    }
  }
  if (Object.keys(payload).length > 0) {
    return JSON.stringify(payload);
  }

  return null;
}

/**
 * Try to get the active model's context window size from the gateway.
 * Returns 0 if unavailable.
 */
function _getActiveModelContextWindow() {
  try {
    const { serviceRegistry } = require('../../serviceRegistry');
    const gateway = serviceRegistry?.get?.('gateway');
    if (!gateway) {
      return 0;
    }
    const info = gateway.getActiveAdapterInfo?.() || gateway.getModelInfo?.() || {};
    return Number(info.contextWindow || info.context_window || info.maxContext || 0);
  } catch {
    return 0;
  }
}

module.exports = {
  _extractToolOutput,
  _getActiveModelContextWindow,
};
