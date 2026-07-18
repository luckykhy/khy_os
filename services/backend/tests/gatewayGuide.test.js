'use strict';

/**
 * gatewayGuide 纯叶子单测(node:test)。覆盖:结构非空、presets 合并/过滤、
 * 已知 id 的环境变量名、configured 标注、renderGuide 行渲染、门控、fail-soft。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const guide = require('../src/services/gateway/gatewayGuide');

test('GATEWAY_STEPS / CONFIG_METHODS 结构完整', () => {
  assert.equal(guide.GATEWAY_STEPS.length, 3);
  for (const s of guide.GATEWAY_STEPS) {
    assert.equal(typeof s.n, 'number');
    assert.ok(s.title && s.desc);
  }
  assert.ok(guide.CONFIG_METHODS.length >= 4);
  const keys = guide.CONFIG_METHODS.map((m) => m.key);
  for (const k of ['direct', 'relay', 'ollama', 'oauth']) assert.ok(keys.includes(k), `缺方式 ${k}`);
  for (const m of guide.CONFIG_METHODS) assert.ok(m.label && m.when && m.how);
});

test('envVarForId 已知 id 用内置命名, 未知 id 回退 <ID>_API_KEY', () => {
  assert.equal(guide.envVarForId('zhipu'), 'GLM_API_KEY');
  assert.equal(guide.envVarForId('deepseek'), 'DEEPSEEK_API_KEY');
  assert.equal(guide.envVarForId('Anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(guide.envVarForId('packycode'), 'PACKYCODE_API_KEY');
  assert.equal(guide.envVarForId(''), '');
  assert.equal(guide.envVarForId(null), '');
});

test('buildKeyReferences 仅保留有 console 链接的 provider', () => {
  const refs = guide.buildKeyReferences([
    { id: 'a', label: 'A', links: { console: 'https://a/keys', docs: 'https://a/docs' }, keyExample: 'sk-a' },
    { id: 'b', label: 'B', links: { home: 'https://b' } },       // 无 console → 丢弃
    { id: 'c', label: 'C' },                                       // 无 links → 丢弃
    null, 'junk',
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, 'a');
  assert.equal(refs[0].console, 'https://a/keys');
  assert.equal(refs[0].keyExample, 'sk-a');
  assert.equal(refs[0].envVar, 'A_API_KEY');
});

test('buildKeyReferences 非数组入参 fail-soft 取真实 presets', () => {
  const refs = guide.buildKeyReferences('not-an-array');
  assert.ok(Array.isArray(refs));
  assert.ok(refs.length > 0); // 真实 presets 至少含 openai/deepseek 等带 console 的
  for (const r of refs) assert.ok(r.console.startsWith('http'));
});

test('buildGuide 标注 configured 且不改入参', () => {
  const presets = [
    { id: 'deepseek', label: 'DeepSeek', links: { console: 'https://x/keys' } },
    { id: 'openai', label: 'OpenAI', links: { console: 'https://y/keys' } },
  ];
  const g = guide.buildGuide({ presets, configured: ['DeepSeek'] });
  assert.equal(g.steps.length, 3);
  assert.ok(g.methods.length >= 4);
  const ds = g.providers.find((p) => p.id === 'deepseek');
  const oa = g.providers.find((p) => p.id === 'openai');
  assert.equal(ds.configured, true);
  assert.equal(oa.configured, false);
  // 入参未被改写
  assert.equal(presets[0].configured, undefined);
});

test('buildGuide 接受 Set 形式的 configured', () => {
  const g = guide.buildGuide({
    presets: [{ id: 'qwen', label: 'Qwen', links: { console: 'https://q/keys' } }],
    configured: new Set(['qwen']),
  });
  assert.equal(g.providers[0].configured, true);
});

test('renderGuide 返回非空行数组, 含三步与申请链接', () => {
  const g = guide.buildGuide({
    presets: [{ id: 'deepseek', label: 'DeepSeek', links: { console: 'https://x/keys', docs: 'https://x/docs' } }],
  });
  const lines = guide.renderGuide(g);
  assert.ok(Array.isArray(lines) && lines.length > 5);
  const text = lines.join('\n');
  assert.ok(text.includes('从这里开始'));
  assert.ok(text.includes('选择供应商'));
  assert.ok(text.includes('https://x/keys'));
  assert.ok(text.includes('khy gateway guide'));
});

test('renderGuide 无入参也安全(回落 buildGuide)', () => {
  const lines = guide.renderGuide();
  assert.ok(Array.isArray(lines) && lines.length > 0);
});

test('isEnabled / guideHintLine 门控默认开, off 回退空串', () => {
  const prev = process.env.KHY_GATEWAY_GUIDE;
  try {
    delete process.env.KHY_GATEWAY_GUIDE;
    assert.equal(guide.isEnabled(), true);
    assert.ok(guide.guideHintLine().includes('gateway guide'));
    for (const off of ['0', 'false', 'off', 'no']) {
      process.env.KHY_GATEWAY_GUIDE = off;
      assert.equal(guide.isEnabled(), false);
      assert.equal(guide.guideHintLine(), '');
    }
    process.env.KHY_GATEWAY_GUIDE = 'on';
    assert.equal(guide.isEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_GATEWAY_GUIDE;
    else process.env.KHY_GATEWAY_GUIDE = prev;
  }
});
