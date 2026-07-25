'use strict';

/**
 * relayDeadEndpointRelax.test.js — a dead HTTP relay endpoint must not lock out
 * every other channel under env-level strict routing.
 *
 * Reproduction: `khy config set model.base_url <trae>` used to pin
 *   GATEWAY_PREFERRED_ADAPTER=relay_api + GATEWAY_PREFERRED_STRICT=true.
 * When that endpoint is dead (HTTP 404 → the gateway classifier reports
 * `model_not_found`), strict made the cascade `continue` past EVERY other
 * adapter — including a healthy native GLM/Claude channel — so the whole turn
 * failed 404. `khy test` only probes connectivity (GET), never a real chat, so
 * it kept returning 200 while chat always 404'd.
 *
 * Fix (change A): for HTTP relay adapters (relay_api / api / relay) under
 * env-level strict (NOT a per-call user pin), a dead-endpoint error type
 * (model_not_found / unavailable / bad_request / server_error) relaxes strict
 * and lets the cascade fall back to a working channel. Gated by
 * KHY_RELAY_DEADENDPOINT_RELAX (default on). auth / rate_limit are deliberately
 * excluded — a live-but-throttled endpoint (e.g. GLM code 1302) must be retried
 * in place / key-rotated, never cascaded away.
 *
 * These cases are the preserved reproduction + the invariants proving the fix
 * cannot spill into the two protected regimes (user-pinned; live-but-throttled).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('../../src/services/gateway/aiGateway');

// Plain mock adapter entry (no jest): a closure-counted generate().
function mkAdapter(key, impl, opts = {}) {
  const calls = { n: 0, args: [] };
  const { available = true, enabled = true } = opts;
  return {
    key, enabled, available, priority: 1,
    adapter: {
      detect: () => available,
      getStatus: () => ({ name: key, available, detail: 'ok' }),
      generate: async (...a) => { calls.n++; calls.args.push(a); return impl(...a); },
    },
    _calls: calls,
  };
}

// A thrown HTTP error whose statusCode drives the gateway classifier.
function httpErr(statusCode, message) {
  const e = new Error(message || `HTTP ${statusCode}`);
  e.statusCode = statusCode;
  return e;
}

const ENV_KEYS = [
  'GATEWAY_PREFERRED_ADAPTER', 'GATEWAY_PREFERRED_STRICT',
  'GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS', 'GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES',
  'KHY_RELAY_DEADENDPOINT_RELAX',
  // Determinism knobs: no retry backoff (fast, single attempt) and no lingering
  // cooldown self-heal timers that would leak fast-fail state into later tests.
  'GATEWAY_POOL_MAX_RETRIES', 'GATEWAY_MAX_RETRY_DELAY_BUDGET_MS',
  'GATEWAY_COOLDOWN_SELF_HEAL_ENABLED',
];
let _saved;

function applyDeterminismEnv() {
  process.env.GATEWAY_POOL_MAX_RETRIES = '1';
  process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS = '0';
  process.env.GATEWAY_COOLDOWN_SELF_HEAL_ENABLED = 'false';
}

function resetGateway() {
  gateway._initialized = true;
  gateway._initPromise = null;
  gateway._adapters = [];
  gateway._failoverOrderCache = null;
  gateway._cooldownSelfHealMeta = {};
  gateway._cooldownSelfHealInFlight = new Map();
  // Drop any pending self-heal timers so a prior test cannot re-populate
  // _adapterLastError mid-run and skip a relay we expect to be tried.
  if (gateway._cooldownSelfHealMidpointTimers) {
    for (const t of gateway._cooldownSelfHealMidpointTimers.values?.() || []) { try { clearTimeout(t); } catch { /* noop */ } }
    gateway._cooldownSelfHealMidpointTimers = new Map();
  }
  if (gateway._cooldownSelfHealTimer) { try { clearInterval(gateway._cooldownSelfHealTimer); } catch { /* noop */ } gateway._cooldownSelfHealTimer = null; }
  if (gateway._adapterFailures) { for (const k of Object.keys(gateway._adapterFailures)) delete gateway._adapterFailures[k]; }
  if (gateway._adapterLastError) { for (const k of Object.keys(gateway._adapterLastError)) delete gateway._adapterLastError[k]; }
}

// Capture gateway status chunks so we can assert the relax notice fired.
function statusCollector() {
  const seen = [];
  return {
    seen,
    onChunk: (chunk) => { if (chunk && chunk.type === 'status' && chunk.text) seen.push(String(chunk.text)); },
  };
}

