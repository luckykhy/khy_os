'use strict';

/**
 * @pattern Adapter, Strategy
 *
 * feishuAdapter.js — IM Adapter 框架的**参考实现**(飞书 / Lark 长连接渠道)。
 *
 * 它证明基类的钩子面够用:整个渠道只写了 5 个钩子(_openChannel / _closeChannel /
 * _deliver / _sendHeartbeat / describeEndpoint)+ 一层帧编解码,状态机、空闲滑动超时、
 * 心跳、指数退避重连、附件落盘全部来自 baseImAdapter,一行都没重写。
 *
 * ── 帧协议边界(**读之前先看这段,别把它当成官方 SDK**)────────────────────
 * 本文件走的是 WebSocket 上的 **JSON 信封**,收下面两种入站外形:
 *   1. 飞书事件回调外形:{ schema, header:{event_type,…}, event:{ message:{…}, sender:{…} } }
 *   2. 扁平外形:{ type:'message', chatId, senderId, text, attachments:[{name,base64|url,mime}] }
 * 出站为 { type:'message.send', chatId, msgType, content, ts }。
 * 飞书官方长连接(open.feishu.cn)在 WS 之上还有一层自有的帧头与 endpoint 协商,
 * **本实现刻意不去猜那套二进制细节**——把它伪装成"已对接官方协议"才是真正的坑。要接官方
 * 协议时,唯一需要替换的是 `_decodeFrame` / `_encodeFrame` 这两个方法(以及可选的
 * `_negotiateEndpoint`),通道骨架与上层业务完全不用动。这就是留这道缝的目的。
 *
 * ── 配置来源(全部经 imRuntimeConfig:env 优先,其次 `.khy/` 运行期 JSON)──────
 *   wsUrl        KHY_IM_FEISHU_WS_URL        长连接地址(默认官方网关)
 *   webhookUrl   KHY_IM_FEISHU_WEBHOOK_URL   无活连接时的降级投递端点
 *   appId        KHY_IM_FEISHU_APP_ID
 *   appSecret    KHY_IM_FEISHU_APP_SECRET    (日志中一律打码)
 *   accessToken  KHY_IM_FEISHU_ACCESS_TOKEN  已换好的 tenant_access_token(有则直接用)
 *   verificationToken KHY_IM_FEISHU_VERIFICATION_TOKEN  校验入站事件来源
 * 源码里**没有任何**写死的 token/webhook,也没有 `~/.khyquant` 硬编码路径。
 *
 * 契约:非纯(网络 / fs / 定时器)。凭据缺失在 connect() 时以**点名 env 变量**的错误抛出,
 * 而不是连上去以后再报一个看不出所以然的 401。
 */

const {
  BaseImAdapter,
  describeError,
  resolveNumericFlag,
} = require('./baseImAdapter');
const {
  resolveChannelConfig,
  describeSources,
  redactSecret,
  redactUrl,
} = require('./imRuntimeConfig');

const CHANNEL = 'feishu';
const DISPLAY_NAME = '飞书网关';

// 官方长连接网关。第三方端点,不属于 constants/serviceDefaults.js 管辖的第一方域;
// 任何部署都可用 KHY_IM_FEISHU_WS_URL 覆盖(私有化 / mock server 联调都走这个口子)。
const DEFAULT_WS_URL = 'wss://open.feishu.cn/callback/ws/endpoint';

// 附件下载上限与超时:下载是**单次有界 I/O**,不是长连接,所以这里用 axios 自己的
// timeout(一次请求的上界),而不是另起一个会掐断长连接的定时器。
const ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;
const FRAME_TYPE_CONTROL = 0;
const FRAME_TYPE_DATA = 1;
const MESSAGE_TYPE_EVENT = 'event';
const MESSAGE_TYPE_CARD = 'card';
const MESSAGE_TYPE_PING = 'ping';
const MESSAGE_TYPE_PONG = 'pong';
const CHUNK_TTL_MS = 5_000;

