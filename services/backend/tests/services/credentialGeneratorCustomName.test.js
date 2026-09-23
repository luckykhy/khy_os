'use strict';

/**
 * credentialGenerator — first-login custom account name.
 *
 * 首次登录时用户可自定义账号名（khy.js ensureAuthenticated 询问后传入
 * customUsername）。本用例锁住解析优先级契约：
 *   env KHY_ADMIN_USERNAME > 既有凭据文件 > 校验通过的 customUsername
 *   > OS 用户名(小写化) > 'admin'
 * 以及 validateCustomUsername 的 2-32 位 [a-zA-Z0-9_-] 校验边界。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the data home BEFORE any credentialGenerator call so the real
// .khy / portable credentials file is never read or written.
const _tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-credgen-custom-'));
process.env.KHY_DATA_HOME = _tmpHome;
delete process.env.KHY_ADMIN_USERNAME;

const credGen = require('../../src/services/credentialGenerator');

test('validateCustomUsername: 合法 2-32 位 [a-zA-Z0-9_-] 原样保留(含大小写)', () => {
  assert.strictEqual(credGen.validateCustomUsername('Alice9'), 'Alice9');
  assert.strictEqual(credGen.validateCustomUsername(' a_b-1 '), 'a_b-1');
  assert.strictEqual(credGen.validateCustomUsername('ab'), 'ab');
  assert.strictEqual(credGen.validateCustomUsername('a'.repeat(32)), 'a'.repeat(32));
});

test('validateCustomUsername: 非法输入返回空串(不静默改写)', () => {
  assert.strictEqual(credGen.validateCustomUsername('a'), '');
  assert.strictEqual(credGen.validateCustomUsername('a'.repeat(33)), '');
  assert.strictEqual(credGen.validateCustomUsername('有 空格'), '');
  assert.strictEqual(credGen.validateCustomUsername('中文字'), '');
  assert.strictEqual(credGen.validateCustomUsername(''), '');
  assert.strictEqual(credGen.validateCustomUsername(undefined), '');
});

test('customUsername 高于 OS 用户, 但低于 env 固定值', () => {
  // Temp home has no credentials file → custom wins over the OS user
  assert.strictEqual(credGen.resolveDefaultAdminUsername({}, 'MyName1'), 'MyName1');
  // Env pin beats a custom argument
  assert.strictEqual(
    credGen.resolveDefaultAdminUsername({ KHY_ADMIN_USERNAME: 'envpin' }, 'MyName1'),
    'envpin'
  );
});

test('loadOrCreate: 首个 custom 名落盘, 之后文件优先(custom 不再生效)', () => {
  const created = credGen.loadOrCreateDefaultAdminCredentials({}, 'CustomAdmin');
  assert.strictEqual(created.username, 'CustomAdmin');
  assert.strictEqual(created.created, true);
  assert.ok(created.filePath && fs.existsSync(created.filePath));

  const again = credGen.loadOrCreateDefaultAdminCredentials({}, 'OtherName');
  assert.strictEqual(again.username, 'CustomAdmin');
  assert.strictEqual(again.created, false);
});

test('loadOrCreate: 非法 custom 名回退到 OS 用户(小写化)或 admin', () => {
  // Remove the file persisted by the previous test to force regeneration.
  const file = credGen.getDefaultAdminCredentialsPath();
  fs.rmSync(file, { force: true });
  const fallback = credGen.loadOrCreateDefaultAdminCredentials({}, 'x!y');
  const osName =
    (os.userInfo().username || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'admin';
  assert.strictEqual(fallback.username, osName);
});

test('清理临时数据目录', () => {
  fs.rmSync(_tmpHome, { recursive: true, force: true });
});
