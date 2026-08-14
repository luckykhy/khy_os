'use strict';

/**
 * betaFallbackNotice.test.js — beta 降级提示纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：门控开关、已知 beta 友好名、context-1m 预算告警、未知 token 透传、
 * 空/坏输入→null、去重、绝不抛。所有事实由参数传入——叶子零 IO。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  betaFallbackNoticeEnabled,
  buildBetaFallbackNotice,
  BETA_LABELS,
} = require('../../src/cli/betaFallbackNotice');

describe('betaFallbackNotice.betaFallbackNoticeEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(betaFallbackNoticeEnabled({}), true);
    assert.equal(betaFallbackNoticeEnabled(), true);
  });
  test('off values disable', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(betaFallbackNoticeEnabled({ KHY_BETA_FALLBACK_NOTICE: v }), false);
    }
  });
  test('unknown value stays on', () => {
    assert.equal(betaFallbackNoticeEnabled({ KHY_BETA_FALLBACK_NOTICE: 'yes' }), true);
  });
});

describe('betaFallbackNotice.buildBetaFallbackNotice', () => {
  test('context-1m → friendly name + 200k budget caveat', () => {
    const n = buildBetaFallbackNotice(['context-1m']);
    assert.ok(n && n.includes('1M 长上下文'));
    assert.ok(n.includes('200k'));
    assert.ok(n.includes('已自动禁用并重试'));
  });

  test('interleaved-thinking → friendly name, no 200k caveat', () => {
    const n = buildBetaFallbackNotice(['interleaved-thinking']);
    assert.ok(n && n.includes('交错思考'));
    assert.doesNotMatch(n, /200k/);
  });

  test('both betas → both friendly names joined, budget caveat present', () => {
    const n = buildBetaFallbackNotice(['context-1m', 'interleaved-thinking']);
    assert.ok(n.includes('1M 长上下文'));
    assert.ok(n.includes('交错思考'));
    assert.ok(n.includes('200k'));
  });

  test('unknown beta token passes through verbatim', () => {
    const n = buildBetaFallbackNotice(['some-future-beta']);
    assert.ok(n && n.includes('some-future-beta'));
  });

  test('deduplicates and normalizes case', () => {
    const n = buildBetaFallbackNotice(['Context-1M', 'context-1m']);
    // 友好名只出现一次。
    assert.equal(n.split('1M 长上下文').length - 1, 1);
  });

  test('gate off → null (byte-identical fallback: no notice)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(buildBetaFallbackNotice(['context-1m'], { KHY_BETA_FALLBACK_NOTICE: v }), null);
    }
  });

  test('empty / non-array / junk entries → null', () => {
    assert.equal(buildBetaFallbackNotice([]), null);
    assert.equal(buildBetaFallbackNotice(null), null);
    assert.equal(buildBetaFallbackNotice(undefined), null);
    assert.equal(buildBetaFallbackNotice('context-1m'), null); // string, not array
    assert.equal(buildBetaFallbackNotice([null, '', '   ', 42]), null);
  });

  test('never throws on hostile input', () => {
    assert.doesNotThrow(() => buildBetaFallbackNotice([{}, [], Symbol('x')]));
    assert.equal(buildBetaFallbackNotice([{}, []]), null);
  });

  test('BETA_LABELS covers the two known optional betas', () => {
    assert.equal(BETA_LABELS['context-1m'], '1M 长上下文');
    assert.equal(BETA_LABELS['interleaved-thinking'], '交错思考');
  });
});
