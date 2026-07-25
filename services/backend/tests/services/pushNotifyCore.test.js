'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../../src/services/pushNotifyCore');

test('isEnabled: default-on, falsy-off', () => {
  assert.strictEqual(core.isEnabled({}), true);
  assert.strictEqual(core.isEnabled({ KHY_PUSH_NOTIFY: 'true' }), true);
  assert.strictEqual(core.isEnabled({ KHY_PUSH_NOTIFY: 'off' }), false);
  assert.strictEqual(core.isEnabled({ KHY_PUSH_NOTIFY: '0' }), false);
  assert.strictEqual(core.isEnabled({ KHY_PUSH_NOTIFY: 'no' }), false);
});

test('provider validation / normalization', () => {
  assert.ok(core.isValidProvider('ntfy'));
  assert.ok(core.isValidProvider('NTFY'));
  assert.ok(!core.isValidProvider('telegram'));
  assert.strictEqual(core.normalizeProvider(' Discord '), 'discord');
  assert.strictEqual(core.normalizeProvider('nope'), null);
});

test('normalizePriority: named + numeric, clamped 1..5, default 3', () => {
  assert.strictEqual(core.normalizePriority(undefined), 3);
  assert.strictEqual(core.normalizePriority('high'), 4);
  assert.strictEqual(core.normalizePriority('urgent'), 5);
  assert.strictEqual(core.normalizePriority('min'), 1);
  assert.strictEqual(core.normalizePriority(9), 5);
  assert.strictEqual(core.normalizePriority(0), 1);
  assert.strictEqual(core.normalizePriority('garbage'), 3);
});

test('maskTarget: never reveals full secret target', () => {
  assert.strictEqual(core.maskTarget(''), '(未配置)');
  // bare token
  const t = core.maskTarget('abcd1234567890');
  assert.ok(!t.includes('abcd1234567890'));
  assert.match(t, /abc…90（14 字）/);
  // URL: host kept, path/query masked
  const u = core.maskTarget('https://discord.com/api/webhooks/123/secrettoken');
  assert.ok(!u.includes('secrettoken'));
  assert.ok(u.startsWith('https://discord.com'));
  assert.match(u, /\*\*\*\*/);
  // host-only URL kept
  assert.strictEqual(core.maskTarget('https://ntfy.sh'), 'https://ntfy.sh');
});

test('buildPushRequest ntfy: topic -> URL, Title/Priority headers', () => {
  const r = core.buildPushRequest({ provider: 'ntfy', target: 'my-topic', title: 'Done', body: 'build ok', priority: 'high' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.url, 'https://ntfy.sh/my-topic');
  assert.strictEqual(r.request.method, 'POST');
  assert.strictEqual(r.request.headers.Title, 'Done');
  assert.strictEqual(r.request.headers.Priority, '4');
  assert.strictEqual(r.request.body, 'build ok');
  // full URL target preserved
  const r2 = core.buildPushRequest({ provider: 'ntfy', target: 'https://ntfy.example.com/t', title: 'x' });
  assert.strictEqual(r2.request.url, 'https://ntfy.example.com/t');
});

test('buildPushRequest bark: GET base/title/body with level', () => {
  const r = core.buildPushRequest({ provider: 'bark', target: 'devicekey', title: 'Hi there', body: 'b', priority: 'max' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.method, 'GET');
  assert.ok(r.request.url.startsWith('https://api.day.app/devicekey/Hi%20there/b'));
  assert.match(r.request.url, /level=critical/);
});

test('buildPushRequest discord/slack: JSON payload, require full URL', () => {
  const d = core.buildPushRequest({ provider: 'discord', target: 'https://discord.com/api/webhooks/1/2', title: 'T', body: 'B' });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(JSON.parse(d.request.body), { content: '**T**\nB' });
  // discord without full URL -> error
  assert.strictEqual(core.buildPushRequest({ provider: 'discord', target: 'notaurl', title: 'x' }).ok, false);

  const s = core.buildPushRequest({ provider: 'slack', target: 'https://hooks.slack.com/x', title: 'T' });
  assert.deepStrictEqual(JSON.parse(s.request.body), { text: '*T*' });
});

test('buildPushRequest generic webhook: structured JSON', () => {
  const r = core.buildPushRequest({ provider: 'webhook', target: 'https://example.com/hook', title: 'T', body: 'B', priority: 2 });
  assert.strictEqual(r.ok, true);
  const payload = JSON.parse(r.request.body);
  assert.strictEqual(payload.title, 'T');
  assert.strictEqual(payload.body, 'B');
  assert.strictEqual(payload.priority, 2);
  assert.strictEqual(payload.source, 'khy');
});

test('buildPushRequest: bad provider / empty target -> error', () => {
  assert.strictEqual(core.buildPushRequest({ provider: 'nope', target: 'x', title: 't' }).ok, false);
  assert.strictEqual(core.buildPushRequest({ provider: 'ntfy', target: '', title: 't' }).ok, false);
});

test('describeProviders / buildNotConfiguredHint', () => {
  const list = core.describeProviders();
  assert.ok(list.find((p) => p.id === 'ntfy'));
  assert.ok(list.every((p) => p.label && p.hint));
  assert.match(core.buildNotConfiguredHint(), /khy notify set/);
});

test('determinism: buildPushRequest stable', () => {
  const a = core.buildPushRequest({ provider: 'webhook', target: 'https://x.io/h', title: 'T', body: 'B', priority: 3 });
  const b = core.buildPushRequest({ provider: 'webhook', target: 'https://x.io/h', title: 'T', body: 'B', priority: 3 });
  assert.deepStrictEqual(a, b);
});
