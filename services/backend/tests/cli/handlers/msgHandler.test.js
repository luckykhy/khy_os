'use strict';

/**
 * CLI 层测试 —— `khy msg` handler。deps 注入 + 全程零真实网络。
 *
 * 覆盖:status(空/有配置)、platforms、set(合法/非法参数/缺平台)、
 *      send / test(桩 sender)、clear、on/off(注入 writeEnvPatch)、未知子命令。
 * 底座数据家用临时 KHYOS_HOME,发送经 require 缓存桩掉 msgSender 避免出网。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-msg-cli-'));
process.env.KHYOS_HOME = TMP_HOME;
process.env.KHY_MSG = 'true';

const store = require('../../../src/services/messaging/msgConfigStore');
const { handleMsg } = require('../../../src/cli/handlers/msg');

// 桩掉 sender:直接改 require 缓存里的 sendText,断言参数、不出网。
const senderPath = require.resolve('../../../src/services/messaging/msgSender');
const senderMod = require(senderPath);
let _sentCalls = [];
const _origSendText = senderMod.sendText;
senderMod.sendText = async (input) => {
  _sentCalls.push(input);
  return { ok: true, platform: input.platform, target: 'https://***masked***' };
};

beforeEach(() => {
  // 清空底座:每个用例从零开始。
  try { fs.rmSync(path.join(TMP_HOME, 'msg.json'), { force: true }); } catch { /* noop */ }
  _sentCalls = [];
});

test('status:未配置任何平台 → 退出码 0', () => {
  assert.strictEqual(handleMsg('status', []), 0);
});

test('platforms:列出支持平台 → 退出码 0', () => {
  assert.strictEqual(handleMsg('platforms', []), 0);
});

test('set:合法 webhook → 落库 + 退出码 0', () => {
  const rc = handleMsg('set', ['dingtalk', 'webhook=https://oapi.dingtalk.com/robot/send?access_token=t']);
  assert.strictEqual(rc, 0);
  const cfg = store.getPlatform('dingtalk');
  assert.ok(cfg && cfg.webhook.includes('access_token=t'));
});

test('set:缺平台参数 → 退出码 1', () => {
  assert.strictEqual(handleMsg('set', []), 1);
});

test('set:参数非 k=v 形式 → 退出码 1', () => {
  assert.strictEqual(handleMsg('set', ['dingtalk', 'not-a-pair']), 1);
});

test('status:已配置后列出 → 退出码 0', () => {
  handleMsg('set', ['feishu', 'webhook=https://open.feishu.cn/open-apis/bot/v2/hook/x']);
  assert.strictEqual(handleMsg('status', []), 0);
});

test('send:已配置 → 调用 sender 且退出码 0', async () => {
  handleMsg('set', ['wecom', 'webhook=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k']);
  const rc = await handleMsg('send', ['wecom', '你好', '世界']);
  assert.strictEqual(rc, 0);
  assert.strictEqual(_sentCalls.length, 1);
  assert.strictEqual(_sentCalls[0].platform, 'wecom');
  assert.strictEqual(_sentCalls[0].text, '你好 世界');
});

test('send:未配置平台 → 退出码 1 且不出网', async () => {
  const rc = await handleMsg('send', ['dingtalk', 'x']);
  assert.strictEqual(rc, 1);
  assert.strictEqual(_sentCalls.length, 0);
});

test('send:缺文本 → 退出码 1', async () => {
  handleMsg('set', ['dingtalk', 'webhook=https://oapi.dingtalk.com/robot/send?access_token=t']);
  const rc = await handleMsg('send', ['dingtalk']);
  assert.strictEqual(rc, 1);
  assert.strictEqual(_sentCalls.length, 0);
});

test('test:已配置 → 发一条测试消息 + 退出码 0', async () => {
  handleMsg('set', ['dingtalk', 'webhook=https://oapi.dingtalk.com/robot/send?access_token=t']);
  const rc = await handleMsg('test', ['dingtalk']);
  assert.strictEqual(rc, 0);
  assert.strictEqual(_sentCalls.length, 1);
  assert.ok(_sentCalls[0].text.length > 0);
});

test('clear:清除单平台 → 退出码 0 且配置消失', () => {
  handleMsg('set', ['feishu', 'webhook=https://open.feishu.cn/open-apis/bot/v2/hook/x']);
  assert.ok(store.getPlatform('feishu'));
  assert.strictEqual(handleMsg('clear', ['feishu']), 0);
  assert.strictEqual(store.getPlatform('feishu'), null);
});

test('on/off:注入 writeEnvPatch → 退出码 0 且写入 KHY_MSG', () => {
  const patches = [];
  const deps = { writeEnvPatch: (obj) => { patches.push(obj); return '/tmp/fake.env'; } };
  assert.strictEqual(handleMsg('on', [], {}, deps), 0);
  assert.strictEqual(handleMsg('off', [], {}, deps), 0);
  assert.deepStrictEqual(patches, [{ KHY_MSG: 'true' }, { KHY_MSG: 'off' }]);
});

test('help:退出码 0', () => {
  assert.strictEqual(handleMsg('help', []), 0);
});

test('未知子命令 → 退出码 1', () => {
  assert.strictEqual(handleMsg('bogus', []), 1);
});

// 收尾:还原 sender(避免污染同进程其它套件)。
test('_teardown:还原 sendText', () => {
  senderMod.sendText = _origSendText;
  assert.strictEqual(typeof senderMod.sendText, 'function');
});
