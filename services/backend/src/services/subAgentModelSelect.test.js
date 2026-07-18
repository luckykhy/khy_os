'use strict';

/**
 * subAgentModelSelect.test.js — 纯叶子测试(node:test)。
 * 覆盖:门控真值表、isTierAlias、selectAvailableModels 各场景 + 畸形输入绝不抛。
 * 另含网关 normalizeModelForAdapter 裸 tier 别名安全网(门控开/关)。
 *
 * 跑:node --test services/backend/src/services/subAgentModelSelect.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const sel = require('./subAgentModelSelect');

test('isEnabled: 默认开 / 显式假值关 / 垃圾值当开', () => {
  assert.strictEqual(sel.isEnabled({}), true);
  assert.strictEqual(sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: undefined }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: v }), false, `expect off: ${v}`);
  }
  for (const v of ['1', 'true', 'yes', 'on', 'whatever']) {
    assert.strictEqual(sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: v }), true, `expect on: ${v}`);
  }
});

test('isTierAlias: 仅裸 tier 别名(大小写/空白不敏感)为真', () => {
  for (const v of ['haiku', 'HAIKU', ' sonnet ', 'opus', 'Opus']) {
    assert.strictEqual(sel.isTierAlias(v), true, `alias: ${v}`);
  }
  for (const v of ['claude-3-5-haiku-20241022', 'gpt-4o', '', 'flash', null, undefined, 42, {}]) {
    assert.strictEqual(sel.isTierAlias(v), false, `not alias: ${String(v)}`);
  }
});

test('selectAvailableModels: 空列表 → []', () => {
  assert.deepStrictEqual(sel.selectAvailableModels('haiku', []), []);
  assert.deepStrictEqual(sel.selectAvailableModels('haiku', null), []);
  assert.deepStrictEqual(sel.selectAvailableModels('haiku', undefined), []);
});

test('selectAvailableModels: 别名 haiku + 混合可用 → 轻量(T3)在前', () => {
  const available = [
    { id: 'claude-sonnet-4-20250514', discoverySource: 'remote' }, // T1
    { id: 'claude-3-5-haiku-20241022', discoverySource: 'remote' }, // T3
    { id: 'claude-opus-4-20250514', discoverySource: 'remote' }, // T0
  ];
  const out = sel.selectAvailableModels('haiku', available, { max: 3 });
  assert.strictEqual(out[0], 'claude-3-5-haiku-20241022', 'lightest first');
  assert.strictEqual(out.length, 3);
});

test('selectAvailableModels: 仅重量级可用 → 返回该重量级 id(调用方再据主模型去重)', () => {
  const available = [{ id: 'claude-sonnet-4-20250514', discoverySource: 'remote' }];
  const out = sel.selectAvailableModels('haiku', available);
  assert.deepStrictEqual(out, ['claude-sonnet-4-20250514']);
});

test('selectAvailableModels: 同 tier 时 remote 优先于 hint', () => {
  const available = [
    { id: 'gpt-4o-mini', discoverySource: 'hint' }, // T3
    { id: 'claude-3-5-haiku-20241022', discoverySource: 'remote' }, // T3
  ];
  const out = sel.selectAvailableModels('haiku', available, { max: 2 });
  assert.strictEqual(out[0], 'claude-3-5-haiku-20241022', 'remote before hint at same tier');
});

test('selectAvailableModels: 具体 id 命中可用 → 原样返回那一个', () => {
  const available = [
    { id: 'claude-sonnet-4-20250514' },
    { id: 'claude-3-5-haiku-20241022' },
  ];
  assert.deepStrictEqual(
    sel.selectAvailableModels('CLAUDE-SONNET-4-20250514', available),
    ['claude-sonnet-4-20250514'],
    'case-insensitive hit returns the available id verbatim',
  );
});

test('selectAvailableModels: 具体 id 未命中 → 按其 tier 展开(不崩)', () => {
  const available = [
    { id: 'claude-3-5-haiku-20241022' }, // T3
    { id: 'claude-opus-4-20250514' }, // T0
  ];
  // 请求一个不在列表里的强模型 → 期望 tier ~ T1,离 T0 更近 → opus 先
  const out = sel.selectAvailableModels('claude-sonnet-4-20250514', available, { max: 2 });
  assert.strictEqual(out.length, 2);
  assert.ok(out.includes('claude-opus-4-20250514'));
});

test('selectAvailableModels: 裸字符串项 + 去重', () => {
  const available = ['claude-3-5-haiku-20241022', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514'];
  const out = sel.selectAvailableModels('haiku', available, { max: 5 });
  assert.strictEqual(out.length, 2, 'dedup by id');
  assert.strictEqual(out[0], 'claude-3-5-haiku-20241022');
});

test('selectAvailableModels: max 截断', () => {
  const available = [
    { id: 'gpt-4o-mini' }, { id: 'claude-3-5-haiku-20241022' }, { id: 'gemini-2.0-flash' },
  ];
  assert.strictEqual(sel.selectAvailableModels('haiku', available, { max: 1 }).length, 1);
});

test('selectAvailableModels: 畸形项(null/{}/数字)绝不抛,过滤空 id', () => {
  const available = [null, {}, 42, { id: '' }, { id: '  ' }, { id: 'claude-3-5-haiku-20241022' }];
  const out = sel.selectAvailableModels('haiku', available);
  assert.deepStrictEqual(out, ['claude-3-5-haiku-20241022']);
});

test('selectAvailableModels: 确定性(同输入恒同输出)', () => {
  const available = [
    { id: 'claude-opus-4-20250514', discoverySource: 'remote' },
    { id: 'claude-3-5-haiku-20241022', discoverySource: 'config' },
    { id: 'claude-sonnet-4-20250514', discoverySource: 'remote' },
  ];
  const a = sel.selectAvailableModels('haiku', available, { max: 3 });
  const b = sel.selectAvailableModels('haiku', available, { max: 3 });
  assert.deepStrictEqual(a, b);
});

test('describeSubAgentModelSelect: 自描述结构', () => {
  const d = sel.describeSubAgentModelSelect();
  assert.strictEqual(d.gate, 'KHY_SUBAGENT_MODEL_AUTOSELECT');
  assert.strictEqual(d.defaultOn, true);
  assert.strictEqual(typeof d.summary, 'string');
});

// ── 网关裸 tier 别名安全网 ──────────────────────────────────────────────────
test('gateway normalizeModelForAdapter: relay_api 裸 haiku/sonnet/opus 门控开 → dated id', () => {
  const prev = process.env.KHY_RELAY_BARE_ALIAS;
  delete process.env.KHY_RELAY_BARE_ALIAS;
  try {
    const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'haiku'), 'claude-3-5-haiku-20241022');
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'sonnet'), 'claude-sonnet-4-20250514');
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'opus'), 'claude-opus-4-20250514');
    assert.strictEqual(normalizeModelForAdapter('api', 'HAIKU'), 'claude-3-5-haiku-20241022');
    // 既有具体别名仍生效
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'claude-haiku-3.5'), 'claude-3-5-haiku-20241022');
  } finally {
    if (prev === undefined) delete process.env.KHY_RELAY_BARE_ALIAS;
    else process.env.KHY_RELAY_BARE_ALIAS = prev;
  }
});

test('gateway normalizeModelForAdapter: 门控关 → 裸别名原样透传(字节回退)', () => {
  const prev = process.env.KHY_RELAY_BARE_ALIAS;
  process.env.KHY_RELAY_BARE_ALIAS = 'off';
  try {
    const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'haiku'), 'haiku');
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'sonnet'), 'sonnet');
    // 具体别名不受门控影响
    assert.strictEqual(normalizeModelForAdapter('relay_api', 'claude-haiku-3.5'), 'claude-3-5-haiku-20241022');
  } finally {
    if (prev === undefined) delete process.env.KHY_RELAY_BARE_ALIAS;
    else process.env.KHY_RELAY_BARE_ALIAS = prev;
  }
});

test('gateway normalizeModelForAdapter: 非 relay/api 通道不碰裸别名', () => {
  const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
  // claude 通道:非 claude-* → null(既有行为)
  assert.strictEqual(normalizeModelForAdapter('claude', 'haiku'), null);
  // codex 通道:haiku → 重映射(既有行为)
  assert.strictEqual(normalizeModelForAdapter('codex', 'haiku'), 'gpt-5.3-codex');
});
