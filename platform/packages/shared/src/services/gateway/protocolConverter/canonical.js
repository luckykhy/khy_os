/**
 * Canonical Message Format — internal lingua franca for protocol conversion.
 *
 * All protocol converters translate their native format to/from this canonical form.
 * This decouples input protocol from output protocol: any-to-any conversion via canonical.
 */

/**
 * @typedef {object} ContentBlock
 * @property {'text'|'image'|'document'} type
 * @property {string|null} text
 * @property {{ type: 'base64'|'url', data: string, mediaType: string }|null} source
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id - Unique tool call identifier
 * @property {string} name - Function/tool name
 * @property {object} arguments - Parsed arguments object
 */

/**
 * @typedef {object} ToolResult
 * @property {string} toolCallId - Matching tool call ID
 * @property {string} name - Function name
 * @property {string} content - Result content (string)
 * @property {boolean} [isError] - Whether the result is an error
 */

/**
 * @typedef {object} CanonicalMessage
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string|ContentBlock[]} content
 * @property {string|null} thinking - Reasoning/thinking content
 * @property {ToolCall[]|null} toolCalls
 * @property {ToolResult[]|null} toolResults
 */

/**
 * @typedef {object} CanonicalRequest
 * @property {string} model
 * @property {CanonicalMessage[]} messages
 * @property {string|null} system - System prompt (extracted from messages or dedicated field)
 * @property {object} metadata
 * @property {number} metadata.maxTokens
 * @property {number} metadata.temperature
 * @property {number|null} metadata.topP
 * @property {boolean} metadata.stream
 * @property {string[]|null} metadata.stopSequences
 * @property {number|null} metadata.frequencyPenalty - OpenAI-only
 * @property {number|null} metadata.presencePenalty - OpenAI-only
 * @property {number|null} metadata.seed - OpenAI-only
 * @property {object|null} metadata.responseFormat - OpenAI-only (e.g. json_schema)
 * @property {string|null} metadata.reasoningEffort - OpenAI o-series / Codex
 * @property {object|null} metadata.thinking - Anthropic request-level thinking config
 * @property {object[]|null} tools - Tool definitions
 * @property {string|object|null} toolChoice - Tool choice configuration
 */

/**
 * @typedef {object} CanonicalResponse
 * @property {string} id - Response identifier
 * @property {string} model - Model used
 * @property {'user'|'assistant'} role
 * @property {string} content - Text content
 * @property {string|null} thinking - Reasoning content
 * @property {ToolCall[]|null} toolCalls
 * @property {string} stopReason - Why generation stopped
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number }|null} usage
 */

/**
 * Create an empty canonical request with defaults.
 * @param {object} [overrides]
 * @returns {CanonicalRequest}
 */
function createCanonicalRequest(overrides = {}) {
  return {
    model: '',
    messages: [],
    system: null,
    metadata: {
      maxTokens: 4096,
      temperature: 0.7,
      topP: null,
      stream: false,
      stopSequences: null,
      frequencyPenalty: null,
      presencePenalty: null,
      seed: null,
      responseFormat: null,
      reasoningEffort: null,
      thinking: null,
    },
    tools: null,
    toolChoice: null,
    ...overrides,
  };
}

/**
 * Create an empty canonical response with defaults.
 * @param {object} [overrides]
 * @returns {CanonicalResponse}
 */
function createCanonicalResponse(overrides = {}) {
  return {
    id: '',
    model: '',
    role: 'assistant',
    content: '',
    thinking: null,
    toolCalls: null,
    stopReason: 'stop',
    usage: null,
    ...overrides,
  };
}

module.exports = { createCanonicalRequest, createCanonicalResponse };
