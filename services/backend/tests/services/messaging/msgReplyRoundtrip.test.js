'use strict';

/**
 * 集成单测 —— 闭合双向环(「像龙虾一样」):
 *   入站 emit 'message' → messageRouter._handleMessage → AI handler(khy chat)
 *   → 回复经 channel.sendReply / sendMessage 发回原会话。
 *
 * 用真实 MessageRouter + 一个假渠道(EventEmitter,记录 sendReply/sendMessage),
 * 经 wireReplyBridge 注入假 chat,断言 AI 回复被发回**原始 channelId/threadId**。
 * 全程离线,零真实网络。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { MessageRouter } = require('../../../src/services/channels/messageRouter');
const { wireReplyBridge } = require('../../../src/services/messaging/msgReplyBridge');

const silentLog = { warn() {}, error() {}, info() {} };

// 最小假渠道:够 registerChannel 用(name + EventEmitter + send*)。
class FakeChannel extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.sent = [];
    this.replies = [];
  }
  toJSON() { return { name: this.name, connected: true }; }
  async sendMessage(channelId, text) { this.sent.push({ channelId, text }); }
  async sendReply(channelId, threadId, text) { this.replies.push({ channelId, threadId, text }); }
  emitInbound(msg) { this.emit('message', msg); }
}

test('龙虾环:有 threadId → AI 回复经 sendReply 回发到原 thread', async () => {
  const router = new MessageRouter();
  const ch = new FakeChannel('dingtalk');
  router.registerChannel(ch);

  const ok = wireReplyBridge(router, {
    env: {},
    getChat: () => async (prompt) => `你说了「${prompt}」,收到`,
    log: silentLog,
  });
  assert.strictEqual(ok, true);

  ch.emitInbound({
    channelId: 'https://oapi.dingtalk.com/robot/send?access_token=sess',
    threadId: 'https://oapi.dingtalk.com/robot/send?access_token=sess',
    userId: 'u1',
    text: '库存多少',
  });
  // 等待 handler 的 microtask 链结算。
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(ch.replies.length, 1);
  assert.strictEqual(ch.replies[0].channelId, 'https://oapi.dingtalk.com/robot/send?access_token=sess');
  assert.strictEqual(ch.replies[0].threadId, 'https://oapi.dingtalk.com/robot/send?access_token=sess');
  assert.strictEqual(ch.replies[0].text, '你说了「库存多少」,收到');
  assert.strictEqual(ch.sent.length, 0);
});

test('龙虾环:无 threadId → AI 回复经 sendMessage 回发到原 channelId', async () => {
  const router = new MessageRouter();
  const ch = new FakeChannel('wecom');
  router.registerChannel(ch);

  wireReplyBridge(router, { env: {}, getChat: () => async () => '好的', log: silentLog });

  ch.emitInbound({ channelId: 'chat-123', userId: 'u9', text: '在吗' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(ch.sent.length, 1);
  assert.strictEqual(ch.sent[0].channelId, 'chat-123');
  assert.strictEqual(ch.sent[0].text, '好的');
  assert.strictEqual(ch.replies.length, 0);
});

test('龙虾环:chat 返回空 → 不回发(fail-soft,不误发空消息)', async () => {
  const router = new MessageRouter();
  const ch = new FakeChannel('feishu');
  router.registerChannel(ch);

  wireReplyBridge(router, { env: {}, getChat: () => async () => '   ', log: silentLog });

  ch.emitInbound({ channelId: 'g1', threadId: 'm1', userId: 'u', text: 'hi' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(ch.replies.length, 0);
  assert.strictEqual(ch.sent.length, 0);
});

test('龙虾环:chat 未注册(headless) → 不回发,入站不崩', async () => {
  const router = new MessageRouter();
  const ch = new FakeChannel('dingtalk');
  router.registerChannel(ch);

  wireReplyBridge(router, { env: {}, getChat: () => null, log: silentLog });

  ch.emitInbound({ channelId: 'x', threadId: 't', userId: 'u', text: 'hi' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(ch.replies.length, 0);
  assert.strictEqual(ch.sent.length, 0);
});
