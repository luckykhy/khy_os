'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

// Dependencies (injected from aiManagementServer)
let authenticateRequest = null;
let sendJson = null;
let sendError = null;

function setAnthropicProxyDeps(deps = {}) {
  if (typeof deps.authenticateRequest === 'function') {
    authenticateRequest = deps.authenticateRequest;
  }
  if (typeof deps.sendJson === 'function') {
    sendJson = deps.sendJson;
  }
  if (typeof deps.sendError === 'function') {
    sendError = deps.sendError;
  }
}

// ── Config from env ──
function getConfig() {
  var enabled = (process.env.ANTHROPIC_PROXY_ENABLED || 'false').toLowerCase() === 'true';
  var upstream = process.env.ANTHROPIC_PROXY_UPSTREAM || 'https://api.commandcode.ai/provider/v1/chat/completions';
  var apiKey = process.env.ANTHROPIC_PROXY_API_KEY || '';
  var model = process.env.ANTHROPIC_PROXY_MODEL || 'meituan/LongCat-2.0:free';
  var displayModel = process.env.ANTHROPIC_PROXY_DISPLAY_MODEL || 'claude-opus-4-8';
  return { enabled: enabled, upstream: upstream, apiKey: apiKey, model: model, displayModel: displayModel };
}

// ── Anthropic �?OpenAI message conversion ──
function convertMessages(anthropicMessages) {
  const openaiMessages = [];

  for (const msg of anthropicMessages || []) {
    const role = msg.role || 'user';

    if (role === 'user' && Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) {
      // tool_result -> role: tool messages
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          });
        }
      }
      continue;
    }

    let content = '';
    const toolCalls = [];

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type === 'tool_use') {
          // Anthropic tool_use -> OpenAI tool_calls
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input || {})
            }
          });
        }
      }
      content = textParts.join('\n');
    }

    const oaiMsg = { role, content };
    if (toolCalls.length > 0) {
      oaiMsg.tool_calls = toolCalls;
    }
    openaiMessages.push(oaiMsg);
  }

  return openaiMessages;
}

// ── Anthropic request �?OpenAI request ──
function anthropicToOpenAI(anthReq) {
  const config = getConfig();
  const msgs = [];
  // Anthropic system field -> OpenAI system role message
  if (anthReq.system) {
    const sc = typeof anthReq.system === 'string' ? anthReq.system : anthReq.system.map(p => p.text || '').join('\n');
    msgs.push({ role: 'system', content: sc });
  }
  msgs.push(...convertMessages(anthReq.messages));

  const result = {
    model: config.model,
    messages: msgs,
    max_tokens: anthReq.max_tokens || 4096,
    temperature: anthReq.temperature,
    top_p: anthReq.top_p,
    stream: anthReq.stream || false,
  };

  // Anthropic tools -> OpenAI tools
  if (anthReq.tools) {
    result.tools = anthReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));
  }

  return result;
}

// ── OpenAI response �?Anthropic response ──
function openaiToAnthropic(openaiResp, displayModel) {
  const choice = openaiResp.choices && openaiResp.choices[0];
  const message = choice ? choice.message : null;
  // LongCat uses reasoning_content instead of content
  const text = message
    ? (message.content || message.reasoning_content || '')
    : '';

  const content = [];
  if (text) {
    content.push({ type: 'text', text: text });
  }

  // OpenAI tool_calls -> Anthropic tool_use blocks
  if (message && message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch (e) {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: input
      });
    }
  }

  const finishReason = choice ? choice.finish_reason : null;

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: displayModel,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: finishReason === 'length' ? 'max_tokens'
      : finishReason === 'tool_calls' ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage ? openaiResp.usage.prompt_tokens : 0,
      output_tokens: openaiResp.usage ? openaiResp.usage.completion_tokens : 0,
    },
  };
}

