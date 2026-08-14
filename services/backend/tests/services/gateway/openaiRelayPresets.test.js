'use strict';

/**
 * openaiRelayPresets.test.js — locks the codex/OpenAI opt-in relay preset behavior.
 *
 * Mirrors anthropicRelayPresets.test.js. The table ships EMPTY by default (no
 * third-party OpenAI relay endpoint is bundled) — but the lookup/list contract and
 * the "never carries a token" invariant must hold so future entries stay safe.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  RELAY_PRESETS,
  listRelayPresetNames,
  listRelayPresets,
  getRelayPreset,
} = require('../../../src/services/gateway/adapters/openaiRelayPresets');

const {
  planCodexEnvAdoption,
} = require('../../../src/services/gateway/adapters/codexEnvAdoptPolicy');

test('默认表为空(不捆绑任何第三方 openai 中转端点)', () => {
  assert.deepStrictEqual(listRelayPresetNames(), []);
  assert.deepStrictEqual(listRelayPresets(), []);
});

test('未知/空预设 → null', () => {
  assert.strictEqual(getRelayPreset('nope'), null);
  assert.strictEqual(getRelayPreset(''), null);
  assert.strictEqual(getRelayPreset(null), null);
  assert.strictEqual(getRelayPreset(undefined), null);
});

test('RELAY_PRESETS 冻结,不可篡改', () => {
  assert.ok(Object.isFrozen(RELAY_PRESETS));
});

test('任何(未来)预设都绝不携带 token 类字段', () => {
  // Contract holds vacuously today; enforce it for any future addition.
  for (const p of listRelayPresets()) {
    assert.strictEqual('token' in p, false);
    assert.strictEqual('apiKey' in p, false);
    assert.strictEqual('authToken' in p, false);
    assert.ok(typeof p.baseUrl === 'string' && p.baseUrl.length > 0);
  }
});

test('preset defaults 与 planCodexEnvAdoption 协作:端点填补,凭据仍来自 env', () => {
  // Simulate a hypothetical preset's non-secret defaults flowing into the policy.
  const plan = planCodexEnvAdoption(
    { CODEX_API_KEY: 'sk-x-abcdef' },
    { baseUrl: 'https://hypothetical.relay/v1', model: 'gpt-5-codex' }
  );
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.endpoint, 'https://hypothetical.relay/v1');
  // 无 key 时端点不是凭据 → ok:false。
  const noKey = planCodexEnvAdoption({}, { baseUrl: 'https://hypothetical.relay/v1' });
  assert.strictEqual(noKey.ok, false);
  assert.strictEqual(noKey.reason, 'no-credential');
});
