/**
 * Gemini Protocol Converter — GenerateContent format ↔ Canonical
 */
const { createCanonicalRequest, createCanonicalResponse } = require('./canonical');

/**
 * Convert Gemini generateContent request to canonical format.
 * @param {object} body - Gemini request body
 * @returns {import('./canonical').CanonicalRequest}
 */
function toCanonical(body) {
  const req = createCanonicalRequest();
  req.model = body.model || '';

  // System instruction
  if (body.systemInstruction) {
    const parts = body.systemInstruction.parts || [];
    req.system = parts.map(p => p.text || '').join('\n');
  }

  // Generation config
  const gc = body.generationConfig || {};
  req.metadata.maxTokens = gc.maxOutputTokens || 4096;
  req.metadata.temperature = gc.temperature ?? 0.7;
  req.metadata.topP = gc.topP ?? null;
  req.metadata.stopSequences = gc.stopSequences || null;

  // Contents → messages
  for (const content of (body.contents || [])) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const canonical = { role, content: '', thinking: null, toolCalls: null, toolResults: null };
    const blocks = [];

    for (const part of (content.parts || [])) {
      if (part.text !== undefined) {
        if (part.thought) {
          canonical.thinking = (canonical.thinking || '') + part.text;
        } else {
          blocks.push({ type: 'text', text: part.text, source: null });
        }
      } else if (part.inlineData) {
        blocks.push({ type: 'image', text: null, source: { type: 'base64', data: part.inlineData.data, mediaType: part.inlineData.mimeType || 'image/jpeg' } });
      } else if (part.fileData) {
        blocks.push({ type: 'image', text: null, source: { type: 'url', data: part.fileData.fileUri, mediaType: part.fileData.mimeType || 'image/jpeg' } });
      } else if (part.functionCall) {
        if (!canonical.toolCalls) canonical.toolCalls = [];
        canonical.toolCalls.push({ id: part.functionCall.id || `call_${Date.now()}`, name: part.functionCall.name, arguments: part.functionCall.args || {} });
      } else if (part.functionResponse) {
        if (!canonical.toolResults) canonical.toolResults = [];
        canonical.toolResults.push({ toolCallId: '', name: part.functionResponse.name, content: JSON.stringify(part.functionResponse.response || {}), isError: false });
      }
    }

    canonical.content = blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks;
    req.messages.push(canonical);
  }

  // Tools
  if (body.tools && body.tools.length > 0) {
    const declarations = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          declarations.push({ name: fd.name, description: fd.description || '', parameters: fd.parameters || fd.parametersJsonSchema || {} });
        }
      }
    }
    if (declarations.length > 0) req.tools = declarations;
  }

  return req;
}

/**
 * Convert canonical response to Gemini generateContent format.
 * @param {import('./canonical').CanonicalResponse} canonical
 * @returns {object}
 */
function fromCanonical(canonical) {
  const parts = [];

  if (canonical.thinking) {
    parts.push({ text: canonical.thinking, thought: true });
  }

  if (canonical.content) {
    const text = typeof canonical.content === 'string' ? canonical.content : canonical.content.map(b => b.text || '').join('');
    if (text) parts.push({ text });
  }

  if (canonical.toolCalls && canonical.toolCalls.length > 0) {
    for (const tc of canonical.toolCalls) {
      parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
    }
  }

  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: mapStopReason(canonical.stopReason),
    }],
    usageMetadata: canonical.usage ? {
      promptTokenCount: canonical.usage.inputTokens,
      candidatesTokenCount: canonical.usage.outputTokens,
      totalTokenCount: canonical.usage.totalTokens,
    } : undefined,
    modelVersion: canonical.model,
  };
}

function mapStopReason(reason) {
  const map = { stop: 'STOP', end_turn: 'STOP', length: 'MAX_TOKENS', max_tokens: 'MAX_TOKENS', tool_calls: 'STOP', tool_use: 'STOP' };
  return map[reason] || 'STOP';
}

module.exports = { toCanonical, fromCanonical };
