'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 把底座数据家指向临时目录(必须在 require 存储层之前,getBaseHome 会缓存)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-msgcfg-'));
process.env.KHYOS_HOME = TMP_HOME;

const store = require('../../../src/services/messaging/msgConfigStore');

// KHYOS_HOME 覆盖时,getBaseDataDir('.') 直接解析到 KHYOS_HOME 本身。
function msgFile() { return path.join(TMP_HOME, 'msg.json'); }

beforeEach(() => {
  try { fs.rmSync(msgFile(), { force: true }); } catch { /* ignore */ }
});

test('未配置时:getPlatform=null, isConfigured=false', () => {
  assert.strictEqual(store.getPlatform('dingtalk'), null);
  assert.strictEqual(store.isConfigured(), false);
  assert.strictEqual(store.isConfigured('feishu'), false);
});

test('setPlatform + getPlatform round-trip(含别名归一)', () => {
  const r = store.setPlatform('dingding', { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 'sec' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.platform, 'dingtalk');
  assert.ok(!r.preview.includes('access_token=t'), 'preview 须遮蔽');

  const cfg = store.getPlatform('dingtalk');
  assert.strictEqual(cfg.webhook, 'https://oapi.dingtalk.com/robot/send?access_token=t');
  assert.strictEqual(cfg.secret, 'sec');
  assert.strictEqual(store.isConfigured('dingtalk'), true);
});

test('文件权限 0600', () => {
  store.setPlatform('feishu', { webhook: 'https://open.feishu.cn/x' });
  const mode = fs.statSync(msgFile()).mode & 0o777;
  assert.strictEqual(mode, 0o600, `实际 ${mode.toString(8)}`);
});

test('字段白名单:未知字段被拒绝入库', () => {
  store.setPlatform('wecom', { webhook: 'https://qyapi.weixin.qq.com/x', token: 'tk', encodingAesKey: 'k', evil: 'DROP TABLE' });
  const cfg = store.getPlatform('wecom');
  assert.strictEqual(cfg.token, 'tk');
  assert.strictEqual(cfg.encodingAesKey, 'k');
  assert.strictEqual(cfg.evil, undefined);
});

test('合并写:第二次 setPlatform 保留旧字段', () => {
  store.setPlatform('feishu', { webhook: 'https://open.feishu.cn/x', secret: 's1' });
  store.setPlatform('feishu', { encryptKey: 'ek1' });
  const cfg = store.getPlatform('feishu');
  assert.strictEqual(cfg.webhook, 'https://open.feishu.cn/x');
  assert.strictEqual(cfg.secret, 's1');
  assert.strictEqual(cfg.encryptKey, 'ek1');
});

test('空串字段 → 删除该字段', () => {
  store.setPlatform('feishu', { webhook: 'https://open.feishu.cn/x', secret: 's1' });
  store.setPlatform('feishu', { secret: '' });
  assert.strictEqual(store.getPlatform('feishu').secret, undefined);
});

test('缺 webhook → 拒绝', () => {
  const r = store.setPlatform('dingtalk', { secret: 'x' });
  assert.strictEqual(r.ok, false);
});

test('多平台并存 + listConfigured 遮蔽', () => {
  store.setPlatform('dingtalk', { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=aaa', secret: 's' });
  store.setPlatform('wecom', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bbb' });
  const list = store.listConfigured();
  assert.strictEqual(list.length, 2);
  for (const item of list) {
    assert.ok(!/aaa|bbb/.test(item.webhook), `${item.webhook} 未遮蔽`);
  }
  assert.strictEqual(list.find((x) => x.platform === 'dingtalk').hasSecret, true);
});

test('clearPlatform 单平台 + 全清', () => {
  store.setPlatform('dingtalk', { webhook: 'https://a/x' });
  store.setPlatform('feishu', { webhook: 'https://b/x' });
  store.clearPlatform('dingtalk');
  assert.strictEqual(store.getPlatform('dingtalk'), null);
  assert.strictEqual(store.getPlatform('feishu').webhook, 'https://b/x');
  store.clearPlatform();
  assert.strictEqual(store.isConfigured(), false);
});

test('损坏文件 fail-soft', () => {
  fs.mkdirSync(path.dirname(msgFile()), { recursive: true });
  fs.writeFileSync(msgFile(), '{ not json');
  assert.strictEqual(store.getPlatform('dingtalk'), null);
  assert.strictEqual(store.isConfigured(), false);
});