// ── Streaming: OpenAI SSE �?Anthropic SSE ──
function openaiStreamToAnthropic(streamReq, res, displayModel) {
  const config = getConfig();
  const upstreamUrl = new URL(config.upstream);

  const postData = JSON.stringify(streamReq);

  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    path: upstreamUrl.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'text/event-stream',
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Set Anthropic-style SSE headers
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send message_start event
    res.write('event: message_start\n');
    res.write(
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: displayModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`
    );

    let buffer = '';

    proxyRes.on('data', (chunk) => {
      const text = chunk.toString();
      buffer += text;

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.substring(6);
          if (data === '[DONE]') {
            // End of stream
            res.write('event: message_delta\n');
            res.write(
              `data: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 0 },
              })}\n\n`
            );
            res.write('event: message_stop\n');
            res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            res.end();
            return;
          }

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (!delta) continue;

            // Text delta
            const deltaText = delta.content || delta.reasoning_content;
            if (deltaText) {
              res.write('event: content_block_delta\n');
              res.write(
                `data: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: deltaText },
                })}\n\n`
              );
            }

            // Tool call delta
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                // content_block_start for tool_use
                res.write('event: content_block_start\n');
                res.write(
                  `data: ${JSON.stringify({
                    type: 'content_block_start',
                    index: 1,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.function.name,
                      input: {}
                    },
                  })}\n\n`
                );

                // input_json_delta
                if (tc.function && tc.function.arguments) {
                  res.write('event: content_block_delta\n');
                  res.write(
                    `data: ${JSON.stringify({
                      type: 'content_block_delta',
                      index: 1,
                      delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                    })}\n\n`
                  );
                }

                // content_block_stop
                res.write('event: content_block_stop\n');
                res.write(
                  `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`
                );
              }
            }

            // Check finish reason
            if (chunk.choices && chunk.choices[0].finish_reason) {
              const fr = chunk.choices[0].finish_reason;
              if (fr === 'tool_calls') {
                // Will be handled on [DONE]
              }
            }
          } catch (e) {
            // Skip malformed chunks
          }
        }
      }
    });

    proxyRes.on('end', () => {
      res.end();
    });

    proxyRes.on('error', (err) => {
      if (sendError) {
        sendError(res, 502, `Upstream stream error: ${err.message}`);
      } else {
        res.end();
      }
    });
  });

  proxyReq.on('error', (err) => {
    if (sendError) {
      sendError(res, 502, `Proxy request error: ${err.message}`);
    } else {
      res.end();
    }
  });

  proxyReq.write(postData);
  proxyReq.end();
}

// ── Non-streaming request handler ──
function handleNonStream(anthropicReq, res) {
  const config = getConfig();
  const openaiReq = anthropicToOpenAI(anthropicReq);
  const postData = JSON.stringify(openaiReq);

  const upstreamUrl = new URL(config.upstream);
  const options = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    path: upstreamUrl.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => (data += chunk));
    proxyRes.on('end', () => {
      try {
        const openaiResp = JSON.parse(data);
        const anthropicResp = openaiToAnthropic(openaiResp, config.displayModel);
        if (sendJson) {
          sendJson(res, 200, anthropicResp);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(anthropicResp));
        }
      } catch (e) {
        if (sendError) {
          sendError(res, 502, `Parse error: ${e.message}`);
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Parse error: ${e.message}` }));
        }
      }
    });
  });

  proxyReq.on('error', (err) => {
    if (sendError) {
      sendError(res, 502, `Upstream error: ${err.message}`);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
    }
  });

  proxyReq.write(postData);
  proxyReq.end();
}

// ── Main handler ──
async function handleAnthropicMessages(req, res) {
  const config = getConfig();

  if (!config.enabled) {
    if (sendError) {
      sendError(res, 403, 'Anthropic proxy is disabled. Set ANTHROPIC_PROXY_ENABLED=true to enable.');
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Anthropic proxy disabled' }));
    }
    return;
  }

  if (!config.apiKey) {
    if (sendError) {
      sendError(res, 401, 'Missing ANTHROPIC_PROXY_API_KEY');
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing API key' }));
    }
    return;
  }

  // Body is already parsed by Express middleware
  const anthropicReq = req.body;

  if (!anthropicReq || !anthropicReq.messages) {
    if (sendError) {
      sendError(res, 400, 'Missing request body or messages');
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing request body or messages' }));
    }
    return;
  }

  try {
    if (anthropicReq.stream) {
      const openaiReq = anthropicToOpenAI(anthropicReq);
      openaiReq.stream = true;
      openaiStreamToAnthropic(openaiReq, res, config.displayModel);
    } else {
      handleNonStream(anthropicReq, res);
    }
  } catch (e) {
    if (sendError) {
      sendError(res, 500, `Proxy error: ${e.message}`);
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }));
    }
  }
}

// ── Health check endpoint ──
function handleAnthropicProxyStatus(req, res) {
  var config = getConfig();
  var status = {
    enabled: config.enabled,
    upstream: config.upstream,
    model: config.model,
    displayModel: config.displayModel,
    hasApiKey: true
  };
  if (sendJson) {
    sendJson(res, 200, status);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }
}

module.exports = {
  setAnthropicProxyDeps,
  handleAnthropicMessages,
  handleAnthropicProxyStatus,
  getConfig,
};
