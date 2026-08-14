'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const sender = require('../../../src/services/messaging/msgSender');
const { DingTalkChannel } = require('../../../src/services/channels/dingtalkChannel');
const { FeishuChannel } = require('../../../src/services/channels/feishuChannel');
const { WecomChannel } = require('../../../src/services/channels/wecomChannel');
const crypto = require('crypto');

// deps 注入:assertUrl 恒放行,post 记录并返回可控应答
function fakeDeps(responder) {
  const calls = [];
  return {
    calls,
    deps: {
      assertUrl: async () => true,
      post: async (url, req) => { calls.push({ url, req }); return responder(url, req); },
    },
  };
}

// ── interpretResponse ──

test('interpretResponse:各平台成功/失败码', () => {
  assert.strictEqual(sender.interpretResponse('dingtalk', { status: 200, body: '{"errcode":0}' }).ok, true);
  assert.strictEqual(sender.interpretResponse('dingtalk', { status: 200, body: '{"errcode":310000,"errmsg":"sign not match"}' }).ok, false);
  assert.strictEqual(sender.interpretResponse('feishu', { status: 200, body: '{"code":0}' }).ok, true);
  assert.strictEqual(sender.interpretResponse('feishu', { status: 200, body: '{"StatusCode":0}' }).ok, true);
  assert.strictEqual(sender.interpretResponse('feishu', { status: 200, body: '{"code":19001,"msg":"bad"}' }).ok, false);
  assert.strictEqual(sender.interpretResponse('wecom', { status: 200, body: '{"errcode":0,"errmsg":"ok"}' }).ok, true);
  assert.strictEqual(sender.interpretResponse('wecom', { status: 500, body: '' }).ok, false);
  assert.strictEqual(sender.interpretResponse('dingtalk', { _err: 'boom' }).ok, false);
});

// ── sendText ──

test('sendText:成功路径 + 目标脱敏', async () => {
  const { calls, deps } = fakeDeps(() => ({ status: 200, body: '{"errcode":0}' }));
  const r = await sender.sendText({ platform: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=SECRET', secret: 'sk', text: 'hi', timestampMs: 1700000000000 }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.platform, 'dingtalk');
  assert.ok(!r.target.includes('SECRET'), '目标须脱敏');
  // 加签追加到 URL
  assert.ok(calls[0].url.includes('&timestamp=1700000000000&sign='), calls[0].url);
});

test('sendText:KHY_MSG 关闭 → 拒绝', async () => {
  const r = await sender.sendText({ platform: 'wecom', webhook: 'https://qyapi.weixin.qq.com/x', text: 'hi', env: { KHY_MSG: 'off' } });
  assert.strictEqual(r.ok, false);
});

test('sendText:非法入参 fail-soft', async () => {
  const { deps } = fakeDeps(() => ({ status: 200, body: '{}' }));
  const r = await sender.sendText({ platform: 'nope', webhook: 'https://a', text: 'x' }, deps);
  assert.strictEqual(r.ok, false);
});

test('sendText:SSRF 守卫拒绝 → ok:false 不发请求', async () => {
  const calls = [];
  const deps = {
    assertUrl: async () => { throw new Error('private target blocked'); },
    post: async (...a) => { calls.push(a); return { status: 200, body: '{}' }; },
  };
  const r = await sender.sendText({ platform: 'wecom', webhook: 'http://127.0.0.1/x', text: 'hi' }, deps);
  assert.strictEqual(r.ok, false);
  assert.ok(/安全守卫/.test(r.error), r.error);
  assert.strictEqual(calls.length, 0, 'SSRF 拒绝后不得发请求');
});

// ── channels: outbound via injected sender ──

test('DingTalkChannel.sendMessage:sessionWebhook 优先于配置 webhook', async () => {
  const ch = new DingTalkChannel({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=grp', secret: '' });
  const orig = sender.sendText;
  const seen = [];
  sender.sendText = async (input) => { seen.push(input); return { ok: true, platform: 'dingtalk', status: 200, target: 'x' }; };
  try {
    await ch.sendMessage('https://oapi.dingtalk.com/robot/sendBySession?access_token=sess', '回复');
    assert.strictEqual(seen[0].webhook, 'https://oapi.dingtalk.com/robot/sendBySession?access_token=sess');
    await ch.sendMessage(null, '广播');
    assert.strictEqual(seen[1].webhook, 'https://oapi.dingtalk.com/robot/send?access_token=grp');
  } finally {
    sender.sendText = orig;
  }
});

// ── channels: inbound ──

test('DingTalkChannel.handleInbound:验签 + emit message', () => {
  const secret = 'ds';
  const ch = new DingTalkChannel({ webhook: 'https://oapi.dingtalk.com/x', secret });
  const ts = '1700000000000';
  const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64');
  let got = null;
  ch.on('message', (m) => { got = m; });
  const r = ch.handleInbound({ timestamp: ts, sign }, { text: { content: '查库存' }, senderStaffId: 'u1', sessionWebhook: 'https://oapi.dingtalk.com/sess' });
  assert.strictEqual(r.ok, true);
  assert.ok(got);
  assert.strictEqual(got.text, '查库存');
  assert.strictEqual(got.channelId, 'https://oapi.dingtalk.com/sess');
});

test('DingTalkChannel.handleInbound:错签被拒,不 emit', () => {
  const ch = new DingTalkChannel({ webhook: 'https://x', secret: 'ds' });
  let emitted = false;
  ch.on('message', () => { emitted = true; });
  const r = ch.handleInbound({ timestamp: '1', sign: 'bad' }, { text: { content: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(emitted, false);
});

test('FeishuChannel.handleInbound:明文 challenge 透传', () => {
  const ch = new FeishuChannel({ webhook: 'https://open.feishu.cn/x' });
  const r = ch.handleInbound({ type: 'url_verification', challenge: 'CH1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'challenge');
  assert.strictEqual(r.challenge, 'CH1');
});

test('FeishuChannel.handleInbound:明文事件 emit message', () => {
  const ch = new FeishuChannel({ webhook: 'https://open.feishu.cn/x' });
  let got = null;
  ch.on('message', (m) => { got = m; });
  const evt = {
    header: { event_type: 'im.message.receive_v1' },
    event: { sender: { sender_id: { open_id: 'ou1' } }, message: { message_id: 'm1', chat_id: 'c1', content: JSON.stringify({ text: '你好' }) } },
  };
  const r = ch.handleInbound(evt);
  assert.strictEqual(r.ok, true);
  assert.ok(got);
  assert.strictEqual(got.text, '你好');
  assert.strictEqual(got.userId, 'ou1');
});

test('WecomChannel.handleInbound:GET echostr 校验 round-trip', () => {
  const token = 'wt';
  const aesKey = crypto.randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43);
  const key = Buffer.from(`${aesKey}=`, 'base64');
  const iv = key.slice(0, 16);
  // 独立加密 echostr
  const plain = 'ECHO';
  const random16 = Buffer.alloc(16, 1);
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(Buffer.byteLength(plain), 0);
  const raw = Buffer.concat([random16, lenBuf, Buffer.from(plain), Buffer.from('rid')]);
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv); cipher.setAutoPadding(false);
  const echostr = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  const sig = crypto.createHash('sha1').update([token, '1', 'n', echostr].sort().join(''), 'utf8').digest('hex');

  const ch = new WecomChannel({ webhook: 'https://qyapi.weixin.qq.com/x', token, encodingAesKey: aesKey });
  const r = ch.handleInbound({ timestamp: '1', nonce: 'n', msgSignature: sig, echostr });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'verify');
  assert.strictEqual(r.plaintext, plain);
});
