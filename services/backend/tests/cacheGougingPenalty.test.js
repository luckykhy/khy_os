'use strict';
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
    // No getRuntimeDiagnostics â†?no runtime penalties; clean baseline.
    adapter: { getStatus: () => ({ available: true, name: key }) },
  };
}
function seedGouging(key) {
  store._reset();
  for (let i = 0; i < 10; i += 1) {
    store.record(key, { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
  }
  expect(store.getVerdict(key)).toBe('opaque_suspected_gouging');
}
test.after(() => store._reset());

describe('Cache Gouging Penalty', () => {
  test('gouging verdict adds a cache_gouging soft penalty, never blocks', () => {
      seedGouging('relay-gouge');
      const assessment = gateway._assessDefaultRouteCandidate(fakeEntry('relay-gouge'));
      expect(assessment).toBeTruthy();
      expect(assessment.blocked).toBe(false, 'must remain a valid fallback (not blocked)');
      const reason = assessment.reasons.find((r) => r.code === 'cache_gouging');
      expect(reason).toBeTruthy();
      expect(reason.penalty > 0).toBeTruthy();
      expect(assessment.totalPenalty >= reason.penalty).toBeTruthy();
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
    
      expect(!clean.reasons.find((r) => r.code === 'cache_gouging')).toBe();
      // Same (unknown) base priority â†?the penalty alone decides; lower score wins.
      expect(clean.score < gouge.score).toBeTruthy();
  });

  test('GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY=0 disables the penalty', () => {
      seedGouging('relay-gouge');
      const prev = process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY;
      process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY = '0';
      try {
        const assessment = gateway._assessDefaultRouteCandidate(fakeEntry('relay-gouge'));
        expect(!assessment.reasons.find((r) => r.code === 'cache_gouging')).toBe();
      } finally {
        if (prev === undefined) delete process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY;
        else process.env.GATEWAY_DEFAULT_ROUTE_CACHE_GOUGING_PENALTY = prev;
      }
  });

});

