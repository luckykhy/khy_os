'use strict';

/**
 * preferredChannelPinning.test.js — retry must not spill into unselected channels.
 *
 * [EvoRequirement] 重试机制中的渠道选择错位: a user explicitly picked a non-trae
 * channel; after consecutive failures the cascade relaxed `strictPreferredOnly`
 * and re-walked the FULL adapter list (kiro→cursor→trae→…), calling trae — a
 * channel the user never selected — and burning retry budget on its HTTP 404.
 *
 * Root cause: `strictPreferredOnly` is a mutable flag the auto-relax / self-heal
 * machinery downgrades to false (pre-loop, on process/timeout/network failure,
 * on language mismatch). Once false, the per-iteration guard
 *   `if (strictPreferredOnly && entry.key !== preferredAdapter) continue;`
 * stops skipping unselected adapters, so the cascade reaches trae.
 *
 * Fix: a DURABLE `userPinned` signal (modelRouter) threaded as
 * `userPinnedAdapter` (proxyServer → gateway) that distinguishes "user explicitly
 * pinned this channel" from "strict because of an env default". When pinned, the
 * relax sites are suppressed so strict can never be downgraded — the cascade
 * skips every unselected adapter and the request fails within the chosen channel
 * with a clear cause. env-default strict KEEPS its auto-relax resilience (the
 * hard constraint: normal retry/cascade must not regress).
 *
 * These cases are the PRESERVED reproduction set + the invariants proving it
 * cannot regress.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { resolveModelRoute } = require('../../src/services/gateway/modelRouter');
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

const ENV_KEYS = [
  'GATEWAY_PREFERRED_ADAPTER', 'GATEWAY_PREFERRED_STRICT',
  'GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS', 'GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES',
];
let _saved;

describe('modelRouter — userPinned signal (explicit vs env-default)', () => {
  test('adapter-scoped model string (claude/sonnet) is user-pinned', () => {
    const r = resolveModelRoute({ model: 'claude/sonnet' });
    assert.equal(r.preferredAdapter, 'claude');
    assert.equal(r.userPinned, true);
    assert.equal(r.metadata.userPinned, true);
  });

  test('colon syntax (codex:gpt-5) is user-pinned', () => {
    const r = resolveModelRoute({ model: 'codex:gpt-5' });
    assert.equal(r.preferredAdapter, 'codex');
    assert.equal(r.userPinned, true);
  });

  test('caller forcing strictPreferred on a routed adapter is user-pinned', () => {
    const r = resolveModelRoute({ model: 'claude/sonnet', strictPreferred: true });
    assert.equal(r.userPinned, true);
  });

  test('an explicit strict route rule is user-pinned', () => {
    // BUILTIN_MODEL_ROUTE_MAP marks sensenova-u1-fast strict:true.
    const r = resolveModelRoute({ model: 'sensenova-u1-fast' });
    assert.equal(r.userPinned, true);
  });

  test('a plain model (no explicit selection) is NOT pinned — cascade stays flexible', () => {
    const r = resolveModelRoute({ model: 'gpt-4o' });
    assert.equal(r.userPinned, false);
    assert.equal(r.metadata.userPinned, false);
  });

  test('auto / no adapter is never pinned', () => {
    const r = resolveModelRoute({ model: '', defaultPreferredAdapter: 'auto' });
    assert.equal(r.userPinned, false);
  });
});

describe('aiGateway — pinned channel must not cascade into unselected adapters', () => {
  beforeEach(() => {
    _saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];
    // Clear accumulated failure / fast-fail / circuit state so it can't leak
    // across tests (a prior test's recorded failure would otherwise trip a
    // circuit breaker and skip the adapter, masking the real cascade behavior).
    if (gateway._adapterFailures) { for (const k of Object.keys(gateway._adapterFailures)) delete gateway._adapterFailures[k]; }
    if (gateway._adapterLastError) { for (const k of Object.keys(gateway._adapterLastError)) delete gateway._adapterLastError[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  test('pinned channel fails with HTTP 404 → trae (unselected) is NEVER called', async () => {
    const codex = mkAdapter('codex', async () => { const e = new Error('HTTP 404 not found'); e.statusCode = 404; throw e; });
    const trae = mkAdapter('trae', async () => ({ success: true, content: 'TRAE REPLY', provider: 'trae', adapter: 'trae', attempts: [] }));
    gateway._adapters = [codex, trae];

    const result = await gateway.generate('hi', {
      preferredAdapter: 'codex', strictPreferred: true, userPinnedAdapter: true, onChunk: () => {},
    });

    assert.equal(result.success, false, 'pinned channel failure must not be masked by a fallback success');
    assert.equal(codex._calls.n, 1, 'the pinned channel is tried');
    assert.equal(trae._calls.n, 0, 'the unselected trae channel must NOT be called');
    assert.match(String(result.content || ''), /404/, 'the real cause is surfaced to the user');
  });

  test('pinned channel with a PROCESS error also stays in-channel (no relax spill)', async () => {
    // process errors are exactly what relaxes strict for non-pinned requests.
    const codex = mkAdapter('codex', async () => { const e = new Error('spawn ENOENT: process crashed'); e.errorType = 'process'; throw e; });
    const trae = mkAdapter('trae', async () => ({ success: true, content: 'TRAE', provider: 'trae', adapter: 'trae', attempts: [] }));
    const relay = mkAdapter('relay_api', async () => ({ success: true, content: 'RELAY', provider: 'relay_api', adapter: 'relay_api', attempts: [] }));
    gateway._adapters = [codex, trae, relay];

    const result = await gateway.generate('hi', {
      preferredAdapter: 'codex', strictPreferred: true, userPinnedAdapter: true, onChunk: () => {},
    });

    assert.equal(result.success, false);
    assert.equal(codex._calls.n, 1);
    assert.equal(trae._calls.n, 0, 'trae must stay untouched under process-error relax pressure');
    assert.equal(relay._calls.n, 0, 'no other adapter is tried for a pinned channel');
  });

  test('pinning via explicit options (preferredAdapter + strictPreferred) also suppresses spill', async () => {
    // No userPinnedAdapter flag: the gateway derives the pin from an explicit
    // concrete preferredAdapter + strictPreferred === true.
    const claude = mkAdapter('claude', async () => { const e = new Error('connection timeout'); e.errorType = 'timeout'; throw e; });
    const trae = mkAdapter('trae', async () => ({ success: true, content: 'TRAE', provider: 'trae', adapter: 'trae', attempts: [] }));
    gateway._adapters = [claude, trae];

    const result = await gateway.generate('hi', {
      preferredAdapter: 'claude', strictPreferred: true, onChunk: () => {},
    });

    assert.equal(result.success, false);
    assert.equal(claude._calls.n, 1);
    assert.equal(trae._calls.n, 0, 'explicit pin via options must not spill to trae');
  });
});

describe('aiGateway — env-default strict KEEPS its auto-relax cascade (hard constraint)', () => {
  beforeEach(() => {
    _saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];
    if (gateway._adapterFailures) { for (const k of Object.keys(gateway._adapterFailures)) delete gateway._adapterFailures[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  test('env-default strict (NOT user-pinned) still relaxes on process failure and cascades', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = 'codex';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    const codex = mkAdapter('codex', async () => { const e = new Error('spawn ENOENT: process crashed'); e.errorType = 'process'; throw e; });
    const trae = mkAdapter('trae', async () => ({ success: true, content: 'TRAE FALLBACK', provider: 'trae', adapter: 'trae', attempts: [] }));
    gateway._adapters = [codex, trae];

    // No userPinnedAdapter, no explicit options.strictPreferred → env-default strict.
    const result = await gateway.generate('hi', { onChunk: () => {} });

    assert.equal(result.success, true, 'env-default strict must still fall back (resilience preserved)');
    assert.equal(codex._calls.n, 1, 'preferred is tried first');
    assert.equal(trae._calls.n, 1, 'cascade to the fallback still happens for env-default strict');
    assert.match(String(result.content || ''), /TRAE FALLBACK/);
  });
});

describe('aiGateway — GPT/OpenAI model hints prefer protocol-matched adapters', () => {
  beforeEach(() => {
    _saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];
    gateway._failoverOrderCache = null;
    gateway._cooldownSelfHealMeta = {};
    gateway._cooldownSelfHealInFlight = new Map();
    if (gateway._adapterFailures) { for (const k of Object.keys(gateway._adapterFailures)) delete gateway._adapterFailures[k]; }
    if (gateway._adapterLastError) { for (const k of Object.keys(gateway._adapterLastError)) delete gateway._adapterLastError[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  });

  test('plain gpt-4o tries api before claude when no adapter is pinned', async () => {
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'CLAUDE', provider: 'claude', adapter: 'claude', attempts: [] }));
    const api = mkAdapter('api', async () => ({ success: true, content: 'API', provider: 'api', adapter: 'api', attempts: [] }));
    gateway._adapters = [claude, api];

    const result = await gateway.generate('gpt api routing check', {
      model: 'gpt-4o',
      onChunk: () => {},
      _toolCapProbe: true,
    });

    assert.equal(result.success, true);
    assert.equal(api._calls.n, 1, 'OpenAI-compatible api should be the first attempted adapter');
    assert.equal(claude._calls.n, 0, 'Claude should not be attempted before a matching OpenAI path succeeds');
    assert.match(String(result.content || ''), /API/);
  });

  test('when api is unavailable, gpt-4o falls through to relay_api before claude', async () => {
    const claude = mkAdapter('claude', async () => ({ success: true, content: 'CLAUDE', provider: 'claude', adapter: 'claude', attempts: [] }));
    const api = mkAdapter('api', async () => ({ success: true, content: 'API', provider: 'api', adapter: 'api', attempts: [] }), { available: false });
    const relayApi = mkAdapter('relay_api', async () => ({ success: true, content: 'RELAY', provider: 'relay_api', adapter: 'relay_api', attempts: [] }));
    gateway._adapters = [claude, api, relayApi];

    const result = await gateway.generate('gpt relay fallback check', {
      model: 'gpt-4o',
      onChunk: () => {},
      _toolCapProbe: true,
    });

    assert.equal(result.success, true);
    assert.equal(api._calls.n, 0, 'Unavailable api should be skipped without a generate call');
    assert.equal(relayApi._calls.n, 1, 'relay_api should be attempted before a mismatched Claude fallback');
    assert.equal(claude._calls.n, 0, 'Claude should stay behind OpenAI-compatible fallbacks');
    assert.match(String(result.content || ''), /RELAY/);
  });
});
