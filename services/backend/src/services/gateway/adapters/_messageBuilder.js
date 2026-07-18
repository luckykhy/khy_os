'use strict';

/**
 * _messageBuilder.js — Unified message array construction for AI adapters.
 *
 * Consolidates the 4 message source resolution patterns repeated across
 * relay, cursor2api, windsurf, claude, and localLLM adapters:
 *   1. options.rawMessages — full Anthropic content blocks (tool_use/tool_result)
 *   2. options.structuredMessages — CLI internal path with content arrays
 *   3. options.messages — simple { role, content } array
 *   4. prompt string — fallback single user message
 *
 * Phase 3B of industrial-grade modularization.
 * Dependencies: none (converters are optional injected).
 */

/**
 * Resolve messages from the various input sources adapters receive.
 *
 * @param {string} prompt - Raw prompt text (fallback)
 * @param {object} options - Adapter options containing message sources
 * @param {Array}  [options.rawMessages] - Anthropic-format messages with content blocks
 * @param {Array}  [options.structuredMessages] - CLI internal structured messages
 * @param {Array}  [options.messages] - Simple { role, content } messages
 * @param {string} [options.system] - System prompt
 * @param {Array}  [options.images] - Image attachments
 * @param {object} [config]
 * @param {'openai'|'anthropic'|'chatml'} [config.protocol='openai'] - Output format
 * @param {boolean} [config.hasTools=false] - Whether tools are enabled
 * @param {function} [config.convertMessagesWithTools] - Anthropic→OpenAI message converter
 * @param {function} [config.attachImages] - Image attachment function
 * @returns {{ messages: Array, system: string }}
 */
function resolveMessages(prompt, options = {}, config = {}) {
  const {
    protocol = 'openai',
    hasTools = false,
    convertMessagesWithTools = null,
    convertMessagesOpts = {},
    attachImages = null,
  } = config;

  // Strip the stable-prefix boundary marker (DESIGN-ARCH-047) before it can
  // reach any non-native wire. Only claudeAdapter's native path consumes the
  // marker (to place a cache breakpoint); every relay/codex/api path forwards
  // `system` verbatim, so the sentinel MUST be removed here. No-op when absent
  // (flag off → marker never present).
  let system = String(options.system || '').trim();
  if (system.includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')) {
    try {
      system = require('../../../constants/systemPromptBoundary').stripSystemPromptBoundary(system);
    } catch {
      system = system
        .replace(/\n*__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n*/, '\n\n')
        .replace(/__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__/g, '');
    }
  }
  let messages = [];

  if (protocol === 'anthropic') {
    // Anthropic protocol: system is separate, messages exclude system role
    messages = _resolveAnthropicMessages(prompt, options);
    return { messages, system };
  }

  // OpenAI / ChatML protocol
  if (hasTools && convertMessagesWithTools) {
    // Tool-enabled path: need structured content blocks
    const source = _pickToolAwareSource(options);
    if (source) {
      messages = convertMessagesWithTools(source, true, convertMessagesOpts);
    } else {
      messages = _resolveSimpleMessages(prompt, options);
    }
  } else {
    messages = _resolveSimpleMessages(prompt, options);
  }

  // Prepend system message for OpenAI protocol
  if (system) {
    messages = [{ role: 'system', content: system }, ...messages];
  }

  // Attach images if handler provided
  if (attachImages && Array.isArray(options.images) && options.images.length > 0) {
    messages = attachImages(messages, options.images);
  }

  return { messages, system };
}

/**
 * Pick the best message source that contains tool_use/tool_result blocks.
 * @returns {Array|null}
 */
function _pickToolAwareSource(options) {
  // rawMessages is the highest-fidelity source
  if (Array.isArray(options.rawMessages) && options.rawMessages.length > 0) {
    return options.rawMessages;
  }

  // structuredMessages with content arrays (CLI internal path)
  if (Array.isArray(options.structuredMessages) && options.structuredMessages.length > 0
      && options.structuredMessages.some(m => Array.isArray(m.content))) {
    return options.structuredMessages.filter(m => m.role !== 'system');
  }

  return null;
}

/**
 * Resolve for Anthropic protocol (system is separate, no system role in messages).
 */
function _resolveAnthropicMessages(prompt, options) {
  if (Array.isArray(options.rawMessages) && options.rawMessages.length > 0) {
    return options.rawMessages.filter(m => m.role !== 'system');
  }
  if (Array.isArray(options.structuredMessages) && options.structuredMessages.length > 0
      && options.structuredMessages.some(m => Array.isArray(m.content))) {
    return options.structuredMessages.filter(m => m.role !== 'system');
  }
  if (Array.isArray(options.messages) && options.messages.length > 0) {
    return options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role || 'user', content: m.content }));
  }
  return [{ role: 'user', content: prompt || '' }];
}

/**
 * Resolve simple { role, content } messages (no tool blocks).
 */
function _resolveSimpleMessages(prompt, options) {
  if (Array.isArray(options.messages) && options.messages.length > 0) {
    return options.messages.map(m => ({ role: m.role || 'user', content: m.content }));
  }
  return [{ role: 'user', content: prompt || '' }];
}

module.exports = {
  resolveMessages,
};
