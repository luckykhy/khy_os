/**
 * Unit tests for customProviderForm — the pure logic behind CustomProviderCard's
 * add form (model-seed parsing + provider payload shape). Zero deps:
 *   node --test src/components/gateway/customProviderForm.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelSeed, validateProviderDraft, buildProviderPayload } from './customProviderForm.js';

test('parseModelSeed splits on comma / newline / semicolon / Chinese comma', () => {
  assert.deepEqual(parseModelSeed('a,b'), ['a', 'b']);
  assert.deepEqual(parseModelSeed('a，b；c'), ['a', 'b', 'c']);
  assert.deepEqual(parseModelSeed('a\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseModelSeed('a;b'), ['a', 'b']);
});

test('parseModelSeed trims and drops empties', () => {
  assert.deepEqual(parseModelSeed('  gpt-4o-mini ,, deepseek-chat , '), ['gpt-4o-mini', 'deepseek-chat']);
  assert.deepEqual(parseModelSeed(''), []);
  assert.deepEqual(parseModelSeed(null), []);
  assert.deepEqual(parseModelSeed(undefined), []);
});

test('parseModelSeed de-duplicates exact repeats, preserving first-seen order', () => {
  assert.deepEqual(parseModelSeed('a,b,a,c,b'), ['a', 'b', 'c']);
});

test('parseModelSeed keeps case-distinct ids (model ids are case-sensitive)', () => {
  assert.deepEqual(parseModelSeed('gpt-4o, GPT-4o'), ['gpt-4o', 'GPT-4o']);
});

test('validateProviderDraft requires provider and key', () => {
  assert.equal(validateProviderDraft({ provider: '', key: 'sk-1' }), '请填写 provider');
  assert.equal(validateProviderDraft({ provider: 'openai', key: '' }), '请填写 API Key');
  assert.equal(validateProviderDraft({ provider: '  ', key: '  ' }), '请填写 provider');
  assert.equal(validateProviderDraft({ provider: 'openai', key: 'sk-1' }), null);
});

test('buildProviderPayload lower-cases provider and always returns a models array', () => {
  const p = buildProviderPayload({ provider: 'OpenAI', displayName: 'Acme', key: ' sk-1 ' });
  assert.equal(p.provider, 'openai');
  assert.equal(p.displayName, 'Acme');
  assert.equal(p.key, 'sk-1');
  assert.deepEqual(p.models, []);
});

test('buildProviderPayload seeds models from the free-text field', () => {
  const p = buildProviderPayload({ provider: 'deepseek', key: 'sk-1', models: 'deepseek-chat, deepseek-reasoner' });
  assert.deepEqual(p.models, ['deepseek-chat', 'deepseek-reasoner']);
});

test('buildProviderPayload carries upstream metadata only when present', () => {
  const bare = buildProviderPayload({ provider: 'acme', key: 'sk-1' });
  assert.equal('baseUrl' in bare, false);
  assert.equal('apiFormat' in bare, false);
  assert.equal('endpoint' in bare, false);

  const full = buildProviderPayload({
    provider: 'acme', key: 'sk-1', baseUrl: 'https://x/v1', apiFormat: 'openai', endpoint: 'https://x/v1',
  });
  assert.equal(full.baseUrl, 'https://x/v1');
  assert.equal(full.apiFormat, 'openai');
  assert.equal(full.endpoint, 'https://x/v1');
});
