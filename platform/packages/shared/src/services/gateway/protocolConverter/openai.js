/**
 * OpenAI Protocol Converter — Chat Completions format ↔ Canonical
 */
const { createCanonicalRequest, createCanonicalResponse } = require('./canonical');
const { safeParseToolArgs, parseImageUrl } = require('./formats');

/**
 * Convert OpenAI chat/completions request to canonical format.
 * @param {object} body - OpenAI request body
 * @returns {import('./canonical').CanonicalRequest}
 */
function toCanonical(body) {
  const req = createCanonicalRequest();
  req.model = body.model || '';
  req.metadata.maxTokens = body.max_tokens || body.max_completion_tokens || 4096;
  req.metadata.temperature = body.temperature ?? 0.7;
  req.metadata.topP = body.top_p ?? null;
  req.metadata.stream = !!body.stream;
  req.metadata.stopSequences = body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : null;
  req.metadata.frequencyPenalty = body.frequency_penalty ?? null;
  req.metadata.presencePenalty = body.presence_penalty ?? null;
  req.metadata.seed = body.seed ?? null;
  req.metadata.responseFormat = body.response_format ?? null;
  req.metadata.reasoningEffort = body.reasoning_effort ?? null;

  // Extract system from messages
  const messages = body.messages || [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      req.system = (req.system || '') + (typeof msg.content === 'string' ? msg.content : msg.content?.map(b => b.text || '').join(''));
      continue;
    }

    const canonical = { role: msg.role, content: '', thinking: null, toolCalls: null, toolResults: null };

    if (typeof msg.content === 'string') {
      canonical.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      canonical.content = msg.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text, source: null };
        if (part.type === 'image_url') return { type: 'image', text: null, source: parseImageUrl(part.image_url?.url || '') };
        return { type: 'text', text: JSON.stringify(part), source: null };
      });
    }

    // Reasoning content (OpenAI o1/o3 style)
    if (msg.reasoning_content) canonical.thinking = msg.reasoning_content;

    // Tool calls (assistant messages)
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      canonical.toolCalls = msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: safeParseToolArgs(tc.function?.arguments),
      }));
    }

    // Tool results
    if (msg.role === 'tool') {
      canonical.role = 'tool';
      canonical.toolResults = [{ toolCallId: msg.tool_call_id || '', name: msg.name || '', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), isError: false }];
    }

    req.messages.push(canonical);
  }

  // Tools
  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map(t => ({ name: t.function?.name, description: t.function?.description || '', parameters: t.function?.parameters || {} }));
  }
  req.toolChoice = body.tool_choice || null;

  return req;
}

/**
 * Convert canonical response to OpenAI chat/completions format.
 * @param {import('./canonical').CanonicalResponse} canonical
 * @param {boolean} [stream=false]
 * @returns {object}
 */
function fromCanonical(canonical, stream = false) {
  const choice = {
    index: 0,
    message: {
      role: 'assistant',
      content: canonical.content || null,
    },
    finish_reason: mapStopReason(canonical.stopReason),
  };

  if (canonical.thinking) {
    choice.message.reasoning_content = canonical.thinking;
  }

  if (canonical.toolCalls && canonical.toolCalls.length > 0) {
    choice.message.tool_calls = canonical.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
    choice.finish_reason = 'tool_calls';
  }

  return {
    id: canonical.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: canonical.model,
    choices: [choice],
    usage: canonical.usage ? {
      prompt_tokens: canonical.usage.inputTokens,
      completion_tokens: canonical.usage.outputTokens,
      total_tokens: canonical.usage.totalTokens,
    } : undefined,
  };
}

function mapStopReason(reason) {
  const map = { stop: 'stop', end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', STOP: 'stop', MAX_TOKENS: 'length' };
  return map[reason] || 'stop';
}

module.exports = { toCanonical, fromCanonical };