describe('aiGateway — dead relay endpoint relaxes env-level strict', () => {
  beforeEach(() => {
    _saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    applyDeterminismEnv();
    process.env.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    resetGateway();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  test('relay_api 404 (model_not_found) → relax, fall back to a healthy channel', async () => {
    const relay = mkAdapter('relay_api', async () => { throw httpErr(404, 'Request failed with status code 404'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'GLM FALLBACK', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const { seen, onChunk } = statusCollector();
    const result = await gateway.generate('relay-relax-404', { onChunk });

    assert.equal(result.success, true, 'a dead relay endpoint must not fail the whole turn');
    assert.ok(relay._calls.n >= 1, 'the preferred relay is tried');
    assert.equal(claude._calls.n, 1, 'the cascade falls back to the healthy channel');
    assert.match(String(result.content || ''), /GLM FALLBACK/);
    assert.ok(seen.some((s) => /临时放宽 strict/.test(s)), 'a relax notice is surfaced to the user');
  });

  test('relay_api 400 (bad_request) also relaxes and falls back', async () => {
    const relay = mkAdapter('relay_api', async () => { throw httpErr(400, 'HTTP 400 bad request'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('relay-relax-400', { onChunk: () => {} });
    assert.equal(result.success, true);
    assert.ok(relay._calls.n >= 1);
    assert.equal(claude._calls.n, 1);
  });

  test('relay_api 502 (server_error) also relaxes and falls back', async () => {
    const relay = mkAdapter('relay_api', async () => { throw httpErr(502, 'HTTP 502 bad gateway'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('relay-relax-502', { onChunk: () => {} });
    assert.equal(result.success, true);
    assert.ok(relay._calls.n >= 1);
    assert.equal(claude._calls.n, 1);
  });
});

describe('aiGateway — dead relay relax does NOT spill into protected regimes', () => {
  beforeEach(() => {
    _saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    applyDeterminismEnv();
    resetGateway();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  test('process-sensitive codex 404 does NOT relax via the relay branch (non-relay stays strict)', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    const codex = mkAdapter('codex', async () => { throw httpErr(404, 'Request failed with status code 404'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [codex, claude];

    const result = await gateway.generate('no-relax-codex-404', { onChunk: () => {} });
    assert.equal(result.success, false, 'codex is not an HTTP relay; a 404 must not relax strict');
    assert.ok(codex._calls.n >= 1);
    assert.equal(claude._calls.n, 0, 'no cascade for a non-relay strict adapter on a non-process error');
  });

  test('user-pinned relay_api 404 does NOT relax (explicit pin is honored)', async () => {
    const relay = mkAdapter('relay_api', async () => { throw httpErr(404, 'Request failed with status code 404'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('no-relax-pinned-404', {
      preferredAdapter: 'relay_api', strictPreferred: true, userPinnedAdapter: true, onChunk: () => {},
    });
    assert.equal(result.success, false, 'a per-call pinned channel must fail in-channel, not cascade');
    assert.ok(relay._calls.n >= 1);
    assert.equal(claude._calls.n, 0);
  });

  test('gate off (KHY_RELAY_DEADENDPOINT_RELAX=false) → 404 keeps old strict behavior (fails)', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    process.env.KHY_RELAY_DEADENDPOINT_RELAX = 'false';
    const relay = mkAdapter('relay_api', async () => { throw httpErr(404, 'Request failed with status code 404'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('no-relax-gateoff-404', { onChunk: () => {} });
    assert.equal(result.success, false, 'with the gate off the relax must not fire');
    assert.ok(relay._calls.n >= 1);
    assert.equal(claude._calls.n, 0);
  });

  test('relay_api 429 (rate_limit) does NOT relax — a live-but-throttled endpoint stays in-channel', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    const relay = mkAdapter('relay_api', async () => { throw httpErr(429, 'HTTP 429 too many requests'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('no-relax-429', { onChunk: () => {} });
    assert.equal(result.success, false, 'rate_limit must not cascade away — retry/key-rotate in place');
    assert.equal(claude._calls.n, 0);
  });

  test('relay_api 401 (auth) does NOT relax — an auth-rejected endpoint stays in-channel', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    const relay = mkAdapter('relay_api', async () => { throw httpErr(401, 'HTTP 401 unauthorized'); });
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'FB', provider: 'claude', adapter: 'claude', attempts: [] }));
    gateway._adapters = [relay, claude];

    const result = await gateway.generate('no-relax-401', { onChunk: () => {} });
    assert.equal(result.success, false, 'auth failure must not cascade away — fix the key');
    assert.equal(claude._calls.n, 0);
  });
});
