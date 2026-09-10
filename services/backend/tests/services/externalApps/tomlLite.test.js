'use strict';
/**
 * tomlLite �?零依�?TOML 读写子集单测(node:test)�?
 *
 * 目标契约:覆盖 DeepSeek-Reasonix / DeepSeek-TUI 配置里实际出现的全部 TOML 构�?
 * 并对本子集外的构造显式抛�?不静默写坏用户配�?。锁�?
 *   - 顶层标量(str/int/float/bool)+ 行内与整行注�?
 *   - 字符串数�?
 *   - 具名�?[ui] / 点分�?[providers.deepseek];
 *   - 表数�?[[providers]];
 *   - Reasonix config.toml 真实样例 parse→stringify→parse round-trip 逐字段等�?
 *   - 坏输入抛清晰错�?
 */
const toml = require('../../../src/services/domain/network/externalApps/tomlLite.js');

describe('Toml Lite', () => {
  test('parses top-level scalars with types', () => {
      const o = toml.parse([
        'config_version = 1',
        'default_model = "deepseek/deepseek-v4-flash"',
        'ratio = 1.5',
        'enabled = true',
        'disabled = false',
      ].join('\n'));
      expect(o.config_version).toBe(1);
      expect(o.default_model).toBe('deepseek/deepseek-v4-flash');
      expect(o.ratio).toBe(1.5);
      expect(o.enabled).toBe(true);
      expect(o.disabled).toBe(false);
  });

  test('strips full-line and inline comments (but not # inside strings)', () => {
      const o = toml.parse([
        '# leading comment',
        'a = "x"   # trailing comment',
        'b = "has # hash inside"',
      ].join('\n'));
      expect(o.a).toBe('x');
      expect(o.b).toBe('has # hash inside');
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
      expect(o.ui.theme).toBe('auto');
      expect(o.providers.deepseek.api_key).toBe('sk-abc');
      expect(o.providers.deepseek.base_url).toBe('https://api.deepseek.com/beta');
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
      expect(Array.isArray(o.providers).toBeTruthy());
      expect(o.providers.length).toBe(2);
      expect(o.providers[0].name).toBe('deepseek');
      assert.deepEqual(o.providers[0].models, ['a', 'b']);
      expect(o.providers[1].name).toBe('openai');
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
      expect(reparsed.providers[0].name).toBe('deepseek');
      expect(reparsed.providers[0].base_url).toBe('https://api.deepseek.com');
      assert.deepEqual(reparsed.providers[0].models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
      expect(reparsed.providers[0].api_key_env).toBe('DEEPSEEK_API_KEY');
      expect(reparsed.desktop.provider_access[0]).toBe('deepseek');
      expect(reparsed.agent.max_steps).toBe(0);
  });

  test('mutating a parsed doc then stringify+parse reflects the edit', () => {
      const doc = toml.parse('[[providers]]\nname = "deepseek"\nmodels = ["a"]');
      doc.providers.push({ name: 'openai', kind: 'openai', models: ['gpt-4.1'], api_key_env: 'OPENAI_API_KEY' });
      const back = toml.parse(toml.stringify(doc));
      expect(back.providers.length).toBe(2);
      expect(back.providers[1].name).toBe('openai');
      expect(back.providers[1].api_key_env).toBe('OPENAI_API_KEY');
  });

  test('parses an inline table', () => {
      const o = toml.parse('http_headers = { "X-Model-Provider-Id" = "your-model-provider", n = 1 }');
      expect(o.http_headers['X-Model-Provider-Id']).toBe('your-model-provider');
      expect(o.http_headers.n).toBe(1);
  });

  test('throws on an unrecognized line', () => {
      expect(() => toml.parse('this is not valid toml').toThrow(), /cannot parse line/);
  });

  test('throws on an unterminated array', () => {
      expect(() => toml.parse('models = ["a", "b"').toThrow(), /unterminated array/);
  });

  test('empty input parses to empty object; empty table round-trips', () => {
      assert.deepEqual(toml.parse(''), {});
      expect(toml.stringify({})).toBe('');
      assert.deepEqual(toml.parse(toml.stringify({})), {});
  });

});

