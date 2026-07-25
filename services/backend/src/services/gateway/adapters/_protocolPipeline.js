'use strict';

/**
 * _protocolPipeline.js — Protocol handler factory for AI gateway adapters.
 *
 * Creates protocol-specific handlers that unify request construction and
 * response parsing, eliminating duplicated boilerplate across adapters.
 *
 * Each handler provides:
 *   buildRequestBody(prompt, options) → { body, system }
 *   parseJsonResponse(rawResponse)   → { content, toolUseBlocks, model, usage, stopReason, thinking }
 *   parseStreamResponse(stream, onChunk, opts) → Promise<same shape>
 *
 * Usage:
 *   const { createProtocolHandler } = require('./_protocolPipeline');
 *   const handler = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
 *   const { body, system } = handler.buildRequestBody(prompt, options);
 *   // ... make HTTP request with body ...
 *   const result = handler.parseJsonResponse(rawResponse);
 *
 * Supported protocols: openai, anthropic, codewhisperer
 * (codex, cli-stream-json deferred to later phases)
 *
 * Dependencies: _messageBuilder, _toolSchemaConverter, _imageCompat,
 *               _openaiSseStream, _anthropicSseStream
 */

const { resolveMessages } = require('./_messageBuilder');
const crypto = require('crypto');
const {
  anthropicToOpenAI,
  openAIToolCallsToAnthropic,
  convertMessagesAnthropicToOpenAI,
} = require('./_toolSchemaConverter');
const {
  attachImagesToOpenAIMessages,
  toAnthropicImageBlocks,
} = require('./_imageCompat');
const {
  extractAnthropicText,
  extractAnthropicToolUses,
  extractAnthropicToolResults,
  extractAnthropicImages,
  convertAnthropicTools,
} = require('./_anthropicFormat');
const {
  repairToolUsePairing,
  parseCWStreamEvents,
} = require('./_cwStreamParser');

/** Default adapter request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Sampling / control parameter passthrough (B-layer ↔ A-layer convergence)
// ---------------------------------------------------------------------------
//
// generateOptions (proxyServer) carries camelCase keys; some callers pass the
// wire-native snake_case forms. These helpers accept either spelling and emit
// the protocol-native body fields, mirroring A-layer's applySamplingParams so
// the two converter layers stay behaviorally identical.

function _pick(options, ...keys) {
  for (const k of keys) {
    if (options[k] !== undefined && options[k] !== null) return options[k];
  }
  return undefined;
}

/**
 * Convert an Anthropic-style tool_choice ('auto'|'required'|{type:'function',function:{name}})
 * or a passthrough object into the OpenAI tool_choice shape.
 */
function _toOpenAIToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') return tc; // 'auto' | 'none' | 'required'
  if (typeof tc === 'object') {
    if (tc.type === 'tool' && tc.name) {
      return { type: 'function', function: { name: tc.name } };
    }
    if (tc.type === 'any') return 'required';
    if (tc.type === 'auto') return 'auto';
    return tc; // already OpenAI-shaped
  }
  return undefined;
}

/**
 * Convert an OpenAI-style tool_choice into the Anthropic tool_choice shape.
 */
function _toAnthropicToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto') return { type: 'auto' };
    if (tc === 'required') return { type: 'any' };
    if (tc === 'none') return undefined;
    return { type: 'auto' };
  }
  if (typeof tc === 'object') {
    if (tc.type === 'function' && tc.function?.name) {
      return { type: 'tool', name: tc.function.name };
    }
    if (tc.type === 'tool' || tc.type === 'auto' || tc.type === 'any') return tc;
  }
  return undefined;
}

