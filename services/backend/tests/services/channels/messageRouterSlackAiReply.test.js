'use strict';

/**
 * messageRouter Slack AI 应答接线测试。
 *
 * 背景:wireReplyBridge(设置 _aiHandler)原本只在「msg 渠道(钉钉/飞书/企微)注册数 > 0」时被调用,
 * Slack 通道单独注册却从不闭合 AI 应答回路 → Slack 入站消息被解析后即丢弃(webhooks.js 旧「诚实边界」)。
 * 修复:Slack 注册分支也调用 wireReplyBridge(经 aiReplyWired 闭包)。本测试断言:
 *   1. 仅配 SLACK_BOT_TOKEN(无任何 msg 渠道)→ _aiHandler 被接线(Slack 消息能回 AI)。
 *   2. 门 KHY_MSG_AUTOREPLY=off → 不接线(逐字节回退)。
 *   3. 未配置任何渠道 → 不接线(保持现状)。
 *
 * 全离线:connect() 打成 no-op,不触 Slack API / 不起 socket。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-mr-slack-'));
process.env.KHY_MSG = 'off';            // 关闭 msg 渠道分支,纯 Slack 部署场景
delete process.env.KHY_MSG_AUTOREPLY;   // 自动回复门缺省开

const { MessageRouter, _bootstrapChannels } =
  require('../../../src/services/channels/messageRouter');
const { SlackChannel } = require('../../../src/services/channels/slackChannel');

const _realConnect = SlackChannel.prototype.connect;
before(() => { SlackChannel.prototype.connect = async function () { this._connected = true; }; });
after(() => { SlackChannel.prototype.connect = _realConnect; });

function freshRouter() {
  return new MessageRouter();
}

test('仅配 SLACK_BOT_TOKEN → _aiHandler 被接线(Slack 消息可回 AI)', () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  try {
    const router = freshRouter();
    _bootstrapChannels(router);
    assert.ok(router._aiHandler, 'Slack 注册后应闭合 AI 应答回路(_aiHandler 非空)');
    assert.strictEqual(typeof router._aiHandler, 'function', '_aiHandler 应是函数');
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test('KHY_MSG_AUTOREPLY=off → 即使配了 Slack 也不接线(逐字节回退)', () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  process.env.KHY_MSG_AUTOREPLY = 'off';
  try {
    const router = freshRouter();
    _bootstrapChannels(router);
    assert.strictEqual(router._aiHandler, null, '自动回复门关 → 不应接线');
  } finally {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.KHY_MSG_AUTOREPLY;
  }
});

test('未配置任何渠道 → 不接线(保持现状)', () => {
  delete process.env.SLACK_BOT_TOKEN;
  process.env.KHY_MSG = 'off';
  const router = freshRouter();
  _bootstrapChannels(router);
  assert.strictEqual(router._aiHandler, null, '无渠道 → 不应接线');
});
