'use strict';

/**
 * channelLifecycle.test.js — [EvoRequirement] 非活跃通道僵尸行为与日志越权（acceptance）。
 *
 * 验证两件事，全程零真实网络/进程：
 *   1. 通道切换时，gateway 把「活跃/弃用」状态下推到每个声明了 setChannelActive 钩子的
 *      适配器：弃用通道收到 false（停后台任务 + 日志降级），活跃通道收到 true。
 *   2. _resolveActiveChannelKey 的语义：auto/空 → null（不弃用任何通道）；具体 key → 该通道活跃。
 *   3. kiroAdapter 暴露 setChannelActive 且可幂等调用（弃用→释放 token 文件 watcher）。
 *
 * 不引入真实 gateway 单例的副作用：直接取类原型上的方法，绑定到一个伪 this。
 */

const test = require('node:test');
const assert = require('node:assert');

// 取出 gateway 单例（其原型上挂着 _syncChannelLifecycle / _resolveActiveChannelKey）。
const gateway = require('../../../src/services/gateway/aiGateway');
const proto = Object.getPrototypeOf(gateway);

const ENV_KEY = 'GATEWAY_PREFERRED_ADAPTER';
const _origPref = process.env[ENV_KEY];

// Build a context whose `this` resolves the real lifecycle methods (they call
// each other via this.*), but carries only the adapter list we want to test.
function ctxWith(adapters) {
  return {
    _adapters: adapters,
    _resolveActiveChannelKey: proto._resolveActiveChannelKey,
    _syncChannelLifecycle: proto._syncChannelLifecycle,
    setActiveChannel: proto.setActiveChannel,
  };
}

function makeFakeGateway(adapterKeys) {
  // 每个带钩子的伪适配器记录收到的 active 状态序列。
  const calls = {};
  const adapters = adapterKeys.map((key) => {
    calls[key] = [];
    return {
      key,
      enabled: true,
      adapter: {
        setChannelActive: (active) => { calls[key].push(active); },
      },
    };
  });
  const ctx = ctxWith(adapters);
  return { ctx, calls };
}

function syncWith(pref, adapterKeys) {
  if (pref === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = pref;
  const { ctx, calls } = makeFakeGateway(adapterKeys);
  proto._syncChannelLifecycle.call(ctx);
  return calls;
}

test.afterEach(() => {
  if (_origPref === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = _origPref;
});

test('_resolveActiveChannelKey: auto / empty → null（不弃用任何通道）', () => {
  const ctx = ctxWith([{ key: 'kiro' }, { key: 'api' }]);

  process.env[ENV_KEY] = '';
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), null);

  process.env[ENV_KEY] = 'auto';
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), null);

  delete process.env[ENV_KEY];
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), null);
});

test('_resolveActiveChannelKey: 具体 key 大小写归一到注册 key', () => {
  const ctx = ctxWith([{ key: 'kiro' }, { key: 'localLLM' }, { key: 'api' }]);

  process.env[ENV_KEY] = 'API';
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), 'api');

  process.env[ENV_KEY] = 'localllm';
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), 'localLLM');

  // 未注册的偏好 → null（不会误把某个真实通道判成弃用）。
  process.env[ENV_KEY] = 'does-not-exist';
  assert.strictEqual(proto._resolveActiveChannelKey.call(ctx), null);
});

test('切到 api：kiro（弃用）收 false，api（活跃）收 true', () => {
  const calls = syncWith('api', ['kiro', 'api', 'trae']);
  assert.deepStrictEqual(calls.kiro, [false], 'kiro 应被弃用');
  assert.deepStrictEqual(calls.trae, [false], 'trae 应被弃用');
  assert.deepStrictEqual(calls.api, [true], 'api 应为活跃');
});

test('auto 模式：所有通道一律视为活跃（不误杀任何后台任务）', () => {
  const calls = syncWith('auto', ['kiro', 'api', 'trae']);
  assert.deepStrictEqual(calls.kiro, [true]);
  assert.deepStrictEqual(calls.api, [true]);
  assert.deepStrictEqual(calls.trae, [true]);
});

test('无钩子的适配器被安全跳过（非侵入）', () => {
  process.env[ENV_KEY] = 'api';
  let kiroState = null;
  const ctx = ctxWith([
    { key: 'kiro', enabled: true, adapter: { setChannelActive: (a) => { kiroState = a; } } },
    { key: 'cursor', enabled: true, adapter: {} }, // 无钩子
    { key: 'api', enabled: true, adapter: {} },    // 无钩子
  ]);
  // 不应抛错；带钩子的 kiro 被正确通知为弃用。
  assert.doesNotThrow(() => proto._syncChannelLifecycle.call(ctx));
  assert.strictEqual(kiroState, false);
});

test('钩子抛错不影响路由（fail-safe）', () => {
  process.env[ENV_KEY] = 'api';
  const ctx = ctxWith([
    { key: 'kiro', enabled: true, adapter: { setChannelActive: () => { throw new Error('boom'); } } },
    { key: 'api', enabled: true, adapter: {} },
  ]);
  assert.doesNotThrow(() => proto._syncChannelLifecycle.call(ctx));
});

test('setActiveChannel 写入偏好并立即对齐生命周期', () => {
  let apiState = null;
  let kiroState = null;
  const ctx = ctxWith([
    { key: 'kiro', enabled: true, adapter: { setChannelActive: (a) => { kiroState = a; } } },
    { key: 'api', enabled: true, adapter: { setChannelActive: (a) => { apiState = a; } } },
  ]);
  proto.setActiveChannel.call(ctx, 'api');
  assert.strictEqual(process.env[ENV_KEY], 'api');
  assert.strictEqual(apiState, true);
  assert.strictEqual(kiroState, false);
});

test('kiroAdapter 暴露 setChannelActive 且幂等可调用', () => {
  const kiro = require('../../../src/services/gateway/adapters/kiroAdapter');
  assert.strictEqual(typeof kiro.setChannelActive, 'function');
  // 幂等：重复弃用/重复激活都不抛错。
  assert.doesNotThrow(() => {
    kiro.setChannelActive(false);
    kiro.setChannelActive(false);
    kiro.setChannelActive(true);
    kiro.setChannelActive(true);
  });
});
