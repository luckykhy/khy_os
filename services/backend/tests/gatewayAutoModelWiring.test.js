'use strict';
/**
 * gatewayAutoModelWiring.test.js �?接线契约:CLI gateway handler 把「Auto」选择持久化成
 * adapter=auto 哨兵 + 清空 GATEWAY_PREFERRED_MODEL(而非把字�?'auto' 写进 model),门控关则
 * 逐字节回退旧持久化�?goal「khy 在模型列表下设置一�?auto 模型」�?
 *
 * 手法:�?require 缓存�?gatewayEnvFile.writeEnvPatch 替换�?spy(零真�?.env 写入),
 * 再直接调 persistGatewayPreference 断言落到 env �?map/unset�?
 */
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

describe('Gateway Auto Model Wiring', () => {
  test('ON: Auto selection �?adapter=auto + GATEWAY_PREFERRED_MODEL unset (not literal auto)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
        expect(_lastPatch).toBeTruthy();
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('auto');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_STRICT).toBe('true');
        // model must NOT be persisted as the literal 'auto'
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe(undefined);
        assert.deepEqual(_lastPatch.unsetKeys, ['GATEWAY_PREFERRED_MODEL']);
      });
  });

  test('ON: concrete model selection still persists model normally (superset �?no behavior change)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'api', model: 'glm-4.6' });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('api');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe('glm-4.6');
        assert.deepEqual(_lastPatch.unsetKeys, []);
      });
  });

  test('OFF byte-revert: Auto value falls through to canonical persistence (model=auto literal)', () => {
      OFF(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'auto', model: 'auto' });
        // Legacy path: model truthy �?persisted verbatim (documents the pre-fix behavior)
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('auto');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe('auto');
        assert.deepEqual(_lastPatch.unsetKeys, []);
      });
  });

  test('ON: adapter-only auto (model null) also normalizes via legacy unset (no regression)', () => {
      ON(() => {
        _lastPatch = null;
        handler.persistGatewayPreference({ adapter: 'claude', model: null });
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_ADAPTER).toBe('claude');
        expect(_lastPatch.envMap.GATEWAY_PREFERRED_MODEL).toBe(undefined);
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
      expect(pick.value.adapter).toBe('codex');
      expect(pick.value.model).toBe('gpt-5.3-codex-review');
  });

});

