'use strict';

/**
 * tomlLite — 零依赖 TOML 读写子集单测(node:test)。
 *
 * 目标契约:覆盖 DeepSeek-Reasonix / DeepSeek-TUI 配置里实际出现的全部 TOML 构造,
 * 并对本子集外的构造显式抛错(不静默写坏用户配置)。锁定:
 *   - 顶层标量(str/int/float/bool)+ 行内与整行注释;
 *   - 字符串数组;
 *   - 具名表 [ui] / 点分表 [providers.deepseek];
 *   - 表数组 [[providers]];
 *   - Reasonix config.toml 真实样例 parse→stringify→parse round-trip 逐字段等价;
 *   - 坏输入抛清晰错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const toml = require('../../../src/services/externalApps/tomlLite');

test('parses top-level scalars with types', () => {
  const o = toml.parse([
    'config_version = 1',
    'default_model = "deepseek/deepseek-v4-flash"',
    'ratio = 1.5',
    'enabled = true',
    'disabled = false',
  ].join('\n'));
  assert.equal(o.config_version, 1);
  assert.equal(o.default_model, 'deepseek/deepseek-v4-flash');
  assert.equal(o.ratio, 1.5);
  assert.equal(o.enabled, true);
  assert.equal(o.disabled, false);
});

test('strips full-line and inline comments (but not # inside strings)', () => {
  const o = toml.parse([
    '# leading comment',
    'a = "x"   # trailing comment',
    'b = "has # hash inside"',
  ].join('\n'));
  assert.equal(o.a, 'x');
  assert.equal(o.b, 'has # hash inside');
});

test('parses a string array', () => {
  const o = toml.parse('models = ["deepseek-v4-flash", "deepseek-v4-pro"]');
  assert.deepEqual(o.models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
});

test('parses named tables and dotted tables', () => {
  const o = toml.parse([
    '[ui]',
    'theme = "auto"',
    '',
    '[providers.deepseek]',
    'api_key = "sk-abc"',
    'base_url = "https://api.deepseek.com/beta"',
  ].join('\n'));
  assert.equal(o.ui.theme, 'auto');
  assert.equal(o.providers.deepseek.api_key, 'sk-abc');
  assert.equal(o.providers.deepseek.base_url, 'https://api.deepseek.com/beta');
});

test('parses array-of-tables [[providers]]', () => {
  const o = toml.parse([
    '[[providers]]',
    'name = "deepseek"',
    'kind = "openai"',
    'models = ["a", "b"]',
    '',
    '[[providers]]',
    'name = "openai"',
    'kind = "openai"',
  ].join('\n'));
  assert.ok(Array.isArray(o.providers));
  assert.equal(o.providers.length, 2);
  assert.equal(o.providers[0].name, 'deepseek');
  assert.deepEqual(o.providers[0].models, ['a', 'b']);
  assert.equal(o.providers[1].name, 'openai');
});

test('round-trips the Reasonix config.toml sample field-for-field', () => {
  const original = [
    'config_version = 1',
    'default_model = "deepseek/deepseek-v4-flash"',
    'language = "zh"',
    '',
    '[ui]',
    'theme = "auto"',
    '',
    '[desktop]',
    'provider_access = ["deepseek"]',
    '',
    '[agent]',
    'auto_plan = "off"',
    'max_steps = 0',
    '',
    '[[providers]]',
    'name = "deepseek"',
    'kind = "openai"',
    'base_url = "https://api.deepseek.com"',
    'models = ["deepseek-v4-flash", "deepseek-v4-pro"]',
    'default = "deepseek-v4-flash"',
    'api_key_env = "DEEPSEEK_API_KEY"',
  ].join('\n');

  const parsed = toml.parse(original);
  const reparsed = toml.parse(toml.stringify(parsed));
  assert.deepEqual(reparsed, parsed);

  // Spot-check the critical provider fields survive the round-trip.
  assert.equal(reparsed.providers[0].name, 'deepseek');
  assert.equal(reparsed.providers[0].base_url, 'https://api.deepseek.com');
  assert.deepEqual(reparsed.providers[0].models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(reparsed.providers[0].api_key_env, 'DEEPSEEK_API_KEY');
  assert.equal(reparsed.desktop.provider_access[0], 'deepseek');
  assert.equal(reparsed.agent.max_steps, 0);
});

test('mutating a parsed doc then stringify+parse reflects the edit', () => {
  const doc = toml.parse('[[providers]]\nname = "deepseek"\nmodels = ["a"]');
  doc.providers.push({ name: 'openai', kind: 'openai', models: ['gpt-4.1'], api_key_env: 'OPENAI_API_KEY' });
  const back = toml.parse(toml.stringify(doc));
  assert.equal(back.providers.length, 2);
  assert.equal(back.providers[1].name, 'openai');
  assert.equal(back.providers[1].api_key_env, 'OPENAI_API_KEY');
});

test('parses an inline table', () => {
  const o = toml.parse('http_headers = { "X-Model-Provider-Id" = "your-model-provider", n = 1 }');
  assert.equal(o.http_headers['X-Model-Provider-Id'], 'your-model-provider');
  assert.equal(o.http_headers.n, 1);
});

test('throws on an unrecognized line', () => {
  assert.throws(() => toml.parse('this is not valid toml'), /cannot parse line/);
});

test('throws on an unterminated array', () => {
  assert.throws(() => toml.parse('models = ["a", "b"'), /unterminated array/);
});

test('empty input parses to empty object; empty table round-trips', () => {
  assert.deepEqual(toml.parse(''), {});
  assert.equal(toml.stringify({}), '');
  assert.deepEqual(toml.parse(toml.stringify({})), {});
});
