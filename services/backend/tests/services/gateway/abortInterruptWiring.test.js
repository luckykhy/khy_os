'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ── root cause C: 网关两处 Promise.race 都补了 abort 臂 ───────────────────────
test('aiGatewayGenerateMethod wires _buildAdapterRaceArms into both race sites', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  // 助手定义存在且读 abortRaceArm 叶子。
  assert.ok(/function _buildAdapterRaceArms\(/.test(src), 'missing _buildAdapterRaceArms helper');
  assert.ok(/require\('\.\/abortRaceArm'\)/.test(src), 'helper must require ./abortRaceArm');
  // 两处 race 站点都改用臂集合;旧的裸两臂 race 不再残留。
  const armedRaces = src.match(/Promise\.race\(_race\w*\.arms\)/g) || [];
  assert.strictEqual(armedRaces.length, 2, `expected 2 armed race sites, got ${armedRaces.length}`);
  assert.ok(
    !/Promise\.race\(\[adapterPromise, idleTimeout\.timeoutPromise\]\)/.test(src),
    'no bare two-arm race should remain'
  );
  // cleanup 在 finally 释放,防 listener 泄漏。
  assert.ok(/_raceC\.cleanup\(\)/.test(src) && /_raceC2\.cleanup\(\)/.test(src), 'both arms must be cleaned up');
});

test('_buildAdapterRaceArms is gated by KHY_GATEWAY_ABORT_RACE_ARM (parent KHY_GATEWAY_HARD_TIMEOUT)', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  assert.ok(/KHY_GATEWAY_ABORT_RACE_ARM/.test(src), 'must reference the gate');
  assert.ok(/KHY_GATEWAY_HARD_TIMEOUT/.test(src), 'must honor parent gate');
  // 门关分支返回两臂(逐字节回退)。
  assert.ok(/return \{ arms: \[adapterPromise, timeoutPromise\], cleanup: \(\) => \{\} \}/.test(src),
    'gate-off branch must byte-revert to two arms');
});

// ── root cause A: kiro 透传 abortSignal 到 send / 内部 race / parseCWStreamEvents ──
test('kiroAdapter forwards abortSignal to client.send, internal race, and stream parser', () => {
  const src = read('services/gateway/adapters/kiroAdapter.js');
  assert.ok(/function _isKiroAbortEnabled\(/.test(src), 'missing gate helper');
  assert.ok(/KHY_KIRO_ABORT/.test(src), 'must reference KHY_KIRO_ABORT');
  // send 接 abortSignal(经 sendConfig)。
  assert.ok(/client\.send\(command, sendConfig\)/.test(src), 'client.send must receive sendConfig');
  assert.ok(/abortSignal: _kiroSignal/.test(src), 'sendConfig must carry abortSignal from options');
  // 内部 120s race 补 abort 臂。
  assert.ok(/createAbortRejectionArm\(_kiroSignal/.test(src), 'internal race must add abort arm');
  assert.ok(/require\('\.\.\/abortRaceArm'\)/.test(src), 'kiro must require ../abortRaceArm');
  // parseCWStreamEvents 收到 signal。
  assert.ok(/signal: _kiroSignal/.test(src), 'parseCWStreamEvents opts must include signal');
});

test('kiro gate off → _kiroSignal undefined → byte-reverts to no-abort behavior', () => {
  const src = read('services/gateway/adapters/kiroAdapter.js');
  // 门关时 _kiroSignal 取 undefined,sendConfig 为 undefined(等价旧 client.send(command))。
  assert.ok(/_kiroAbortOn \? \(options\.abortSignal \|\| undefined\) : undefined/.test(src),
    'signal must be gated off to undefined');
  assert.ok(/const sendConfig = _kiroSignal \? \{ abortSignal: _kiroSignal \} : undefined/.test(src),
    'sendConfig must be undefined when signal is off');
});

// ── flagRegistry: 三门全注册且 default-on ─────────────────────────────────────
test('flagRegistry registers all three abort gates as default-on', () => {
  const reg = require('../../../src/services/flagRegistry');
  for (const name of ['KHY_GATEWAY_ABORT_RACE_ARM', 'KHY_KIRO_ABORT', 'KHY_CLITOOL_ABORT']) {
    assert.ok(reg.FLAGS[name], `flag ${name} must be registered`);
    assert.strictEqual(reg.FLAGS[name].mode, 'default-on', `${name} must be default-on`);
    assert.strictEqual(reg.isFlagEnabled(name, {}), true, `${name} must default enabled`);
    for (const off of ['off', 'false', '0', 'no']) {
      assert.strictEqual(reg.isFlagEnabled(name, { [name]: off }), false, `${name}=${off} must disable`);
    }
  }
});

test('KHY_GATEWAY_ABORT_RACE_ARM is child of KHY_GATEWAY_HARD_TIMEOUT (paired shutdown)', () => {
  const reg = require('../../../src/services/flagRegistry');
  assert.strictEqual(reg.FLAGS.KHY_GATEWAY_ABORT_RACE_ARM.parent, 'KHY_GATEWAY_HARD_TIMEOUT');
});
