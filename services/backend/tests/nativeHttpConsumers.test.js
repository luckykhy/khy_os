'use strict';

const http = require('http');
const { test, after } = require('node:test');
const assert = require('node:assert');

const { defaultPrimitives } = require('../src/services/workflow/workflowExecutor');
const { testConnectivity } = require('../src/services/gateway/providerConnectivityTester');

const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/fail/v1/chat/completions') {
      res.statusCode = 401;
      res.end('{"error":"fixture"}');
      return;
    }
    res.statusCode = 207;
    res.end('{"result":"fixture"}');
  });
});

server.listen(0, '127.0.0.1');
after(() => server.close());

function endpoint(path = '') {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

test('workflow HTTP primitive sends JSON and returns non-2xx data', async () => {
  const result = await defaultPrimitives().http({
    method: 'POST',
    url: endpoint('/workflow'),
    body: { prompt: 'fixture' },
  });
  assert.deepStrictEqual(result, { status: 207, data: { result: 'fixture' } });
  assert.deepStrictEqual(received.at(-1), {
    method: 'POST',
    url: '/workflow',
    body: '{"prompt":"fixture"}',
  });
});

test('provider connectivity classifies an HTTP response without throwing', async () => {
  const result = await testConnectivity({
    poolKey: 'relay',
    key: 'TOKEN',
    endpoint: endpoint('/fail'),
    model: 'fixture-model',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 401);
  assert.strictEqual(result.verdict, 'bad_key');
  assert.strictEqual(received.at(-1).body.includes('fixture-model'), true);
});
