'use strict';

/**
 * toolUseLoopIntentGuards.test.js — locks the C3-P4 extraction of the one-time
 * (pre-loop) intent/error/follow-through guard resolution out of runToolUseLoop
 * into services/domain/catalog/toolUseLoop/intentGuards.js.
 *
 * The god-file split must be behavior-preserving, so this pins the leaf's two
 * contract guarantees: (1) it populates the intent frame from the REAL
 * buildIntentAssuranceDirective when KHY_INTENT_COVERAGE is on, and (2) each
 * env gate independently collapses its own output to the byte-fallback default
 * (empty frame / empty signals / false) — plus fail-soft on a throwing provider.
 * The injected collaborators (extractErrorSignals / isFollowThroughGuardEnabled)
 * are stubbed here to assert pass-through wiring; their real behavior is covered
 * by the loop-level suites (toolUseLoopIntentCoverage / errorEnumerationGuard /
 * followThroughGuard).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntentGuards } = require('../../src/services/domain/catalog/toolUseLoop/intentGuards');
const { buildIntentAssuranceDirective } = require('../../src/services/khyUpgradeRuntime');

const NAMING_MSG = '帮我修复登录，另外确认一下 zzz_special_module.js 这个文件要不要动';
const baseDeps = () => ({
  originalUserMessage: NAMING_MSG,
  env: {},
  requireKhyUpgradeRuntime: () => ({ buildIntentAssuranceDirective }),
  extractErrorSignals: () => [],
  isFollowThroughGuardEnabled: () => false,
});

describe('resolveIntentGuards (C3-P4 leaf)', () => {
  test('coverage on (default) → intent frame populated from the real directive builder', () => {
    const out = resolveIntentGuards(baseDeps());
    assert.equal(out.intentCoverageEnabled, true);
    assert.ok(out.intentFrame.detailAnchors.includes('zzz_special_module.js'));
    assert.match(out.intentFrame.summary, /zzz_special_module\.js/);
  });

  test('KHY_INTENT_COVERAGE=0 → coverage off, frame stays the empty default (no provider call)', () => {
    let called = false;
    const deps = baseDeps();
    deps.env = { KHY_INTENT_COVERAGE: '0' };
    deps.requireKhyUpgradeRuntime = () => {
      called = true;
      return { buildIntentAssuranceDirective };
    };
    const out = resolveIntentGuards(deps);
    assert.equal(out.intentCoverageEnabled, false);
    assert.deepEqual(out.intentFrame, { detailAnchors: [], tailDetails: [], summary: '' });
    assert.equal(called, false, 'the lazy provider must NOT be required when coverage is off');
  });

  test('KHY_ERROR_ENUMERATION=0 → error gate off, signals stay empty (extractErrorSignals not called)', () => {
    let called = false;
    const deps = baseDeps();
    deps.env = { KHY_ERROR_ENUMERATION: 'off' };
    deps.extractErrorSignals = () => {
      called = true;
      return ['boom'];
    };
    const out = resolveIntentGuards(deps);
    assert.equal(out.errorEnumEnabled, false);
    assert.deepEqual(out.errorSignals, []);
    assert.equal(called, false);
  });

  test('error gate on → extractErrorSignals is called with the original message', () => {
    let seen = null;
    const deps = baseDeps();
    deps.extractErrorSignals = (msg) => {
      seen = msg;
      return ['ERR_500'];
    };
    const out = resolveIntentGuards(deps);
    assert.equal(out.errorEnumEnabled, true);
    assert.equal(seen, NAMING_MSG);
    assert.deepEqual(out.errorSignals, ['ERR_500']);
  });

  test('follow-through guard reflects the injected predicate against env', () => {
    const deps = baseDeps();
    deps.env = { KHY_FOLLOW_THROUGH_GUARD: '1' };
    deps.isFollowThroughGuardEnabled = (env) => env.KHY_FOLLOW_THROUGH_GUARD === '1';
    assert.equal(resolveIntentGuards(deps).followThroughEnabled, true);
  });

  test('fail-soft: a throwing intent provider leaves the frame empty and never throws', () => {
    const deps = baseDeps();
    deps.requireKhyUpgradeRuntime = () => {
      throw new Error('MODULE_NOT_FOUND');
    };
    assert.doesNotThrow(() => resolveIntentGuards(deps));
    assert.deepEqual(resolveIntentGuards(deps).intentFrame, {
      detailAnchors: [],
      tailDetails: [],
      summary: '',
    });
  });
});