function _applyOpenAISamplingParams(body, options) {
  const topP = _pick(options, 'topP', 'top_p');
  if (topP != null) body.top_p = topP;

  const stop = _pick(options, 'stopSequences', 'stop_sequences', 'stop');
  if (stop != null) body.stop = stop;

  const freqPenalty = _pick(options, 'frequencyPenalty', 'frequency_penalty');
  if (freqPenalty != null) body.frequency_penalty = freqPenalty;

  const presPenalty = _pick(options, 'presencePenalty', 'presence_penalty');
  if (presPenalty != null) body.presence_penalty = presPenalty;

  const seed = _pick(options, 'seed');
  if (seed != null) body.seed = seed;

  const responseFormat = _pick(options, 'responseFormat', 'response_format');
  if (responseFormat != null) body.response_format = responseFormat;

  const reasoningEffort = _pick(options, 'reasoningEffort', 'reasoning_effort');
  if (reasoningEffort != null) body.reasoning_effort = reasoningEffort;

  // OpenAI-compatible reasoning models (e.g. 智谱 GLM-5.2 with thinking:{type:'enabled'})
  // accept a request-side `thinking` field, but the OpenAI path historically dropped it —
  // only reasoning_effort survived, so GLM-5.2's headline thinking toggle never reached the
  // wire through the gateway. Forward it when present (gate KHY_OPENAI_THINKING_PASSTHROUGH,
  // default-on). Gate off → byte-reverts to the prior "drop it" behavior. Anthropic path is
  // unaffected (it already forwards thinking via _applyAnthropicSamplingParams).
  if (_openaiThinkingPassthroughEnabled()) {
    const thinking = _pick(options, 'thinking');
    if (thinking != null) body.thinking = thinking;
  }

  const toolChoice = _toOpenAIToolChoice(_pick(options, 'toolChoice', 'tool_choice'));
  if (toolChoice != null && body.tools) body.tool_choice = toolChoice;
}

const _OPENAI_THINKING_OFF = ['0', 'false', 'off', 'no'];

/** Gate for forwarding a request-side `thinking` field on the OpenAI path (default-on). */
function _openaiThinkingPassthroughEnabled() {
  try {
    const raw = process.env.KHY_OPENAI_THINKING_PASSTHROUGH;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !_OPENAI_THINKING_OFF.includes(v);
  } catch {
    return true;
  }
}

function _applyAnthropicSamplingParams(body, options) {
  const topP = _pick(options, 'topP', 'top_p');
  if (topP != null) body.top_p = topP;

  const stop = _pick(options, 'stopSequences', 'stop_sequences');
  if (stop != null) body.stop_sequences = stop;

  const thinking = _pick(options, 'thinking');
  if (thinking != null) body.thinking = thinking;

  const toolChoice = _toAnthropicToolChoice(_pick(options, 'toolChoice', 'tool_choice'));
  if (toolChoice != null && body.tools) body.tool_choice = toolChoice;
}

// ---------------------------------------------------------------------------
// OpenAI protocol handler
// ---------------------------------------------------------------------------

