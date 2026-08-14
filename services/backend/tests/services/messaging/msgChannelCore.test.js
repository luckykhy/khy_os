'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const core = require('../../../src/services/messaging/msgChannelCore');

// 固定向量:secret='SECbenchmark', timestampMs=1700000000000
const SECRET = 'SECbenchmark';
const TS_MS = 1700000000000;
const DING_SIGN = '%2FBzvcoWPp2YUoAF9Yy1Ug0uhjOR54GROqiYP5dpapdg%3D';
const FEISHU_SIGN = 'bYRQSyB8YMYnSGfp53GnejKUjl/LT2ncUKdpZxqsU7s=';

test('isEnabled: 默认开;off-words 关;大小写空白不敏感', () => {
  assert.strictEqual(core.isEnabled({}), true);
  assert.strictEqual(core.isEnabled({ KHY_MSG: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.strictEqual(core.isEnabled({ KHY_MSG: off }), false, `期望 ${off} 关`);
  }
});

test('normalizePlatform: 别名归一', () => {
  assert.strictEqual(core.normalizePlatform('dingding'), 'dingtalk');
  assert.strictEqual(core.normalizePlatform('LARK'), 'feishu');
  assert.strictEqual(core.normalizePlatform('wechat'), 'wecom');
  assert.strictEqual(core.normalizePlatform('qywx'), 'wecom');
  assert.strictEqual(core.normalizePlatform('unknown'), null);
  assert.strictEqual(core.isValidPlatform('feishu'), true);
  assert.strictEqual(core.isValidPlatform('x'), false);
});

test('钉钉签名 = 已知固定向量', () => {
  assert.strictEqual(core._dingtalkSign(SECRET, TS_MS), DING_SIGN);
});

test('飞书签名 = 已知固定向量', () => {
  assert.strictEqual(core._feishuSign(SECRET, Math.floor(TS_MS / 1000)), FEISHU_SIGN);
});

test('签名确定性 + 敏感性(改 secret/时间戳→签名变)', () => {
  assert.strictEqual(core._dingtalkSign(SECRET, TS_MS), core._dingtalkSign(SECRET, TS_MS));
  assert.notStrictEqual(core._dingtalkSign(SECRET, TS_MS), core._dingtalkSign('other', TS_MS));
  assert.notStrictEqual(core._dingtalkSign(SECRET, TS_MS), core._dingtalkSign(SECRET, TS_MS + 1));
});

test('钉钉:无密钥→纯 webhook;有密钥→追加 timestamp&sign', () => {
  const plain = core.buildSendRequest({ platform: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abc', text: '你好' });
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.request.url, 'https://oapi.dingtalk.com/robot/send?access_token=abc');
  assert.deepStrictEqual(JSON.parse(plain.request.body), { msgtype: 'text', text: { content: '你好' } });

  const signed = core.buildSendRequest({ platform: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: SECRET, text: '你好', timestampMs: TS_MS });
  assert.strictEqual(signed.ok, true);
  assert.ok(signed.request.url.includes(`&timestamp=${TS_MS}&sign=${DING_SIGN}`), signed.request.url);
});

test('钉钉:有密钥但缺 timestampMs → ok:false', () => {
  const r = core.buildSendRequest({ platform: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: SECRET, text: 'x' });
  assert.strictEqual(r.ok, false);
});

test('飞书:无密钥→纯 body;有密钥→body 含 timestamp+sign', () => {
  const plain = core.buildSendRequest({ platform: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', text: 'hi' });
  assert.strictEqual(plain.ok, true);
  const pb = JSON.parse(plain.request.body);
  assert.deepStrictEqual(pb, { msg_type: 'text', content: { text: 'hi' } });

  const signed = core.buildSendRequest({ platform: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', secret: SECRET, text: 'hi', timestampMs: TS_MS });
  const sb = JSON.parse(signed.request.body);
  assert.strictEqual(sb.timestamp, String(Math.floor(TS_MS / 1000)));
  assert.strictEqual(sb.sign, FEISHU_SIGN);
});

test('企业微信:无签名,纯 text 报文', () => {
  const r = core.buildSendRequest({ platform: 'wecom', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', secret: 'ignored', text: '报告' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.request.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k');
  assert.deepStrictEqual(JSON.parse(r.request.body), { msgtype: 'text', text: { content: '报告' } });
});

test('入参非法 → fail-soft(不抛)', () => {
  assert.strictEqual(core.buildSendRequest({ platform: 'x', webhook: 'https://a', text: 'y' }).ok, false);
  assert.strictEqual(core.buildSendRequest({ platform: 'feishu', webhook: 'ftp://a', text: 'y' }).ok, false);
  assert.strictEqual(core.buildSendRequest({ platform: 'feishu', webhook: 'https://a', text: '   ' }).ok, false);
});

test('maskWebhook:遮蔽凭据,绝不回显完整 token', () => {
  const m = core.maskWebhook('https://oapi.dingtalk.com/robot/send?access_token=SECRET_TOKEN_123');
  assert.ok(!m.includes('SECRET_TOKEN_123'), m);
  assert.ok(m.includes('oapi.dingtalk.com'), m);
  assert.strictEqual(core.maskWebhook(''), '(未配置)');
});

test('describePlatforms:三平台齐全,含 hint', () => {
  const list = core.describePlatforms();
  assert.strictEqual(list.length, 3);
  const keys = list.map((x) => x.platform).sort();
  assert.deepStrictEqual(keys, ['dingtalk', 'feishu', 'wecom']);
  for (const p of list) assert.ok(p.hint && p.hint.length > 0);
});

// 交叉验证:_feishuSign 与独立重算的官方公式一致(防公式回归)
test('飞书签名与独立重算官方公式一致', () => {
  const tsSec = Math.floor(TS_MS / 1000);
  const independent = crypto.createHmac('sha256', `${tsSec}\n${SECRET}`).update('', 'utf8').digest('base64');
  assert.strictEqual(core._feishuSign(SECRET, tsSec), independent);
});
