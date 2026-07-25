/**
 * gatewayGuide 纯逻辑单测(apps/ai-frontend 为 type:module,用内置 Node 运行器):
 *   node --test src/components/gateway/gatewayGuide.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GATEWAY_STEPS, CONFIG_METHODS, buildKeyReferences, buildGuide } from './gatewayGuide.js';

test('GATEWAY_STEPS / CONFIG_METHODS 结构完整', () => {
  assert.equal(GATEWAY_STEPS.length, 3);
  for (const s of GATEWAY_STEPS) {
    assert.equal(typeof s.n, 'number');
    assert.ok(s.title && s.desc);
  }
  assert.ok(CONFIG_METHODS.length >= 4);
  const keys = CONFIG_METHODS.map((m) => m.key);
  for (const k of ['direct', 'relay', 'ollama', 'oauth']) assert.ok(keys.includes(k), `缺方式 ${k}`);
  for (const m of CONFIG_METHODS) assert.ok(m.label && m.when && m.how);
});

test('buildKeyReferences 仅保留有 console 链接的 provider', () => {
  const refs = buildKeyReferences([
    { id: 'a', label: 'A', links: { console: 'https://a/keys', docs: 'https://a/docs' }, keyExample: 'sk-a' },
    { id: 'b', label: 'B', links: { home: 'https://b' } },   // 无 console → 丢弃
    { id: 'c', label: 'C' },                                  // 无 links → 丢弃
    null, 'junk', 42,
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, 'a');
  assert.equal(refs[0].console, 'https://a/keys');
  assert.equal(refs[0].docs, 'https://a/docs');
  assert.equal(refs[0].keyExample, 'sk-a');
});

test('buildKeyReferences 非数组入参 fail-soft → []', () => {
  assert.deepEqual(buildKeyReferences(undefined), []);
  assert.deepEqual(buildKeyReferences(null), []);
  assert.deepEqual(buildKeyReferences('x'), []);
  assert.deepEqual(buildKeyReferences({}), []);
});

test('buildKeyReferences 不改入参', () => {
  const presets = [{ id: 'a', label: 'A', links: { console: 'https://a/keys' } }];
  const snapshot = JSON.stringify(presets);
  buildKeyReferences(presets);
  assert.equal(JSON.stringify(presets), snapshot);
});

test('buildGuide 组装三步/方式/providers', () => {
  const g = buildGuide({ presets: [{ id: 'deepseek', label: 'DeepSeek', links: { console: 'https://x/keys' } }] });
  assert.ok(g.intro);
  assert.equal(g.steps.length, 3);
  assert.ok(g.methods.length >= 4);
  assert.equal(g.providers.length, 1);
  assert.equal(g.providers[0].id, 'deepseek');
});

test('buildGuide 无 presets → providers 为空数组', () => {
  const g = buildGuide();
  assert.deepEqual(g.providers, []);
  assert.equal(g.steps.length, 3);
});
