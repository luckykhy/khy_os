'use strict';

/**
 * manualRelayAutoFallbackPolicy.test.js — 人肉中转通道(relay/clipboard)不作自动兜底的决策叶子契约锁。
 *
 * 根因回归(排障「为什么会出现剪贴板中转模式」收尾修):
 *   剪贴板/网页中转需要人在场复制粘贴,绝不该作为自动兜底。旧行为下 generate 级联遍历整份 _adapters,
 *   manual 通道只被排到队尾却从不剔除 → 云端全失败后静默走到剪贴板等人 5 分钟。本叶子:命中 manual
 *   通道 + 门控开 + 非用户显式指定 → 自动级联应跳过(让本地模式成为真正兜底)。
 *
 * 锁死:
 *   - 门控开(缺省/1/on)+ manual 通道 + 非显式 → skip=true;
 *   - 门控关(0/false/off/no)→ 一律 skip=false(逐字节回退今日行为);
 *   - 非 manual 通道 → skip=false;
 *   - 显式指定(preferredAdapter / forceAdapter 命中该通道,含大小写)→ skip=false(放行);
 *   - 绝不抛(null / 非字符串 / 怪异输入)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const L = require('../../../src/services/gateway/manualRelayAutoFallbackPolicy');

const ON = {}; // 缺省 env → 默认开

test('门控:缺省 / 1 / on → true', () => {
  assert.strictEqual(L.manualRelayNoAutoFallbackEnabled({}), true);
  assert.strictEqual(L.manualRelayNoAutoFallbackEnabled({ KHY_MANUAL_RELAY_NO_AUTO_FALLBACK: '1' }), true);
  assert.strictEqual(L.manualRelayNoAutoFallbackEnabled({ KHY_MANUAL_RELAY_NO_AUTO_FALLBACK: 'on' }), true);
});

test('门控:0/false/off/no/FALSE/ Off  → false', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(
      L.manualRelayNoAutoFallbackEnabled({ KHY_MANUAL_RELAY_NO_AUTO_FALLBACK: off }),
      false,
      `off=${off}`
    );
  }
});

test('manual 通道 + 门控开 + 非显式 → 跳过', () => {
  for (const key of ['relay', 'clipboard', 'CLIPBOARD', ' Relay ']) {
    const skip = L.shouldSkipManualRelayInAutoCascade(
      { isManualFallbackOnly: true, adapterKey: key },
      ON
    );
    assert.strictEqual(skip, true, `key=${key} 应跳过`);
  }
});

test('门控关 → 一律不跳过(逐字节回退今日行为)', () => {
  const skip = L.shouldSkipManualRelayInAutoCascade(
    { isManualFallbackOnly: true, adapterKey: 'clipboard' },
    { KHY_MANUAL_RELAY_NO_AUTO_FALLBACK: '0' }
  );
  assert.strictEqual(skip, false);
});

test('非 manual 通道 → 不跳过', () => {
  for (const key of ['api', 'ollama', 'localLLM', 'kiro', 'codex']) {
    const skip = L.shouldSkipManualRelayInAutoCascade(
      { isManualFallbackOnly: false, adapterKey: key },
      ON
    );
    assert.strictEqual(skip, false, `key=${key} 非 manual 不应跳过`);
  }
});

test('显式指定 preferredAdapter 命中该通道 → 放行(不跳过,含大小写)', () => {
  assert.strictEqual(
    L.shouldSkipManualRelayInAutoCascade(
      { isManualFallbackOnly: true, adapterKey: 'clipboard', preferredAdapter: 'clipboard' },
      ON
    ),
    false
  );
  assert.strictEqual(
    L.shouldSkipManualRelayInAutoCascade(
      { isManualFallbackOnly: true, adapterKey: 'CLIPBOARD', preferredAdapter: 'clipboard' },
      ON
    ),
    false,
    '大小写不敏感'
  );
});

test('显式指定 forceAdapter 命中该通道 → 放行(不跳过)', () => {
  assert.strictEqual(
    L.shouldSkipManualRelayInAutoCascade(
      { isManualFallbackOnly: true, adapterKey: 'relay', forceAdapter: 'relay' },
      ON
    ),
    false
  );
});

test('显式指定的是别的通道 → 仍跳过该 manual 通道', () => {
  const skip = L.shouldSkipManualRelayInAutoCascade(
    { isManualFallbackOnly: true, adapterKey: 'clipboard', preferredAdapter: 'api', forceAdapter: 'ollama' },
    ON
  );
  assert.strictEqual(skip, true);
});

test('绝不抛:null / 非字符串 / 怪异输入', () => {
  assert.doesNotThrow(() => L.shouldSkipManualRelayInAutoCascade(null, ON));
  assert.doesNotThrow(() => L.shouldSkipManualRelayInAutoCascade({}, ON));
  assert.doesNotThrow(() => L.shouldSkipManualRelayInAutoCascade({ isManualFallbackOnly: true, adapterKey: 12345 }, ON));
  assert.doesNotThrow(() => L.shouldSkipManualRelayInAutoCascade({ isManualFallbackOnly: true, adapterKey: null }, null));
  assert.doesNotThrow(() => L.manualRelayNoAutoFallbackEnabled(null));
  // 空 adapterKey → 不跳过(无从判定)
  assert.strictEqual(
    L.shouldSkipManualRelayInAutoCascade({ isManualFallbackOnly: true, adapterKey: '' }, ON),
    false
  );
});

test('GATE_FLAG 常量正确', () => {
  assert.strictEqual(L.GATE_FLAG, 'KHY_MANUAL_RELAY_NO_AUTO_FALLBACK');
});

// ── wiring:确认真接线到级联 + SSOT 访问器,防叶子写了没接 ──
test('wiring: generate 级联接线跳过守卫 + SSOT 访问器', () => {
  const gen = fs.readFileSync(
    path.join(__dirname, '../../../src/services/gateway/aiGatewayGenerateMethod.js'), 'utf8'
  );
  assert.ok(/shouldSkipManualRelayInAutoCascade/.test(gen), 'generate 调用跳过决策叶子');
  assert.ok(/_isManualFallbackOnlyKey/.test(gen), 'generate 用 SSOT 访问器判定 manual 通道');
  assert.ok(/manual_fallback_skipped/.test(gen), 'skip 尝试标记 manual_fallback_skipped');

  const routing = fs.readFileSync(
    path.join(__dirname, '../../../src/services/gateway/aiGatewayRoutingMethods.js'), 'utf8'
  );
  assert.ok(/_isManualFallbackOnlyKey\s*\(/.test(routing), 'routing 定义 _isManualFallbackOnlyKey');
  assert.ok(/DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS\.has/.test(routing), '复用 SSOT 集合而非新造');
});
