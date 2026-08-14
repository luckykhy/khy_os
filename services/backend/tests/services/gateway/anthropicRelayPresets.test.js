'use strict';

/**
 * anthropicRelayPresets.test.js — locks the opt-in relay preset behavior.
 *
 * A preset ships a NON-SECRET base URL (+ default model) inside the package. It is
 * activated explicitly per machine (`khy claude use-relay <name>`); it is never an
 * active global default and never carries a token. Combined with planCcEnvAdoption's
 * `defaults`, the preset fills only the endpoint/model the env lacks — env always wins.
 *
 * 承 [[project_claude_adapter_bearer_auth_scheme_relay_reuse]].
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  RELAY_PRESETS,
  listRelayPresetNames,
  listRelayPresets,
  getRelayPreset,
} = require('../../../src/services/gateway/adapters/anthropicRelayPresets');

const {
  planCcEnvAdoption,
} = require('../../../src/services/gateway/adapters/ccEnvAdoptPolicy');

test('mindflow 预设存在,携非机密端点/默认模型,绝不含 token', () => {
  const p = getRelayPreset('mindflow');
  assert.ok(p);
  assert.strictEqual(p.baseUrl, 'https://ai.mindflow.com.cn');
  assert.strictEqual(p.model, 'claude-opus-4-8');
  assert.ok(p.label);
  // A preset must never expose a token-like field.
  assert.strictEqual('token' in p, false);
  assert.strictEqual('authToken' in p, false);
  assert.strictEqual('apiKey' in p, false);
});

test('getRelayPreset 大小写不敏感 + trim', () => {
  assert.strictEqual(getRelayPreset('  MindFlow  ').baseUrl, 'https://ai.mindflow.com.cn');
  assert.strictEqual(getRelayPreset('MINDFLOW').baseUrl, 'https://ai.mindflow.com.cn');
});

test('未知/空预设 → null', () => {
  assert.strictEqual(getRelayPreset('nope'), null);
  assert.strictEqual(getRelayPreset(''), null);
  assert.strictEqual(getRelayPreset(null), null);
  assert.strictEqual(getRelayPreset(undefined), null);
});

test('list 接口一致,均含 mindflow', () => {
  assert.ok(listRelayPresetNames().includes('mindflow'));
  const list = listRelayPresets();
  const m = list.find((x) => x.name === 'mindflow');
  assert.ok(m);
  assert.strictEqual(m.baseUrl, 'https://ai.mindflow.com.cn');
});

test('RELAY_PRESETS 冻结,不可篡改', () => {
  assert.ok(Object.isFrozen(RELAY_PRESETS));
  assert.ok(Object.isFrozen(RELAY_PRESETS.mindflow));
});

test('预设 defaults 填补:env 只带 token → 端点/模型来自预设', () => {
  const preset = getRelayPreset('mindflow');
  const plan = planCcEnvAdoption(
    { ANTHROPIC_AUTH_TOKEN: 'sk-relay-abcdef123' },
    { baseUrl: preset.baseUrl, model: preset.model }
  );
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.credKind, 'ANTHROPIC_AUTH_TOKEN');
  assert.strictEqual(plan.authScheme, 'bearer');
  assert.strictEqual(plan.endpoint, 'https://ai.mindflow.com.cn');
  assert.strictEqual(plan.model, 'claude-opus-4-8');
  const base = plan.entries.find((e) => e.key === 'ANTHROPIC_BASE_URL');
  assert.strictEqual(base.value, 'https://ai.mindflow.com.cn');
});

test('env 显式 base url 优先于预设 default(env always wins)', () => {
  const plan = planCcEnvAdoption(
    { ANTHROPIC_AUTH_TOKEN: 'sk-relay-abcdef123', ANTHROPIC_BASE_URL: 'https://my.own.relay' },
    { baseUrl: 'https://ai.mindflow.com.cn', model: 'claude-opus-4-8' }
  );
  assert.strictEqual(plan.endpoint, 'https://my.own.relay');
});

test('预设不提供凭据:无 token 时仍 ok:false(端点不是凭据)', () => {
  const preset = getRelayPreset('mindflow');
  const plan = planCcEnvAdoption({}, { baseUrl: preset.baseUrl, model: preset.model });
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.reason, 'no-credential');
});

test('一参调用 byte-兼容:defaults 缺省不改旧行为', () => {
  const plan = planCcEnvAdoption({ ANTHROPIC_API_KEY: 'sk-official-xyz789' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.authScheme, 'x-api-key');
  assert.strictEqual(plan.endpoint, 'https://api.anthropic.com');
});
