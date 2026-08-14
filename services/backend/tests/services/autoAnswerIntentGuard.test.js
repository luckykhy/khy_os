'use strict';

/**
 * autoAnswerIntentGuard.test.js — 无人值守自动作答「不偏离本意」纯叶子
 * (goal 2026-07-11「…还有不会偏离用户的本意」)。
 *
 * 校准回原始本意:仅当某选项与「目标/原始诉求锚点」词法重叠**唯一严格更高**才改选;
 * 显式 (Recommended) 一律尊重;无锚点/无信号/门关 → 逐字节回退基线 index 0。零 IO 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../../src/services/autoAnswerIntentGuard');

describe('autoAnswerIntentGuard.isEnabled — default ON, only explicit falsy disables', () => {
  test('unset / empty → enabled', () => {
    assert.equal(guard.isEnabled({}), true);
    assert.equal(guard.isEnabled({ KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: '' }), true);
  });
  test('explicit falsy → disabled', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(guard.isEnabled({ KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: v }), false, v);
    }
  });
  test('truthy/other → enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'x']) {
      assert.equal(guard.isEnabled({ KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: v }), true, v);
    }
  });
  test('hostile env → conservative on, never throws', () => {
    const hostile = { get KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD() { throw new Error('boom'); } };
    assert.equal(guard.isEnabled(hostile), true);
  });
});

describe('autoAnswerIntentGuard._tokenize — latin words + CJK bigrams', () => {
  test('latin words ≥2 chars, lowercased', () => {
    const t = guard._tokenize('Use PostgreSQL DB v2');
    assert.ok(t.has('postgresql'));
    assert.ok(t.has('db'));
    assert.ok(t.has('v2'));
  });
  test('CJK → 2-char shingles', () => {
    const t = guard._tokenize('推送通知');
    assert.ok(t.has('推送'));
    assert.ok(t.has('送通'));
    assert.ok(t.has('通知'));
  });
  test('empty / null → empty set, never throws', () => {
    assert.equal(guard._tokenize('').size, 0);
    assert.equal(guard._tokenize(null).size, 0);
  });
});

describe('autoAnswerIntentGuard.buildIntentTokens — merge goal + anchors + message', () => {
  test('merges all sources', () => {
    const t = guard.buildIntentTokens({
      goalText: 'ship the postgres migration',
      intentAnchors: ['retry_budget', { text: 'faketcp' }],
      originalMessage: '不要偏离',
    });
    assert.ok(t.has('postgres'));
    assert.ok(t.has('retry_budget'.replace('_', '')) || t.has('retry') || t.has('budget'));
    assert.ok(t.has('faketcp'));
    assert.ok(t.has('不要') || t.has('要偏') || t.has('偏离'));
  });
  test('empty / bad ctx → empty set', () => {
    assert.equal(guard.buildIntentTokens(null).size, 0);
    assert.equal(guard.buildIntentTokens({}).size, 0);
  });
});

describe('autoAnswerIntentGuard.refineChoice — realign toward intent (fail-soft)', () => {
  const opts = [
    { label: 'sqlite', description: 'embedded zero-config' },
    { label: 'postgres', description: 'relational server' },
  ];

  test('disabled gate → baseline unchanged (byte-identical)', () => {
    const r = guard.refineChoice({
      options: opts,
      baselineChoice: opts[0],
      intentContext: { originalMessage: 'use postgres please' },
      env: { KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD: 'off' },
    });
    assert.equal(r.choice, opts[0]);
    assert.equal(r.realigned, false);
    assert.equal(r.reason, 'disabled');
  });

  test('intent clearly points at non-baseline option → realign', () => {
    const r = guard.refineChoice({
      options: opts,
      baselineChoice: opts[0], // sqlite (blind index-0)
      intentContext: { goalText: 'migrate the service to postgres' },
      env: {},
    });
    assert.equal(guard._optLabel(r.choice), 'postgres');
    assert.equal(r.realigned, true);
    assert.equal(r.reason, 'intent-aligned');
    assert.ok(r.chosenScore > r.baselineScore);
  });

  test('no anchor material → keep baseline', () => {
    const r = guard.refineChoice({ options: opts, baselineChoice: opts[0], intentContext: {}, env: {} });
    assert.equal(r.choice, opts[0]);
    assert.equal(r.realigned, false);
    assert.equal(r.reason, 'no-anchor');
  });

  test('no intent signal (message unrelated to any option) → keep baseline', () => {
    const r = guard.refineChoice({
      options: opts,
      baselineChoice: opts[0],
      intentContext: { originalMessage: 'please make it fast and reliable' },
      env: {},
    });
    assert.equal(r.choice, opts[0]);
    assert.equal(r.realigned, false);
    assert.equal(r.reason, 'no-intent-signal');
  });

  test('tie in overlap → keep baseline (no unique signal)', () => {
    const tied = [{ label: 'alpha redis' }, { label: 'beta redis' }];
    const r = guard.refineChoice({
      options: tied,
      baselineChoice: tied[0],
      intentContext: { goalText: 'use redis' },
      env: {},
    });
    assert.equal(r.choice, tied[0]);
    assert.equal(r.realigned, false);
  });

  test('explicit (Recommended) baseline → honored, never overridden', () => {
    const marked = [
      { label: 'sqlite (Recommended)', description: 'default' },
      { label: 'postgres', description: 'server' },
    ];
    const r = guard.refineChoice({
      options: marked,
      baselineChoice: marked[0],
      intentContext: { goalText: 'postgres postgres postgres' },
      env: {},
    });
    assert.equal(r.choice, marked[0]);
    assert.equal(r.realigned, false);
    assert.equal(r.reason, 'explicit-recommendation');
  });

  test('CJK intent realigns to matching CJK option', () => {
    const cjkOpts = [{ label: '完成推送' }, { label: '推送通知' }];
    const r = guard.refineChoice({
      options: cjkOpts,
      baselineChoice: cjkOpts[0],
      intentContext: { goalText: '我要推送通知功能' },
      env: {},
    });
    assert.equal(guard._optLabel(r.choice), '推送通知');
    assert.equal(r.realigned, true);
  });

  test('no options / null baseline → fail-soft', () => {
    assert.doesNotThrow(() => guard.refineChoice({ options: [], baselineChoice: null, intentContext: {}, env: {} }));
    assert.doesNotThrow(() => guard.refineChoice(null));
    assert.doesNotThrow(() => guard.refineChoice({}));
  });
});
