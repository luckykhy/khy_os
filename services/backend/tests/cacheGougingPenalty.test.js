'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the data dir BEFORE requiring anything that touches getDataDir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cache-gouge-'));
process.env.KHY_PROJECT_DATA_HOME = TMP;

const store = require('../src/services/gateway/cacheEconomyStore');
const gateway = require('../src/services/gateway/aiGateway');

function fakeEntry(key) {
  return {
    key,
    enabled: true,
    available: true,
    // No getRuntimeDiagnostics → no runtime penalties; clean baseline.
    adapter: { getStatus: () => ({ available: true, name: key }) },
  };
}

function seedGouging(key) {
  store._reset();
  for (let i = 0; i < 10; i += 1) {
    store.record(key, { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
  }
  assert.strictEqual(store.getVerdict(key), 'opaque_suspected_gouging');
}

test('gouging verdict adds a cache_gouging soft penalty, never blocks', () => {
  seedGouging('relay-gouge');
  const assessment = gateway._assessDefaultRouteCandidate(fakeEntry('relay-gouge'));
  assert.ok(assessment, 'assessment produced');
  assert.strictEqual(assessment.blocked, false, 'must remain a valid fallback (not blocked)');
  const reason = assessment.reasons.find((r) => r.code === 'cache_gouging');
  assert.ok(reason, 'cache_gouging reason present');
  assert.ok(reason.penalty > 0, 'penalty is positive');
  assert.ok(assessment.totalPenalty >= reason.penalty, 'totalPenalty includes the cache penalty');
});

test('clean (transparent) adapter gets no cache_gouging penalty and ranks above the gouger', () => {
  store._reset();
  // Gouger.
  for (let i = 0; i < 10; i += 1) {
    store.record('relay-gouge', { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
  }
  // Transparent.
  for (let i = 0; i < 10; i += 1) {
    store.record('relay-clean', {
      tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 800 },
      family: 'relay openai',
    });
  }

  const gouge = gateway._assessDefaultRouteCandidate(fakeEntry('relay-gouge'));
  const clean = gateway._assessDefaultRouteCandidate(fakeEntry('relay-clean'));

  assert.ok(!clean.reasons.find((r) => r.code === 'cache_gouging'), 'clean adapter has no cache penalty');
  // Same (unknown) base priority → the penalty alone decides; lower score wins.
  assert.ok(clean.score < gouge.score, 'transparent adapter ranks above the gouger');
});

test('GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY=0 disables the penalty', () => {
  seedGouging('relay-gouge');
  const prev = process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY;
  process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY = '0';
  try {
    const assessment = gateway._assessDefaultRouteCandidate(fakeEntry('relay-gouge'));
    assert.ok(!assessment.reasons.find((r) => r.code === 'cache_gouging'), 'penalty disabled at 0');
  } finally {
    if (prev === undefined) delete process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY;
    else process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY = prev;
  }
});

test.after(() => store._reset());
