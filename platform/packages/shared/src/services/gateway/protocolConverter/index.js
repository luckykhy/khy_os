/**
 * Protocol Converter — entry point for multi-protocol conversion.
 *
 * Supports OpenAI, Anthropic (Claude), Gemini, Grok, and Codex (Responses API) formats.
 * Converts any incoming format to any outgoing format via a canonical intermediate representation.
 *
 * Usage:
 *   const converter = require('./protocolConverter');
 *   const canonical = converter.convertRequest(body, 'anthropic');  // detect input → canonical
 *   const response = converter.convertResponse(canonicalResp, 'openai');  // canonical → output
 */
const { PROTOCOLS, detectProtocol, getSupportedProtocols, applySamplingParams, canonicalImageToUrl, canonicalImageToAnthropicSource, DESC_LIMITS } = require('./formats');
const openai = require('./openai');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const grok = require('./grok');
const codex = require('./codex');

const converters = {
  [PROTOCOLS.OPENAI]: openai,
  [PROTOCOLS.ANTHROPIC]: anthropic,
  [PROTOCOLS.GEMINI]: gemini,
  [PROTOCOLS.GROK]: grok,
  [PROTOCOLS.CODEX]: codex,
};

/**
 * Convert a request body from its detected format to canonical.
 * @param {object} body - Raw request body
 * @param {string} [sourceProtocol] - Override auto-detection
 * @param {string} [path] - Request path for protocol detection
 * @returns {{ canonical: import('./canonical').CanonicalRequest, detectedProtocol: string }}
 */
function convertRequest(body, sourceProtocol = null, path = '') {
  const protocol = sourceProtocol || detectProtocol(body, path);
  const converter = converters[protocol];
  if (!converter) throw new Error(`Unsupported protocol: ${protocol}`);
  return { canonical: converter.toCanonical(body), detectedProtocol: protocol };
}

/**
 * Convert a canonical response to target protocol format.
 * @param {import('./canonical').CanonicalResponse} canonical - Canonical response
 * @param {string} targetProtocol - Target output format
 * @returns {object} Formatted response body
 */
function convertResponse(canonical, targetProtocol = PROTOCOLS.OPENAI) {
  const converter = converters[targetProtocol];
  if (!converter) throw new Error(`Unsupported target protocol: ${targetProtocol}`);
  return converter.fromCanonical(canonical);
}

/**
 * Direct protocol-to-protocol request conversion.
 * @param {object} body - Source request body
 * @param {string} fromProtocol
 * @param {string} toProtocol
 * @returns {object} Converted request body (in target protocol's native format)
 */
function convertRequestBetween(body, fromProtocol, toProtocol) {
  if (fromProtocol === toProtocol) return body;
  const { canonical } = convertRequest(body, fromProtocol);
  // Re-serialize canonical to target request format
  // Note: fromCanonical is for responses; for request conversion we go canonical → target request
  // This requires building the target request body from canonical data
  return buildRequestBody(canonical, toProtocol);
}

/**
 * Build a native request body from canonical request.
 * @param {import('./canonical').CanonicalRequest} canonical
 * @param {string} targetProtocol
 * @returns {object}
 */
function buildRequestBody(canonical, targetProtocol) {
  switch (targetProtocol) {
    case PROTOCOLS.OPENAI:
    case PROTOCOLS.GROK:
      return buildOpenAIRequest(canonical);
    case PROTOCOLS.ANTHROPIC:
      return buildAnthropicRequest(canonical);
    case PROTOCOLS.GEMINI:
      return buildGeminiRequest(canonical);
    case PROTOCOLS.CODEX:
      return buildCodexRequest(canonical);
    default:
      return buildOpenAIRequest(canonical);
  }
}

function buildOpenAIRequest(c) {
  const messages = [];
  if (c.system) messages.push({ role: 'system', content: c.system });
  for (const msg of c.messages) {
    // Any message carrying tool results expands to one OpenAI tool message per
    // result (role may be 'tool' from OpenAI input or 'user' from Anthropic input)
    // so parallel tool calls are not collapsed to the first result.
    if (msg.toolResults && msg.toolResults.length > 0) {
      for (const tr of msg.toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.toolCallId, content: tr.content });
      }
      const extra = openaiContentFromCanonical(msg.content);
      if (extra && (typeof extra !== 'string' || extra.trim())) {
        messages.push({ role: 'user', content: extra });
      }
      continue;
    }
    const m = { role: msg.role, content: openaiContentFromCanonical(msg.content) };
    if (msg.toolCalls) {
      m.tool_calls = msg.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
    }
    messages.push(m);
  }
  const body = { model: c.model, messages, max_tokens: c.metadata.maxTokens, temperature: c.metadata.temperature, stream: c.metadata.stream };
  applySamplingParams(body, c.metadata, PROTOCOLS.OPENAI);
  if (c.tools) body.tools = c.tools.map(t => ({ type: 'function', function: { name: t.name, description: (t.description || '').slice(0, DESC_LIMITS.openai), parameters: t.parameters } }));
  if (c.toolChoice) body.tool_choice = c.toolChoice;
  return body;
}

/**
 * Build OpenAI message content from a canonical content (string or block array).
 * Returns a plain string when there are no images (keeps the common path simple),
 * otherwise an OpenAI multimodal content array preserving image_url blocks.
 */
