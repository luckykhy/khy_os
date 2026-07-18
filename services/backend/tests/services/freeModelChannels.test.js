'use strict';

/**
 * freeModelChannels.test.js — 「问 khyos 也给其他免费模型渠道」纯叶子契约锁死。
 *
 *   - 门开(default)→ 内置 3 渠道(zhipu/siliconflow/openrouter),仅公开 URL,无凭据;
 *   - env KHY_FREE_MODEL_CHANNELS(JSON 数组)按 key 覆盖/新增;非 JSON 开关词不当覆盖;
 *   - buildFreeModelChannelsMessage 出一行式摘要;
 *   - 门关(0/false/off/no)→ list 空、message 空(逐字节回退);
 *   - 绝不放不可信 URL scheme;绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  FREE_MODEL_CHANNELS,
  freeModelChannelsEnabled,
  listFreeModelChannels,
  buildFreeModelChannelsMessage,
} = require('../../src/services/freeModelChannels');

test('gate default-on', () => {
  assert.strictEqual(freeModelChannelsEnabled({}), true);
  assert.strictEqual(freeModelChannelsEnabled({ KHY_FREE_MODEL_CHANNELS: 'on' }), true);
});

test('built-in seed: 3 channels, public URLs only, no secret leakage', () => {
  const list = listFreeModelChannels({});
  assert.deepStrictEqual(list.map((c) => c.key), ['zhipu', 'siliconflow', 'openrouter']);
  for (const c of list) {
    assert.ok(/^https?:\/\//.test(c.console), `console is url: ${c.key}`);
    assert.ok(!('apiKey' in c) && !('secret' in c), `no secret field: ${c.key}`);
    assert.ok(Array.isArray(c.freeModels) && c.freeModels.length > 0, `has example models: ${c.key}`);
  }
  // zhipu 一条与免费模型权威源对齐(含 7 个免费 id)
  const zhipu = list.find((c) => c.key === 'zhipu');
  assert.ok(zhipu.freeModels.includes('glm-4.7-flash'));
  assert.ok(zhipu.freeModels.includes('cogview-3-flash'));
});

test('buildFreeModelChannelsMessage: one-line summary joining all channels', () => {
  const msg = buildFreeModelChannelsMessage({});
  assert.ok(msg.includes('智谱'));
  assert.ok(msg.includes('硅基流动'));
  assert.ok(msg.includes('OpenRouter'));
  assert.ok(msg.includes('；')); // channels joined by ；
});

test('env override merges by key (replace existing, append new)', () => {
  const env = {
    KHY_FREE_MODEL_CHANNELS: JSON.stringify([
      { key: 'zhipu', note: '自定义覆盖说明' },
      { key: 'myfree', name: '我的免费渠道', console: 'https://example.com/keys', note: 'x' },
    ]),
  };
  const list = listFreeModelChannels(env);
  const zhipu = list.find((c) => c.key === 'zhipu');
  assert.strictEqual(zhipu.note, '自定义覆盖说明'); // 覆盖生效
  assert.ok(zhipu.name.length > 0); // 未覆盖字段保留内置
  const mine = list.find((c) => c.key === 'myfree');
  assert.ok(mine && mine.console === 'https://example.com/keys'); // 新增 key 追加
});

test('env override drops untrusted URL scheme', () => {
  const env = {
    KHY_FREE_MODEL_CHANNELS: JSON.stringify([
      { key: 'evil', name: 'x', console: 'javascript:alert(1)' },
    ]),
  };
  const evil = listFreeModelChannels(env).find((c) => c.key === 'evil');
  assert.strictEqual(evil.console, ''); // 非 http(s) → 丢弃
});

test('non-JSON toggle word for KHY_FREE_MODEL_CHANNELS is not treated as override', () => {
  // 'true'/'1' 是开关词而非 JSON 数组 → 不当覆盖,仍返回内置 3 条
  assert.strictEqual(listFreeModelChannels({ KHY_FREE_MODEL_CHANNELS: 'true' }).length, 3);
  assert.strictEqual(listFreeModelChannels({ KHY_FREE_MODEL_CHANNELS: '1' }).length, 3);
});

test('gate off (0/false/off/no) → byte-revert (empty list + empty message)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    const env = { KHY_FREE_MODEL_CHANNELS: v };
    assert.strictEqual(freeModelChannelsEnabled(env), false, v);
    assert.deepStrictEqual(listFreeModelChannels(env), [], v);
    assert.strictEqual(buildFreeModelChannelsMessage(env), '', v);
  }
});

test('never throws; returns fresh copies', () => {
  assert.doesNotThrow(() => listFreeModelChannels(null));
  assert.doesNotThrow(() => buildFreeModelChannelsMessage(undefined));
  const a = listFreeModelChannels({});
  a[0].name = 'mutated';
  assert.notStrictEqual(FREE_MODEL_CHANNELS[0].name, 'mutated'); // 源不被污染
});