function encodeVarint(value) {
  let n = typeof value === 'bigint' ? value : BigInt(Math.max(0, Number(value) || 0));
  const out = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let at = offset;
  for (; at < buf.length && shift <= 63n; at += 1) {
    const byte = buf[at];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, offset: at + 1 };
    shift += 7n;
  }
  throw new Error('protobuf varint 无法完整解析');
}

function encodeProtoField(number, wireType, value) {
  const tag = encodeVarint((BigInt(number) << 3n) | BigInt(wireType));
  if (wireType === 0) return Buffer.concat([tag, encodeVarint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([tag, encodeVarint(bytes.length), bytes]);
}

function encodeHeader(key, value) {
  return Buffer.concat([encodeProtoField(1, 2, Buffer.from(String(key))), encodeProtoField(2, 2, Buffer.from(String(value)))]);
}

function encodeFrame(frame) {
  const fields = [
    encodeProtoField(1, 0, frame.SeqID || 0),
    encodeProtoField(2, 0, frame.LogID || 0),
    encodeProtoField(3, 0, frame.service || 0),
    encodeProtoField(4, 0, frame.method || 0),
  ];
  for (const header of frame.headers || []) fields.push(encodeProtoField(5, 2, encodeHeader(header.key, header.value)));
  if (frame.payload_encoding) fields.push(encodeProtoField(6, 2, frame.payload_encoding));
  if (frame.payload_type) fields.push(encodeProtoField(7, 2, frame.payload_type));
  if (frame.payload !== undefined) fields.push(encodeProtoField(8, 2, frame.payload));
  if (frame.LogIDNew) fields.push(encodeProtoField(9, 2, frame.LogIDNew));
  return Buffer.concat(fields);
}

function decodeFrame(buf) {
  const frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: Buffer.alloc(0) };
  let offset = 0;
  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset); offset = tag.offset;
    const number = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = decodeVarint(buf, offset); offset = v.offset;
      if (number === 1) frame.SeqID = v.value; else if (number === 2) frame.LogID = v.value;
      else if (number === 3) frame.service = Number(v.value); else if (number === 4) frame.method = Number(v.value);
      continue;
    }
    if (wire !== 2) throw new Error(`protobuf Frame 不支持 wire type ${wire}`);
    const len = decodeVarint(buf, offset); offset = len.offset;
    const end = offset + Number(len.value); if (end > buf.length) throw new Error('protobuf Frame 长度越界');
    const value = buf.subarray(offset, end); offset = end;
    if (number === 5) {
      const header = decodeHeader(value); frame.headers.push(header);
    } else if (number === 6) frame.payload_encoding = value.toString();
    else if (number === 7) frame.payload_type = value.toString();
    else if (number === 8) frame.payload = Buffer.from(value);
    else if (number === 9) frame.LogIDNew = value.toString();
  }
  return frame;
}

function decodeHeader(buf) {
  const header = { key: '', value: '' }; let offset = 0;
  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset); offset = tag.offset;
    const number = Number(tag.value >> 3n); const wire = Number(tag.value & 7n);
    if (wire !== 2) throw new Error('protobuf Header wire type 非 bytes');
    const len = decodeVarint(buf, offset); offset = len.offset;
    const end = offset + Number(len.value); if (end > buf.length) throw new Error('protobuf Header 长度越界');
    const value = buf.subarray(offset, end).toString(); offset = end;
    if (number === 1) header.key = value; else if (number === 2) header.value = value;
  }
  return header;
}

const CONFIG_SPEC = {
  wsUrl: { default: DEFAULT_WS_URL },
  webhookUrl: {},
  appId: {},
  appSecret: { secret: true },
  accessToken: { secret: true },
  verificationToken: { secret: true },
};