function _createOpenAIHandler(adapterName) {
  return {
    /**
     * Build an OpenAI chat/completions request body.
     *
     * @param {string} prompt - Raw prompt text
     * @param {object} options
     * @param {string} [options.model] - Model identifier
     * @param {string} [options.system] - System prompt
     * @param {Array}  [options.tools] - Tools in Anthropic format (auto-converted)
     * @param {Array}  [options.images] - Image attachments
     * @param {Array}  [options.rawMessages] - Anthropic-format messages
     * @param {Array}  [options.structuredMessages] - CLI internal messages
     * @param {Array}  [options.messages] - Simple messages
     * @param {boolean} [options.stream=true] - Stream mode
     * @param {number} [options.max_tokens] - Max output tokens
     * @param {number} [options.temperature] - Temperature
     * @returns {{ body: object, system: string }}
     */
    buildRequestBody(prompt, options = {}) {
      const hasToolDefs = Array.isArray(options.tools) && options.tools.length > 0;
      const openaiTools = hasToolDefs ? anthropicToOpenAI(options.tools) : undefined;

      const { messages, system } = resolveMessages(prompt, options, {
        protocol: 'openai',
        hasTools: hasToolDefs,
        convertMessagesWithTools: hasToolDefs ? convertMessagesAnthropicToOpenAI : null,
        convertMessagesOpts: { useToolRole: options.useToolRole },
        attachImages: attachImagesToOpenAIMessages,
      });

      const body = {
        model: options.model || undefined,
        messages,
        stream: options.stream !== false,
      };
      if (openaiTools) body.tools = openaiTools;
      if (options.max_tokens) body.max_tokens = options.max_tokens;
      if (options.temperature != null) body.temperature = options.temperature;
      _applyOpenAISamplingParams(body, options);

      return { body, system };
    },

    /**
     * Parse a non-streaming OpenAI chat/completions JSON response.
     *
     * @param {object} rawResponse - Parsed JSON response body
     * @returns {{ content: string, toolUseBlocks: Array, model: string|null, usage: object|null, stopReason: string|null, thinking: string|null }}
     */
    parseJsonResponse(rawResponse) {
      const choice = rawResponse?.choices?.[0] || {};
      const message = choice.message || {};
      const content = message.content || '';
      const toolUseBlocks = openAIToolCallsToAnthropic(choice);
      const thinking = message.reasoning_content || message.thinking || null;
      const usage = rawResponse?.usage || null;
      const stopReason = choice.finish_reason || (toolUseBlocks.length > 0 ? 'tool_use' : 'end_turn');

      return { content, toolUseBlocks, model: rawResponse?.model || null, usage, stopReason, thinking };
    },

    /**
     * Parse an OpenAI-compatible SSE stream.
     * Delegates to _openaiSseStream.parseOpenAISseStream().
     *
     * @param {import('stream').Readable} stream
     * @param {function} [onChunk]
     * @param {object} [opts] - { signal, enableStaleDetection, staleOptions }
     * @returns {Promise<{ content, toolUseBlocks, model, finishReason, usage }>}
     */
    async parseStreamResponse(stream, onChunk, opts = {}) {
      const { parseOpenAISseStream } = require('./_openaiSseStream');
      return parseOpenAISseStream(stream, onChunk, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic protocol handler
// ---------------------------------------------------------------------------

function _createAnthropicHandler(adapterName) {
  return {
    /**
     * Build an Anthropic Messages API request body.
     *
     * @param {string} prompt - Raw prompt text
     * @param {object} options
     * @param {string} [options.model] - Model identifier
     * @param {string} [options.system] - System prompt
     * @param {Array}  [options.tools] - Tools in Anthropic format (native, no conversion)
     * @param {Array}  [options.images] - Image attachments
     * @param {Array}  [options.rawMessages] - Anthropic-format messages
     * @param {Array}  [options.structuredMessages] - CLI internal messages
     * @param {Array}  [options.messages] - Simple messages
     * @param {boolean} [options.stream=true] - Stream mode
     * @param {number} [options.max_tokens] - Max output tokens
     * @param {number} [options.temperature] - Temperature
     * @returns {{ body: object, system: string }}
     */
    buildRequestBody(prompt, options = {}) {
      const { messages, system } = resolveMessages(prompt, options, {
        protocol: 'anthropic',
      });

      // Attach images to the last user message as Anthropic image blocks
      let finalMessages = messages;
      if (Array.isArray(options.images) && options.images.length > 0) {
        const imageBlocks = toAnthropicImageBlocks(options.images);
        if (imageBlocks.length > 0) {
          finalMessages = [...messages];
          for (let i = finalMessages.length - 1; i >= 0; i--) {
            if (finalMessages[i]?.role === 'user') {
              const msg = { ...finalMessages[i] };
              const existingContent = typeof msg.content === 'string'
                ? [{ type: 'text', text: msg.content }]
                : (Array.isArray(msg.content) ? [...msg.content] : []);
              msg.content = [...existingContent, ...imageBlocks];
              finalMessages[i] = msg;
              break;
            }
          }
        }
      }

      const body = {
        model: options.model || undefined,
        messages: finalMessages,
        max_tokens: options.max_tokens || 8192,
        stream: options.stream !== false,
      };
      if (system) body.system = system;
      if (Array.isArray(options.tools) && options.tools.length > 0) {
        body.tools = options.tools;
      }
      if (options.temperature != null) body.temperature = options.temperature;
      _applyAnthropicSamplingParams(body, options);

      return { body, system };
    },

    /**
     * Parse a non-streaming Anthropic Messages API JSON response.
     *
     * @param {object} rawResponse - Parsed JSON response body
     * @returns {{ content: string, toolUseBlocks: Array, model: string|null, usage: object|null, stopReason: string|null, thinking: string|null }}
     */
    parseJsonResponse(rawResponse) {
      const contentBlocks = rawResponse?.content || [];
      let content = '';
      let thinking = null;
      const toolUseBlocks = [];

      for (const block of contentBlocks) {
        if (block.type === 'text') {
          content += block.text || '';
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        } else if (block.type === 'server_tool_use') {
          toolUseBlocks.push({
            type: 'server_tool_use',
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        } else if (block.type === 'thinking') {
          thinking = (thinking || '') + (block.thinking || '');
        }
      }

      const usage = rawResponse?.usage || null;
      const stopReason = rawResponse?.stop_reason || (toolUseBlocks.length > 0 ? 'tool_use' : 'end_turn');

      return { content, toolUseBlocks, model: rawResponse?.model || null, usage, stopReason, thinking };
    },

    /**
     * Parse an Anthropic Messages API SSE stream.
     * Delegates to _anthropicSseStream.parseAnthropicSseStream().
     *
     * @param {import('stream').Readable} stream
     * @param {function} [onChunk]
     * @param {object} [opts] - { signal, enableStaleDetection, staleOptions }
     * @returns {Promise<{ content, toolUseBlocks, model, finishReason, usage, thinking }>}
     */
    async parseStreamResponse(stream, onChunk, opts = {}) {
      const { parseAnthropicSseStream } = require('./_anthropicSseStream');
      return parseAnthropicSseStream(stream, onChunk, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// CodeWhisperer (CW) protocol handler
// ---------------------------------------------------------------------------

/**
 * System prompt sanitization regex -- removes phrases that trigger
 * anti-injection detection in Q Developer's server-side filtering.
 */
const _CW_SYSTEM_SANITIZE_RULES = [
  [/\bHIGHEST\s+PRIORITY\b/gi, 'PRIMARY RULE'],
  [/\bNON[- ]NEGOTIABLE\b/gi, 'STRICT'],
  [/\boverride\s+(any|all)\s+(prior|previous)\b/gi, 'take precedence over prior'],
  [/\bignore\s+(all\s+)?(prior|previous)\s+(instructions?|context)\b/gi, 'supersede earlier context'],
];

function _sanitizeCWSystemPrompt(text) {
  let result = text;
  for (const [pattern, replacement] of _CW_SYSTEM_SANITIZE_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function _createCWHandler(adapterName) {
  return {
    /**
     * Build a CodeWhisperer conversationState from Anthropic-format messages.
     *
     * Unlike OpenAI/Anthropic handlers that return { body, system }, CW returns
     * { conversationState, system } because the CW SDK uses a completely
     * different request structure (GenerateAssistantResponseCommand).
     *
     * @param {string} prompt - Raw prompt text
     * @param {object} options
     * @param {string} [options.model] - Model identifier (passed as modelId in context)
     * @param {string} [options.system] - System prompt
     * @param {Array}  [options.tools] - Tools in Anthropic format (auto-converted to CW)
     * @param {Array}  [options.images] - Image attachments
     * @param {Array}  [options.rawMessages] - Anthropic-format messages
     * @param {Array}  [options.structuredMessages] - CLI internal messages
     * @param {Array}  [options.messages] - Simple messages
     * @returns {{ conversationState: object, system: string }}
     */
    buildRequestBody(prompt, options = {}) {
      const { messages } = resolveMessages(prompt, options, { protocol: 'anthropic' });

      const modelId = options.model || undefined;
      // Strip the stable-prefix boundary marker (DESIGN-ARCH-047) — CW forwards
      // system verbatim and does not consume the sentinel. No-op when absent.
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
      const tools = options.tools;

      const history = [];
      const buildCtx = (extra = {}) => ({ modelId, editorState: {}, ...extra });

      // Convert Anthropic tools to CW toolSpecification
      const cwTools = convertAnthropicTools(tools);

      // Repair unpaired tool_use/tool_result blocks
      const repairedMessages = repairToolUsePairing(messages);

      // Inject system prompt as first user/assistant pair
      const sysText = system;
      if (sysText) {
        history.push({
          userInputMessage: {
            content: sysText,
            origin: 'AI_EDITOR',
            userInputMessageContext: buildCtx(),
          },
        });
        history.push({ assistantResponseMessage: { content: 'OK' } });
      }

      for (const msg of repairedMessages) {
        if (msg.role === 'user') {
          const text = extractAnthropicText(msg.content);
          const toolResults = extractAnthropicToolResults(msg.content);
          const images = extractAnthropicImages(msg.content);

          if (toolResults.length > 0) {
            history.push({
              userInputMessage: {
                content: text || '',
                origin: 'AI_EDITOR',
                userInputMessageContext: buildCtx({ toolResults }),
                ...(images.length > 0 && { images }),
              },
            });
          } else {
            history.push({
              userInputMessage: {
                content: text,
                origin: 'AI_EDITOR',
                userInputMessageContext: buildCtx(),
                ...(images.length > 0 && { images }),
              },
            });
          }
        } else if (msg.role === 'assistant') {
          const text = extractAnthropicText(msg.content);
          const toolUses = extractAnthropicToolUses(msg.content);
          history.push({
            assistantResponseMessage: {
              content: text,
              toolUses: toolUses.length > 0 ? toolUses : undefined,
            },
          });
        }
      }

      // Ensure conversation ends with user message
      const last = history.at(-1);
      if (last?.assistantResponseMessage) {
        history.push({
          userInputMessage: {
            content: 'Continue.',
            origin: 'AI_EDITOR',
            userInputMessageContext: buildCtx(),
          },
        });
      }

      // Inline system prompt into the last user message for highest priority
      const currentMessage = history.at(-1);
      if (sysText && currentMessage?.userInputMessage) {
        const original = currentMessage.userInputMessage.content || '';
        const sanitized = _sanitizeCWSystemPrompt(sysText);
        currentMessage.userInputMessage.content =
          `<system_context>\n${sanitized}\n</system_context>\n\n${original}`;
      }

      // Inject tools into currentMessage context
      if (cwTools && currentMessage?.userInputMessage) {
        currentMessage.userInputMessage.userInputMessageContext = {
          ...currentMessage.userInputMessage.userInputMessageContext,
          tools: cwTools,
        };
      }

      const conversationState = {
        conversationId: crypto.randomUUID(),
        currentMessage,
        history: history.slice(0, -1),
        chatTriggerType: 'MANUAL',
      };

      return { conversationState, system };
    },

    /**
     * Parse a CW SDK streaming response.
     * Delegates to the shared parseCWStreamEvents().
     *
     * @param {AsyncIterable} eventStream - generateAssistantResponseResponse
     * @param {function} [onChunk]
     * @param {object} [opts] - { signal }
     * @returns {Promise<{ content, modelId, tokenUsage, toolUseBlocks, thinking }>}
     */
    async parseStreamResponse(eventStream, onChunk, opts = {}) {
      return parseCWStreamEvents(eventStream, onChunk, opts);
    },

    /**
     * CW protocol is streaming-only.
     * @throws {Error} Always
     */
    parseJsonResponse(_rawResponse) {
      throw new Error('CW protocol only supports streaming (GenerateAssistantResponse)');
    },
  };
}

// ---------------------------------------------------------------------------
// Responses API (OpenAI /v1/responses, "codex" wire format) protocol handler
// ---------------------------------------------------------------------------

function _createResponsesHandler(adapterName) {
  const openaiHandler = _createOpenAIHandler(adapterName);
  return {
    /**
     * Build an OpenAI Responses API request body (`input[]` + `instructions`).
     *
     * Reuses the OpenAI handler to resolve messages/tools/system, then converts
     * the OpenAI body → Responses body via protocolConverter (single source of
     * truth for the canonical → codex mapping). No request-shape logic is
     * duplicated here.
     *
     * @param {string} prompt
     * @param {object} options - same options as the OpenAI handler
     * @returns {{ body: object, system: string }}
     */
    buildRequestBody(prompt, options = {}) {
      const { body: openaiBody, system } = openaiHandler.buildRequestBody(prompt, options);
      const protocolConverter = require('../protocolConverter');
      const body = protocolConverter.convertRequestBetween(
        openaiBody,
        protocolConverter.PROTOCOLS.OPENAI,
        protocolConverter.PROTOCOLS.CODEX,
      );
      return { body, system };
    },

    /**
     * Parse a non-streaming Responses API JSON response (`{ output:[…], usage }`).
     *
     * @param {object} rawResponse
     * @returns {{ content: string, toolUseBlocks: Array, model: string|null, usage: object|null, stopReason: string|null, thinking: string|null }}
     */
    parseJsonResponse(rawResponse) {
      const { parseDirectResponse } = require('./_responsesFormat');
      const output = Array.isArray(rawResponse?.output) ? rawResponse.output : [];
      const { textParts, functionCalls, reasoningParts } = parseDirectResponse(output);
      const content = textParts.join('\n').trim();
      const toolUseBlocks = functionCalls.map((fc) => {
        let input = {};
        try { input = JSON.parse(fc.arguments); } catch { input = {}; }
        return { type: 'tool_use', id: fc.call_id, name: fc.name, input };
      });
      const usage = rawResponse?.usage || null;
      const thinking = reasoningParts.length > 0 ? reasoningParts.join('\n') : null;
      const stopReason = toolUseBlocks.length > 0 ? 'tool_use' : 'end_turn';
      return { content, toolUseBlocks, model: rawResponse?.model || null, usage, stopReason, thinking };
    },

    /**
     * Parse a Responses API SSE stream.
     * Delegates to _responsesSseStream.parseResponsesSseStream().
     *
     * @param {import('stream').Readable} stream
     * @param {function} [onChunk]
     * @param {object} [opts] - { signal, enableStaleDetection, staleOptions }
     * @returns {Promise<{ content, toolUseBlocks, model, finishReason, usage }>}
     */
    async parseStreamResponse(stream, onChunk, opts = {}) {
      const { parseResponsesSseStream } = require('./_responsesSseStream');
      return parseResponsesSseStream(stream, onChunk, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a protocol handler for the specified protocol.
 *
 * @param {object} config
 * @param {string} config.protocol - Protocol identifier: 'openai' | 'anthropic'
 * @param {string} [config.adapterName] - Adapter name (for diagnostics)
 * @param {number} [config.defaultTimeout] - Default request timeout (ms)
 * @returns {{ buildRequestBody, parseJsonResponse, parseStreamResponse }}
 * @throws {Error} If protocol is not supported
 */
function createProtocolHandler({ protocol, adapterName = 'unknown', defaultTimeout = DEFAULT_TIMEOUT_MS } = {}) {
  switch (protocol) {
    case 'openai':
      return _createOpenAIHandler(adapterName);
    case 'anthropic':
      return _createAnthropicHandler(adapterName);
    case 'codewhisperer':
    case 'cw':
      return _createCWHandler(adapterName);
    case 'responses':
      return _createResponsesHandler(adapterName);
    default:
      throw new Error(`_protocolPipeline: unsupported protocol "${protocol}" (adapter: ${adapterName})`);
  }
}

module.exports = {
  createProtocolHandler,
  DEFAULT_TIMEOUT_MS,
};
