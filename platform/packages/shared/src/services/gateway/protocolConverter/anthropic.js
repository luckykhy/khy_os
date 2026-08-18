/**
 * Anthropic (Claude) Protocol Converter — Messages API ↔ Canonical
 */
const { createCanonicalRequest, createCanonicalResponse } = require('./canonical');

/**
 * Convert Claude /v1/messages request to canonical format.
 * @param {object} body - Claude request body
 * @returns {import('./canonical').CanonicalRequest}
 */
function toCanonical(body) {
  const req = createCanonicalRequest();
  req.model = body.model || '';
  req.system = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map(b => b.text || '').join('\n') : null;
  req.metadata.maxTokens = body.max_tokens || 4096;
  req.metadata.temperature = body.temperature ?? 0.7;
  req.metadata.topP = body.top_p ?? null;
  req.metadata.stream = !!body.stream;
  req.metadata.stopSequences = body.stop_sequences || null;
  req.metadata.thinking = body.thinking ?? null;

  // First pass: map tool_use id → tool name so tool_result blocks can backfill
  // the function name (Anthropic tool_result carries no name, but downstream
  // protocols like Gemini's functionResponse require it).
  const toolNameById = {};
  for (const msg of (body.messages || [])) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) toolNameById[block.id] = block.name || '';
    }
  }

  for (const msg of (body.messages || [])) {
    const canonical = { role: msg.role, content: '', thinking: null, toolCalls: null, toolResults: null };

    if (typeof msg.content === 'string') {
      canonical.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = [];
      const blocks = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
          blocks.push({ type: 'text', text: block.text, source: null });
        } else if (block.type === 'image') {
          const src = block.source || {};
          const isUrl = src.type === 'url';
          blocks.push({ type: 'image', text: null, source: { type: isUrl ? 'url' : 'base64', data: isUrl ? (src.url || '') : (src.data || ''), mediaType: src.media_type || 'image/jpeg' } });
        } else if (block.type === 'document') {
          const src = block.source || {};
          const isUrl = src.type === 'url';
          blocks.push({ type: 'document', text: src.type === 'text' ? (src.data || '') : null, source: { type: isUrl ? 'url' : 'base64', data: isUrl ? (src.url || '') : (src.data || ''), mediaType: src.media_type || 'application/pdf' } });
        } else if (block.type === 'thinking') {
          canonical.thinking = block.thinking || block.text || '';
        } else if (block.type === 'tool_use') {
          if (!canonical.toolCalls) canonical.toolCalls = [];
          canonical.toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
        } else if (block.type === 'tool_result') {
          if (!canonical.toolResults) canonical.toolResults = [];
          const resultContent = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('')
            : JSON.stringify(block.content);
          canonical.toolResults.push({ toolCallId: block.tool_use_id, name: toolNameById[block.tool_use_id] || '', content: resultContent, isError: !!block.is_error });
        }
      }

      canonical.content = blocks.length > 0 ? blocks : textParts.join('\n');
    }

    req.messages.push(canonical);
  }

  // Tools
  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map(t => ({ name: t.name, description: t.description || '', parameters: t.input_schema || {} }));
  }

  // Tool choice
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') req.toolChoice = 'auto';
    else if (body.tool_choice.type === 'any') req.toolChoice = 'required';
    else if (body.tool_choice.type === 'tool') req.toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
    else req.toolChoice = body.tool_choice;
  }

  return req;
}

/**
 * Convert canonical response to Claude /v1/messages format.
 * @param {import('./canonical').CanonicalResponse} canonical
 * @returns {object}
 */
function fromCanonical(canonical) {
  const content = [];

  if (canonical.thinking) {
    content.push({ type: 'thinking', thinking: canonical.thinking });
  }

  if (canonical.content) {
    content.push({ type: 'text', text: typeof canonical.content === 'string' ? canonical.content : canonical.content.map(b => b.text || '').join('') });
  }

  if (canonical.toolCalls && canonical.toolCalls.length > 0) {
    for (const tc of canonical.toolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
    }
  }

  return {
    id: canonical.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: canonical.model,
    content,
    stop_reason: mapStopReason(canonical.stopReason),
    usage: canonical.usage ? {
      input_tokens: canonical.usage.inputTokens,
      output_tokens: canonical.usage.outputTokens,
    } : undefined,
  };
}

function mapStopReason(reason) {
  const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', end_turn: 'end_turn', max_tokens: 'max_tokens', STOP: 'end_turn', MAX_TOKENS: 'max_tokens' };
  return map[reason] || 'end_turn';
}

module.exports = { toCanonical, fromCanonical };
