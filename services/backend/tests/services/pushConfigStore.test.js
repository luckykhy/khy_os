'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// KHYOS_HOME 必须在 require dataHome 之前设置(首次 getBaseHome 会缓存)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-push-'));
process.env.KHYOS_HOME = TMP_HOME;

const store = require('../../src/services/pushConfigStore');
const { getBaseDataDir } = require('../../src/utils/dataHome');

const DATA_DIR = getBaseDataDir('.');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const PUSH_BAK = path.join(DATA_DIR, 'push.bak');

test('getConfig: missing -> null, isConfigured false', () => {
  assert.strictEqual(store.getConfig(), null);
  assert.strictEqual(store.isConfigured(), false);
});

test('setConfig: round-trip + masked preview + 0600 perms', () => {
  const res = store.setConfig('ntfy', 'my-secret-topic');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.provider, 'ntfy');
  assert.ok(!res.preview.includes('my-secret-topic'));

  const cfg = store.getConfig();
  assert.strictEqual(cfg.provider, 'ntfy');
  assert.strictEqual(cfg.target, 'my-secret-topic');
  assert.ok(cfg.updatedAt);
  assert.ok(store.isConfigured());

  // 0600 权限(屏蔽平台差异只看低 9 位)
  const mode = fs.statSync(PUSH_FILE).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('setConfig: bad provider / empty target -> error, no write', () => {
  assert.strictEqual(store.setConfig('telegram', 'x').ok, false);
  assert.strictEqual(store.setConfig('ntfy', '   ').ok, false);
  // 既有配置不被破坏
  assert.strictEqual(store.getConfig().provider, 'ntfy');
});

test('setConfig: overwrite keeps .bak of previous', () => {
  store.setConfig('discord', 'https://discord.com/api/webhooks/1/oldtoken');
  const res = store.setConfig('discord', 'https://discord.com/api/webhooks/1/newtoken');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store.getConfig().target, 'https://discord.com/api/webhooks/1/newtoken');
  assert.ok(fs.existsSync(PUSH_BAK));
  assert.strictEqual(fs.statSync(PUSH_BAK).mode & 0o777, 0o600);
});

test('clearConfig: removes config, fail-soft when absent', () => {
  assert.strictEqual(store.clearConfig().ok, true);
  assert.strictEqual(store.getConfig(), null);
  // 再清一次仍 ok(force)
  assert.strictEqual(store.clearConfig().ok, true);
});

test('getConfig: corrupt file -> null (fail-soft)', () => {
  fs.writeFileSync(PUSH_FILE, '{ not valid json', 'utf-8');
  assert.strictEqual(store.getConfig(), null);
  fs.rmSync(PUSH_FILE, { force: true });
});
