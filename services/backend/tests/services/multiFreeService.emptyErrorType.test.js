'use strict';

/**
 * multiFreeService.emptyErrorType.test.js — 「Empty response (cooldown 12s)」修复。
 *
 * An empty HTTP-200 reply means the channel is HEALTHY but the model produced no
 * text (a weak-model blip, common right after a tool call). aiGateway deliberately
 * excludes `empty` from the transient-cooldown map; but multiFreeService pushed the
 * empty attempt with NO errorType, so aiGateway.classifyError fell through to
 * `unknown` — which DOES carry a ~20s cross-request cooldown, forcing 5-6 re-asks.
 *
 * Fix: tag empty replies `errorType:'empty'` at BOTH the attempt level (drives the
 * displayed "真实失败原因") AND the top-level all-empty return (drives recordFailureEarly's
 * cooldown decision, which reads rawResult.errorType first).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const MultiFreeService = require('../../src/services/multiFreeService');
const gateway = require('../../src/services/gateway/aiGateway');

function serviceReturningEmpty() {
  const svc = new MultiFreeService();
  // One healthy provider that returns an empty body.
  svc.getAvailableProviders = () => [{ key: 'fake', name: 'fake', model: 'm', priority: 1, enabled: true }];
  svc.callProvider = async () => ({ content: '' });
  return svc;
}

describe('multiFree tags empty replies as errorType:empty', () => {
  test('the per-provider attempt carries errorType:empty', async () => {
    const svc = serviceReturningEmpty();
    const res = await svc.generateResponse('hi', {});
    assert.equal(res.success, false);
    assert.ok(Array.isArray(res.attempts) && res.attempts.length >= 1);
    assert.ok(res.attempts.every((a) => a.success === false && a.errorType === 'empty'),
      'every empty attempt must be tagged errorType:empty');
  });

  test('the all-empty top-level return carries errorType:empty (drives cooldown decision)', async () => {
    const svc = serviceReturningEmpty();
    const res = await svc.generateResponse('hi', {});
    assert.equal(res.errorType, 'empty');
    assert.equal(res.error, 'Empty response');
  });

  test('the tag is load-bearing: without it, classifyError would have cooled the channel as unknown', () => {
    // Documents WHY the explicit tag matters — the raw message alone classifies to
    // `unknown` (which carries a cooldown). recordFailureEarly reads rawResult.errorType
    // FIRST, so the explicit `empty` tag wins and skips the cooldown.
    assert.equal(gateway.classifyError(0, 'Empty response'), 'unknown');
  });
});
