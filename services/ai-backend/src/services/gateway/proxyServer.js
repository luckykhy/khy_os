/**
 * Reverse Proxy Server — unified OpenAI-compatible API endpoint
 * that routes requests to IDE adapters (Kiro, Cursor, Claude, Codex).
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat (stream/non-stream)
 *   POST /v1/messages          — Anthropic-compatible messages
 *   GET  /v1/models            — Aggregated model list from all IDEs
 *   GET  /health               — Health check
 *   GET  /pool/stats           — Account pool statistics
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const protocolConverter = require('./protocolConverter');
const { PROTOCOLS } = protocolConverter;
// 数据家单一真源:复用主 backend 的 getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../../utils/dataHome。
const { getAppDataDir } = require('../../utils/dataHome');

let _server = null;
let _httpsServer = null;
let _gateway = null;

function getGateway() {
  if (!_gateway) _gateway = require('./aiGateway');
  return _gateway;
}

let _enforcer = null;
function getEnforcer() {
  if (!_enforcer) _enforcer = require('./dataPlaneEnforcer');
  return _enforcer;
}

/** Extract the raw bearer value (without the "Bearer " prefix) from a request. */
function extractBearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

const IDE_ADAPTERS = ['kiro', 'cursor', 'claude', 'codex', 'trae', 'warp', 'windsurf', 'vscode'];

/**
 * Strip real IP headers from outgoing requests to prevent IP leaking.
 * Called before forwarding to IDE adapters.
 */
function sanitizeIpHeaders() {
  // Set fake forwarded headers to mask real IP
  const fakeIp = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  return {
    'X-Forwarded-For': fakeIp,
    'X-Real-IP': fakeIp,
    'CF-Connecting-IP': fakeIp,
    'True-Client-IP': fakeIp,
  };
}

/**
 * Parse request body as JSON.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send JSON response with additional headers (e.g. Retry-After for 429).
 */
function sendJsonWithHeaders(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Reject a request that failed data-plane enforcement.
 */
function sendEnforcementRejection(res, verdict) {
  const extra = verdict.retryAfterMs
    ? { 'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) }
    : {};
  sendJsonWithHeaders(res, verdict.httpStatus || 403, {
    error: { message: verdict.message || 'Forbidden', code: verdict.code || 'forbidden' },
  }, extra);
}

/**
 * Route model ID to adapter key.
 * Format: "kiro/claude-sonnet-4" → { adapterKey: 'kiro', modelId: 'claude-sonnet-4' }
 * Fallback: "gpt-4o" → { adapterKey: null, modelId: 'gpt-4o' }
 */
function parseModel(model) {
  if (!model) return { adapterKey: null, modelId: null };
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash).toLowerCase();
    if (IDE_ADAPTERS.includes(prefix)) {
      return { adapterKey: prefix, modelId: model.slice(slash + 1) };
    }
  }
  return { adapterKey: null, modelId: model };
}

/**
 * Handle POST /v1/chat/completions
 */
