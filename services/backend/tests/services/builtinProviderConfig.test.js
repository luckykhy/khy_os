'use strict';

/**
 * builtinProviderConfig.test.js — service single source of truth for the
 * built-in provider catalog + the non-interactive key-apply path used by both
 * the CLI/TUI flow and the agent tool.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILTIN_PROVIDERS,
  listBuiltinProviders,
  findBuiltinProvider,
  applyBuiltinProviderKey,
} = require('../../src/services/gateway/builtinProviderConfig');

/** A fake apiKeyPool that records addKey calls instead of touching disk. */
function fakePool() {
  const added = [];
  return {
    added,
    init() {},
    addKey(poolKey, entry) { added.push({ poolKey, entry }); },
    getPoolStatus() { return []; },
  };
}

/** A fake gatewayEnvFile that records writes instead of touching .env. */
function fakeEnv() {
  const envWrites = {};
  const merges = [];
  const unsets = [];
  return {
    envWrites, merges, unsets,
    writeEnvMap(map) { Object.assign(envWrites, map); },
    unsetEnvKeys(keys) { unsets.push(...keys); },
    mergeJsonEnvVar(key, entries) { merges.push({ key, entries }); },
  };
}

describe('builtinProviderConfig catalog', () => {
  test('catalog is non-empty and listBuiltinProviders returns copies', () => {
    assert.ok(BUILTIN_PROVIDERS.length >= 8);
    const list = listBuiltinProviders();
    list[0].name = 'MUTATED';
    assert.notEqual(BUILTIN_PROVIDERS[0].name, 'MUTATED', 'must return fresh copies');
  });

  test('findBuiltinProvider matches by poolKey, exact name, and alias token', () => {
    assert.equal(findBuiltinProvider('deepseek').poolKey, 'deepseek');
    assert.equal(findBuiltinProvider('DeepSeek').poolKey, 'deepseek');
    assert.equal(findBuiltinProvider('通义千问 (Qwen)').poolKey, 'qwen');
    assert.equal(findBuiltinProvider('qwen').poolKey, 'qwen');
    assert.equal(findBuiltinProvider('claude').poolKey, 'anthropic'); // alias token
    assert.equal(findBuiltinProvider('nope-not-real'), null);
    assert.equal(findBuiltinProvider(''), null);
  });
});

describe('applyBuiltinProviderKey', () => {
  test('deepseek + model writes pool key, env key/endpoint, and three route maps', () => {
    const pool = fakePool();
    const env = fakeEnv();
    const res = applyBuiltinProviderKey(
      { provider: 'deepseek', keyInput: 'sk-test-123', model: 'deepseek-chat' },
      { pool, env },
    );

    assert.equal(res.poolKey, 'deepseek');
    assert.equal(res.added, 1);
    assert.equal(res.duplicate, 0);
    assert.equal(res.model, 'deepseek-chat');

    // pool got the key under the right poolKey
    assert.equal(pool.added.length, 1);
    assert.equal(pool.added[0].poolKey, 'deepseek');
    assert.equal(pool.added[0].entry.key, 'sk-test-123');

    // env got DEEPSEEK_API_KEY + DEEPSEEK_API_ENDPOINT
    assert.equal(env.envWrites.DEEPSEEK_API_KEY, 'sk-test-123');
    assert.equal(env.envWrites.DEEPSEEK_API_ENDPOINT, 'https://api.deepseek.com/v1');

    // three route maps merged when a model is chosen
    const mergedKeys = env.merges.map((m) => m.key);
    assert.ok(mergedKeys.includes('GATEWAY_API_POOL_SERVICE_MAP'));
    assert.ok(mergedKeys.includes('GATEWAY_API_POOL_DEFAULT_MODEL_MAP'));
    assert.ok(mergedKeys.includes('PROXY_MODEL_ROUTE_MAP'));
  });

  test('without a model, no route maps are written (key still persisted)', () => {
    const pool = fakePool();
    const env = fakeEnv();
    applyBuiltinProviderKey({ provider: 'openai', keyInput: 'sk-openai' }, { pool, env });
    assert.equal(env.envWrites.OPENAI_API_KEY, 'sk-openai');
    assert.equal(env.merges.length, 0, 'no route maps without a chosen model');
  });

  test('isToken provider (HuggingFace) only writes the env token, no pool', () => {
    const pool = fakePool();
    const env = fakeEnv();
    const res = applyBuiltinProviderKey({ provider: 'HuggingFace', keyInput: 'hf_token_abc' }, { pool, env });
    assert.equal(res.token, true);
    assert.equal(pool.added.length, 0);
    assert.equal(env.envWrites.HF_TOKEN, 'hf_token_abc');
  });

  test('rejects unknown provider and empty key', () => {
    assert.throws(() => applyBuiltinProviderKey({ provider: 'nope', keyInput: 'k' }, { pool: fakePool(), env: fakeEnv() }), /未知的内置厂商/);
    assert.throws(() => applyBuiltinProviderKey({ provider: 'deepseek', keyInput: '' }, { pool: fakePool(), env: fakeEnv() }), /未输入 API Key/);
  });
});
