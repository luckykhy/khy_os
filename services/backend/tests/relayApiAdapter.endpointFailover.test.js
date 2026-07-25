'use strict';

/**
 * relayApiAdapter.endpointFailover.test.js — P1 of the IDE-channel stability fix.
 *
 * Live failure: RELAY_API_ENDPOINT pointed at a host that 404s every request, so
 * the cascade looped the same dead endpoint until the retry budget burned out with
 * no output. With RELAY_API_ENDPOINT_FALLBACKS configured, a *structural* endpoint
 * failure (404 / DNS / refused / 5xx) advances to the next candidate; auth / rate
 * limit / success do NOT (not the endpoint's fault), and the first success is sticky.
 *
 * Tests drive the orchestration through the `_impl.generateOnce` seam so no real
 * HTTP is involved.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const relay = require('../src/services/gateway/adapters/relayApiAdapter');

const ok = (ep) => ({ success: true, content: `from ${ep}`, _ep: ep });
const fail = (errorType) => ({ success: false, errorType, content: '', error: errorType });

describe('relay_api endpoint failover (P1)', () => {
  let saved;
  beforeEach(() => {
    saved = {
      endpoint: process.env.RELAY_API_ENDPOINT,
      fallbacks: process.env.RELAY_API_ENDPOINT_FALLBACKS,
      key: process.env.RELAY_API_KEY,
      impl: relay._impl.generateOnce,
    };
    process.env.RELAY_API_ENDPOINT = 'https://primary.example/v1';
    process.env.RELAY_API_KEY = 'sk-test';
    relay._resetEndpointState();
  });
  afterEach(() => {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('RELAY_API_ENDPOINT', saved.endpoint);
    restore('RELAY_API_ENDPOINT_FALLBACKS', saved.fallbacks);
    restore('RELAY_API_KEY', saved.key);
    relay._impl.generateOnce = saved.impl;
    relay._resetEndpointState();
  });

  test('candidate list = primary first, then fallbacks, deduped & trimmed', () => {
    process.env.RELAY_API_ENDPOINT_FALLBACKS = ' https://b.example/v1 , https://primary.example/v1 , https://c.example/v1 ';
    const list = relay._resolveEndpointCandidates(process.env.RELAY_API_ENDPOINT);
    assert.deepEqual(list, ['https://primary.example/v1', 'https://b.example/v1', 'https://c.example/v1']);
  });

  test('no fallbacks → single candidate, called exactly once (legacy parity)', async () => {
    delete process.env.RELAY_API_ENDPOINT_FALLBACKS;
    const seen = [];
    relay._impl.generateOnce = async (_p, o) => { seen.push(o._endpointOverride); return ok('primary'); };
    const r = await relay.generate('hi', {});
    assert.equal(r.success, true);
    assert.equal(seen.length, 1);
  });

  test('primary 404 (unavailable) → advances to the fallback and succeeds', async () => {
    process.env.RELAY_API_ENDPOINT_FALLBACKS = 'https://b.example/v1';
    const hit = [];
    relay._impl.generateOnce = async (_p, o) => {
      hit.push(o._endpointOverride);
      return o._endpointOverride.includes('primary') ? fail('unavailable') : ok('b');
    };
    const r = await relay.generate('hi', {});
    assert.equal(r.success, true);
    assert.match(r.content, /from b/);
    assert.deepEqual(hit, ['https://primary.example/v1', 'https://b.example/v1']);
  });

  test('auth failure does NOT failover — returns immediately on the first endpoint', async () => {
    process.env.RELAY_API_ENDPOINT_FALLBACKS = 'https://b.example/v1';
    const hit = [];
    relay._impl.generateOnce = async (_p, o) => { hit.push(o._endpointOverride); return fail('auth'); };
    const r = await relay.generate('hi', {});
    assert.equal(r.success, false);
    assert.equal(r.errorType, 'auth');
    assert.equal(hit.length, 1, 'auth is not an endpoint fault — no second candidate tried');
  });

  test('all endpoints structurally dead → returns the last failure, having tried every one', async () => {
    process.env.RELAY_API_ENDPOINT_FALLBACKS = 'https://b.example/v1,https://c.example/v1';
    const hit = [];
    relay._impl.generateOnce = async (_p, o) => { hit.push(o._endpointOverride); return fail('unavailable'); };
    const r = await relay.generate('hi', {});
    assert.equal(r.success, false);
    assert.equal(hit.length, 3);
  });

  test('a successful endpoint becomes sticky — the next call tries it first', async () => {
    process.env.RELAY_API_ENDPOINT_FALLBACKS = 'https://b.example/v1';
    let round = 0;
    const hit = [];
    relay._impl.generateOnce = async (_p, o) => {
      hit.push(o._endpointOverride);
      round += 1;
      // Round 1: primary dead, b good. Round 2: b should be tried first (sticky).
      if (o._endpointOverride.includes('primary')) return fail('unavailable');
      return ok('b');
    };
    await relay.generate('hi', {});
    hit.length = 0;
    await relay.generate('again', {});
    assert.equal(hit[0], 'https://b.example/v1', 'sticky endpoint is attempted first on the next call');
  });

  test('_isEndpointStructuralFailure: structural vs non-structural', () => {
    assert.equal(relay._isEndpointStructuralFailure('unavailable'), true);
    assert.equal(relay._isEndpointStructuralFailure('network'), true);
    assert.equal(relay._isEndpointStructuralFailure('server_error'), true);
    assert.equal(relay._isEndpointStructuralFailure('auth'), false);
    assert.equal(relay._isEndpointStructuralFailure('rate_limit'), false);
    assert.equal(relay._isEndpointStructuralFailure('cancelled'), false);
  });
});