class FeishuImAdapter extends BaseImAdapter {
  /**
   * @param {object} [options] 见 BaseImAdapter;另支持 options.wsFactory(注入 ws 实现,单测用)
   */
  constructor(options = {}) {
    super({ channel: CHANNEL, displayName: DISPLAY_NAME, ...options });

    const resolved = resolveChannelConfig(CHANNEL, CONFIG_SPEC, { env: this._env });
    this._config = resolved.values;
    this._configSources = resolved.sources;
    this._configFile = resolved.file;
    this._configNotes = resolved.notes;
    this._wsFactory = typeof options.wsFactory === 'function' ? options.wsFactory : null;
    this._httpClient = options.httpClient || null;
    this._handshakeMs = resolveNumericFlag(this._env, 'KHY_IM_HANDSHAKE_MS');

    this._ws = null;
    this._openSeq = 0; // 递增代号:迟到的旧 socket 事件不许影响新连接
    this._officialProtocol = this._configSources.wsUrl === 'default';
    this._negotiatedEndpoint = null;
    this._serviceId = 0;
    this._chunks = new Map();
    this._tenantToken = null;
    this._tenantTokenExpiresAt = 0;
  }

  /** 已脱敏端点串(query 上的一次性 ticket 会被打码)。 */
  describeEndpoint() {
    return redactUrl(this._negotiatedEndpoint || this._config.wsUrl || DEFAULT_WS_URL);
  }

  /** 配置来源快照,给 `khy` 诊断/启动日志用(secret 只报来源与打码值)。 */
  describeConfig() {
    return {
      channel: CHANNEL,
      wsUrl: redactUrl(this._config.wsUrl),
      webhookUrl: this._config.webhookUrl ? redactUrl(this._config.webhookUrl) : null,
      appId: this._config.appId || null,
      appSecret: this._config.appSecret ? redactSecret(this._config.appSecret) : null,
      accessToken: this._config.accessToken ? redactSecret(this._config.accessToken) : null,
      verificationToken: this._config.verificationToken ? redactSecret(this._config.verificationToken) : null,
      file: this._configFile,
      sources: describeSources(this._configSources),
      notes: this._configNotes,
    };
  }

  // ── 钩子实现 ─────────────────────────────────────────────────────────

