'use strict';

/**
 * adaptiveParamStrip.test.js — 自适应采样参数剥离策略叶子的行为契约。
 *
 * 覆盖:
 *   - detectUnsupportedParams:有「不支持」信号 + 参数在报文里被点名且确实发出 → 剥离;
 *     无信号 → 空;参数未发出 → 不剥;中文措辞;结构性字段永不进白名单。
 *   - planParamStrip:门关 → {enabled:false, strip:[]};alreadyStripped 过滤使循环收敛;
 *     门开且无信号 → 空。
 *   - isEnabled:default-on 语义(unset/''/未知值 → true;0/false/off/no → false)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../../../src/services/gateway/adapters/adaptiveParamStrip');

describe('adaptiveParamStrip.isEnabled (default-on gate)', () => {
  test('unset / empty / unknown value → enabled', () => {
    assert.equal(mod.isEnabled({}), true);
    assert.equal(mod.isEnabled({ KHY_ADAPTIVE_PARAM_STRIP: '' }), true);
    assert.equal(mod.isEnabled({ KHY_ADAPTIVE_PARAM_STRIP: 'on' }), true);
    assert.equal(mod.isEnabled({ KHY_ADAPTIVE_PARAM_STRIP: '1' }), true);
  });

  test('falsy values (0/false/off/no, case/space-insensitive) → disabled', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(mod.isEnabled({ KHY_ADAPTIVE_PARAM_STRIP: v }), false, `value=${JSON.stringify(v)}`);
    }
  });
});

describe('adaptiveParamStrip.detectUnsupportedParams', () => {
  test('unsupported-signal + named param present in body → strip that param', () => {
    const body = { model: 'm', messages: [], reasoning_effort: 'high', temperature: 0.7 };
    const out = mod.detectUnsupportedParams("Unsupported parameter: 'reasoning_effort'", body);
    assert.deepEqual(out, ['reasoning_effort']);
  });

  test('no unsupported-signal in text → [] even if a param name appears', () => {
    const body = { model: 'm', temperature: 0.7 };
    // A generic 400 that merely mentions "temperature" but carries no unsupported signal.
    const out = mod.detectUnsupportedParams('temperature must be a number', body);
    assert.deepEqual(out, []);
  });

  test('named param NOT present in body → not stripped', () => {
    const body = { model: 'm', messages: [] };
    const out = mod.detectUnsupportedParams("unsupported parameter 'top_p'", body);
    assert.deepEqual(out, []);
  });

  test('Chinese unsupported wording (不支持/参数错误) is recognized', () => {
    const body = { model: 'm', top_p: 0.9 };
    assert.deepEqual(mod.detectUnsupportedParams('不支持的参数: top_p', body), ['top_p']);
    assert.deepEqual(mod.detectUnsupportedParams('参数错误 top_p', body), ['top_p']);
  });

  test('multiple offending params in one error → all stripped', () => {
    const body = { model: 'm', temperature: 0.7, top_p: 0.9, seed: 1 };
    const out = mod.detectUnsupportedParams('unsupported parameter: temperature, top_p', body);
    assert.deepEqual(out.sort(), ['temperature', 'top_p']);
  });

  test('never strips structural/required fields (model/messages/max_tokens/stream)', () => {
    const body = { model: 'm', messages: [], max_tokens: 100, stream: true, input: 'x' };
    // Even if the error text mentions them, they are not on the whitelist.
    const out = mod.detectUnsupportedParams('unsupported parameter: model, messages, max_tokens, stream, input', body);
    assert.deepEqual(out, []);
    for (const forbidden of ['model', 'messages', 'input', 'stream', 'max_tokens']) {
      assert.ok(!mod._STRIPPABLE_PARAMS.includes(forbidden), `${forbidden} must not be strippable`);
    }
  });

  test('non-object / empty error → [] (fail-soft, never throws)', () => {
    assert.deepEqual(mod.detectUnsupportedParams('unsupported parameter x', null), []);
    assert.deepEqual(mod.detectUnsupportedParams('', { temperature: 1 }), []);
    assert.deepEqual(mod.detectUnsupportedParams(null, { temperature: 1 }), []);
  });
});

describe('adaptiveParamStrip.planParamStrip', () => {
  test('gate off → {enabled:false, strip:[]} (byte-revert path)', () => {
    const body = { model: 'm', reasoning_effort: 'high' };
    const plan = mod.planParamStrip("unsupported parameter 'reasoning_effort'", body, {
      env: { KHY_ADAPTIVE_PARAM_STRIP: 'off' },
    });
    assert.deepEqual(plan, { enabled: false, strip: [] });
  });

  test('gate on + detected → {enabled:true, strip:[param]}', () => {
    const body = { model: 'm', response_format: { type: 'json_object' } };
    const plan = mod.planParamStrip("unsupported parameter 'response_format'", body, { env: {} });
    assert.deepEqual(plan, { enabled: true, strip: ['response_format'] });
  });

  test('alreadyStripped filters converge the retry loop', () => {
    const body = { model: 'm', temperature: 0.7, top_p: 0.9 };
    const already = new Set(['temperature']);
    const plan = mod.planParamStrip('unsupported parameter: temperature, top_p', body, {
      alreadyStripped: already,
      env: {},
    });
    assert.deepEqual(plan.strip, ['top_p']);
  });

  test('gate on but no unsupported-signal → strip empty', () => {
    const body = { model: 'm', temperature: 0.7 };
    const plan = mod.planParamStrip('rate limit exceeded', body, { env: {} });
    assert.deepEqual(plan, { enabled: true, strip: [] });
  });
});
