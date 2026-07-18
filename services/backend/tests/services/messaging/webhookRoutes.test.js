'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 独立底座数据家 + 配好三平台(必须在 require 存储/路由前)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-webhook-'));
process.env.KHYOS_HOME = TMP_HOME;
process.env.KHY_MSG = 'true';

const AES_KEY_43 = crypto.randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43);
const DING_SECRET = 'ding-inbound-secret';
const WECOM_TOKEN = 'wecom-token';

const store = require('../../../src/services/messaging/msgConfigStore');
store.setPlatform('dingtalk', { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: DING_SECRET });
store.setPlatform('feishu', { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' });
store.setPlatform('wecom', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', token: WECOM_TOKEN, encodingAesKey: AES_KEY_43 });

const express = require('express');
const request = require('supertest');
const { getMessageRouter } = require('../../../src/services/channels/messageRouter');

let app;

before(() => {
  // 触发 bootstrap(读 store 注册三平台)。
  getMessageRouter();
  app = express();
  app.use('/webhooks', require('../../../src/routes/webhooks'));
});

test('bootstrap 注册了 dingtalk/feishu/wecom 三渠道', () => {
  const names = getMessageRouter().getChannels().map((c) => c.name).sort();
  for (const p of ['dingtalk', 'feishu', 'wecom']) {
    assert.ok(names.includes(p), `缺渠道 ${p}:${names}`);
  }
});

test('POST /webhooks/dingtalk:有效签名 → 200', async () => {
  const ts = '1700000000000';
  const sign = crypto.createHmac('sha256', DING_SECRET).update(`${ts}\n${DING_SECRET}`, 'utf8').digest('base64');
  const res = await request(app)
    .post('/webhooks/dingtalk')
    .set('Content-Type', 'application/json')
    .set('timestamp', ts)
    .set('sign', sign)
    .send(JSON.stringify({ text: { content: '查库存' }, senderStaffId: 'u1' }));
  assert.strictEqual(res.status, 200);
});

test('POST /webhooks/dingtalk:错误签名 → 401', async () => {
  const res = await request(app)
    .post('/webhooks/dingtalk')
    .set('Content-Type', 'application/json')
    .set('timestamp', '1')
    .set('sign', 'wrong')
    .send(JSON.stringify({ text: { content: 'x' } }));
  assert.strictEqual(res.status, 401);
});

test('POST /webhooks/feishu:url_verification challenge 回显', async () => {
  const res = await request(app)
    .post('/webhooks/feishu')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ type: 'url_verification', challenge: 'CHAL42' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.challenge, 'CHAL42');
});

test('GET /webhooks/wecom:echostr 校验回明文', async () => {
  const key = Buffer.from(`${AES_KEY_43}=`, 'base64');
  const iv = key.slice(0, 16);
  const plain = 'VERIFY_OK';
  const random16 = Buffer.alloc(16, 2);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(Buffer.byteLength(plain), 0);
  const raw = Buffer.concat([random16, lenBuf, Buffer.from(plain), Buffer.from('rid')]);
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); cipher.setAutoPadding(false);
  const echostr = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  const sig = crypto.createHash('sha1').update([WECOM_TOKEN, '100', 'nn', echostr].sort().join(''), 'utf8').digest('hex');

  const res = await request(app)
    .get('/webhooks/wecom')
    .query({ msg_signature: sig, timestamp: '100', nonce: 'nn', echostr });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, plain);
});

test('GET /webhooks/wecom:错误签名 → 401', async () => {
  const res = await request(app)
    .get('/webhooks/wecom')
    .query({ msg_signature: 'deadbeef', timestamp: '1', nonce: 'n', echostr: 'AAAA' });
  assert.strictEqual(res.status, 401);
});