async function handleChatCompletions(req, res) {
  const body = await parseBody(req);
  const { messages: rawMsgs, model, stream } = body;

  if (!rawMsgs?.length) return sendJson(res, 400, { error: { message: 'messages required' } });

  // Data-plane enforcement: auth -> model permission -> rate limit -> quota.
  const enforcer = getEnforcer();
  const traceId = crypto.randomUUID();
  const verdict = await enforcer.enforceInbound({
    bearer: extractBearer(req),
    model: model || '',
    messages: rawMsgs,
    traceId,
  });
  if (!verdict.ok) return sendEnforcementRejection(res, verdict);
  const ctx = verdict.ctx;
  // Per-user upstream (multi-tenant): when present, force the relay path with
  // this user's key/endpoint/format and ignore any IDE-adapter prefix.
  const up = ctx.upstream;

  // Extract system prompt and convert to flat prompt
  let system;
  const messages = [];
  for (const m of rawMsgs) {
    if (m.role === 'system') { system = m.content; continue; }
    messages.push(m);
  }

  const prompt = [
    system ? `System: ${system}` : '',
    ...messages.map(m => `${m.role}: ${m.content}`),
  ].filter(Boolean).join('\n');

  const { adapterKey, modelId } = parseModel(model);
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  if (stream) {
    // SSE streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    });

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    let fullText = '';
    try {
      const onChunk = (chunk) => {
        if (chunk.type === 'text') {
          fullText += chunk.text;
          sendSSE({
            id: responseId, object: 'chat.completion.chunk', created,
            model: model || 'default',
            choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
          });
        }
      };
      const result = up
        ? await gw.generate(prompt, { model: up.model, apiKey: up.apiKey, apiEndpoint: up.apiEndpoint, apiFormat: up.apiFormat, apiKeyField: up.apiKeyField, onChunk })
        : adapterKey
          ? await gw.generateWithAdapter(adapterKey, prompt, { model: modelId, onChunk })
          : await gw.generate(prompt, { onChunk });

      sendSSE({
        id: responseId, object: 'chat.completion.chunk', created,
        model: model || 'default',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();

      const usage = enforcer.deriveUsage(ctx, result, fullText);
      enforcer.settleOutbound(ctx, { ...usage, model: model || usage.model, status: 'ok', httpStatus: 200 });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
      enforcer.settleOutbound(ctx, {
        inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
        model: model || '', status: 'error', httpStatus: 500, error: err.message,
      });
    }
  } else {
    // Non-streaming
    try {
      const result = up
        ? await gw.generate(prompt, { model: up.model, apiKey: up.apiKey, apiEndpoint: up.apiEndpoint, apiFormat: up.apiFormat, apiKeyField: up.apiKeyField })
        : adapterKey
          ? await gw.generateWithAdapter(adapterKey, prompt, { model: modelId })
          : await gw.generate(prompt);

      if (!result.success) {
        enforcer.settleOutbound(ctx, {
          inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
          model: model || '', status: 'error', httpStatus: 500, error: 'Generation failed',
        });
        return sendJson(res, 500, { error: { message: 'Generation failed' } });
      }

      const usage = enforcer.deriveUsage(ctx, result, result.content || '');
      enforcer.settleOutbound(ctx, { ...usage, model: model || usage.model, status: 'ok', httpStatus: 200 });

      sendJson(res, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'default',
        choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      });
    } catch (err) {
      enforcer.settleOutbound(ctx, {
        inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
        model: model || '', status: 'error', httpStatus: 500, error: err.message,
      });
      sendJson(res, 500, { error: { message: err.message } });
    }
  }
}

/**
 * Handle multi-protocol requests — converts input protocol to canonical,
 * generates via gateway, then converts response back to source protocol.
 */
async function handleMultiProtocol(req, res, sourceProtocol) {
  const body = await parseBody(req);
  const { canonical, detectedProtocol } = protocolConverter.convertRequest(body, sourceProtocol);

  // Data-plane enforcement.
  const enforcer = getEnforcer();
  const traceId = crypto.randomUUID();
  const verdict = await enforcer.enforceInbound({
    bearer: extractBearer(req),
    model: canonical.model || '',
    messages: canonical.messages,
    traceId,
  });
  if (!verdict.ok) return sendEnforcementRejection(res, verdict);
  const ctx = verdict.ctx;
  // Per-user upstream (multi-tenant): force this user's relay key/endpoint/format.
  const up = ctx.upstream;

  // Build flat prompt from canonical messages
  const prompt = [
    canonical.system ? `System: ${canonical.system}` : '',
    ...canonical.messages.map(m => {
      const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : '');
      return `${m.role}: ${text}`;
    }),
  ].filter(Boolean).join('\n');

  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const outputProtocol = detectedProtocol;

  if (canonical.metadata.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    });

    let fullContent = '';
    try {
      const onChunk = (chunk) => {
        if (chunk.type === 'text') {
          fullContent += chunk.text;
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: chunk.text } })}\n\n`);
        }
      };
      const result = up
        ? await gw.generate(prompt, { model: up.model, apiKey: up.apiKey, apiEndpoint: up.apiEndpoint, apiFormat: up.apiFormat, apiKeyField: up.apiKeyField, onChunk })
        : await gw.generate(prompt, { onChunk });

      const usage = enforcer.deriveUsage(ctx, result, fullContent);
      // Build canonical response and convert to output protocol
      const canonicalResp = { id: `msg_${crypto.randomUUID()}`, model: canonical.model || 'default', content: fullContent, thinking: null, toolCalls: null, stopReason: 'end_turn', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens } };
      const formatted = protocolConverter.convertResponse(canonicalResp, outputProtocol);
      res.write(`data: ${JSON.stringify(formatted)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();

      enforcer.settleOutbound(ctx, { ...usage, model: canonical.model || usage.model, status: 'ok', httpStatus: 200 });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
      enforcer.settleOutbound(ctx, {
        inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
        model: canonical.model || '', status: 'error', httpStatus: 500, error: err.message,
      });
    }
  } else {
    try {
      const result = up
        ? await gw.generate(prompt, { model: up.model, apiKey: up.apiKey, apiEndpoint: up.apiEndpoint, apiFormat: up.apiFormat, apiKeyField: up.apiKeyField })
        : await gw.generate(prompt);
      if (!result.success) {
        enforcer.settleOutbound(ctx, {
          inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
          model: canonical.model || '', status: 'error', httpStatus: 500, error: 'Generation failed',
        });
        return sendJson(res, 500, { error: { message: 'Generation failed' } });
      }

      const usage = enforcer.deriveUsage(ctx, result, result.content || '');
      const canonicalResp = { id: `msg_${crypto.randomUUID()}`, model: canonical.model || 'default', content: result.content, thinking: null, toolCalls: null, stopReason: 'end_turn', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens } };
      const formatted = protocolConverter.convertResponse(canonicalResp, outputProtocol);
      sendJson(res, 200, formatted);

      enforcer.settleOutbound(ctx, { ...usage, model: canonical.model || usage.model, status: 'ok', httpStatus: 200 });
    } catch (err) {
      enforcer.settleOutbound(ctx, {
        inputTokens: ctx.estInput, outputTokens: 0, estimated: true,
        model: canonical.model || '', status: 'error', httpStatus: 500, error: err.message,
      });
      sendJson(res, 500, { error: { message: err.message } });
    }
  }
}

