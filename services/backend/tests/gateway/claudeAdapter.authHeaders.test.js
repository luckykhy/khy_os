'use strict';

/**
 * claudeAdapter.authHeaders.test.js — locks the Anthropic credential/auth-header
 * pure-logic seams of src/services/gateway/adapters/claudeAdapter.js:
 *
 *   - resolveAnthropicCredentialFromEnv: env precedence
 *     ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > CLAUDE_API_KEY, source tracking,
 *     "Bearer" prefix stripping (via apiKeyFormat.extractPrimaryApiKey);
 *   - resolveAnthropicAuthScheme: source-aware header choice
 *     (ANTHROPIC_AUTH_TOKEN → Bearer, anything else → x-api-key) plus the
 *     ANTHROPIC_AUTH_SCHEME compatibility override;
 *   - buildAnthropicAuthHeaders: bearer / x-api-key / both header shapes;
 *   - bridgeToolUseRawInputEnabled: KHY_BRIDGE_TOOLUSE_RAW_INPUT gate values.
 *
 * Zero network, zero disk: every seam is a pure function reachable through
 * the adapter's `__test__` export (plain functions, no module state).
 * Who changes the precedence order, the source→scheme mapping, or the header
 * shapes goes red first.
 */
const adapter = require('../../src/services/gateway/adapters/claudeAdapter');

const {
  resolveAnthropicCredentialFromEnv,
  resolveAnthropicAuthScheme,
  buildAnthropicAuthHeaders,
  bridgeToolUseRawInputEnabled,
} = adapter.__test__;

describe('claudeAdapter credential resolution (offline pure seams)', () => {
  test('env 优先级: ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN > CLAUDE_API_KEY', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-primary',
      ANTHROPIC_AUTH_TOKEN: 'relay-token',
      CLAUDE_API_KEY: 'claude-last',
    };
    expect(resolveAnthropicCredentialFromEnv(env)).toEqual({
      apiKey: 'sk-ant-primary',
      source: 'ANTHROPIC_API_KEY',
    });

    expect(resolveAnthropicCredentialFromEnv({ ...env, ANTHROPIC_API_KEY: undefined })).toEqual({
      apiKey: 'relay-token',
      source: 'ANTHROPIC_AUTH_TOKEN',
    });

    expect(
      resolveAnthropicCredentialFromEnv({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_API_KEY: 'claude-last',
      })
    ).toEqual({ apiKey: 'claude-last', source: 'CLAUDE_API_KEY' });
  });

  test('空 env → 双 null（纯函数，永不抛）', () => {
    expect(resolveAnthropicCredentialFromEnv({})).toEqual({ apiKey: null, source: null });
    // whitespace-only values count as absent
    expect(resolveAnthropicCredentialFromEnv({ ANTHROPIC_API_KEY: '  ' })).toEqual({
      apiKey: null,
      source: null,
    });
  });

  test('值里的 Bearer 前缀被剥离（extractPrimaryApiKey 清洗）', () => {
    const env = { ANTHROPIC_AUTH_TOKEN: 'Bearer sk-relay-key' };
    expect(resolveAnthropicCredentialFromEnv(env)).toEqual({
      apiKey: 'sk-relay-key',
      source: 'ANTHROPIC_AUTH_TOKEN',
    });
  });

  test('auth scheme 自动判定: AUTH_TOKEN 源 → bearer，其余 → x-api-key', () => {
    expect(resolveAnthropicAuthScheme('ANTHROPIC_AUTH_TOKEN', {})).toBe('bearer');
    expect(resolveAnthropicAuthScheme('ANTHROPIC_API_KEY', {})).toBe('x-api-key');
    expect(resolveAnthropicAuthScheme('CLAUDE_API_KEY', {})).toBe('x-api-key');
    expect(resolveAnthropicAuthScheme('pool', {})).toBe('x-api-key');
    expect(resolveAnthropicAuthScheme(null, {})).toBe('x-api-key');
  });

  test('ANTHROPIC_AUTH_SCHEME 覆盖值优先于自动判定', () => {
    const env = { ANTHROPIC_AUTH_SCHEME: 'both' };
    expect(resolveAnthropicAuthScheme('ANTHROPIC_AUTH_TOKEN', env)).toBe('both');
    expect(resolveAnthropicAuthScheme('ANTHROPIC_API_KEY', env)).toBe('both');

    expect(resolveAnthropicAuthScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'x-api-key' })).toBe(
      'x-api-key'
    );
    expect(
      resolveAnthropicAuthScheme('ANTHROPIC_API_KEY', { ANTHROPIC_AUTH_SCHEME: 'bearer' })
    ).toBe('bearer');
  });

  test('ANTHROPIC_AUTH_SCHEME 非法值 → 回退自动判定', () => {
    expect(resolveAnthropicAuthScheme('ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_SCHEME: 'weird' })).toBe(
      'bearer'
    );
    expect(
      resolveAnthropicAuthScheme('ANTHROPIC_API_KEY', { ANTHROPIC_AUTH_SCHEME: 'WEIRD' })
    ).toBe('x-api-key');
  });

  test('header 构建: bearer / x-api-key / both 三种形状', () => {
    expect(buildAnthropicAuthHeaders('sk-x', 'bearer')).toEqual({
      Authorization: 'Bearer sk-x',
    });
    expect(buildAnthropicAuthHeaders('sk-x', 'x-api-key')).toEqual({ 'x-api-key': 'sk-x' });
    expect(buildAnthropicAuthHeaders('sk-x', 'both')).toEqual({
      'x-api-key': 'sk-x',
      Authorization: 'Bearer sk-x',
    });
    // unknown scheme falls back to the official x-api-key shape (byte-identical legacy)
    expect(buildAnthropicAuthHeaders('sk-x', '')).toEqual({ 'x-api-key': 'sk-x' });
    expect(buildAnthropicAuthHeaders('sk-x', undefined)).toEqual({ 'x-api-key': 'sk-x' });
  });

  test('bridge rawInput 门: 默认开，0/false/off/no 关', () => {
    expect(bridgeToolUseRawInputEnabled({})).toBe(true);
    expect(bridgeToolUseRawInputEnabled({ KHY_BRIDGE_TOOLUSE_RAW_INPUT: '1' })).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(bridgeToolUseRawInputEnabled({ KHY_BRIDGE_TOOLUSE_RAW_INPUT: off })).toBe(false);
    }
    // trim + lowercase
    expect(bridgeToolUseRawInputEnabled({ KHY_BRIDGE_TOOLUSE_RAW_INPUT: ' OFF ' })).toBe(false);
  });
});