  /**
   * 建立 WS 长连接。连上(open 事件)即 resolve;握手阶段有界等待——这是**一次有界
   * I/O**(TCP+HTTP upgrade),不是对已建立连接的固定时长限制,故与红线 3 不冲突:
   * 连上之后接管的是空闲滑动超时,握手计时器会被清掉。
   */
  async _openChannel(ctx) {
    let url = String(this._config.wsUrl || '').trim();
    if (!url) {
      throw new Error(
        `飞书长连接地址为空:请设置 KHY_IM_FEISHU_WS_URL,或在 ${this._configFile || '<数据家>/im/feishu.json'} 里写 wsUrl`
      );
    }
    if (this._officialProtocol) {
      const negotiated = await this._negotiateEndpoint();
      url = negotiated.endpoint;
      this._negotiatedEndpoint = url;
      this._serviceId = negotiated.serviceId;
    } else {
      this._serviceId = 0;
    }
    const WebSocketImpl = this._resolveWebSocketImpl();
    const seq = ++this._openSeq;
    const ws = new WebSocketImpl(url, { headers: this._officialProtocol ? {} : this._buildAuthHeaders() });
    this._ws = ws;

    await new Promise((resolve, reject) => {
      let settled = false;
      let handshakeTimer = null;

      const finish = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.removeListener('close', onEarlyClose);
        if (err) {
          try {
            ws.close();
          } catch {
            /* 已经坏掉了,close 抛错无所谓 */
          }
          reject(err);
        } else {
          resolve();
        }
      };
      const onOpen = () => finish(null);
      const onError = (err) => finish(new Error(`WS 握手失败:${describeError(err)}`));
      const onEarlyClose = (code, reasonBuf) =>
        finish(new Error(`WS 在握手完成前被关闭(code ${code}${reasonBuf ? `,${String(reasonBuf)}` : ''})`));

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onEarlyClose);
      // 握手上界。用变量而非字面量,并在 finish() 里清除;超时只让**这一次握手**失败,
      // 由基类接手退避重连,不会杀进程、也不会掐已建立的连接。
      handshakeTimer = setTimeout(
        () => finish(new Error(`WS 握手在 ${(this._handshakeMs / 1000).toFixed(1)}s 内未完成`)),
        this._handshakeMs
      );
      if (handshakeTimer && typeof handshakeTimer.unref === 'function') {
        handshakeTimer.unref();
      }
    });

    // 握手成功 → 挂常驻监听。所有入站事件都先喂 noteActivity(滑动窗口的「滑」)。
    ws.on('message', (data, isBinary) => {
      ctx.noteActivity('ws-message');
      this._handleFrame(data, isBinary, ctx);
    });
    ws.on('pong', () => ctx.noteActivity('ws-pong'));
    ws.on('ping', () => ctx.noteActivity('ws-ping'));
    ws.on('error', (err) => {
      if (seq !== this._openSeq) {
        return; // 旧 socket 的迟到事件
      }
      ctx.noteClosed(`ws-error:${describeError(err)}`);
    });
    ws.on('close', (code, reasonBuf) => {
      if (seq !== this._openSeq) {
        return;
      }
      const reason = reasonBuf && String(reasonBuf) ? `,${String(reasonBuf)}` : '';
      ctx.noteClosed(`ws-close:code ${code}${reason}`);
    });
    return this;
  }

  async _negotiateEndpoint() {
    const appId = String(this._config.appId || '').trim();
    const appSecret = String(this._config.appSecret || '').trim();
    if (!appId || !appSecret) {
      throw new Error(
        `飞书长连接凭据未配置:请设置 KHY_IM_FEISHU_APP_ID 与 KHY_IM_FEISHU_APP_SECRET(或在 ${this._configFile || '<数据家>/im/feishu.json'} 中配置)`
      );
    }
    const base = this._apiBase();
    const url = `${base}/callback/ws/endpoint`;
    const client = this._httpClient || require('axios');
    const response = await client.post(url, { AppID: appId, AppSecret: appSecret }, {
      timeout: ATTACHMENT_FETCH_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', locale: 'zh', 'User-Agent': 'khy-os-feishu-im/1.0' },
      validateStatus: () => true,
    });
    const body = response && response.data ? response.data : {};
    if (response.status < 200 || response.status >= 300 || Number(body.code) !== 0) {
      throw new Error(`飞书长连接 endpoint 协商失败:HTTP ${response.status},code ${body.code == null ? 'unknown' : body.code}`);
    }
    const endpoint = body.data && (body.data.endpoint || body.data.URL || body.data.url);
    if (!endpoint) throw new Error('飞书长连接 endpoint 协商失败:响应缺少 data.endpoint');
    const parsed = new URL(endpoint);
    const serviceId = Number(parsed.searchParams.get('service_id') || 0);
    this._applyClientConfig(body.data.client_config || body.data.ClientConfig || {});
    return { endpoint, serviceId };
  }

  _applyClientConfig(config = {}) {
    const pick = (name) => Number(config[name] == null ? config[name[0].toLowerCase() + name.slice(1)] : config[name]);
    const ping = pick('PingInterval');
    if (Number.isFinite(ping) && ping > 0) this._timing.heartbeatMs = Math.max(1, Math.round(ping * 1000));
    const reconnect = pick('ReconnectInterval');
    if (Number.isFinite(reconnect) && reconnect > 0) {
      const ms = Math.round(reconnect * 1000);
      this._timing.reconnectMinMs = ms;
      if (this._timing.reconnectMaxMs < ms) this._timing.reconnectMaxMs = ms;
    }
  }
  async _closeChannel() {
    const ws = this._ws;
    this._ws = null;
    if (!ws) {
      return;
    }
    try {
      ws.removeAllListeners();
    } catch {
      /* 某些实现没有 removeAllListeners */
    }
    try {
      ws.close();
    } catch {
      /* 已断开 */
    }
    try {
      if (typeof ws.terminate === 'function' && ws.readyState !== 3) {
        ws.terminate(); // 半开 TCP:close 可能永远等不到对端回 FIN
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 投递一条消息。有活连接 → 走 WS;没有 → 若配了 webhook 则降级为一次 HTTP POST
   * (退避重连期间消息不至于全丢),两者都不可用时**点名缺哪个配置**再抛。
   */
  async _deliver(target, payload, meta = {}) {
    const ws = this._ws;
    const canUseWs = Boolean(meta.connected && ws && ws.readyState === 1);
    if (canUseWs && this._officialProtocol) {
      return this._deliverViaApi(target, payload);
    }
    if (canUseWs) {
      const frame = this._encodeFrame(target, payload);
      await new Promise((resolve, reject) => {
        ws.send(frame, (err) => (err ? reject(new Error(`WS 发送失败:${describeError(err)}`)) : resolve()));
      });
      return { via: 'ws', target, bytes: Buffer.byteLength(frame) };
    }
    if (this._config.webhookUrl) {
      return this._deliverViaWebhook(target, payload);
    }
    throw new Error(
      `飞书消息未能发出(当前状态 ${meta.state || 'unknown'},无活连接且未配置 webhook 降级端点):` +
        `请设置 KHY_IM_FEISHU_WEBHOOK_URL,或等重连完成后重试`
    );
  }

  /** 出站心跳:WS 层 ping。对端回 pong 会 renew 空闲计时(见基类)。 */
  async _sendHeartbeat() {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) {
      throw new Error('心跳无法发送:WS 不在 OPEN 状态');
    }
    if (this._officialProtocol) {
      await new Promise((resolve, reject) => ws.send(this._newPingFrame(), (err) => err ? reject(err) : resolve()));
      return;
    }
    ws.ping();
  }

  // ── 帧编解码(接官方协议时只需替换这两个方法)──────────────────────────

  _encodeFrame(target, payload) {
    if (!this._officialProtocol) {
      return JSON.stringify({ type: 'message.send', chatId: target, msgType: payload.type || 'text', content: payload, appId: this._config.appId || undefined, ts: Date.now() });
    }
    const content = JSON.stringify({ text: payload.text || '' });
    const event = { receive_id: target, msg_type: payload.type || 'text', content };
    return encodeFrame({ service: this._serviceId, method: FRAME_TYPE_DATA, headers: [{ key: 'type', value: MESSAGE_TYPE_EVENT }], payload: Buffer.from(JSON.stringify(event)) });
  }

  _newPingFrame() {
    return encodeFrame({ SeqID: 0, LogID: 0, service: this._serviceId, method: FRAME_TYPE_CONTROL, headers: [{ key: 'type', value: MESSAGE_TYPE_PING }] });
  }

  _newPongFrame(frame) {
    return encodeFrame({
      SeqID: frame && frame.SeqID ? frame.SeqID : 0,
      LogID: frame && frame.LogID ? frame.LogID : 0,
      service: this._serviceId,
      method: FRAME_TYPE_CONTROL,
      headers: [{ key: 'type', value: MESSAGE_TYPE_PONG }],
    });
  }

  _decodeFrame(input) {
    if (!this._officialProtocol) return this._decodeLegacyFrame(input);
    let frame;
    try { frame = decodeFrame(Buffer.isBuffer(input) ? input : Buffer.from(input)); } catch (err) { return { kind: 'undecodable', error: `protobuf 解码失败(${describeError(err)})` }; }
    const headers = Object.fromEntries(frame.headers.map((h) => [h.key, h.value]));
    const type = String(headers.type || '').toLowerCase();
    if (type === MESSAGE_TYPE_PING) return { kind: 'ping', frame };
    if (type === MESSAGE_TYPE_PONG) {
      try { this._applyClientConfig(JSON.parse(frame.payload.toString('utf8'))); } catch { /* pong payload 可为空 */ }
      return { kind: 'pong', frame };
    }
    if (frame.method !== FRAME_TYPE_DATA || type === MESSAGE_TYPE_CARD || type !== MESSAGE_TYPE_EVENT) return { kind: 'ignored', eventType: type || '(无 type)' };
    let payload = frame.payload;
    const sum = Number(headers.sum || 1); const seq = Number(headers.seq || 0); const messageId = headers.message_id || `${frame.LogID}`;
    if (sum > 1) {
      let bundle = this._chunks.get(messageId);
      if (!bundle || bundle.sum !== sum || Date.now() - bundle.at > CHUNK_TTL_MS) bundle = { sum, at: Date.now(), parts: new Array(sum) };
      if (!Number.isInteger(seq) || seq < 0 || seq >= sum) return { kind: 'undecodable', error: `分片 seq ${seq} 超出 [0,${sum})` };
      bundle.parts[seq] = payload; bundle.at = Date.now(); this._chunks.set(messageId, bundle);
      if (bundle.parts.filter(Buffer.isBuffer).length !== sum) return { kind: 'chunk' };
      payload = Buffer.concat(bundle.parts); this._chunks.delete(messageId);
    }
    let event;
    try { event = JSON.parse(payload.toString('utf8')); } catch (err) { return { kind: 'undecodable', error: `事件 payload 不是 JSON(${describeError(err)})` }; }
    const decoded = this._decodeLegacyFrame(event);
    if (decoded.kind === 'message') decoded.frame = frame;
    return decoded;
  }

  _decodeLegacyFrame(text) {
    let frame;
    try { frame = typeof text === 'string' ? JSON.parse(text) : text; } catch (err) { return { kind: 'undecodable', error: `不是合法 JSON(${describeError(err)})` }; }
    if (!frame || typeof frame !== 'object') return { kind: 'undecodable', error: '帧顶层不是对象' };
    const type = String(frame.type || '').toLowerCase();
    if (type === 'ping') return { kind: 'ping', echo: { type: 'pong', ts: Date.now() } };
    if (type === 'pong') return { kind: 'pong' };
    if (frame.challenge) return { kind: 'challenge', echo: { type: 'challenge_ack', challenge: frame.challenge } };
    const eventType = String((frame.header && frame.header.event_type) || frame.event_type || type || '');
    const event = frame.event || {};
    if (event.message) {
      const m = event.message;
      return { kind: 'message', token: frame.token || (frame.header && frame.header.token), message: { id: m.message_id || m.messageId || frame.event_id || null, eventType: eventType || 'im.message.receive_v1', chatId: m.chat_id || m.chatId || null, senderId: (event.sender && event.sender.sender_id && (event.sender.sender_id.open_id || event.sender.sender_id.user_id)) || (event.sender && event.sender.senderId) || null, text: this._extractText(m), rawAttachments: Array.isArray(m.attachments) ? m.attachments : [], raw: frame } };
    }
    if (type === 'message' || type === 'message.receive' || frame.text !== undefined) return { kind: 'message', token: frame.token, message: { id: frame.id || frame.messageId || null, eventType: eventType || 'message', chatId: frame.chatId || frame.chat_id || null, senderId: frame.senderId || frame.sender_id || null, text: typeof frame.text === 'string' ? frame.text : this._extractText(frame), rawAttachments: Array.isArray(frame.attachments) ? frame.attachments : [], raw: frame } };
    return { kind: 'ignored', eventType: eventType || type || '(无 type)' };
  }

  /** 文本抽取:飞书 content 是个 JSON 字符串({"text":"…"}),扁平帧直接给 text。 */
  _extractText(m) {
    if (!m) {
      return '';
    }
    if (typeof m.text === 'string') {
      return m.text;
    }
    const content = m.content;
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.text === 'string') {
          return parsed.text;
        }
      } catch {
        return content; // 不是 JSON → 就是纯文本
      }
      return '';
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }
    return '';
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────

  _handleFrame(data, isBinary, ctx) {
    const started = Date.now();
    const input = this._officialProtocol ? Buffer.from(data) : (typeof data === 'string' ? data : String(data));
    const decoded = this._decodeFrame(input);
    if (decoded.kind === 'undecodable') {
      const preview = this._officialProtocol ? Buffer.from(data).subarray(0, 24).toString('hex') : input.slice(0, 120);
      this._logWarn(`入站帧无法解码(${decoded.error}),前段:${preview}`);
      return;
    }
    if (this._officialProtocol && decoded.kind === 'ping') {
      this._sendBinary(this._newPongFrame(decoded.frame), 'PONG');
      return;
    }
    if (!this._officialProtocol && (decoded.kind === 'ping' || decoded.kind === 'challenge')) {
      this._sendRaw(decoded.echo);
      return;
    }
    if (decoded.kind !== 'message') return;

    const expected = this._config.verificationToken;
    if (expected && decoded.token && String(decoded.token) !== String(expected)) {
      this._logWarn(`丢弃一条入站消息:verification token 不匹配(收到 ${redactSecret(decoded.token)},期望 ${redactSecret(expected)})`);
      this._ackEvent(decoded.frame, 500, started);
      return;
    }

    const msg = decoded.message;
    const pending = Array.isArray(msg.rawAttachments) ? msg.rawAttachments : [];
    delete msg.rawAttachments;
    msg.attachments = [];
    const dispatch = () => {
      try {
        ctx.emitMessage(msg);
        this._ackEvent(decoded.frame, 200, started);
      } catch (err) {
        this._logWarn(`入站消息派发失败:${describeError(err)}`);
        this._ackEvent(decoded.frame, 500, started);
      }
    };
    if (!pending.length) {
      dispatch();
      return;
    }
    this._cacheAttachments(pending, msg.id)
      .then((cached) => { msg.attachments = cached; dispatch(); })
      .catch((err) => { this._logWarn(`附件缓存失败,消息按无附件派发:${describeError(err)}`); dispatch(); });
  }

  _ackEvent(frame, code, started) {
    if (!this._officialProtocol || !frame) return;
    frame.headers = [...(frame.headers || []), { key: 'biz_rt', value: String(Math.max(0, Date.now() - started)) }];
    frame.payload = Buffer.from(JSON.stringify({ code, data: Buffer.from(JSON.stringify({ code })).toString('base64') }));
    this._sendBinary(encodeFrame(frame), 'EVENT ACK');
  }

  _sendBinary(bytes, label) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(bytes, (err) => { if (err) this._logWarn(`${label} 发送失败:${describeError(err)}`); });
    } catch (err) {
      this._logWarn(`${label} 发送失败:${describeError(err)}`);
    }
  }

  async _cacheAttachments(list, messageId) {
    const out = [];
    for (const item of list) {
      const a = item || {};
      try {
        if (a.base64 || a.data) {
          out.push(await this.cacheAttachment({ ...a, messageId }));
          continue;
        }
        const url = a.url || a.download_url || a.downloadUrl;
        if (url) {
          const bytes = await this._fetchAttachmentBytes(url);
          out.push(await this.cacheAttachment({ name: a.name || a.file_name, mime: a.mime, data: bytes, messageId }));
          continue;
        }
        this._logWarn(`附件 ${a.name || '(未命名)'} 既无内联字节也无下载地址,已跳过`);
      } catch (err) {
        this._logWarn(`附件 ${a.name || '(未命名)'} 缓存失败:${describeError(err)}`);
      }
    }
    return out;
  }

  /** 单次有界下载(axios 自带 timeout;不新起会影响长连接的定时器)。 */
  async _fetchAttachmentBytes(url) {
    const axios = require('axios');
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: ATTACHMENT_FETCH_TIMEOUT_MS,
      headers: this._buildAuthHeaders(),
      maxRedirects: 3,
      // 自己判状态码 → 才能把 HTTP 码写进错误消息;交给 axios 默认抛会丢掉这层信息。
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`下载附件失败:HTTP ${res.status} ${redactUrl(url)}`);
    }
    return Buffer.from(res.data);
  }

  _apiBase() {
    const configured = String(this._config.wsUrl || DEFAULT_WS_URL).replace(/\/callback\/ws\/endpoint\/?$/, '');
    return configured.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  }

  async _deliverViaApi(target, payload) {
    const client = this._httpClient || require('axios');
    const token = await this._getTenantToken(client);
    const base = this._apiBase();
    const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const response = await client.post(url, {
      receive_id: target,
      msg_type: payload.type || 'text',
      content: JSON.stringify({ text: payload.text || '' }),
    }, {
      timeout: ATTACHMENT_FETCH_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300 || Number(response.data && response.data.code) !== 0) {
      throw new Error(`飞书消息 API 投递失败:HTTP ${response.status},code ${response.data && response.data.code}`);
    }
    return { via: 'api', target, status: response.status };
  }

  async _getTenantToken(client) {
    if (this._config.accessToken) return this._config.accessToken;
    if (this._tenantToken && this._tenantTokenExpiresAt > Date.now() + 60_000) return this._tenantToken;
    const base = this._apiBase();
    const response = await client.post(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: this._config.appId,
      app_secret: this._config.appSecret,
    }, { timeout: ATTACHMENT_FETCH_TIMEOUT_MS, headers: { 'Content-Type': 'application/json; charset=utf-8' }, validateStatus: () => true });
    const body = response.data || {};
    if (response.status < 200 || response.status >= 300 || Number(body.code) !== 0 || !body.tenant_access_token) {
      throw new Error(`飞书 tenant_access_token 获取失败:HTTP ${response.status},code ${body.code}`);
    }
    this._tenantToken = body.tenant_access_token;
    this._tenantTokenExpiresAt = Date.now() + Math.max(1, Number(body.expire || 7200) - 60) * 1000;
    return this._tenantToken;
  }
  async _deliverViaWebhook(target, payload) {
    const axios = require('axios');
    const url = this._config.webhookUrl;
    const body = {
      // 飞书自定义机器人的 body 外形;私有网关按扁平字段读也能拿到 chatId/text。
      msg_type: payload.type || 'text',
      chatId: target,
      content: { text: payload.text || '' },
    };
    const res = await axios.post(url, body, {
      timeout: ATTACHMENT_FETCH_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', ...this._buildAuthHeaders() },
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`webhook 投递失败:HTTP ${res.status} ${redactUrl(url)}`);
    }
    this._logInfo(`无活连接,已经 webhook(${redactUrl(url)})降级投递 1 条消息到会话 ${target}`);
    return { via: 'webhook', target, status: res.status };
  }

  /** 发一帧原始控制消息(pong / challenge_ack),失败只记日志。 */
  _sendRaw(obj) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) {
      return;
    }
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      this._logWarn(`控制帧 ${obj && obj.type} 发送失败:${describeError(err)}`);
    }
  }

  _buildAuthHeaders() {
    const headers = {};
    if (this._config.accessToken) {
      headers.Authorization = `Bearer ${this._config.accessToken}`;
    }
    if (this._config.appId) {
      headers['X-Khy-Im-App-Id'] = this._config.appId;
    }
    return headers;
  }

  /**
   * ws 实现解析:优先注入的 wsFactory(单测),否则懒加载 `ws` 包。**懒加载**很重要——
   * 没启用飞书渠道的部署不该为它装/加载一个 WS 库(见 adapterRegistry 的零加载契约)。
   */
  _resolveWebSocketImpl() {
    if (this._wsFactory) {
      return this._wsFactory;
    }
    try {
      const mod = require('ws');
      return mod.WebSocket || mod.default || mod;
    } catch (err) {
      throw new Error(`飞书渠道需要 ws 包,但加载失败:${describeError(err)}(请在后端工作区安装 ws)`);
    }
  }
}

/**
 * 工厂:注册表通过它构造实例(注册表只持有 thunk,故未启用时本文件零加载)。
 * @param {object} [options]
 * @returns {FeishuImAdapter}
 */
function createFeishuAdapter(options = {}) {
  return new FeishuImAdapter(options);
}

module.exports = {
  FeishuImAdapter,
  createFeishuAdapter,
  CHANNEL,
  DISPLAY_NAME,
  DEFAULT_WS_URL,
  CONFIG_SPEC,
  _protocol: { encodeFrame, decodeFrame, encodeHeader, decodeHeader },
};