/**
 * Handle GET /v1/models — aggregate from all IDE adapters
 */
async function handleListModels(req, res) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const allModels = [];

  for (const key of IDE_ADAPTERS) {
    try {
      const models = await gw.listModels(key);
      for (const m of models) {
        allModels.push({
          id: `${key}/${m.id}`,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: key,
          name: m.name || m.id,
          description: m.description || '',
          is_default: m.isDefault || false,
        });
      }
    } catch { /* adapter not available */ }
  }

  sendJson(res, 200, { object: 'list', data: allModels });
}

/**
 * Start the proxy server (HTTP + optional HTTPS).
 * @param {number|object} portOrOpts - port number or options object
 *   opts.port, opts.httpsPort, opts.tlsCert, opts.tlsKey, opts.httpsOnly
 */
function start(portOrOpts) {
  return new Promise((resolve, reject) => {
    if (_server || _httpsServer) {
      reject(new Error('Proxy server already running'));
      return;
    }

    const opts = typeof portOrOpts === 'object' && portOrOpts !== null ? portOrOpts : {};
    const httpPort = opts.port || (typeof portOrOpts === 'number' ? portOrOpts : null) || parseInt(process.env.PROXY_PORT, 10) || 9100;
    const httpsOnly = opts.httpsOnly || process.env.PROXY_HTTPS_ONLY === 'true';
    const authToken = process.env.PROXY_AUTH_TOKEN;

    // Resolve TLS cert/key
    const defaultCertDir = getAppDataDir('proxy_certs');
    const tlsCert = opts.tlsCert || process.env.PROXY_TLS_CERT_FILE || path.join(process.env.PROXY_TLS_DIR || defaultCertDir, 'localhost.crt');
    const tlsKey = opts.tlsKey || process.env.PROXY_TLS_KEY_FILE || path.join(process.env.PROXY_TLS_DIR || defaultCertDir, 'localhost.key');
    const httpsPort = opts.httpsPort || parseInt(process.env.PROXY_HTTPS_PORT, 10) || (httpPort + 1);

    // Check if TLS certs exist
    const hasTls = fs.existsSync(tlsCert) && fs.existsSync(tlsKey);
    const enableHttps = hasTls && (opts.https !== false && process.env.PROXY_HTTPS_DISABLE !== 'true');

    const requestHandler = async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }

      const url = new URL(req.url, `http://localhost:${httpPort}`);
      const pathname = url.pathname;

      // Data-plane POST endpoints run the full enforcement chain inside their
      // handlers (global token OR managed customer token). Other endpoints keep
      // the legacy global-token gate for backward compatibility.
      const isDataPlanePost = req.method === 'POST' && (
        pathname === '/v1/chat/completions'
        || pathname === '/v1/messages'
        || pathname === '/v1/responses'
        || /^\/v1beta\/models\/[^/]+:generateContent$/.test(pathname)
      );
      if (authToken && !isDataPlanePost) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${authToken}`) {
          return sendJson(res, 401, { error: { message: 'Unauthorized' } });
        }
      }

      // Strip real client IP from incoming request before processing
      delete req.headers['x-forwarded-for'];
      delete req.headers['x-real-ip'];
      delete req.headers['cf-connecting-ip'];
      delete req.headers['true-client-ip'];

      try {
        if (req.method === 'POST' && pathname === '/v1/chat/completions') {
          await handleChatCompletions(req, res);
        } else if (req.method === 'POST' && pathname === '/v1/messages') {
          await handleMultiProtocol(req, res, PROTOCOLS.ANTHROPIC);
        } else if (req.method === 'POST' && pathname.match(/^\/v1beta\/models\/[^/]+:generateContent$/)) {
          await handleMultiProtocol(req, res, PROTOCOLS.GEMINI);
        } else if (req.method === 'POST' && pathname === '/v1/responses') {
          await handleMultiProtocol(req, res, PROTOCOLS.CODEX);
        } else if (req.method === 'GET' && pathname === '/v1/models') {
          await handleListModels(req, res);
        } else if (req.method === 'GET' && pathname === '/health') {
          sendJson(res, 200, { status: 'ok', adapters: IDE_ADAPTERS, protocols: protocolConverter.getSupportedProtocols() });
        } else {
          sendJson(res, 404, { error: { message: 'Not found' } });
        }
      } catch (err) {
        sendJson(res, 500, { error: { message: err.message } });
      }
    };

    const result = { httpPort: null, httpsPort: null };
    let pending = 0;
    const done = () => { if (--pending <= 0) resolve(result); };
    const fail = (err) => reject(err);

    // Start HTTP server (unless httpsOnly)
    if (!httpsOnly) {
      pending++;
      _server = http.createServer(requestHandler);
      _server.listen(httpPort, () => { result.httpPort = httpPort; done(); });
      _server.on('error', fail);
    }

    // Start HTTPS server
    if (enableHttps) {
      pending++;
      try {
        const tlsOpts = {
          cert: fs.readFileSync(tlsCert),
          key: fs.readFileSync(tlsKey),
        };
        _httpsServer = https.createServer(tlsOpts, requestHandler);
        _httpsServer.listen(httpsPort, () => { result.httpsPort = httpsPort; done(); });
        _httpsServer.on('error', fail);
      } catch (err) {
        console.warn('[proxy] HTTPS startup failed, falling back to HTTP only:', err.message);
        pending--;
        if (pending <= 0) resolve(result);
      }
    }

    if (pending === 0) {
      reject(new Error('No server started — check HTTPS config'));
    }
  });
}

/**
 * Stop the proxy server(s).
 */
function stop() {
  return new Promise((resolve) => {
    let pending = 0;
    const done = () => { if (--pending <= 0) resolve(); };
    if (_server) {
      pending++;
      _server.close(() => { _server = null; done(); });
    }
    if (_httpsServer) {
      pending++;
      _httpsServer.close(() => { _httpsServer = null; done(); });
    }
    if (pending === 0) resolve();
  });
}

function isRunning() { return !!_server || !!_httpsServer; }

function getPort() {
  return parseInt(process.env.PROXY_PORT, 10) || 9100;
}

function getHttpsPort() {
  return parseInt(process.env.PROXY_HTTPS_PORT, 10) || (getPort() + 1);
}

function isHttpsRunning() { return !!_httpsServer; }

module.exports = { start, stop, isRunning, getPort, getHttpsPort, isHttpsRunning };
