'use strict';

/**
 * codexAdapter.tomlEditing.test.js — locks the pure TOML editing helpers that
 * power setCodexUpstream() in src/services/gateway/adapters/codexAdapter.js,
 * exposed via the `__test__` export:
 *
 *   - sanitizeProviderName: cc-switch-compatible provider-name sanitizer;
 *   - upsertPreambleKey:  replaces/adds a top-level `key = value` pair ONLY in
 *     the preamble (before the first [section]), never touching section bodies;
 *   - removeTomlSection: drops one [section] table (header + body) and keeps
 *     every other table byte-intact.
 *
 * Zero network, zero disk (pure string in → string out). Who changes the
 * preamble-only rewrite or the section-removal boundaries goes red first —
 * those feed codex config.toml live-writes that must never clobber unrelated
 * user config.
 */
const {
  __test__: { sanitizeProviderName, upsertPreambleKey, removeTomlSection },
} = require('../../src/services/gateway/adapters/codexAdapter');

describe('codexAdapter TOML editing helpers (pure seams)', () => {
  test('sanitizeProviderName: 小写 + 非法字符转下划线 + 去首尾下划线，空 → custom', () => {
    expect(sanitizeProviderName('Mind-Flow!')).toBe('mind_flow');
    expect(sanitizeProviderName('My Provider')).toBe('my_provider');
    expect(sanitizeProviderName('ab__cd..ef')).toBe('ab__cd__ef');
    expect(sanitizeProviderName('___x___')).toBe('x');
    expect(sanitizeProviderName('')).toBe('custom');
    expect(sanitizeProviderName('!!')).toBe('custom');
  });

  test('upsertPreambleKey: 已有键就地替换，section 正文中的同名键不动', () => {
    const content = [
      'model_provider = "old"',
      'model = "o4-mini"',
      '[model_providers.mindflow]',
      'model_provider = "nested-must-survive"',
      'base_url = "https://relay.example/v1"',
      '',
    ].join('\n');

    const out = upsertPreambleKey(content, 'model_provider', '"new"');
    const lines = out.split('\n');
    expect(lines[0]).toBe('model_provider = "new"');
    expect(out).toContain('model_provider = "nested-must-survive"');
    // section body untouched
    expect(out).toContain('[model_providers.mindflow]');
    expect(out).toContain('base_url = "https://relay.example/v1"');
    // no duplicated preamble line: the old value is gone, new one in place
    expect(out).not.toContain('model_provider = "old"');
    expect(lines[0]).toBe('model_provider = "new"');
  });

  test('upsertPreambleKey: 新键插入到第一个 section 之前（保持 section 顺序）', () => {
    const content = [
      'model = "o4-mini"',
      '[model_providers.x]',
      'base_url = "https://x.example/v1"',
      '[model_providers.y]',
      'base_url = "https://y.example/v1"',
      '',
    ].join('\n');

    const out = upsertPreambleKey(content, 'model_reasoning_effort', '"high"');
    const lines = out.split('\n');
    const keyIdx = lines.findIndex((l) => l.startsWith('model_reasoning_effort ='));
    const sectionIdx = lines.findIndex((l) => l.startsWith('[model_providers.x]'));
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBeLessThan(sectionIdx);
    expect(lines[keyIdx]).toBe('model_reasoning_effort = "high"');
    // replacing an existing key does not add a second line
    const out2 = upsertPreambleKey(content, 'model', '"o3"');
    expect(out2.match(/^model = /gm)).toHaveLength(1);
    expect(out2).toContain('model = "o3"');
  });

  test('upsertPreambleKey: 无 section 时追加到文件尾', () => {
    const out = upsertPreambleKey('model = "o4-mini"\n', 'profile', '"fast"');
    // the input's trailing newline yields an empty line; new key appends after it
    expect(out.split('\n')).toEqual(['model = "o4-mini"', '', 'profile = "fast"']);
  });

  test('removeTomlSection: 删除目标表（含正文），其余表逐字节保留', () => {
    const content = [
      'a = 1',
      '[model_providers.x]',
      'base_url = "https://x.example/v1"',
      'wire_api = "chat"',
      '[model_providers.y]',
      'base_url = "https://y.example/v1"',
      '',
    ].join('\n');

    const out = removeTomlSection(content, 'model_providers.x');
    expect(out).not.toContain('[model_providers.x]');
    expect(out).not.toContain('wire_api');
    expect(out).toContain('a = 1');
    expect(out).toContain('[model_providers.y]');
    expect(out).toContain('base_url = "https://y.example/v1"');
  });

  test('removeTomlSection: 表不存在 → 内容不变（幂等安全）', () => {
    const content = 'a = 1\n[other]\nb = 2\n';
    expect(removeTomlSection(content, 'nope')).toBe(content);
  });
});
