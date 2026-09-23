'use strict';

/**
 * toolUseLoopBudgets.test.js — locks the C3-P6 extraction of the pre-loop
 * iteration/elapsed budget resolution out of runToolUseLoop into
 * services/domain/catalog/toolUseLoop/budgets.js.
 *
 * The split is behavior-preserving, so this pins the leaf's contract:
 *   (1) explicit requestedMaxIterations → that resolved value (floored by
 *       dynamicMinSafe), NO boost and NOT capped at 200;
 *   (2) no explicit → boost-sum capped at 200, then floored by dynamicMinSafe;
 *   (3) transientRecoveryMax / maxElapsedMs are pure pass-through of the injected
 *       resolvers; the gateway / intentGate thunks are the only module loaders and
 *       the gateway require is conditional (fail-soft) + absent-context-window only.
 * The four resolver functions are stubbed to assert wiring; the real env/config
 * behavior they encode is covered by the pre-existing loop-level suites.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveLoopBudgets } = require('../../src/services/domain/catalog/toolUseLoop/budgets');

// Default stubs: resolvers return distinguishable constants so the arithmetic in
// the leaf is easy to verify by hand.
const baseDeps = (over = {}) => ({
  chatOpts: { contextWindowTokens: 200000 },
  requestedMaxIterations: undefined,
  originalUserMessage: 'do the thing',
  options: {},
  gatedInput: { activatedModes: [] },
  harnessProfile: { maxIterationsBoost: 0 },
  resolveMaxIterations: () => 50,
  resolveTransientRecoveryMax: () => 3,
  resolveMinSafeIterations: () => 10,
  resolveMaxElapsedMs: () => 60000,
  requireGateway: () => ({ getModelContextWindow: () => 0 }),
  requireIntentGate: () => ({ getLoopLimitBoost: () => ({ outerBoost: 0 }) }),
  ...over,
});

describe('resolveLoopBudgets (C3-P6 leaf)', () => {
  test('explicit requestedMaxIterations → resolved value, no boost, no 200-cap', () => {
    const out = resolveLoopBudgets(
      baseDeps({
        requestedMaxIterations: 500,
        resolveMaxIterations: () => 500,
        resolveMinSafeIterations: () => 10,
      })
    );
    // hasExplicit → max(minSafe=10, resolved=500) = 500 (cap does not apply)
    assert.equal(out.effectiveMaxIterations, 500);
  });

  test('no explicit → boost-sum (resolved+outerBoost+transient+harness) applied', () => {
    const out = resolveLoopBudgets(
      baseDeps({
        resolveMaxIterations: () => 40,
        resolveTransientRecoveryMax: () => 4,
        harnessProfile: { maxIterationsBoost: 6 },
        requireIntentGate: () => ({ getLoopLimitBoost: () => ({ outerBoost: 18 }) }),
        resolveMinSafeIterations: () => 10,
      })
    );
    // no explicit → min(200, 40+18+4+6)=68 ; max(10,68)=68
    assert.equal(out.effectiveMaxIterations, 68);
  });

  test('no explicit and sum > 200 → capped at 200', () => {
    const out = resolveLoopBudgets(
      baseDeps({
        resolveMaxIterations: () => 250,
        resolveTransientRecoveryMax: () => 0,
        requireIntentGate: () => ({ getLoopLimitBoost: () => ({ outerBoost: 0 }) }),
        resolveMinSafeIterations: () => 10,
      })
    );
    assert.equal(out.effectiveMaxIterations, 200);
  });

  test('dynamicMinSafe floor wins over a small boost-sum', () => {
    const out = resolveLoopBudgets(
      baseDeps({
        resolveMaxIterations: () => 5,
        resolveTransientRecoveryMax: () => 0,
        resolveMinSafeIterations: () => 60,
      })
    );
    // max(60, min(200, 5)) = 60
    assert.equal(out.effectiveMaxIterations, 60);
  });

  test('transientRecoveryMax + maxElapsedMs are pure pass-through', () => {
    const out = resolveLoopBudgets(
      baseDeps({
        resolveTransientRecoveryMax: () => 7,
        resolveMaxElapsedMs: () => 99999,
      })
    );
    assert.equal(out.transientRecoveryMax, 7);
    assert.equal(out.maxElapsedMs, 99999);
  });

  test('context window present in chatOpts → gateway NOT required', () => {
    let called = false;
    resolveLoopBudgets(
      baseDeps({
        chatOpts: { contextWindowTokens: 128000 },
        requireGateway: () => {
          called = true;
          return {};
        },
      })
    );
    assert.equal(called, false, 'gateway loader must not run when chatOpts carries the window');
  });

  test('context window absent + preferredModel → gateway queried; throwing loader is fail-soft', () => {
    let queried = 0;
    const out = resolveLoopBudgets(
      baseDeps({
        chatOpts: { preferredModel: 'gpt-x' },
        requireGateway: () => {
          throw new Error('MODULE_NOT_FOUND');
        },
        resolveMinSafeIterations: (cw) => {
          queried = cw;
          return 10;
        },
      })
    );
    // fail-soft: window stays 0 → dynamicMinSafe receives 0
    assert.equal(queried, 0);
    // no explicit → min(200, resolved 50 + boost 0 + transient 3 + harness 0)=53 ; max(10,53)=53
    assert.equal(out.effectiveMaxIterations, 53);
  });
});
