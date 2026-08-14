'use strict';

const crypto = require('crypto');

let authenticateRequest = null;
let parseBody = null;
let getGateway = null;
let sendJson = null;

function setOpenaiCompatDeps(deps = {}) {
  if (typeof deps.authenticateRequest === 'function') {
    authenticateRequest = deps.authenticateRequest;
  }
  if (typeof deps.parseBody === 'function') {
    parseBody = deps.parseBody;
  }
  if (typeof deps.getGateway === 'function') {
    getGateway = deps.getGateway;
  }
  if (typeof deps.sendJson === 'function') {
    sendJson = deps.sendJson;
  }
}

function _convertMessages(messages) {
  let prompt = '';
  const images = [];
  let systemContent = '';

  for (const msg of messages || []) {
    const role = msg.role || 'user';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          content += (content ? '\n' : '') + part.text;
        } else if (part.type === 'image_url' && part.image_url) {
          const url = part.image_url.url || '';
          if (url.startsWith('data:')) {
            const mimeMatch = url.match(/^data:([^;]+);/);
            const base64Match = url.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
              images.push({
                base64: base64Match[1],
                mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
              });
            }
          }
        }
      }
    }

    if (role === 'system') {
      systemContent = (systemContent ? systemContent + '\n' : '') + content;
    } else if (content) {
      prompt += (prompt ? '\n\n' : '') + role + ': ' + content;
    }
  }

  if (systemContent) {
    prompt = 'System: ' + systemContent + '\n\n' + prompt;
  }

  return { prompt, images };
}

function _genId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

async function handleV1ChatCompletions(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return sendJson(res, 401, {
      error: {
        message: auth.error || 'Authentication required',
        type: 'auth_error',
        param: null,
        code: null,
      },
    });
  }

  const body = await parseBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = body.stream === true;
  const modelParam = typeof body.model === 'string' ? body.model.trim() : undefined;

  if (!messages.length) {
    return sendJson(res, 400, {
      error: {
        message: 'messages is required',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  }

  const { prompt, images } = _convertMessages(messages);
  if (!prompt && !images.length) {
    return sendJson(res, 400, {
      error: {
        message: 'at least one text or image message is required',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    });
  }

  const gw = getGateway();
  if (!gw.isInitialized()) {
    await gw.init();
  }

  const completionId = _genId();
  const created = Math.floor(Date.now() / 1000);
  const model = modelParam || undefined;

  const genOptions = {
    model,
    preferredModel: model,
    ...(images.length ? { images } : {}),
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    const sendData = (data) => {
      if (clientGone) {
        return;
      }
      try {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      } catch {
        clientGone = true;
      }
    };

    const chunkBase = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: model || 'unknown',
    };

    sendData({
      ...chunkBase,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
    });

    try {
      await gw.generate(prompt, {
        ...genOptions,
        onChunk: (chunk) => {
          if (!chunk || clientGone) {
            return;
          }
          if (chunk.type === 'text') {
            const piece = String(chunk.text || '');
            if (!piece) {
              return;
            }
            sendData({
              ...chunkBase,
              choices: [
                { index: 0, delta: { content: piece }, finish_reason: null, logprobs: null },
              ],
            });
          }
        },
      });
    } catch {
      /* streaming error — finalize below */
    }

    sendData({
      ...chunkBase,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
    });
    try {
      res.write('data: [DONE]\n\n');
    } catch {
      /* ignore */
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    const result = await gw.generate(prompt, genOptions);
    const reply = String(result.content || '').trim();
    const providerModel = result.model || result.provider || model || 'unknown';
    const usage = result.tokenUsage
      ? {
          prompt_tokens: result.tokenUsage.promptTokens || result.tokenUsage.inputTokens || 0,
          completion_tokens:
            result.tokenUsage.completionTokens || result.tokenUsage.outputTokens || 0,
          total_tokens: result.tokenUsage.totalTokens || 0,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return sendJson(res, 200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model: providerModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply, refusal: null },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage,
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: {
        message: err.message || 'Internal error',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  }
}

async function handleV1ListModels(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) {
    return sendJson(res, 401, {
      error: {
        message: auth.error || 'Authentication required',
        type: 'auth_error',
        param: null,
        code: null,
      },
    });
  }

  try {
    const gw = getGateway();
    if (!gw.isInitialized()) {
      await gw.init();
    }

    const statuses = gw.getStatus();
    const models = [];

    for (const s of statuses) {
      if (!s.enabled) {
        continue;
      }
      try {
        const adapterModels = await gw.listModels(s.type).catch(() => []);
        for (const m of adapterModels) {
          models.push({
            id: m.id || m.name || m.model,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: s.type || 'unknown',
          });
        }
      } catch {
        /* skip */
      }
    }

    return sendJson(res, 200, { object: 'list', data: models });
  } catch (err) {
    return sendJson(res, 500, {
      error: {
        message: err.message || 'Failed to list models',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  }
}

module.exports = {
  handleV1ChatCompletions,
  handleV1ListModels,
  setOpenaiCompatDeps,
};
