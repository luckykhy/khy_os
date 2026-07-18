'use strict';

/**
 * WeCom (企业微信) Channel — 企业微信群机器人 + 回调收发。
 *
 * 发送:文本经 msgChannelCore 封装(群机器人无需加签),过 SSRF 守卫后 POST 到群 webhook。
 * 接收:企业微信「接收消息服务器」把消息 POST 到 /webhooks/wecom;GET 携 echostr 做地址校验;
 *       POST 为加密 XML,用 token+EncodingAESKey 验签解密后解析文本,emit 'message'。
 *       回复广播回配置的群 webhook。
 *
 * config: { webhook, token, encodingAesKey }
 */

const { BaseChannel } = require('./_baseChannel');
const sender = require('../messaging/msgSender');
const inbound = require('../messaging/msgInboundCore');

class WecomChannel extends BaseChannel {
  constructor(config = {}) {
    super({ name: 'wecom', config });
    this.webhook = config.webhook || '';
    this.token = config.token || '';
    this.encodingAesKey = config.encodingAesKey || '';
  }

  async connect() {
    if (!this.webhook) throw new Error('wecom: webhook is required');
    this._connected = true;
    this.emit('connected');
  }

  async sendMessage(channelId, text, opts = {}) {
    const result = await sender.sendText({ platform: 'wecom', webhook: this.webhook, text });
    if (!result.ok) { this.emit('error', { error: new Error(result.error) }); }
    return result;
  }

  async sendReply(channelId, threadId, text, opts = {}) {
    return this.sendMessage(channelId, text, opts);
  }

  /**
   * 处理入站回调(由 /webhooks/wecom 调用)。
   * @param {{timestamp, nonce, msgSignature, echostr?, xmlBody?}} args
   * @returns {{ok:boolean, kind?:string, plaintext?:string, error?:string}}
   */
  handleInbound(args = {}) {
    const r = inbound.handleWecom({
      token: this.token,
      encodingAesKey: this.encodingAesKey,
      timestamp: args.timestamp,
      nonce: args.nonce,
      msgSignature: args.msgSignature,
      echostr: args.echostr,
      xmlBody: args.xmlBody,
    });
    if (!r.ok) return r;
    if (r.kind === 'verify') return r; // 路由据此回明文 echostr
    const msg = r.message;
    if (msg && msg.text) {
      this.emit('message', {
        channelId: msg.chatId || this.webhook,
        userId: msg.userId,
        text: msg.text,
        threadId: '',
        timestamp: String(args.timestamp || ''),
        raw: msg.raw,
      });
    }
    return { ok: true, kind: 'event' };
  }

  toJSON() {
    return {
      ...super.toJSON(),
      hasWebhook: !!this.webhook,
      hasToken: !!this.token,
      hasAesKey: !!this.encodingAesKey,
    };
  }
}

module.exports = { WecomChannel };
