'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ── root cause D: idle 看门狗只被「真实推进」重置,不被网关自造心跳续命 ─────────────
// 源级 wiring 断言 aiGatewayGenerateMethod 已把 gatewayIdleProgressPolicy 接进 funnel,
// 且状态/脉冲/预警走「非真实推进」、assistant 内容走「真实推进」。

test('aiGatewayGenerateMethod wires gatewayIdleProgressPolicy via _shouldResetIdleForProgress', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  assert.ok(
    /function _shouldResetIdleForProgress\(/.test(src),
    'missing _shouldResetIdleForProgress helper'
  );
  assert.ok(
    /require\('\.\/gatewayIdleProgressPolicy'\)/.test(src),
    'helper must require ./gatewayIdleProgressPolicy'
  );
});

test('forwardGatewayChunk gates _touchGatewayActivity by isRealProgress (single choke-point)', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  // forwardGatewayChunk 现在带 isRealProgress 参(默认 true = 逐字节等价真实 chunk 路径)。
  assert.ok(
    /const forwardGatewayChunk = \(chunk, isRealProgress = true\) =>/.test(src),
    'forwardGatewayChunk must take isRealProgress default true'
  );
  // idle 重置由门控裹住,不再无条件 touch。
  assert.ok(
    /if \(_shouldResetIdleForProgress\(isRealProgress\)\) _touchGatewayActivity\(\);/.test(src),
    'touch must be gated by _shouldResetIdleForProgress'
  );
});

test('status/activity emit as non-real-progress; assistant emits as real-progress', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  // emitStatus + emitActivity 都以 false 传入(网关自言自语)。
  const nonProgress = src.match(/forwardGatewayChunk\(\{ type: 'status', text: normalized \}, false\)/g) || [];
  assert.strictEqual(
    nonProgress.length,
    2,
    `expected emitStatus+emitActivity to pass isRealProgress=false, got ${nonProgress.length}`
  );
  // assistant_message 走真实推进(不传 false → 默认 true)。
  assert.ok(
    /forwardGatewayChunk\(\{ type: 'assistant_message', content: normalized \}\);/.test(src),
    'assistant_message must forward as real progress (default true)'
  );
  assert.ok(
    !/forwardGatewayChunk\(\{ type: 'assistant_message'[^)]*\}, false\)/.test(src),
    'assistant_message must NOT be marked non-progress'
  );
});

test('emit* wrappers no longer redundantly _touchGatewayActivity (funnel owns idle-reset)', () => {
  const src = read('services/gateway/aiGatewayGenerateMethod.js');
  // 计 _touchGatewayActivity() 调用点:定义体本身 + funnel 内 1 处 + 两个真实推进 touchActivity 闭包各 1 处。
  // emitStatus/emitActivity/emitAssistantMessage 内的冗余 touch 已删除。
  const touchCalls = src.match(/_touchGatewayActivity\(\)/g) || [];
  // 允许的调用点:funnel(1)+ 两处 adapter onChunk touchActivity 闭包(2)。定义处 `const _touchGatewayActivity =` 不计入此正则。
  assert.strictEqual(
    touchCalls.length,
    3,
    `expected exactly 3 _touchGatewayActivity() call sites (funnel + 2 real-progress closures), got ${touchCalls.length}`
  );
});

test('policy leaf is gated by KHY_GATEWAY_IDLE_PROGRESS_ONLY and fails safe', () => {
  const leaf = read('services/gateway/gatewayIdleProgressPolicy.js');
  assert.ok(/KHY_GATEWAY_IDLE_PROGRESS_ONLY/.test(leaf), 'leaf must reference the gate');
  // 门关 / 异常 → 回退今日行为(shouldResetIdle 恒 true)。
  const { shouldResetIdle } = require('../../../src/services/gateway/gatewayIdleProgressPolicy');
  assert.strictEqual(shouldResetIdle(false, { KHY_GATEWAY_IDLE_PROGRESS_ONLY: 'off' }), true);
  assert.strictEqual(shouldResetIdle(false, {}), false); // 默认开 + 自言自语 → 不重置
});
