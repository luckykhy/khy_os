'use strict';

/**
 * Contract tests for scripts/lib/modelTypeProviderPlan.js (pure leaf).
 * Run: node --test scripts/tests/modelTypeProviderPlan.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  planModelTypeProviders,
  classifyChannel,
  CANONICAL_TYPES,
  CHANNEL_LOCAL,
  CHANNEL_DIRECT,
  CHANNEL_RELAY,
  CHANNEL_UNKNOWN,
  STATUS_READY,
  STATUS_KEYLESS,
  STATUS_UNCONFIGURED,
  _hostOf,
  _isLoopback,
} = require('../lib/modelTypeProviderPlan');

const HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'];

// ── channel classification ──────────────────────────────────────────────
test('official vendor host → direct (直连)', () => {
  assert.strictEqual(classifyChannel('https://api.openai.com/v1', HOSTS, false), CHANNEL_DIRECT);
  assert.strictEqual(classifyChannel('https://api.anthropic.com', HOSTS, false), CHANNEL_DIRECT);
});

test('subdomain of an official host → direct', () => {
  assert.strictEqual(classifyChannel('https://gateway.api.openai.com/v1', HOSTS, false), CHANNEL_DIRECT);
});

test('arbitrary public host → relay (中转站)', () => {
  assert.strictEqual(classifyChannel('https://my-relay.example.com/v1', HOSTS, false), CHANNEL_RELAY);
  assert.strictEqual(classifyChannel('https://oneapi.somewhere.io', HOSTS, false), CHANNEL_RELAY);
});

test('loopback host → local', () => {
  assert.strictEqual(classifyChannel('http://localhost:11434', HOSTS, false), CHANNEL_LOCAL);
  assert.strictEqual(classifyChannel('http://127.0.0.1:8080/v1', HOSTS, false), CHANNEL_LOCAL);
});

test('explicit localHint → local even for a public-looking url', () => {
  assert.strictEqual(classifyChannel('http://ollama.internal/api', HOSTS, true), CHANNEL_LOCAL);
});

test('no base url → unknown (uses a default host)', () => {
  assert.strictEqual(classifyChannel('', HOSTS, false), CHANNEL_UNKNOWN);
});

test('bare host:port without scheme still classifies', () => {
  assert.strictEqual(classifyChannel('api.openai.com:443/v1', HOSTS, false), CHANNEL_DIRECT);
  assert.strictEqual(classifyChannel('127.0.0.1:1234', HOSTS, false), CHANNEL_LOCAL);
});

// ── per-type readiness ──────────────────────────────────────────────────
test('key + relay url → ready, channel relay', () => {
  const plan = planModelTypeProviders({
    officialHosts: HOSTS,
    types: { text: { baseUrl: 'https://relay.example.com/v1', hasKey: true, source: 'env' } },
  });
  const text = plan.types.find((t) => t.type === 'text');
  assert.strictEqual(text.configured, true);
  assert.strictEqual(text.status, STATUS_READY);
  assert.strictEqual(text.channel, CHANNEL_RELAY);
});

test('local backend needs no key → ready', () => {
  const plan = planModelTypeProviders({
    officialHosts: HOSTS,
    types: { vector: { baseUrl: 'http://localhost:11434/api/embeddings', hasKey: false, local: true } },
  });
  const vec = plan.types.find((t) => t.type === 'vector');
  assert.strictEqual(vec.configured, true);
  assert.strictEqual(vec.status, STATUS_READY);
  assert.strictEqual(vec.channel, CHANNEL_LOCAL);
});

test('base url but no key → keyless, not ready, missing api_key', () => {
  const plan = planModelTypeProviders({
    officialHosts: HOSTS,
    types: { video: { baseUrl: 'https://api.openai.com/v1', hasKey: false } },
  });
  const vid = plan.types.find((t) => t.type === 'video');
  assert.strictEqual(vid.configured, false);
  assert.strictEqual(vid.status, STATUS_KEYLESS);
  assert.deepStrictEqual(vid.missing, ['api_key']);
});

test('nothing supplied → unconfigured, missing key + url', () => {
  const plan = planModelTypeProviders({ officialHosts: HOSTS, types: {} });
  const role = plan.types.find((t) => t.type === 'role');
  assert.strictEqual(role.configured, false);
  assert.strictEqual(role.status, STATUS_UNCONFIGURED);
  assert.deepStrictEqual(role.missing, ['api_key', 'base_url']);
  assert.strictEqual(role.channel, CHANNEL_UNKNOWN);
});

// ── rollup ──────────────────────────────────────────────────────────────
test('all four canonical types always present in output', () => {
  const plan = planModelTypeProviders({});
  assert.strictEqual(plan.types.length, CANONICAL_TYPES.length);
  assert.deepStrictEqual(plan.types.map((t) => t.type).sort(), [...CANONICAL_TYPES].sort());
});

test('ok only when all four configured', () => {
  const full = {
    officialHosts: HOSTS,
    types: {
      text: { baseUrl: 'https://api.openai.com/v1', hasKey: true },
      video: { baseUrl: 'https://relay.example.com', hasKey: true },
      vector: { baseUrl: 'http://localhost:11434', local: true },
      role: { baseUrl: '', hasKey: true },
    },
  };
  const plan = planModelTypeProviders(full);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.configuredCount, 4);
  assert.deepStrictEqual(plan.unconfiguredTypes, []);
  assert.strictEqual(plan.byChannel.direct, 1);
  assert.strictEqual(plan.byChannel.relay, 1);
  assert.strictEqual(plan.byChannel.local, 1);
  assert.strictEqual(plan.byChannel.unknown, 1); // role: key, no base url
});

test('partial config → not ok, lists unconfigured types', () => {
  const plan = planModelTypeProviders({
    officialHosts: HOSTS,
    types: { text: { baseUrl: 'https://api.openai.com/v1', hasKey: true } },
  });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.configuredCount, 1);
  assert.deepStrictEqual(plan.unconfiguredTypes.sort(), ['role', 'vector', 'video']);
});

// ── never throws / degrades safely ──────────────────────────────────────
test('malformed facts never throw → all unconfigured', () => {
  for (const bad of [null, undefined, 42, 'nope', [], { types: 'no' }, { types: { text: 7 } }]) {
    let plan;
    assert.doesNotThrow(() => { plan = planModelTypeProviders(bad); });
    assert.strictEqual(plan.types.length, 4);
    assert.strictEqual(plan.ok, false);
    // never fabricates a ready verdict from garbage
    assert.ok(plan.types.every((t) => t.configured === false));
  }
});

test('malformed base url never throws in classifyChannel', () => {
  for (const bad of [null, undefined, 42, {}, 'http://', 'ht!tp://%%%']) {
    assert.doesNotThrow(() => classifyChannel(bad, HOSTS, false));
  }
});

test('_hostOf / _isLoopback helpers', () => {
  assert.strictEqual(_hostOf('https://API.OpenAI.com/v1'), 'api.openai.com');
  assert.strictEqual(_hostOf(''), '');
  assert.strictEqual(_isLoopback('localhost'), true);
  assert.strictEqual(_isLoopback('api.openai.com'), false);
});

test('non-array officialHosts is tolerated (→ relay for public host)', () => {
  const plan = planModelTypeProviders({
    officialHosts: 'not-an-array',
    types: { text: { baseUrl: 'https://api.openai.com/v1', hasKey: true } },
  });
  const text = plan.types.find((t) => t.type === 'text');
  // With no usable allowlist, a public host is conservatively a relay.
  assert.strictEqual(text.channel, CHANNEL_RELAY);
  assert.strictEqual(text.configured, true);
});
