'use strict';

/**
 * Feishu (Lark) Channel — 飞书群自定义机器人(收发)。
 *
 * 发送:文本经 msgChannelCore 封装为飞书报文(可选签名校验),过 SSRF 守卫后 POST 到群 webhook。
 * 接收:飞书「事件订阅」把消息 POST 到 /webhooks/feishu;首次配置回调时先回 url_verification
 *       challenge;加密事件用 encryptKey 解密后解析文本,emit 'message'。回复广播回配置的群 webhook。
 *
 * config: { webhook, secret, encryptKey, verificationToken }
 */

const { BaseChannel } = require('./_baseChannel');
const sender = require('../messaging/msgSender');
const inbound = require('../messaging/msgInboundCore');

class FeishuChannel extends BaseChannel {
  constructor(config = {}) {
    super({ name: 'feishu', config });
    this.webhook = config.webhook || '';
    this.secret = config.secret || '';
    this.encryptKey = config.encryptKey || '';
    this.verificationToken = config.verificationToken || '';
  }

  async connect() {
    if (!this.webhook) throw new Error('feishu: webhook is required');
    this._connected = true;
    this.emit('connected');
  }

  async sendMessage(channelId, text, opts = {}) {
    const result = await sender.sendText({ platform: 'feishu', webhook: this.webhook, secret: this.secret, text });
    if (!result.ok) { this.emit('error', { error: new Error(result.error) }); }
    return result;
  }

  async sendReply(channelId, threadId, text, opts = {}) {
    return this.sendMessage(channelId, text, opts);
  }

  /**
   * 处理入站回调(由 /webhooks/feishu 调用)。
   * @param {object} body 已解析的 JSON body(可能含 encrypt)
   * @returns {{ok:boolean, kind?:string, challenge?:string, error?:string}}
   */
  handleInbound(body = {}) {
    const r = inbound.handleFeishu(body, { encryptKey: this.encryptKey, verificationToken: this.verificationToken });
    if (!r.ok) return r;
    if (r.kind === 'challenge') return r; // 路由据此回 { challenge }
    const msg = r.message;
    if (msg && msg.text) {
      this.emit('message', {
        channelId: msg.chatId || this.webhook,
        userId: msg.userId,
        text: msg.text,
        threadId: msg.messageId || '',
        timestamp: '',
        raw: msg.raw,
      });
    }
    return { ok: true, kind: 'event' };
  }

  toJSON() {
    return {
      ...super.toJSON(),
      hasWebhook: !!this.webhook,
      hasSecret: !!this.secret,
      hasEncryptKey: !!this.encryptKey,
    };
  }
}

module.exports = { FeishuChannel };
