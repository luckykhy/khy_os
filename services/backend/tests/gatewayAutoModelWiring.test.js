'use strict';

/**
 * gatewayAutoModelWiring.test.js — 接线契约:CLI gateway handler 把「Auto」选择持久化成
 * adapter=auto 哨兵 + 清空 GATEWAY_PREFERRED_MODEL(而非把字面 'auto' 写进 model),门控关则
 * 逐字节回退旧持久化。/goal「khy 在模型列表下设置一个 auto 模型」。
 *
 * 手法:经 require 缓存把 gatewayEnvFile.writeEnvPatch 替换成 spy(零真实 .env 写入),
 * 再直接调 persistGatewayPreference 断言落到 env 的 map/unset。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const envFilePath = require.resolve(path.join(BACKEND, 'src/services/gatewayEnvFile'));
const handlerPath = require.resolve(path.join(BACKEND, 'src/cli/handlers/gateway'));

// Install a spy over gatewayEnvFile.writeEnvPatch before the handler binds it.
const realEnvFile = require(envFilePath);
const _origWrite = realEnvFile.writeEnvPatch;
let _lastPatch = null;
realEnvFile.writeEnvPatch = (envMap, unsetKeys, options) => {
  _lastPatch = { envMap, unsetKeys, options };
  return { ok: true };
};

const handler = require(handlerPath);

test.after(() => { realEnvFile.writeEnvPatch = _origWrite; });

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}
const ON = (fn) => withEnv('KHY_AUTO_MODEL_SELECT', undefined, fn);
const OFF = (fn) => withEnv('KHY_AUTO_MODEL_SELECT', '0', fn);

test('ON: Auto selection → adapter=auto + GATEWAY_PREFERRED_MODEL unset (not literal auto)', () => {
  ON(() => {
    _lastPatch = null;
    handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
    assert.ok(_lastPatch, 'writeEnvPatch called');
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER, 'auto');
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_STRICT, 'true');
    // model must NOT be persisted as the literal 'auto'
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL, undefined);
    assert.deepEqual(_lastPatch.unsetKeys, ['GATEWAY_PREFERRED_MODEL']);
  });
});

test('ON: concrete model selection still persists model normally (superset — no behavior change)', () => {
  ON(() => {
    _lastPatch = null;
    handler.persistGatewayPreference({ adapter: 'api', model: 'glm-4.6' });
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER, 'api');
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL, 'glm-4.6');
    assert.deepEqual(_lastPatch.unsetKeys, []);
  });
});

test('OFF byte-revert: Auto value falls through to canonical persistence (model=auto literal)', () => {
  OFF(() => {
    _lastPatch = null;
    handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
    // Legacy path: model truthy → persisted verbatim (documents the pre-fix behavior)
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER, 'auto');
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL, 'auto');
    assert.deepEqual(_lastPatch.unsetKeys, []);
  });
});

test('ON: adapter-only auto (model null) also normalizes via legacy unset (no regression)', () => {
  ON(() => {
    _lastPatch = null;
    handler.persistGatewayPreference({ adapter: 'claude', model: null });
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER, 'claude');
    assert.equal(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL, undefined);
    assert.deepEqual(_lastPatch.unsetKeys, ['GATEWAY_PREFERRED_MODEL']);
  });
});

test('non-interactive blind fallback skips the Auto sentinel (Auto is explicit-only)', () => {
  // Documents the regression fix: with the Auto entry unshifted to the front, the
  // "pick first non-disabled" fallback in handleGatewaySelectModel must NOT pick Auto.
  const autoSelect = require(path.join(BACKEND, 'src/services/gateway/autoModelSelect'));
  const modelChoices = [
    autoSelect.buildAutoChoice(),
    { value: { adapter: 'codex', model: 'gpt-5.3-codex-review' }, disabled: false },
  ];
  const isAuto = autoSelect.isAutoSelection;
  const pick = modelChoices.find(c => c && c.value && !c.disabled && !isAuto(c.value));
  assert.equal(pick.value.adapter, 'codex');
  assert.equal(pick.value.model, 'gpt-5.3-codex-review');
});
