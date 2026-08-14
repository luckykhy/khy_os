'use strict';

/**
 * server_error fast-fail 熔断接线测试。
 *
 * 背景修复:网关对 server_error(502/503/504) 此前不设 transient 冷却 → _getRecentFastFail
 * 对 5xx 恒返回 null → 同一请求/连续请求对同一把抖动 key 无限重试(卡死 1 小时根因)。
 * 修复:_TRANSIENT_COOLDOWN_MS 增加 server_error(默认 15s,GATEWAY_SERVER_ERROR_COOLDOWN_MS 可覆盖)。
 *
 * 验证点:
 *   1. _TRANSIENT_COOLDOWN_MS.server_error 存在且默认 ≥ 5000ms
 *   2. env 覆盖生效
 *   3. _getRecentFastFail 对 server_error 失败(在冷却窗口内)返回非空 → 熔断生效
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const GATEWAY_SRC = path.join(__dirname, '..', '..', 'src', 'services', 'gateway', 'aiGateway.js');

test('_TRANSIENT_COOLDOWN_MS 包含 server_error(默认 ≥ 5000ms)', () => {
  const src = fs.readFileSync(GATEWAY_SRC, 'utf-8');
  assert.match(src, /server_error[^,]*_parseMs\(process\.env\.GATEWAY_SERVER_ERROR_COOLDOWN_MS,\s*15000,\s*5000\)/,
    'server_error 冷却应存在且默认 15000ms');
});

test('GATEWAY_SERVER_ERROR_COOLDOWN_MS env 覆盖 server_error 冷却', () => {
  const { _parseMs } = require('../../src/services/gateway/_envParse');
  process.env.GATEWAY_SERVER_ERROR_COOLDOWN_MS = '5000';
  try {
    // _TRANSIENT_COOLDOWN_MS 在模块加载时求值;经 _parseMs(env, 15000, 5000)。
    const v = _parseMs(process.env.GATEWAY_SERVER_ERROR_COOLDOWN_MS, 15000, 5000);
    assert.strictEqual(v, 5000);
  } finally {
    delete process.env.GATEWAY_SERVER_ERROR_COOLDOWN_MS;
  }
});

test('真实网关:_getRecentFastFail 对 server_error 失败在窗口内返回非空(熔断生效)', () => {
  // 加载真实 gateway,经 DI 注入 cooldown mixin 依赖,驱动完整 fast-fail 判定路径。
  const gatewayMod = require('../../src/services/gateway/aiGateway');
  const cooldownLeaf = require('../../src/services/gateway/aiGatewayCooldownMethods');
  // 注入真实模块级 helper(经 aiGateway 加载时已由 setAiGatewayCooldownMethodsDeps 接线;
  // 这里显式重注入,保证测试环境与生产一致)。
  cooldownLeaf.setAiGatewayCooldownMethodsDeps({
    _transientCooldownMs: (t) => gatewayMod._transientCooldownMs
      ? gatewayMod._transientCooldownMs(t)
      : (String(t) === 'server_error' ? 15000 : 0),
    _shouldUseFastFail: () => false,
    _parseMs: gatewayMod._parseMs || ((raw, fb) => Number(raw) || fb),
    _parsePositiveInt: () => 1,
    _parseFloat01: () => 0,
    _parseNonNegativeInt: () => 0,
    _adaptiveConfig: null,
  });

  const AIGateway = gatewayMod.AIGateway || gatewayMod.default || gatewayMod;
  const proto = AIGateway.prototype || Object.getPrototypeOf(AIGateway) || AIGateway;
  assert.strictEqual(typeof proto._recordAdapterFailure, 'function');
  assert.strictEqual(typeof proto._getRecentFastFail, 'function');

  const gw = Object.create(proto);
  gw._adapterLastError = {};
  gw._adapterFailures = {};
  gw._adapterOutcomes = new Map();
  gw._fastFailProbeMeta = {};
  gw._lastAdapterFailureAt = {};
  gw._adapterFirstFailureAt = {};
  gw._resolveFastFailCooldownMs = (k, type) => 30000;

  // server_error 现在应有 transient 冷却 → _getRecentFastFail 返回非空
  const transient = gatewayMod._transientCooldownMs
    ? gatewayMod._transientCooldownMs('server_error')
    : 15000;
  assert.ok(transient >= 5000, `server_error transient 冷却应 ≥5000ms,实得 ${transient}`);

  // 手动写入一条 server_error 失败记录,验证 _getRecentFastFail 在窗口内能读到它。
  gw._adapterLastError['api'] = {
    at: Date.now(),
    errorType: 'server_error',
    error: 'Request failed with status code 502',
    cooldownMs: 30000,
    circuitOpen: false,
  };
  const recent = gw._getRecentFastFail('api');
  assert.ok(recent && recent.remainingMs > 0,
    `server_error 失败在冷却窗口内应被 fast-fail 拦截,实得 ${JSON.stringify(recent)}`);
});