function openaiContentFromCanonical(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const hasImage = content.some(b => b && (b.type === 'image' || b.type === 'document'));
  if (!hasImage) return content.map(b => b.text || '').join('') || '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'image' && b.source) {
      const url = canonicalImageToUrl(b.source);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    } else if (b.type === 'document') {
      // OpenAI chat has no document block — degrade to a text note so it is not lost.
      parts.push({ type: 'text', text: b.text || '[document omitted: unsupported by OpenAI chat]' });
    } else {
      parts.push({ type: 'text', text: b.text || '' });
    }
  }
  return parts;
}

function buildAnthropicRequest(c) {
  const messages = [];
  for (const msg of c.messages) {
    if (msg.toolResults && msg.toolResults.length > 0) {
      messages.push({ role: 'user', content: msg.toolResults.map(tr => ({ type: 'tool_result', tool_use_id: tr.toolCallId, content: tr.content })) });
    } else {
      const content = [];
      if (msg.thinking) content.push({ type: 'thinking', thinking: msg.thinking });
      if (typeof msg.content === 'string') { content.push({ type: 'text', text: msg.content }); }
      else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text') content.push({ type: 'text', text: b.text });
          else if (b.type === 'image' && b.source) {
            const source = canonicalImageToAnthropicSource(b.source);
            if (source) content.push({ type: 'image', source });
          } else if (b.type === 'document' && b.source) {
            const source = canonicalImageToAnthropicSource(b.source);
            if (source) content.push({ type: 'document', source });
          }
        }
      }
      if (msg.toolCalls) { for (const tc of msg.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments }); }
      messages.push({ role: msg.role === 'tool' ? 'user' : msg.role, content });
    }
  }
  const body = { model: c.model, messages, max_tokens: c.metadata.maxTokens, temperature: c.metadata.temperature, stream: c.metadata.stream };
  if (c.system) body.system = c.system;
  applySamplingParams(body, c.metadata, PROTOCOLS.ANTHROPIC);
  if (c.tools) body.tools = c.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (c.toolChoice) body.tool_choice = anthropicToolChoice(c.toolChoice);
  return body;
}

/** Map canonical tool_choice back to Anthropic's native shape. */
function anthropicToolChoice(tc) {
  if (!tc) return undefined;
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'required') return { type: 'any' };
  if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) return { type: 'tool', name: tc.function.name };
  return tc;
}

function buildGeminiRequest(c) {
  const contents = [];
  for (const msg of c.messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (msg.thinking) parts.push({ text: msg.thinking, thought: true });
    if (typeof msg.content === 'string') { parts.push({ text: msg.content }); }
    else if (Array.isArray(msg.content)) { for (const b of msg.content) { if (b.type === 'text') parts.push({ text: b.text }); else if (b.type === 'image' && b.source) parts.push({ inlineData: { mimeType: b.source.mediaType, data: b.source.data } }); } }
    if (msg.toolCalls) { for (const tc of msg.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.arguments } }); }
    if (msg.toolResults) { for (const tr of msg.toolResults) parts.push({ functionResponse: { name: tr.name, response: { result: tr.content } } }); }
    contents.push({ role, parts });
  }
  const body = { contents, generationConfig: { maxOutputTokens: c.metadata.maxTokens, temperature: c.metadata.temperature } };
  if (c.system) body.systemInstruction = { parts: [{ text: c.system }] };
  if (c.metadata.topP !== null) body.generationConfig.topP = c.metadata.topP;
  if (c.metadata.stopSequences) body.generationConfig.stopSequences = c.metadata.stopSequences;
  if (c.tools) body.tools = [{ functionDeclarations: c.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  return body;
}

function buildCodexRequest(c) {
  const input = [];
  for (const msg of c.messages) {
    if (msg.toolResults && msg.toolResults.length > 0) {
      for (const tr of msg.toolResults) input.push({ type: 'function_call_output', call_id: tr.toolCallId, output: tr.content });
    } else {
      input.push({ type: 'message', role: msg.role, content: codexContentFromCanonical(msg.content, msg.role) });
      if (msg.toolCalls) { for (const tc of msg.toolCalls) input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) }); }
    }
  }
  const body = { model: c.model, input, max_output_tokens: c.metadata.maxTokens, temperature: c.metadata.temperature, stream: c.metadata.stream };
  if (c.system) body.instructions = c.system;
  if (c.metadata.topP != null) body.top_p = c.metadata.topP;
  if (c.metadata.reasoningEffort != null) body.reasoning = { effort: c.metadata.reasoningEffort };
  if (c.tools) body.tools = c.tools.map(t => ({ type: 'function', name: t.name, description: (t.description || '').slice(0, DESC_LIMITS.openai), parameters: t.parameters }));
  return body;
}

/**
 * Build Responses-API (Codex) input content from a canonical content.
 * Preserves images as `input_image` blocks (assistant text uses output_text).
 */
function codexContentFromCanonical(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [{ type: textType, text: '' }];
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'image' && b.source) {
      const url = canonicalImageToUrl(b.source);
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (b.type === 'document') {
      parts.push({ type: textType, text: b.text || '[document omitted: unsupported by Responses API]' });
    } else {
      parts.push({ type: textType, text: b.text || '' });
    }
  }
  return parts.length > 0 ? parts : [{ type: textType, text: '' }];
}

module.exports = {
  convertRequest,
  convertResponse,
  convertRequestBetween,
  buildRequestBody,
  detectProtocol,
  getSupportedProtocols,
  PROTOCOLS,
};
