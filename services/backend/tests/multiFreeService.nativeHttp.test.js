'use strict';

const http = require('http');
const { test, after } = require('node:test');
const assert = require('node:assert');

const MultiFreeService = require('../src/services/multiFreeService');

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.end('data: [DONE]\n\n'), 5);
  });
});
server.listen(0, '127.0.0.1');
after(() => server.close());

test('multi-provider HTTP seam returns a real stream', async () => {
  const url = `http://127.0.0.1:${server.address().port}/stream`;
  const response = await MultiFreeService.httpClient.post(url, { stream: true }, {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'stream',
    timeout: 1000,
  });
  let text = '';
  for await (const chunk of response.data) text += chunk;
  assert.strictEqual(response.status, 200);
  assert.match(text, /hello/);
  assert.match(text, /\[DONE\]/);
});
