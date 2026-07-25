'use strict';

/**
 * DingTalk Channel — 钉钉群自定义机器人(收发)。
 *
 * 发送:把文本经 msgChannelCore 封装为钉钉报文(可选加签),过 SSRF 守卫后 POST 到群 webhook。
 * 接收:钉钉「outgoing 机器人」把用户@机器人的消息 POST 到本服务的 /webhooks/dingtalk;
 *       经请求头 timestamp+sign 验签后解析文本,emit 'message'。回复走消息里带的 sessionWebhook。
 *
 * config: { webhook, secret }
 */

const { BaseChannel } = require('./_baseChannel');
const log = require('../../utils/logger');
const sender = require('../messaging/msgSender');
const inbound = require('../messaging/msgInboundCore');

class DingTalkChannel extends BaseChannel {
  constructor(config = {}) {
    super({ name: 'dingtalk', config });
    this.webhook = config.webhook || '';
    this.secret = config.secret || '';
  }

  async connect() {
    // 群机器人基于 webhook,无持久连接;有 webhook 即视为「就绪」。
    if (!this.webhook) throw new Error('dingtalk: webhook is required');
    this._connected = true;
    this.emit('connected');
  }

  /** channelId 若为 https sessionWebhook 则回该会话,否则发到配置的群 webhook。 */
  async sendMessage(channelId, text, opts = {}) {
    const webhook = (typeof channelId === 'string' && /^https:\/\//i.test(channelId)) ? channelId : this.webhook;
    const result = await sender.sendText({ platform: 'dingtalk', webhook, secret: this.secret, text });
    if (!result.ok) { this.emit('error', { error: new Error(result.error) }); }
    return result;
  }

  async sendReply(channelId, threadId, text, opts = {}) {
    return this.sendMessage(channelId, text, opts);
  }

  /**
   * 处理入站回调(由 /webhooks/dingtalk 调用)。
   * @param {{timestamp:string, sign:string}} headers
   * @param {object} body 已解析的 JSON 消息体
   * @returns {{ok:boolean, error?:string}}
   */
  handleInbound(headers = {}, body = {}) {
    if (this.secret) {
      const ok = inbound.verifyDingtalk({ secret: this.secret, timestamp: headers.timestamp, sign: headers.sign });
      if (!ok) return { ok: false, error: 'dingtalk 签名校验失败' };
    }
    const msg = inbound.parseDingtalk(body);
    if (!msg.text) return { ok: true };
    this.emit('message', {
      channelId: msg.sessionWebhook || this.webhook,
      userId: msg.userId,
      text: msg.text,
      threadId: msg.sessionWebhook || '',
      timestamp: String(headers.timestamp || ''),
      raw: msg.raw,
    });
    return { ok: true };
  }

  toJSON() {
    return { ...super.toJSON(), hasWebhook: !!this.webhook, hasSecret: !!this.secret };
  }
}

module.exports = { DingTalkChannel };
