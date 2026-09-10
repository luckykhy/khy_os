'use strict';
/**
 * 集成单测 —�?闭合双向�?「像龙虾一样�?:
 *   入站 emit 'message' �?messageRouter._handleMessage �?AI handler(khy chat)
 *   �?回复�?channel.sendReply / sendMessage 发回原会话�?
 *
 * 用真�?MessageRouter + 一个假渠道(EventEmitter,记录 sendReply/sendMessage),
 * �?wireReplyBridge 注入�?chat,断言 AI 回复被发�?*原始 channelId/threadId**�?
 * 全程离线,零真实网络�?
 */
const { EventEmitter } = require('events');
const { MessageRouter } = require('../../../src/services/domain/messaging/channels/messageRouter.js');
const { wireReplyBridge } = require('../../../src/services/domain/messaging/messaging/msgReplyBridge.js');
const silentLog = { warn() {}, error() {}, info() {} };
// 最小假渠道:�?registerChannel �?name + EventEmitter + send*)�?
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

describe('Msg Reply Roundtrip', () => {
  test('龙虾�?�?threadId �?AI 回复�?sendReply 回发到原 thread', async () => {
      const router = new MessageRouter();
      const ch = new FakeChannel('dingtalk');
      router.registerChannel(ch);
    
      const ok = wireReplyBridge(router, {
        env: {},
        getChat: () => async (prompt) => `你说了�?{prompt}�?收到`,
        log: silentLog,
      });
      expect(ok).toBe(true);
    
      ch.emitInbound({
        channelId: 'https://oapi.dingtalk.com/robot/send?access_token=sess',
        threadId: 'https://oapi.dingtalk.com/robot/send?access_token=sess',
        userId: 'u1',
        text: '库存多少',
      });
      // 等待 handler �?microtask 链结算�?
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    
      expect(ch.replies.length).toBe(1);
      expect(ch.replies[0].channelId).toBe('https://oapi.dingtalk.com/robot/send?access_token=sess');
      expect(ch.replies[0].threadId).toBe('https://oapi.dingtalk.com/robot/send?access_token=sess');
      expect(ch.replies[0].text).toBe('你说了「库存多少�?收到');
      expect(ch.sent.length).toBe(0);
  });

  test('龙虾�?�?threadId �?AI 回复�?sendMessage 回发到原 channelId', async () => {
      const router = new MessageRouter();
      const ch = new FakeChannel('wecom');
      router.registerChannel(ch);
    
      wireReplyBridge(router, { env: {}, getChat: () => async () => '好的', log: silentLog });
    
      ch.emitInbound({ channelId: 'chat-123', userId: 'u9', text: '在吗' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    
      expect(ch.sent.length).toBe(1);
      expect(ch.sent[0].channelId).toBe('chat-123');
      expect(ch.sent[0].text).toBe('好的');
      expect(ch.replies.length).toBe(0);
  });

  test('龙虾�?chat 返回�?�?不回�?fail-soft,不误发空消息)', async () => {
      const router = new MessageRouter();
      const ch = new FakeChannel('feishu');
      router.registerChannel(ch);
    
      wireReplyBridge(router, { env: {}, getChat: () => async () => '   ', log: silentLog });
    
      ch.emitInbound({ channelId: 'g1', threadId: 'm1', userId: 'u', text: 'hi' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    
      expect(ch.replies.length).toBe(0);
      expect(ch.sent.length).toBe(0);
  });

  test('龙虾�?chat 未注�?headless) �?不回�?入站不崩', async () => {
      const router = new MessageRouter();
      const ch = new FakeChannel('dingtalk');
      router.registerChannel(ch);
    
      wireReplyBridge(router, { env: {}, getChat: () => null, log: silentLog });
    
      ch.emitInbound({ channelId: 'x', threadId: 't', userId: 'u', text: 'hi' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    
      expect(ch.replies.length).toBe(0);
      expect(ch.sent.length).toBe(0);
  });

});

