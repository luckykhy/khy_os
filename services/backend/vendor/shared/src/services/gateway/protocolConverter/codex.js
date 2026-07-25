/**
 * Codex Protocol Converter — OpenAI Responses API format ↔ Canonical
 *
 * Codex uses the newer OpenAI Responses API format with structured input array.
 */
const { createCanonicalRequest, createCanonicalResponse } = require('./canonical');
const { safeParseToolArgs, parseImageUrl } = require('./formats');

/**
 * Safely parse function_call arguments (may be string, object, or malformed).
 * Delegates to the shared helper so all converters share one parse policy.
 */
function parseArgsSafe(args) {
  return safeParseToolArgs(args);
}

/**
 * Convert a Responses-API message `content` into canonical content.
 * Returns a plain string when there are no images; otherwise a block array
 * preserving input_image blocks so multimodal input is not dropped.
 */
function codexInputContentToCanonical(content) {
  if (!Array.isArray(content)) return content || '';
  const hasImage = content.some(c => c && c.type === 'input_image');
  if (!hasImage) return content.map(c => c.text || '').join('');
  return content.map(c => {
    if (c && c.type === 'input_image') {
      return { type: 'image', text: null, source: parseImageUrl(c.image_url || '') };
    }
    return { type: 'text', text: (c && c.text) || '', source: null };
  });
}

/**
 * Convert Codex/Responses request to canonical format.
 * @param {object} body - Responses API request body
 * @returns {import('./canonical').CanonicalRequest}
 */
function toCanonical(body) {
  const req = createCanonicalRequest();
  req.model = body.model || '';
  req.system = body.instructions || null;
  req.metadata.maxTokens = body.max_output_tokens || 4096;
  req.metadata.temperature = body.temperature ?? 0.7;
  req.metadata.topP = body.top_p ?? null;
  req.metadata.stream = !!body.stream;
  req.metadata.reasoningEffort = body.reasoning?.effort ?? null;

  // Map call_id → function name so function_call_output can backfill its name
  // (Responses outputs carry no name, but downstream protocols may require it).
  const toolNameByCallId = {};
  for (const item of (body.input || [])) {
    if (item.type === 'function_call' && item.call_id) toolNameByCallId[item.call_id] = item.name || '';
  }

  // Parse input array
  for (const item of (body.input || [])) {
    if (item.type === 'message') {
      const content = codexInputContentToCanonical(item.content);
      req.messages.push({ role: item.role, content, thinking: null, toolCalls: null, toolResults: null });
    } else if (item.type === 'function_call') {
      // Attach to last assistant message or create one
      const last = req.messages[req.messages.length - 1];
      if (last && last.role === 'assistant') {
        if (!last.toolCalls) last.toolCalls = [];
        last.toolCalls.push({ id: item.call_id, name: item.name, arguments: parseArgsSafe(item.arguments) });
      }
    } else if (item.type === 'function_call_output') {
      req.messages.push({ role: 'tool', content: item.output || '', thinking: null, toolCalls: null, toolResults: [{ toolCallId: item.call_id, name: toolNameByCallId[item.call_id] || '', content: item.output || '', isError: false }] });
    }
  }

  // Tools
  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.filter(t => t.type === 'function').map(t => ({ name: t.name, description: t.description || '', parameters: t.parameters || {} }));
  }

  return req;
}

/**
 * Convert canonical response to Codex/Responses format.
 * @param {import('./canonical').CanonicalResponse} canonical
 * @returns {object}
 */
function fromCanonical(canonical) {
  const output = [];

  // Text output
  if (canonical.content) {
    output.push({
      type: 'message',
      id: `msg_${Date.now()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: typeof canonical.content === 'string' ? canonical.content : canonical.content.map(b => b.text || '').join('') }],
    });
  }

  // Tool calls
  if (canonical.toolCalls && canonical.toolCalls.length > 0) {
    for (const tc of canonical.toolCalls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
        status: 'completed',
      });
    }
  }

  return {
    id: canonical.id || `resp_${Date.now()}`,
    object: 'response',
    status: canonical.toolCalls ? 'requires_action' : 'completed',
    output,
    usage: canonical.usage ? {
      input_tokens: canonical.usage.inputTokens,
      output_tokens: canonical.usage.outputTokens,
      total_tokens: canonical.usage.totalTokens,
    } : undefined,
    model: canonical.model,
  };
}

module.exports = { toCanonical, fromCanonical };
