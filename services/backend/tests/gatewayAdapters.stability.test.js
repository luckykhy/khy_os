'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

function canBindLoopbackSync() {
  const probe = `
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => process.exit(1));
    server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', probe], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const describeWithLoopback = canBindLoopbackSync() ? describe : describe.skip;

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const address = server.address() || {};
      const isIpv6 = address.family === 'IPv6' || address.address === '::' || address.address === '::1';
      resolve({
        port: address.port,
        httpHost: isIpv6 ? '[::1]' : '127.0.0.1',
      });
    });
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

describeWithLoopback('gateway adapters stability', () => {
  afterEach(() => {
    delete process.env.RELAY_API_ENDPOINT;
    delete process.env.RELAY_API_KEY;
    delete process.env.RELAY_API_MODEL;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OLLAMA_AUTO_START;
    delete process.env.KHY_DATA_HOME;
    jest.restoreAllMocks();
  });

  test('api adapter forwards abortSignal to timeout wrapper and provider call', async () => {
    jest.resetModules();

    const fetchWithTimeout = jest.fn(async (fn, opts) => fn(opts.signal));
    const generateResponse = jest.fn(async (_prompt, opts) => ({
      success: true,
      content: 'ok',
      provider: opts.provider || 'openai',
      model: opts.model || 'gpt-4o-mini',
      attempts: [],
    }));
    const getAvailableProviders = jest.fn(() => [{
      key: 'openai',
      name: 'OpenAI',
      model: 'gpt-4o-mini',
      availableModels: [{ id: 'gpt-4o-mini' }],
    }]);
    const getStatus = jest.fn(() => ({
      available: true,
      configuredProviders: [{ key: 'openai' }],
      provider: 'openai',
    }));

    jest.doMock('../src/services/fetchTimeout', () => ({ fetchWithTimeout }));
    jest.doMock('../src/services/multiFreeService', () => {
      return jest.fn().mockImplementation(() => ({
        generateResponse,
        getAvailableProviders,
        getStatus,
      }));
    });

    const apiAdapter = require('../src/services/gateway/adapters/apiAdapter');
    const controller = new AbortController();

    const result = await apiAdapter.generate('hello', {
      model: 'openai:gpt-4o-mini',
      abortSignal: controller.signal,
    });

    expect(result.success).toBe(true);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeout.mock.calls[0][1].signal).toBe(controller.signal);
    expect(generateResponse).toHaveBeenCalledTimes(1);
    expect(generateResponse.mock.calls[0][1].signal).toBe(controller.signal);
    expect(generateResponse.mock.calls[0][1].provider).toBe('openai');
    expect(generateResponse.mock.calls[0][1].model).toBe('gpt-4o-mini');
  });

  test('api adapter records runtime diagnostics for failed provider results', async () => {
    jest.resetModules();

    const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-api-runtime-'));
    process.env.KHY_DATA_HOME = tempDataHome;

    jest.doMock('../src/services/fetchTimeout', () => ({
      fetchWithTimeout: jest.fn(async (fn, opts) => fn(opts.signal)),
    }));
    jest.doMock('../src/services/multiFreeService', () => {
      return jest.fn().mockImplementation(() => ({
        generateResponse: jest.fn(async () => ({
          success: false,
          error: 'provider timeout after 5000ms',
          errorType: 'timeout',
          provider: 'openai',
          model: 'gpt-4o-mini',
          attempts: [{ provider: 'openai', success: false, error: 'provider timeout after 5000ms', errorType: 'timeout' }],
        })),
        getAvailableProviders: jest.fn(() => [{
          key: 'openai',
          name: 'OpenAI',
          model: 'gpt-4o-mini',
          availableModels: [{ id: 'gpt-4o-mini' }],
        }]),
        getStatus: jest.fn(() => ({
          available: true,
          configuredProviders: [{ key: 'openai' }],
          provider: 'openai',
        })),
      }));
    });

    const apiAdapter = require('../src/services/gateway/adapters/apiAdapter');
    apiAdapter.destroy();

    const result = await apiAdapter.generate('hello', {
      model: 'openai:gpt-4o-mini',
      requestId: 'req-api-timeout-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('provider timeout after 5000ms');
    expect(apiAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
      adapterKey: 'api',
      requestId: 'req-api-timeout-1',
      trigger: 'request_timeout',
      category: 'stall',
      phase: 'response',
    });
  });

  test('relay api adapter aborts in-flight request on abortSignal', async () => {
    jest.resetModules();

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const delayed = setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: 'relay-test',
            choices: [{ message: { content: 'late response' } }],
          }));
        }, 1500);
        delayed.unref?.();
        req.on('close', () => clearTimeout(delayed));
        res.on('close', () => clearTimeout(delayed));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const { port, httpHost } = await listenOnRandomPort(server);
    process.env.RELAY_API_ENDPOINT = `http://${httpHost}:${port}/v1`;
    process.env.RELAY_API_KEY = 'relay-test-key';
    process.env.RELAY_API_MODEL = 'relay-test-model';

    const relayApiAdapter = require('../src/services/gateway/adapters/relayApiAdapter');
    relayApiAdapter.destroy();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort('user-cancelled'), 40);
    abortTimer.unref?.();

    const startedAt = Date.now();
    let result;
    try {
      result = await relayApiAdapter.generate('hello', {
        abortSignal: controller.signal,
        timeoutMs: 5000,
      });
    } finally {
      clearTimeout(abortTimer);
      await closeServer(server);
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(String(result.error || '').toLowerCase()).toContain('aborted');
    expect(elapsedMs).toBeLessThan(1200);
  });

  test('relay api adapter persists runtime diagnostics for HTTP failures', async () => {
    jest.resetModules();

    const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-relay-runtime-'));
    process.env.KHY_DATA_HOME = tempDataHome;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream relay unavailable' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'relay-test-model' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const { port, httpHost } = await listenOnRandomPort(server);
    process.env.RELAY_API_ENDPOINT = `http://${httpHost}:${port}/v1`;
    process.env.RELAY_API_KEY = 'relay-test-key';
    process.env.RELAY_API_MODEL = 'relay-test-model';

    let relayApiAdapter = require('../src/services/gateway/adapters/relayApiAdapter');
    relayApiAdapter.destroy();

    try {
      const result = await relayApiAdapter.generate('hello', {
        requestId: 'req-relay-http-1',
        timeoutMs: 3000,
        retryTotalAttempts: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('upstream relay unavailable');
      expect(relayApiAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        adapterKey: 'relay_api',
        requestId: 'req-relay-http-1',
        trigger: 'http_502',
        phase: 'response',
      });

      relayApiAdapter.destroy();
      jest.resetModules();
      relayApiAdapter = require('../src/services/gateway/adapters/relayApiAdapter');
      expect(relayApiAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        adapterKey: 'relay_api',
        requestId: 'req-relay-http-1',
        trigger: 'http_502',
        phase: 'response',
      });
    } finally {
      await closeServer(server);
    }
  });

  test('ollama adapter aborts in-flight request on abortSignal', async () => {
    jest.resetModules();

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const delayed = setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: { content: 'late response' },
            model: 'qwen3.5:4b',
          }));
        }, 1500);
        delayed.unref?.();
        req.on('close', () => clearTimeout(delayed));
        res.on('close', () => clearTimeout(delayed));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const { port, httpHost } = await listenOnRandomPort(server);
    process.env.OLLAMA_HOST = `http://${httpHost}:${port}`;
    process.env.OLLAMA_AUTO_START = 'false';
    process.env.OLLAMA_MODEL = 'qwen3.5:4b';

    const ollamaAdapter = require('../src/services/gateway/adapters/ollamaAdapter');
    ollamaAdapter.destroy();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort('user-cancelled'), 40);
    abortTimer.unref?.();

    const startedAt = Date.now();
    let result;
    try {
      result = await ollamaAdapter.generate('hello', {
        abortSignal: controller.signal,
        timeoutMs: 5000,
      });
    } finally {
      clearTimeout(abortTimer);
      await closeServer(server);
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('cancelled');
    expect(String(result.error || '').toLowerCase()).toContain('aborted');
    expect(elapsedMs).toBeLessThan(1200);
  });

  test('ollama adapter persists runtime diagnostics for HTTP failures', async () => {
    jest.resetModules();

    const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ollama-runtime-'));
    process.env.KHY_DATA_HOME = tempDataHome;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model backend warming up' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/generate') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'model backend warming up' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const { port, httpHost } = await listenOnRandomPort(server);
    process.env.OLLAMA_HOST = `http://${httpHost}:${port}`;
    process.env.OLLAMA_AUTO_START = 'false';
    process.env.OLLAMA_MODEL = 'qwen3.5:4b';

    let ollamaAdapter = require('../src/services/gateway/adapters/ollamaAdapter');
    ollamaAdapter.destroy();

    try {
      const result = await ollamaAdapter.generate('hello', {
        requestId: 'req-ollama-http-1',
        timeoutMs: 3000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 503: model backend warming up');
      expect(ollamaAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        adapterKey: 'ollama',
        requestId: 'req-ollama-http-1',
        trigger: 'http_503',
        phase: 'response',
      });

      ollamaAdapter.destroy();
      jest.resetModules();
      ollamaAdapter = require('../src/services/gateway/adapters/ollamaAdapter');
      expect(ollamaAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        adapterKey: 'ollama',
        requestId: 'req-ollama-http-1',
        trigger: 'http_503',
        phase: 'response',
      });
    } finally {
      await closeServer(server);
    }
  });

  test('codex adapter aborts in-flight request on abortSignal', async () => {
    jest.resetModules();

    const killMock = jest.fn();
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort('user-cancelled'), 40);
    abortTimer.unref?.();

    const startedAt = Date.now();
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        abortSignal: controller.signal,
        timeoutMs: 5000,
      });
    } finally {
      clearTimeout(abortTimer);
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('cancelled');
    expect(String(result.error || '').toLowerCase()).toContain('aborted');
    expect(killMock).toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(1200);
  });

  test('codex adapter fails fast when no subprocess output arrives before first-response timeout', async () => {
    jest.resetModules();

    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '40';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const killMock = jest.fn();
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    const startedAt = Date.now();
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        onChunk: (chunk) => chunks.push(chunk),
        timeoutMs: 3000,
      });
    } finally {
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(result.diagnostics).toMatchObject({
      stallFingerprint: 'no_subprocess_output',
    });
    expect(String(result.error || '').toLowerCase()).toContain('first response timeout');
    expect(String(result.error || '')).toContain('stall=no_subprocess_output');
    expect(String(result.error || '')).toContain('stage=spawned');
    expect(String(result.error || '')).toContain('last_event=process:spawn:codex spawned');
    expect(killMock).toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(1500);

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('Codex first response timeout'))).toBe(true);
  });

  test('codex adapter keeps first-response timeout armed for startup noise without model progress', async () => {
    jest.resetModules();

    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '60';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const killMock = jest.fn();
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't_1' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Reconnecting... 1/10 (stream disconnected)' })}\n`);
        child.stderr.write('WARNING: proceeding, even though we could not update PATH: Read-only file system (os error 30)\n');
        child.stderr.write('Reading prompt from stdin...\n');
      }, 5).unref?.();
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        onChunk: (chunk) => chunks.push(chunk),
        timeoutMs: 3000,
      });
    } finally {
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
    }

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(result.diagnostics).toMatchObject({
      stallFingerprint: 'turn_started_reconnect_loop',
    });
    expect(result.diagnostics.progressEvidence).toMatchObject({
      stallFingerprint: 'turn_started_reconnect_loop',
      turnStartedCount: 1,
      assistantMessageEvents: 0,
    });
    expect(String(result.error || '').toLowerCase()).toContain('first response timeout');
    expect(String(result.error || '').toLowerCase()).toContain('meaningful model progress');
    expect(String(result.error || '')).toContain('stall=turn_started_reconnect_loop');
    expect(String(result.error || '')).toContain('stage=turn_started');
    expect(String(result.error || '')).toContain('milestones=thread:');
    expect(String(result.error || '')).toContain('first_transport:');
    expect(String(result.error || '')).toContain('last_event=stderr:stderr:Reading prompt from stdin...');
    expect(String(result.error || '')).toContain('recent=process:spawn(codex spawned) -> stdout_json:thread.started');
    expect(String(result.error || '')).toContain('stdout_json:error(Reconnecting... 1/10 (stream disconnected))');
    expect(String(result.error || '')).toContain('stderr:stderr(WARNING: proceeding, even though we could not update PATH: Read-only file system (os error 30))');
    expect(String(result.error || '')).not.toContain('self_heal=');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalled();
    expect(codexAdapter.getRuntimeDiagnostics()).toMatchObject({
      healed: false,
      trigger: 'first_response_timeout',
    });
    expect(String(codexAdapter.getRuntimeDiagnostics().diagnosis || '')).toContain('stall=turn_started_reconnect_loop');

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('Codex 开始处理请求'))).toBe(true);
    expect(statusLines.some(s => s.includes('Reconnecting...'))).toBe(true);
    expect(statusLines.some(s => s.includes('Codex first response timeout'))).toBe(true);
    expect(statusLines.some(s => s.includes('stage=turn_started'))).toBe(true);
  });

  test('codex adapter early-bails on a genuine reconnect loop without burning the full first-response window', async () => {
    jest.resetModules();

    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    const oldBailThreshold = process.env.GATEWAY_CODEX_RECONNECT_BAIL_THRESHOLD;
    // Large first-response window: if the early bail does NOT fire, the request
    // would block ~5s. We assert it settles far below that.
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '5000';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';
    process.env.GATEWAY_CODEX_RECONNECT_BAIL_THRESHOLD = '3';

    const killMock = jest.fn();
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't_1' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
        // Three reconnect warnings → genuine loop, zero meaningful output.
        child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Reconnecting... 1/10 (stream disconnected)' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Reconnecting... 2/10 (stream disconnected)' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'error', message: 'Reconnecting... 3/10 (stream disconnected)' })}\n`);
      }, 5).unref?.();
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    const startedAt = Date.now();
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        onChunk: (chunk) => chunks.push(chunk),
        timeoutMs: 8000,
      });
    } finally {
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
      if (oldBailThreshold === undefined) delete process.env.GATEWAY_CODEX_RECONNECT_BAIL_THRESHOLD;
      else process.env.GATEWAY_CODEX_RECONNECT_BAIL_THRESHOLD = oldBailThreshold;
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(result.diagnostics).toMatchObject({
      stallFingerprint: 'turn_started_reconnect_loop',
    });
    // The whole point: settle well below the 5000ms first-response window.
    expect(elapsedMs).toBeLessThan(2500);
    expect(killMock).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('reconnect loop detected'))).toBe(true);
  });

  test('codex adapter settles first-response timeout even when child never emits close after kill', async () => {
    jest.resetModules();

    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '40';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const killMock = jest.fn(() => true);
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock;
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const startedAt = Date.now();
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        timeoutMs: 3000,
      });
    } finally {
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
    }

    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(String(result.error || '').toLowerCase()).toContain('first response timeout');
    expect(String(result.error || '')).toContain('stage=spawned');
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
    expect(elapsedMs).toBeLessThan(1500);
  });

  test('codex adapter persists first-response stall diagnostics for a later process', async () => {
    jest.resetModules();

    const oldDataHome = process.env.KHY_DATA_HOME;
    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-codex-runtime-'));
    process.env.KHY_DATA_HOME = tempDataHome;
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '40';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const killMock = jest.fn(() => true);
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock;
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    try {
      const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
      codexAdapter.__test__.clearPersistedRuntimeDiagnostics();
      codexAdapter.destroy();

      const result = await codexAdapter.generate('hello', {
        timeoutMs: 3000,
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('timeout');
      expect(killMock).toHaveBeenCalledWith('SIGTERM');

      codexAdapter.destroy();
      expect(codexAdapter.getRuntimeDiagnostics()).toEqual({
        adapterKey: 'codex',
        at: 0,
        requestId: '',
        healed: false,
        diagnosis: '',
        lastError: '',
        trigger: '',
        category: '',
        phase: '',
        summary: '',
      });

      jest.resetModules();
      const reloadedCodexAdapter = require('../src/services/gateway/adapters/codexAdapter');
      const persisted = reloadedCodexAdapter.getRuntimeDiagnostics({ includePersisted: true });
      const persistedState = reloadedCodexAdapter.__test__.readPersistedRuntimeDiagnosticsState();

      expect(persisted).toMatchObject({
        healed: false,
        trigger: 'first_response_timeout',
      });
      expect(Number(persisted.at)).toBeGreaterThan(0);
      expect(String(persisted.diagnosis || '')).toContain('stall=no_subprocess_output');
      expect(String(persisted.lastError || '').toLowerCase()).toContain('first response timeout');
      expect(persistedState.latestByTrigger.first_response_timeout).toMatchObject({
        trigger: 'first_response_timeout',
      });
      expect(persistedState.latestByCategory.stall).toMatchObject({
        trigger: 'first_response_timeout',
      });

      const persistedFile = reloadedCodexAdapter.__test__.getCodexRuntimeDiagnosticsFile();
      fs.writeFileSync(persistedFile, `${JSON.stringify({
        adapterKey: 'codex',
        latest: {
          at: Number(persisted.at) + 1000,
          healed: true,
          diagnosis: 'provider_fallback=openai',
          lastError: 'ERROR: Reconnecting... channel closed',
          trigger: 'provider_fallback_recovered',
          category: 'recovery',
        },
        latestByTrigger: {
          first_response_timeout: persistedState.latestByTrigger.first_response_timeout,
          provider_fallback_recovered: {
            at: Number(persisted.at) + 1000,
            healed: true,
            diagnosis: 'provider_fallback=openai',
            lastError: 'ERROR: Reconnecting... channel closed',
            trigger: 'provider_fallback_recovered',
            category: 'recovery',
          },
        },
        latestByCategory: {
          stall: persistedState.latestByCategory.stall,
          recovery: {
            at: Number(persisted.at) + 1000,
            healed: true,
            diagnosis: 'provider_fallback=openai',
            lastError: 'ERROR: Reconnecting... channel closed',
            trigger: 'provider_fallback_recovered',
            category: 'recovery',
          },
        },
      }, null, 2)}\n`, 'utf-8');

      expect(reloadedCodexAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        healed: true,
        trigger: 'provider_fallback_recovered',
      });
      expect(reloadedCodexAdapter.getRuntimeDiagnostics({
        includePersisted: true,
        preferTrigger: 'first_response_timeout',
      })).toMatchObject({
        healed: false,
        trigger: 'first_response_timeout',
      });
      expect(reloadedCodexAdapter.getRuntimeDiagnostics({
        includePersisted: true,
        preferCategory: 'stall',
      })).toMatchObject({
        healed: false,
        trigger: 'first_response_timeout',
      });

      reloadedCodexAdapter.__test__.clearPersistedRuntimeDiagnostics();
    } finally {
      if (oldDataHome === undefined) delete process.env.KHY_DATA_HOME;
      else process.env.KHY_DATA_HOME = oldDataHome;
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
      fs.rmSync(tempDataHome, { recursive: true, force: true });
    }
  });

  test('codex adapter surfaces temporary HOME hint on timeout', async () => {
    jest.resetModules();

    const oldHome = process.env.HOME;
    const oldFirstResponseTimeout = process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '40';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-codex-home-risk-'));
    process.env.HOME = tmpHome;

    const killMock = jest.fn();
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = killMock.mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    let result;
    try {
      result = await codexAdapter.generate('hello', {
        onChunk: (chunk) => chunks.push(chunk),
        timeoutMs: 3000,
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldFirstResponseTimeout === undefined) delete process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
      else process.env.GATEWAY_CODEX_FIRST_RESPONSE_TIMEOUT_MS = oldFirstResponseTimeout;
      if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
      else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;
    }

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');
    expect(String(result.error || '')).toContain('home_hint=temp_home:');
    expect(String(result.error || '')).toContain('codex_cli_temp_home_may_break_tls_or_helper_setup');
    expect(String(result.error || '')).toContain(tmpHome);
    expect(killMock).toHaveBeenCalled();

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('HOME=') && s.includes('临时目录'))).toBe(true);
  });

  test('codex adapter debug log records meaningful progress snapshot instead of unknown last_event', async () => {
    jest.resetModules();

    const oldDebugFile = process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE;
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy-codex-progress.log';

    const appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);

      setTimeout(() => {
        child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't_1' })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
        child.stdout.write(`${JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'message',
            content: [{ text: '已收到。' }],
          },
        })}\n`);
        child.emit('close', 0);
      }, 5).unref?.();

      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    let result;
    try {
      result = await codexAdapter.generate('hello', {
        timeoutMs: 3000,
      });
    } finally {
      if (oldDebugFile === undefined) delete process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE;
      else process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = oldDebugFile;
    }

    expect(result.success).toBe(true);
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp', { recursive: true });

    const debugLines = appendSpy.mock.calls
      .filter((call) => call[0] === '/tmp/khy-codex-progress.log')
      .map((call) => String(call[1] || ''));
    const meaningfulLine = debugLines.find((line) => line.includes('stage=meaningful_output'));
    expect(meaningfulLine).toBeTruthy();
    expect(meaningfulLine).toContain('furthest_stage=assistant_message');
    expect(meaningfulLine).toContain('last_event_kind=item.message.completed');
    expect(meaningfulLine).toContain('last_event_summary=已收到。');
    expect(meaningfulLine).toContain('meaningful_events=1');
    expect(meaningfulLine).toContain('reasoning_events=0');
    expect(meaningfulLine).toContain('tool_events=0');
    expect(meaningfulLine).toContain('progress=stall=meaningful_progress_seen');
  });

  test('codex direct mode inherits upstream system prompt when provided', () => {
    jest.resetModules();
    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    const inherited = [
      '# Language',
      'Use Chinese by default for all user-facing replies.',
      '',
      '# Project',
      'KHY instructions win.',
    ].join('\n');

    const built = codexAdapter.__test__.buildDirectSystemPrompt({ system: inherited });
    expect(built).toBe(inherited);
  });

  test('codex cli mode prepends compact KHY language priority directive to stdin prompt', async () => {
    jest.resetModules();

    const writes = [];
    const stdin = new PassThrough();
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = jest.fn((chunk, encoding, cb) => {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return originalWrite(chunk, encoding, cb);
    });

    const spawnSyncMock = jest.fn((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'exec' && args[1] === '--help') {
        return { status: 0, error: null, stdout: 'help', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, error: null, stdout: 'codex 1.0.0', stderr: '' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    });

    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = stdin;
      child.kill = jest.fn(() => true);
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: 'message', text: 'final answer' })}\n`);
        child.emit('close', 0);
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync: spawnSyncMock,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const result = await codexAdapter.generate('USER: 你好', {
      system: '# Language\nUse Chinese by default for all user-facing replies.',
      timeoutMs: 3000,
    });

    expect(result.success).toBe(true);
    const fullPrompt = writes.join('');
    expect(fullPrompt).toContain('[KHY PRIORITY DIRECTIVE]');
    expect(fullPrompt).toContain('default to Chinese for user-facing replies');
    expect(fullPrompt).toContain('USER: 你好');
  });

  test('codex cli prompt compacts structured conversation instead of forwarding full flattened prompt', () => {
    jest.resetModules();
    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    const giantRaw = [
      'SYSTEM: very long flattened prompt that should not be forwarded verbatim.',
      'Assistant: previous answer',
      'User: latest request',
      'X'.repeat(6000),
    ].join('\n');
    const system = [
      '# Language',
      'Use Chinese by default for all user-facing replies.',
      '',
      '# 轻量对话',
      '保持回答简洁，先给结果再补充必要说明。',
    ].join('\n');

    const built = codexAdapter.__test__.buildCliPrompt(giantRaw, {
      system,
      messages: [
        { role: 'user', content: '先前问题：请检查配置' },
        { role: 'assistant', content: '已经检查过配置。' },
        { role: 'user', content: '当前请求：只用一句中文回复：已收到，不要调用工具。' },
      ],
    });

    expect(built).toContain('[KHY PRIORITY DIRECTIVE]');
    expect(built).toContain('# Recent Conversation');
    expect(built).toContain('当前请求：只用一句中文回复：已收到，不要调用工具。');
    expect(built).not.toContain('SYSTEM: very long flattened prompt that should not be forwarded verbatim.');
    expect(built.length).toBeLessThan(3500);
  });

  test('codex reconnect failure triggers self-heal and diagnostic status', async () => {
    jest.resetModules();

    const oldSandbox = process.env.GATEWAY_CODEX_SANDBOX;
    const oldAutoHeal = process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT;
    process.env.GATEWAY_CODEX_SANDBOX = 'workspace-write';
    process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT = 'true';

    const spawnSync = jest.fn((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'exec' && args[1] === '--help') {
        return { status: 0, error: null, stdout: 'help', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, error: null, stdout: 'codex 1.0.0', stderr: '' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    });

    const spawn = jest.fn((_cmd, _args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);
      setImmediate(() => {
        child.stderr.write('ERROR: Reconnecting... channel closed');
        child.emit('close', 1);
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    const result = await codexAdapter.generate('hello', {
      onChunk: (chunk) => chunks.push(chunk),
      timeoutMs: 2000,
    });
    const healedSandbox = process.env.GATEWAY_CODEX_SANDBOX;
    const runtimeDiag = codexAdapter.getRuntimeDiagnostics();

    if (oldSandbox === undefined) delete process.env.GATEWAY_CODEX_SANDBOX;
    else process.env.GATEWAY_CODEX_SANDBOX = oldSandbox;
    if (oldAutoHeal === undefined) delete process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT;
    else process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT = oldAutoHeal;

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('network');
    expect(healedSandbox).toBe('none');
    expect(process.env.GATEWAY_CODEX_SANDBOX).toBe(oldSandbox === undefined ? undefined : oldSandbox);
    expect(String(result.error || '')).toContain('self_heal=mode_none');
    expect(String(result.error || '')).toContain('diagnosis=');
    expect(Number(runtimeDiag.at)).toBeGreaterThan(0);
    expect(runtimeDiag.healed).toBe(true);
    expect(runtimeDiag.trigger).toBe('reconnect');
    expect(String(runtimeDiag.lastError || '').toLowerCase()).toContain('reconnecting');
    expect(String(runtimeDiag.diagnosis || '')).toContain('exec_probe=ok');

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('Codex 通道异常'))).toBe(true);
    expect(statusLines.some(s => s.includes('Codex 自愈'))).toBe(true);
    expect(statusLines.some(s => s.includes('Codex 自检'))).toBe(true);

    codexAdapter.destroy();
    expect(codexAdapter.getRuntimeDiagnostics()).toEqual({
      adapterKey: 'codex',
      at: 0,
      requestId: '',
      healed: false,
      diagnosis: '',
      lastError: '',
      trigger: '',
      category: '',
      phase: '',
      summary: '',
    });
  });

  test('codex reconnect emits self-heal retry status before failing', async () => {
    jest.resetModules();

    const oldSandbox = process.env.GATEWAY_CODEX_SANDBOX;
    const oldAutoHeal = process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT;
    const oldJson = process.env.GATEWAY_CODEX_JSON;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    process.env.GATEWAY_CODEX_SANDBOX = 'workspace-write';
    process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT = 'true';
    process.env.GATEWAY_CODEX_JSON = 'false';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'false';

    const spawnSync = jest.fn((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'exec' && args[1] === '--help') {
        return { status: 0, error: null, stdout: 'help', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, error: null, stdout: 'codex 1.0.0', stderr: '' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    });

    const spawn = jest.fn((_cmd, args = []) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);

      setImmediate(() => {
        child.stderr.write('ERROR: Reconnecting... channel closed');
        child.emit('close', 1);
      });

      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    const result = await codexAdapter.generate('hello', {
      onChunk: (chunk) => chunks.push(chunk),
      timeoutMs: 2000,
    });

    const spawnArgs = spawn.mock.calls.map(c => c[1] || []);

    if (oldSandbox === undefined) delete process.env.GATEWAY_CODEX_SANDBOX;
    else process.env.GATEWAY_CODEX_SANDBOX = oldSandbox;
    if (oldAutoHeal === undefined) delete process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT;
    else process.env.GATEWAY_CODEX_AUTO_DISABLE_SANDBOX_ON_RECONNECT = oldAutoHeal;
    if (oldJson === undefined) delete process.env.GATEWAY_CODEX_JSON;
    else process.env.GATEWAY_CODEX_JSON = oldJson;
    if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('network');
    expect(spawnArgs.length).toBeGreaterThanOrEqual(3);
    expect(spawnArgs[0].includes('--sandbox')).toBe(true);
    expect(spawnArgs[1].includes('--sandbox')).toBe(false);
    expect(spawnArgs.some((a, idx) => idx >= 2 && !a.includes('--sandbox'))).toBe(true);

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('Codex 自愈后重试中'))).toBe(true);
    expect(statusLines.some(s => s.includes('Codex 自检'))).toBe(true);
  });

  test('codex custom provider transport failure falls back to openai provider', async () => {
    jest.resetModules();

    const oldHome = process.env.HOME;
    const oldJson = process.env.GATEWAY_CODEX_JSON;
    const oldFallbackEnabled = process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;

    process.env.GATEWAY_CODEX_JSON = 'false';
    process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = 'true';

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-codex-home-'));
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), [
      'model = "gpt-5.3-codex-review"',
      'model_provider = "proxy"',
      '',
      '[model_providers.proxy]',
      'base_url = "https://proxy.example.com/v1"',
      '',
    ].join('\n'), 'utf-8');
    process.env.HOME = tmpHome;

    const spawnSync = jest.fn((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'exec' && args[1] === '--help') {
        return { status: 0, error: null, stdout: 'help', stderr: '' };
      }
      if (Array.isArray(args) && args.includes('--version')) {
        return { status: 0, error: null, stdout: 'codex 1.0.0', stderr: '' };
      }
      return { status: 0, error: null, stdout: '', stderr: '' };
    });

    const spawn = jest.fn((_cmd, args = []) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);

      const isOpenAIFallback = args.includes('model_provider="openai"');
      setImmediate(() => {
        if (isOpenAIFallback) {
          child.stdout.write('fallback success');
          child.emit('close', 0);
          return;
        }
        child.stderr.write('ERROR: Reconnecting... channel closed');
        child.emit('close', 1);
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();

    const chunks = [];
    const result = await codexAdapter.generate('hello', {
      onChunk: (chunk) => chunks.push(chunk),
      timeoutMs: 2000,
    });

    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldJson === undefined) delete process.env.GATEWAY_CODEX_JSON;
    else process.env.GATEWAY_CODEX_JSON = oldJson;
    if (oldFallbackEnabled === undefined) delete process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED;
    else process.env.GATEWAY_CODEX_OPENAI_FALLBACK_ENABLED = oldFallbackEnabled;

    expect(result.success).toBe(true);
    expect(String(result.provider || '')).toContain('openai-fallback');
    expect(String(result.content || '')).toContain('fallback success');

    const spawnArgs = spawn.mock.calls.map(c => c[1] || []);
    expect(spawnArgs.length).toBeGreaterThanOrEqual(2);
    expect(spawnArgs[0].includes('model_provider="openai"')).toBe(false);
    expect(spawnArgs.some(a => a.includes('model_provider="openai"'))).toBe(true);

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('尝试回退 OpenAI provider'))).toBe(true);
    expect(statusLines.some(s => s.includes('provider 回退成功'))).toBe(true);
  });

  test('cli tool adapter emits retry status when switching to next tool', async () => {
    jest.resetModules();

    const spawnSync = jest.fn((cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') {
        if (cmd === 'claude' || cmd === 'codex') return { status: 0, error: null };
        return { status: 1, error: new Error('missing') };
      }
      return { status: 1, error: new Error('unsupported') };
    });

    const spawn = jest.fn((cmd) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);

      if (cmd === 'claude') {
        setImmediate(() => {
          child.stderr.write('exit 1');
          child.emit('close', 1);
        });
        return child;
      }
      if (cmd === 'codex') {
        setImmediate(() => {
          child.stdout.write('codex ok');
          child.emit('close', 0);
        });
        return child;
      }

      setImmediate(() => child.emit('close', 1));
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const cliToolAdapter = require('../src/services/gateway/adapters/cliToolAdapter');
    cliToolAdapter.destroy();

    const chunks = [];
    const result = await cliToolAdapter.generate('hello', {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('Codex');
    expect(String(result.content || '')).toContain('codex ok');

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));

    expect(statusLines.some(s => s.includes('Launching Claude Code'))).toBe(true);
    expect(statusLines.some(s => s.includes('CLI 工具桥接重试中'))).toBe(true);
    expect(statusLines.some(s => s.includes('切换到 Codex'))).toBe(true);
    expect(statusLines.some(s => s.includes('Launching Codex'))).toBe(true);
  });

  test('cli tool adapter classifies generic "canceled" as process (not user-cancel)', async () => {
    jest.resetModules();

    const spawnSync = jest.fn((cmd, args) => {
      if (Array.isArray(args) && args[0] === '--version') {
        if (cmd === 'claude') return { status: 0, error: null };
      }
      return { status: 1, error: new Error('missing') };
    });

    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);
      setImmediate(() => {
        child.stderr.write('canceled');
        child.emit('close', 1);
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const cliToolAdapter = require('../src/services/gateway/adapters/cliToolAdapter');
    cliToolAdapter.destroy();

    const result = await cliToolAdapter.generate('hello');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('process');
    expect(String(result.error || '').toLowerCase()).toContain('canceled');
  });

  test('local llm adapter classifies generic "canceled" as process (not user-cancel)', async () => {
    jest.resetModules();

    jest.doMock('../src/services/localLLMService', () => ({
      isModelAvailable: jest.fn(() => true),
      ensureLoaded: jest.fn(async () => {}),
      generate: jest.fn(async () => { throw new Error('canceled'); }),
      getStatus: jest.fn(() => ({
        backend: 'node-llama-cpp',
        available: true,
        loaded: true,
        modelPath: '/tmp/model.gguf',
      })),
      dispose: jest.fn(),
    }));

    const localLLMAdapter = require('../src/services/gateway/adapters/localLLMAdapter');
    localLLMAdapter.destroy();
    const result = await localLLMAdapter.generate('hello');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('process');
    expect(String(result.error || '').toLowerCase()).toContain('canceled');
  });

  test('ollama adapter classifies generic "canceled" as process (not user-cancel)', async () => {
    jest.resetModules();

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'canceled' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const { port, httpHost } = await listenOnRandomPort(server);
    process.env.OLLAMA_HOST = `http://${httpHost}:${port}`;
    process.env.OLLAMA_AUTO_START = 'false';
    process.env.OLLAMA_MODEL = 'qwen3.5:4b';

    const ollamaAdapter = require('../src/services/gateway/adapters/ollamaAdapter');
    ollamaAdapter.destroy();

    let result;
    try {
      result = await ollamaAdapter.generate('hello', { timeoutMs: 3000 });
    } finally {
      await closeServer(server);
    }

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('process');
    expect(String(result.error || '').toLowerCase()).toContain('canceled');
  });

  test('codex adapter classifies generic "canceled" as process (not user-cancel)', async () => {
    jest.resetModules();

    const spawnSync = jest.fn((_cmd, _args) => ({ status: 0, error: null }));
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);
      setImmediate(() => {
        child.stderr.write('canceled');
        child.emit('close', 1);
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(),
      spawn,
      spawnSync,
    }));

    const codexAdapter = require('../src/services/gateway/adapters/codexAdapter');
    codexAdapter.destroy();
    const result = await codexAdapter.generate('hello', { timeoutMs: 3000 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('process');
    expect(String(result.error || '').toLowerCase()).toContain('canceled');
  });
});
