'use strict';

/**
 * @pattern Adapter
 *
 * imAdapterChannel.js — 把 `adapters/im` 的长连接适配器接进 `messageRouter` 的通道协议。
 *
 * 两套接口本来对不上,这层只做翻译,不含任何渠道逻辑:
 *   BaseImAdapter                      BaseChannel(messageRouter 认的)
 *   ────────────────────────────────   ────────────────────────────────
 *   onMessage(handler) → 归一消息       emit('message', {channelId,userId,text,threadId,…})
 *   sendMessage(target, content)        sendMessage(channelId, text, opts)
 *   connect() / disconnect()            connect() / disconnect()
 *   describeState()                     toJSON()
 * 接上之后,入站消息就能走 messageRouter 既有的 AI 应答回路(msgReplyBridge),
 * 与钉钉/飞书 webhook/微信个人号同一条路——不必在长连接侧再造一遍分发。
 *
 * **注册名带 `im:` 前缀**(如 `im:feishu`):仓里已有一个 webhook 版 `feishuChannel`
 * 注册成 `feishu`,而 `messageRouter.registerChannel` 遇到同名是**直接替换**的。长连接和
 * 群机器人 webhook 是两种可并存的接入方式(前者不需要公网入口,后者不需要 app 凭据),
 * 用前缀区分,`/webhooks/feishu` 的对外行为一个字节都不动。
 *
 * 契约:
 *   - `connected` 直接问适配器的状态机,而不是本地布尔——适配器在后台退避重连成功时不会
 *     回调本层,缓存一个本地标志必然会说谎(诊断里最不该说谎的就是这一位)。
 *   - 适配器的 `onMessage` 回调抛错已在其内部隔离,故这里只管翻译字段。
 *   - 附件已由适配器落盘,这里把落盘信息原样挂在消息的 `attachments` 上传下去。
 */

const { BaseChannel } = require('./_baseChannel');

/**
 * Protocol-level delivery/read receipts must never enter the AI reply path.
 * Keep this event-type-only: a real user may legitimately send text such as
 * "已读" or "收到", and message content is not a receipt signal.
 * @param {object} message normalized adapter message
 * @returns {boolean}
 */
function _isReadReceiptMessage(message) {
  const eventType = String(message && (message.eventType || message.event_type) || '')
    .trim()
    .toLowerCase();
  if (!eventType) {
    return false;
  }
  return /(?:^|[._:-])(read|receipt|read_receipt|message_read|message\.read|seen)(?:$|[._:-])/.test(
    eventType
  );
}

class ImAdapterChannel extends BaseChannel {
  /**
   * @param {object} opts
   * @param {object} opts.adapter    BaseImAdapter 实例(需有 channel/connect/disconnect/onMessage/sendMessage)
   * @param {string} [opts.name]     注册名;缺省 `im:<adapter.channel>`
   */
  constructor(opts = {}) {
    const adapter = opts.adapter;
    if (!adapter || typeof adapter.onMessage !== 'function' || typeof adapter.sendMessage !== 'function') {
      throw new Error('ImAdapterChannel: 需要一个 BaseImAdapter 实例(缺 onMessage/sendMessage)');
    }
    super({ name: String(opts.name || `im:${adapter.channel}`), config: {} });
    this.adapter = adapter;

    // 只订阅一次,且不在 disconnect 时退订:适配器允许 disconnect() 之后再 connect(),
    // 那时若已退订就会静默收不到消息。适配器停机期间本就不会派发,留着无副作用。
    this._unsubscribe = adapter.onMessage((msg) => this._onAdapterMessage(msg));
  }

  /** 状态问适配器,不缓存(见文件头契约)。 */
  get connected() {
    try {
      const st = this.adapter.describeState();
      return !!st && st.state === 'open';
    } catch {
      return false;
    }
  }

  async connect() {
    await this.adapter.connect();
    this._connected = true; // 仅为兼容基类字段;真值以 get connected() 为准
    this.emit('connected');
  }

  async disconnect() {
    await this.adapter.disconnect('channel-disconnect');
    this._connected = false;
    this.emit('disconnected');
  }

  /**
   * @param {string} channelId 会话/群 id(适配器语义)
   * @param {string} text
   * @param {object} [opts] 透传给适配器的结构化字段(如 { type })
   * @returns {Promise<object>}
   */
  async sendMessage(channelId, text, opts = {}) {
    const content = opts && Object.keys(opts).length ? { ...opts, text: String(text == null ? '' : text) } : text;
    try {
      return await this.adapter.sendMessage(channelId, content);
    } catch (err) {
      // 与既有渠道一致:发送失败经 'error' 事件上报(messageRouter 会记日志),
      // 同时把错误继续抛给调用方——AI 应答回路要能知道这条没发出去。
      this.emit('error', { error: err });
      throw err;
    }
  }

  /**
   * 归一消息 → 通道消息。适配器给的字段名是渠道中立的(chatId/senderId),
   * 通道协议用的是 channelId/userId,这里只做改名,不丢信息(raw 原样带上)。
   * @param {object} msg
   */
  _onAdapterMessage(msg) {
    const m = msg || {};
    if (_isReadReceiptMessage(m)) {
      return; // 回执只用于渠道状态，不应触发模型回复。
    }
    const text = String(m.text == null ? '' : m.text);
    const attachments = Array.isArray(m.attachments) ? m.attachments : [];
    if (!text && !attachments.length) {
      return; // 纯控制帧(心跳/回执)不冒充用户消息
    }
    this.emit('message', {
      channelId: m.chatId || '',
      userId: m.senderId || '',
      text,
      threadId: m.id || '',
      timestamp: m.receivedAt || '',
      attachments,
      raw: m.raw !== undefined ? m.raw : m,
    });
  }

  toJSON() {
    let state = null;
    try {
      state = this.adapter.describeState(); // endpoint 已在适配器侧打码
    } catch {
      state = null;
    }
    return {
      ...super.toJSON(),
      connected: this.connected,
      transport: 'long-link',
      adapter: state,
    };
  }
}

module.exports = { ImAdapterChannel };
