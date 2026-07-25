/**
 * Unit tests for createAiProxy factory function.
 */
const http = require('http');
const express = require('express');
const axios = require('axios');

// -- Helpers: spin up a mock AI backend and proxy server --

function createMockAiBackend(handler) {
  const app = express();
  app.use(express.json());
  app.use(handler);
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function createProxyApp(aiBackendUrl, timeout = 5000) {
  const app = express();
  app.use(express.json());

  // Inline the createAiProxy logic (same as server.js)
  function createAiProxy({ timeout: t = 30000 } = {}) {
    return async (req, res) => {
      try {
        const url = `${aiBackendUrl}${req.originalUrl}`;
        const { host, connection, ...forwardHeaders } = req.headers;
        const resp = await axios({
          method: req.method,
          url,
          data: req.body,
          headers: forwardHeaders,
          timeout: t,
          validateStatus: () => true,
          responseType: 'stream',
        });
        res.status(resp.status);
        const skipHeaders = new Set(['transfer-encoding', 'connection']);
        for (const [key, value] of Object.entries(resp.headers)) {
          if (!skipHeaders.has(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }
        resp.data.pipe(res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(503).json({ error: 'AI backend unavailable', detail: err.message });
        }
      }
    };
  }

  app.use('/api/ai', createAiProxy({ timeout }));
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('createAiProxy', () => {
  let mockBackend, proxy;
  const localHost = '127.0.0.1';
  const closedPort = 1;

  afterEach(async () => {
    if (mockBackend?.server) mockBackend.server.close();
    if (proxy?.server) proxy.server.close();
  });

  test('proxies JSON response with correct status', async () => {
    mockBackend = await createMockAiBackend((req, res) => {
      res.status(200).json({ result: 'hello from AI' });
    });
    proxy = await createProxyApp(mockBackend.url);

    const resp = await axios.get(`${proxy.url}/api/ai/chat`);
    expect(resp.status).toBe(200);
    expect(resp.data).toEqual({ result: 'hello from AI' });
  });

  test('proxies non-200 status codes', async () => {
    mockBackend = await createMockAiBackend((req, res) => {
      res.status(422).json({ error: 'bad input' });
    });
    proxy = await createProxyApp(mockBackend.url);

    const resp = await axios.get(`${proxy.url}/api/ai/analyze`, { validateStatus: () => true });
    expect(resp.status).toBe(422);
    expect(resp.data.error).toBe('bad input');
  });

  test('does not forward host or connection headers', async () => {
    let receivedHeaders = {};
    mockBackend = await createMockAiBackend((req, res) => {
      receivedHeaders = req.headers;
      res.status(200).json({ ok: true });
    });
    proxy = await createProxyApp(mockBackend.url);

    await axios.get(`${proxy.url}/api/ai/test`, {
      headers: { 'x-custom': 'keep-me', connection: 'keep-alive' },
    });

    expect(receivedHeaders['x-custom']).toBe('keep-me');
    // host should be the mock backend's host, not the original
    expect(receivedHeaders.host).toBe(`127.0.0.1:${mockBackend.port}`);
  });

  test('returns 503 when AI backend is unreachable', async () => {
    // Point to a closed port
    proxy = await createProxyApp(`http://${localHost}:${closedPort}`, 1000);

    const resp = await axios.get(`${proxy.url}/api/ai/down`, { validateStatus: () => true });
    expect(resp.status).toBe(503);
    expect(resp.data.error).toBe('AI backend unavailable');
  });

  test('streams SSE response correctly', async () => {
    mockBackend = await createMockAiBackend((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write('data: chunk1\n\n');
      res.write('data: chunk2\n\n');
      res.end();
    });
    proxy = await createProxyApp(mockBackend.url);

    const resp = await axios.get(`${proxy.url}/api/ai/stream`, { responseType: 'text' });
    expect(resp.headers['content-type']).toContain('text/event-stream');
    expect(resp.data).toContain('data: chunk1');
    expect(resp.data).toContain('data: chunk2');
  });
});
