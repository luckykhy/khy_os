'use strict';

/**
 * 凭据加固 — 纯逻辑测试(node:test)。
 *
 * 锁定两处与「明文凭据」相关的防线:
 *   1. apiKeyPool 的凭据文件权限(默认 0600,且保留显式回退退路)
 *   2. channelApiCrypto 的严格模式(未配置主 KEK 时拒绝回退到主机名派生密钥)
 *
 * 这两条都属于「静默降级比报错更危险」的情形:降级时功能照常可用,
 * 只有真出事时才会发现密钥是弱的。所以用测试把口径钉死。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../src/services/apiKeyPool.js');
const channelCrypto = require('../../src/services/channelApiCrypto.js');

// ── 凭据文件权限 ────────────────────────────────────────────────────────────

test('resolveCredentialsFileMode: 默认 0600(不再世界可读)', () => {
  assert.equal(pool.resolveCredentialsFileMode({}), 0o600);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '' }), 0o600);
});

test('resolveCredentialsFileMode: 可显式回退 666(共享目录部署留退路)', () => {
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '666' }), 0o666);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '600' }), 0o600);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '640' }), 0o640);
});

test('resolveCredentialsFileMode: 非法值回退默认,绝不抛', () => {
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: 'abc' }), 0o600);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '0' }), 0o600);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '999' }), 0o600);
  assert.equal(pool.resolveCredentialsFileMode({ KHY_CREDENTIALS_FILE_MODE: '-1' }), 0o600);
});

// ── 渠道密钥严格模式 ────────────────────────────────────────────────────────

test('resolveSecret: 显式配置 env → 直接采用,fromEnv=true', () => {
  const r = channelCrypto.resolveSecret({ [channelCrypto.KEY_SECRET_ENV]: 'explicit-secret' });
  assert.equal(r.fromEnv, true);
  assert.equal(r.secret, 'explicit-secret');
});

test('resolveSecret: 严格模式 + 未配置 env → 抛错,不回退弱密钥', () => {
  assert.throws(
    () => channelCrypto.resolveSecret({ [channelCrypto.KEY_SECRET_STRICT_ENV]: '1' }),
    /KHY_CHANNEL_KEY_SECRET/
  );
});

test('resolveSecret: 严格模式开关识别 1/true/yes/on', () => {
  for (const v of ['1', 'true', 'YES', 'on']) {
    assert.throws(
      () => channelCrypto.resolveSecret({ [channelCrypto.KEY_SECRET_STRICT_ENV]: v }),
      /KHY_CHANNEL_KEY_SECRET/,
      `严格值 ${v} 应触发拒绝`
    );
  }
});

test('resolveSecret: 严格模式关闭 + 未配置 env → 回退且 fromEnv=false', () => {
  const r = channelCrypto.resolveSecret({ [channelCrypto.KEY_SECRET_STRICT_ENV]: '0' });
  assert.equal(r.fromEnv, false);
  assert.equal(typeof r.secret, 'string');
  assert.ok(r.secret.length > 0);
});

test('resolveSecret: 严格模式下配置了 env 仍正常工作', () => {
  const r = channelCrypto.resolveSecret({
    [channelCrypto.KEY_SECRET_ENV]: 'explicit',
    [channelCrypto.KEY_SECRET_STRICT_ENV]: '1',
  });
  assert.equal(r.fromEnv, true);
  assert.equal(r.secret, 'explicit');
});
