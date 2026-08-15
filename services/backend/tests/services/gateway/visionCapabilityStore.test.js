'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('../../../src/services/gateway/visionCapabilityStore');

test('vision store: same model on different routes has isolated keys', () => {
  const a = store.makeRouteKey({ adapter: 'api', pool: 'stepfun', endpoint: 'https://a.example/v1', apiFormat: 'openai', model: 'step-3.7-flash', apiKey: 'KEY_A' });
  const b = store.makeRouteKey({ adapter: 'api', pool: 'stepfun', endpoint: 'https://b.example/v1', apiFormat: 'openai', model: 'step-3.7-flash', apiKey: 'KEY_A' });
  const c = store.makeRouteKey({ adapter: 'api', pool: 'stepfun', endpoint: 'https://a.example/v1', apiFormat: 'anthropic', model: 'step-3.7-flash', apiKey: 'KEY_A' });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('vision store: route key does not contain credential plaintext', () => {
  const secret = 'super-secret-token';
  const key = store.makeRouteKey({ model: 'step-3.7-flash', apiKey: secret });
  assert.ok(!key.includes(secret));
});

test('vision store: record and read a fresh verdict without leaking secret', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vision-store-')), 'vision.json');
  const previous = process.env.KHY_VISION_CAP_FILE;
  process.env.KHY_VISION_CAP_FILE = file;
  store.resetCache();
  const route = { adapter: 'api', pool: 'stepfun', endpoint: 'https://route.example/v1', apiFormat: 'openai', model: 'step-3.7-flash', apiKey: 'secret-value' };
  assert.strictEqual(store.recordVerdict(route, 'supported', { reason: 'test' }), true);
  assert.strictEqual(store.getVerdict(route), 'supported');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-value'));
  if (previous === undefined) delete process.env.KHY_VISION_CAP_FILE;
  else process.env.KHY_VISION_CAP_FILE = previous;
  store.resetCache();
});
