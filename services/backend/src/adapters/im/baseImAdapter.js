'use strict';

/**
 * @pattern Template Method, Adapter
 *
 * baseImAdapter.js — IM 渠道适配器抽象基类:所有 IM 渠道(飞书 / Telegram / 钉钉)
 * 共用的「通道骨架」单一真源。
 *
 * 为什么需要它:`src/bridge/`(HTTP + WS 远程控制)与 `extensions/khy-trae-bridge/`
 * (编辑器侧)各自把「连上去 → 收消息 → 回消息 → 断线重连 → 附件落盘」从零搭了一遍。
 * 再加一个 IM 渠道就是第三遍,而每一遍都会重新踩同样的坑:固定时长超时把活着的长连接
 * 掐死、退避没有上界把网关打爆、附件散落在各自硬编码的 `~/.khyquant/…` 下。基类把这些
 * **与渠道无关**的部分收敛到一处,子类只实现 4 个渠道特有的钩子。
 *
 * Template Method:公开方法 connect / onMessage / sendMessage / disconnect 是**骨架**
 * (状态机 + 空闲滑动超时 + 心跳 + 指数退避重连 + 日志 + 附件缓存),渠道差异全部落在钩子:
 *   _openChannel(ctx)          建立底层长连接(ws / HTTP 长轮询),连上即 resolve
 *   _closeChannel()            关闭底层连接(**必须幂等**,重复调用不许抛)
 *   _deliver(target, payload, meta)  真正把一条消息发出去
 *   _sendHeartbeat()           发一次心跳(默认 no-op;不发心跳的渠道无需覆写)
 *   describeEndpoint()         给日志用的**已脱敏**端点串(token/secret 一律打码)
 * ctx 提供三个回调给子类回喂事件:noteActivity(renew 空闲计时)/ emitMessage / noteClosed。
 *
 * 红线 3(禁止固定时长硬超时):本基类**没有**任何「连上 N 秒就掐掉」的定时器。唯一的
 * 连接级定时器是**空闲滑动超时**——每一次来自对端的活动(数据帧 / pong / 子类显式
 * noteActivity)都会把它整体推后(_resetIdle),所以一条持续有数据的连接永远不会被超时;
 * 只有**真的静默** idleMs 才判定为半开连接并触发重连。心跳(出站)刻意**不**renew 空闲
 * 计时:否则「我一直在 ping、对端早已死透」会被自己的心跳伪装成健康连接,半开连接就再也
 * 检测不出来了。renew 只能由**入站**活动触发。
 *
 * 附件目录:一律经 utils/dataHome 的 getAppHome()(getAppDataDir 即其子目录形式)解析,
 * **禁止**任何形式的 `os.homedir() + '.khyquant'` 硬编码——那正是 dataHome.js 头部
 * [Eco-Arch-Unresolved] 记录的分叉根,新写入点不许再制造一个。
 *
 * 契约:非纯(fs 写附件、定时器、日志)。连接/发送失败一律以**具名错误**抛给调用方;
 * 但**收消息回调里的异常绝不外泄**——一个坏 handler 不许掀翻整条通道。所有定时器
 * unref,故一个空闲 adapter 不会把宿主进程钉住不退出。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clampInt = require('../../utils/clampInt');
const { getAppDataDir } = require('../../utils/dataHome');

/** 连接状态机。刻意不用「connecting」这类不透明词做状态名,日志读者能一眼分清阶段。 */
const STATE = Object.freeze({
  IDLE: 'idle', // 从未连过 / 已断开且未重连
  OPENING: 'opening', // 正在建立底层连接
  OPEN: 'open', // 已接入,收发中
  BACKOFF: 'backoff', // 断开,等退避窗口到点后重连
  STOPPED: 'stopped', // 调用方显式 disconnect(),不再自动重连
});

// 时序默认值。与 services/flagRegistry.js 里同名 numeric flag 的 `default` **必须一致**
// ——注册表是真源,这里是「注册表 require 不到时」的本地兜底(fail-soft 不许改变语义)。
const DEFAULTS = Object.freeze({
  KHY_IM_IDLE_MS: { value: 90_000, min: 0, max: 3_600_000 },
  KHY_IM_HEARTBEAT_MS: { value: 30_000, min: 0, max: 600_000 },
  KHY_IM_RECONNECT_MIN_MS: { value: 1_000, min: 100, max: 60_000 },
  KHY_IM_RECONNECT_MAX_MS: { value: 60_000, min: 1_000, max: 3_600_000 },
  // 握手上界:这是「建立一次连接」的有界等待(TCP + HTTP upgrade),不是对已建立连接的
  // 固定时长限制,与红线 3 不冲突。连上之后接管的是空闲滑动超时。
  KHY_IM_HANDSHAKE_MS: { value: 10_000, min: 1_000, max: 120_000 },
});

// 退避抖动 ±20%:同一台机器上多个渠道(飞书 + Telegram)同时掉线时,不许在同一毫秒
// 一起撞回网关。抖动只影响单次等待,不影响「指数增长」这个可断言的性质。
const RECONNECT_JITTER = 0.2;

// 单个附件上限 32MB。超限**明确报错并写出实际大小**,而不是静默截断成半个文件
// ——半个附件比没有附件更难排查。
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** 数值门控解析:优先走中央注册表(已登记 + 可注入 env),取不到 → 本地默认 + clamp。 */
function resolveNumericFlag(env, name) {
  const spec = DEFAULTS[name];
  try {
    const registry = require('../../services/flagRegistry');
    if (registry && typeof registry.resolveNumeric === 'function' && registry.FLAGS && registry.FLAGS[name]) {
      return registry.resolveNumeric(name, env || process.env);
    }
  } catch {
    /* 注册表不可用 → 落本地兜底,绝不因此起不来 */
  }
  const raw = env && env[name];
  return clampInt(raw, spec.min, spec.max, spec.value);
}

/** 把任意抛出物压成一行可读消息(绝不再抛)。 */
function describeError(err) {
  if (!err) {
    return 'unknown';
  }
  if (err instanceof Error) {
    return err.message || err.name || 'Error';
  }
  try {
    return String(err);
  } catch {
    return 'unstringifiable';
  }
}

/** 秒数展示:统一 1 位小数,日志里 `0.5s` / `12.0s` 对齐好读。 */
function seconds(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
}

/** 附件文件名消毒:去掉路径分隔符与控制字符,防止 `../` 逃出附件目录。 */
function safeFileName(name, fallback) {
  const base = path.basename(String(name || '').trim());
  // 控制字符 + Windows 非法文件名字符 → '_'。逐码点过滤而不是写一个含控制字符的
  // 正则字面量:源码里嵌裸控制字节会让 grep/diff 把本文件当二进制处理。
  const cleaned = [...base]
    .map((ch) => (ch.codePointAt(0) < 0x20 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

class BaseImAdapter {
  /**
   * @param {object} options
   * @param {string} options.channel        渠道短名(小写,如 'feishu'),决定配置键与附件目录
   * @param {string} [options.displayName]  日志里的人类可读名(如 '飞书网关')
   * @param {object} [options.env]          env 快照(可注入,便于单测)
   * @param {object} [options.logger]       日志器(winston 风格 info/warn/error);缺省懒加载共享 logger
   * @param {boolean} [options.autoReconnect=true] 断线是否自动重连
   * @param {object} [options.timing]       覆盖 idleMs/heartbeatMs/reconnectMinMs/reconnectMaxMs
   * @param {function} [options.random]     抖动随机源(可注入,便于断言退避序列)
   */
  constructor(options = {}) {
    const opts = options || {};
    this.channel = String(opts.channel || '').trim().toLowerCase();
    if (!this.channel) {
      throw new Error('BaseImAdapter: 缺少 channel 名(如 feishu),无法解析配置键与附件目录');
    }
    this.displayName = String(opts.displayName || '').trim() || this.channel;

    this._env = opts.env || process.env;
    this._logger = opts.logger || null;
    this._autoReconnect = opts.autoReconnect !== false;
    this._random = typeof opts.random === 'function' ? opts.random : Math.random;

    this._timing = this._resolveTiming(opts.timing);

    this._handlers = new Set();
    this._state = STATE.IDLE;
    this._attempt = 0; // 连续失败次数;连上即归零
    this._lastActivityAt = 0;
    this._lastCloseReason = '';
    this._stopped = false;
    this._connectPromise = null;

    this._idleTimer = null;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;

    this._stats = { opens: 0, reconnects: 0, received: 0, sent: 0, attachments: 0 };
  }

  /**
   * 时序解析。心跳必须**严格短于**空闲超时,否则空闲窗口在第一次心跳之前就到点了,
   * 心跳形同不存在;这里把它收敛为 idle/3(而不是静默接受一个自相矛盾的配置)。
   */
  _resolveTiming(override = {}) {
    const env = this._env;
    const idleMs = Number.isFinite(override.idleMs)
      ? Math.max(0, Math.round(override.idleMs))
      : resolveNumericFlag(env, 'KHY_IM_IDLE_MS');
    let heartbeatMs = Number.isFinite(override.heartbeatMs)
      ? Math.max(0, Math.round(override.heartbeatMs))
      : resolveNumericFlag(env, 'KHY_IM_HEARTBEAT_MS');
    if (idleMs > 0 && heartbeatMs >= idleMs) {
      heartbeatMs = Math.max(1, Math.floor(idleMs / 3));
    }
    const reconnectMinMs = Number.isFinite(override.reconnectMinMs)
      ? Math.max(1, Math.round(override.reconnectMinMs))
      : resolveNumericFlag(env, 'KHY_IM_RECONNECT_MIN_MS');
    let reconnectMaxMs = Number.isFinite(override.reconnectMaxMs)
      ? Math.max(1, Math.round(override.reconnectMaxMs))
      : resolveNumericFlag(env, 'KHY_IM_RECONNECT_MAX_MS');
    if (reconnectMaxMs < reconnectMinMs) {
      reconnectMaxMs = reconnectMinMs;
    }
    return { idleMs, heartbeatMs, reconnectMinMs, reconnectMaxMs };
  }

  // ── 日志(懒加载共享 logger:单测注入自己的收集器即可完全不碰 winston 文件传输)──
  _log(level, message, meta) {
    try {
      if (!this._logger) {
        this._logger = require('../../utils/logger');
      }
      const fn = this._logger[level] || this._logger.info;
      if (typeof fn === 'function') {
        fn.call(this._logger, message, meta || { channel: this.channel });
      }
    } catch {
      /* 日志绝不阻断通道 */
    }
  }

  _logInfo(message, meta) {
    this._log('info', message, meta);
  }

  _logWarn(message, meta) {
    this._log('warn', message, meta);
  }

  // ── 公开 API(Template Method 骨架:子类不覆写)────────────────────────────

  /**
   * 建立长连接并进入「收发 + 自愈」状态。
   *
   * 首次连接失败:**既 reject 给调用方**(调用方要知道自己没连上),**也照常排程退避
   * 重连**(网关抖一下不该让整条渠道永久躺平)。调用方 catch 后什么都不做即可,重连在
   * 后台继续,进度写在日志里。`autoReconnect:false` 时只 reject,不排程。
   *
   * 并发安全:重复 connect() 复用同一个在飞 promise;已 OPEN 时直接返回。
   * @returns {Promise<this>}
   */
  async connect() {
    this._stopped = false; // 允许 disconnect() 之后重新 connect()
    if (this._state === STATE.OPEN) {
      return this;
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }
    this._connectPromise = this._openOnce().finally(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  /**
   * 注册收消息回调。回调收到的是**归一后**的消息对象:
   *   { channel, receivedAt, id, chatId, senderId, text, attachments[], raw }
   * @param {function} handler
   * @returns {function} 反注册函数(幂等)
   */
  onMessage(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`${this.displayName} onMessage(handler) 需要一个函数,收到 ${typeof handler}`);
    }
    this._handlers.add(handler);
    return () => {
      this._handlers.delete(handler);
    };
  }

  /**
   * 发送一条消息。
   * @param {string} target 会话/群 id(渠道语义由子类解释)
   * @param {string|object} content 文本或 { type, text, ... } 结构
   * @returns {Promise<*>} 子类 _deliver 的返回值
   */
  async sendMessage(target, content) {
    if (this._state === STATE.STOPPED) {
      throw new Error(`${this.displayName} 已断开(disconnect),发送前请先 connect()`);
    }
    const chatId = String(target == null ? '' : target).trim();
    if (!chatId) {
      throw new Error(`${this.displayName} 发送失败:target(会话/群 id)为空`);
    }
    const payload = this._normalizeOutgoing(content);

    // 从未连过 → 先连一次。已在 OPENING/BACKOFF 中则不阻塞调用方:把「当前是否有活连接」
    // 如实告诉子类,由子类决定走无连接旁路(如 webhook)还是明确报错。
    if (this._state === STATE.IDLE) {
      try {
        await this.connect();
      } catch (err) {
        // 首连失败**不是** sendMessage 的终局:_openOnce 已记日志并排程退避重连,而有旁路的
        // 渠道(webhook / REST)本就该在没有长连接时也把消息送出去。这里如实把「无活连接」
        // 交给子类决定,没有旁路的子类会在 _deliver 里报出「缺哪个配置」的明确错误。
        this._logWarn(
          `${this.displayName} 发送前首次连接未成功,本条改按「无活连接」投递:${describeError(err)}`
        );
      }
    }
    const connected = this._state === STATE.OPEN;
    const result = await this._deliver(chatId, payload, { connected, state: this._state });
    this._stats.sent += 1;
    return result;
  }

  /**
   * 显式断开:停掉所有定时器与自动重连,关闭底层连接。幂等。
   * @param {string} [reason]
   */
  async disconnect(reason = 'caller') {
    const wasActive = this._state === STATE.OPEN || this._state === STATE.OPENING || this._state === STATE.BACKOFF;
    this._stopped = true;
    this._clearIdleTimer();
    this._clearHeartbeatTimer();
    this._clearReconnectTimer();
    this._state = STATE.STOPPED;
    try {
      await this._closeChannel();
    } catch (err) {
      this._logWarn(`${this.displayName} 关闭底层连接时报错(已忽略):${describeError(err)}`);
    }
    if (wasActive) {
      const s = this._stats;
      this._logInfo(
        `已断开${this.displayName}(${this.describeEndpoint()},原因 ${reason}):本次会话收 ${s.received} 条·发 ${s.sent} 条·缓存附件 ${s.attachments} 个`
      );
    }
    return this;
  }

  /** 只读快照,给 `khy` 诊断命令/测试用。 */
  describeState() {
    return {
      channel: this.channel,
      displayName: this.displayName,
      endpoint: this.describeEndpoint(),
      state: this._state,
      attempt: this._attempt,
      autoReconnect: this._autoReconnect,
      lastActivityAt: this._lastActivityAt ? new Date(this._lastActivityAt).toISOString() : null,
      lastCloseReason: this._lastCloseReason || null,
      timing: { ...this._timing },
      stats: { ...this._stats },
      attachmentDir: this.attachmentDir(),
    };
  }

  // ── 附件缓存(统一落数据目录;禁止硬编码 ~/.khyquant)────────────────────

  /**
   * 本渠道的附件目录:`<getAppHome()>/im/<channel>/attachments`。
   * getAppDataDir 内部即 getAppHome() + mkdir,故这里**没有**任何 homedir 拼接。
   * @returns {string}
   */
  attachmentDir() {
    return getAppDataDir('im', this.channel, 'attachments');
  }

  /**
   * 把一个附件字节流缓存到数据目录,返回落盘信息。
   *
   * 命名 `<sha1-12>-<原名>`:内容寻址 → 同一附件重复推送只落一份(直接复用已有文件),
   * 且原名保留在尾部,人能在文件管理器里认出来。
   *
   * @param {object} attachment
   * @param {Buffer|Uint8Array|string} [attachment.data]   原始字节(string 按 base64 解)
   * @param {string} [attachment.base64]                   base64 字节(与 data 二选一)
   * @param {string} [attachment.name]                     原始文件名
   * @param {string} [attachment.mime]                     MIME 类型(仅记录)
   * @param {string} [attachment.messageId]                来源消息 id(仅记录)
   * @returns {Promise<{path:string,bytes:number,sha1:string,name:string,mime:string|null,reused:boolean}>}
   */
  async cacheAttachment(attachment = {}) {
    const a = attachment || {};
    let buf;
    if (Buffer.isBuffer(a.data)) {
      buf = a.data;
    } else if (a.data instanceof Uint8Array) {
      buf = Buffer.from(a.data);
    } else if (typeof a.base64 === 'string' && a.base64) {
      buf = Buffer.from(a.base64, 'base64');
    } else if (typeof a.data === 'string' && a.data) {
      buf = Buffer.from(a.data, 'base64');
    } else {
      throw new Error(
        `${this.displayName} 附件缓存失败:未提供字节(需要 data:Buffer 或 base64:string),附件名 ${a.name || '(未命名)'}`
      );
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${this.displayName} 附件 ${a.name || '(未命名)'} 为 ${buf.length} 字节,超过上限 ${MAX_ATTACHMENT_BYTES} 字节,已拒绝缓存(未写入半个文件)`
      );
    }

    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const dir = this.attachmentDir();
    const fileName = `${sha1.slice(0, 12)}-${safeFileName(a.name, `${this.channel}-attachment`)}`;
    const target = path.join(dir, fileName);

    let reused = false;
    try {
      const st = fs.statSync(target);
      reused = st.isFile() && st.size === buf.length;
    } catch {
      reused = false; // 不存在 → 正常写入
    }
    if (!reused) {
      // 局部原子写:tmp + rename。utils/atomicWriteJson 明确把「二进制写」排除在收敛
      // 范围外(Buffer 有自己的编码/长度语义),故这里保留一份 3 行的二进制版本。
      const tmp = `${target}.tmp-${process.pid}-${this._stats.attachments}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
    }
    this._stats.attachments += 1;
    return {
      path: target,
      bytes: buf.length,
      sha1,
      name: a.name || fileName,
      mime: a.mime || null,
      messageId: a.messageId || null,
      reused,
    };
  }

  // ── 子类回喂事件的受保护接口 ───────────────────────────────────────────

  /**
   * 标记「对端有活动」——把空闲滑动超时整体推后。子类在收到任何入站帧 / pong 时调用。
   * @param {string} [reason]
   */
  _noteActivity(reason = 'inbound') {
    this._lastActivityAt = Date.now();
    this._lastActivityReason = reason;
    this._resetIdle();
  }

  /**
   * 归一并派发一条入站消息。同时 renew 空闲计时(收到消息当然算活动)。
   * 回调抛错**就地隔离**:一个坏 handler 不许掀翻通道。
   * @param {object} message
   * @returns {object} 派发出去的归一消息
   */
  _emitMessage(message) {
    this._noteActivity('message');
    this._stats.received += 1;
    const msg = {
      channel: this.channel,
      receivedAt: new Date().toISOString(),
      ...(message || {}),
    };
    for (const handler of [...this._handlers]) {
      try {
        const ret = handler(msg);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => {
            this._logWarn(`${this.displayName} 消息回调(异步)抛错,已隔离:${describeError(err)}`);
          });
        }
      } catch (err) {
        this._logWarn(`${this.displayName} 消息回调抛错,已隔离:${describeError(err)}`);
      }
    }
    return msg;
  }

  /**
   * 标记底层连接已断(子类的 close/error 事件里调用)→ 关闭 + 排程退避重连。
   * @param {string} reason
   */
  _noteChannelClosed(reason = 'remote-close') {
    if (this._stopped || this._state === STATE.STOPPED) {
      return;
    }
    if (this._state === STATE.BACKOFF && this._reconnectTimer) {
      return; // 已在退避窗口里,别把同一次断开排程两遍
    }
    const wasOpen = this._state === STATE.OPEN;
    this._lastCloseReason = String(reason || 'remote-close');
    this._state = STATE.BACKOFF;
    this._clearIdleTimer();
    this._clearHeartbeatTimer();
    try {
      const ret = this._closeChannel();
      if (ret && typeof ret.then === 'function') {
        ret.catch(() => {});
      }
    } catch {
      /* 幂等关闭失败无所谓,接下来就要重建连接 */
    }
    if (wasOpen) {
      this._logWarn(`${this.displayName}连接断开(${this._lastCloseReason}),准备重连`);
    }
    this._scheduleReconnect(this._lastCloseReason);
  }

  // ── 子类必须/可以实现的钩子 ───────────────────────────────────────────

  /* eslint-disable-next-line no-unused-vars */
  async _openChannel(ctx) {
    throw new Error(`${this.constructor.name} 未实现 _openChannel(ctx):无法建立 ${this.channel} 长连接`);
  }

  async _closeChannel() {
    /* 默认 no-op;子类覆写且必须幂等 */
  }

  /* eslint-disable-next-line no-unused-vars */
  async _deliver(target, payload, meta) {
    throw new Error(`${this.constructor.name} 未实现 _deliver(target, payload):无法发送 ${this.channel} 消息`);
  }

  async _sendHeartbeat() {
    /* 默认 no-op:不需要应用层心跳的渠道无需覆写 */
  }

  /** 日志用的已脱敏端点串。子类覆写。 */
  describeEndpoint() {
    return `${this.channel}://(端点未声明)`;
  }

  /** 出站内容归一。子类可覆写以支持富文本/卡片。 */
  _normalizeOutgoing(content) {
    if (typeof content === 'string') {
      return { type: 'text', text: content };
    }
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      return { type: 'text', ...content };
    }
    throw new TypeError(
      `${this.displayName} 发送失败:content 需要 string 或 object,收到 ${Array.isArray(content) ? 'array' : typeof content}`
    );
  }

  // ── 连接 / 重连内部实现 ───────────────────────────────────────────────

  async _openOnce() {
    this._clearReconnectTimer();
    const isRetry = this._attempt > 0;
    this._state = STATE.OPENING;
    try {
      await this._openChannel({
        noteActivity: (reason) => this._noteActivity(reason),
        emitMessage: (msg) => this._emitMessage(msg),
        noteClosed: (reason) => this._noteChannelClosed(reason),
      });
    } catch (err) {
      this._state = STATE.BACKOFF;
      this._logWarn(`接入${this.displayName}(${this.describeEndpoint()})失败:${describeError(err)}`);
      this._scheduleReconnect(`open-failed:${describeError(err)}`);
      const wrapped = new Error(
        `接入${this.displayName}(${this.describeEndpoint()})失败:${describeError(err)}`
      );
      wrapped.cause = err;
      wrapped.channel = this.channel;
      throw wrapped;
    }
    if (this._stopped) {
      // disconnect() 在握手期间发生:立刻收掉刚建好的连接,不留孤儿 socket。
      try {
        await this._closeChannel();
      } catch {
        /* ignore */
      }
      return this;
    }
    this._state = STATE.OPEN;
    this._stats.opens += 1;
    if (isRetry) {
      this._stats.reconnects += 1;
    }
    const attemptsUsed = this._attempt;
    this._attempt = 0;
    this._noteActivity('open');
    this._startHeartbeat();
    const t = this._timing;
    this._logInfo(
      `已接入${this.displayName}(${this.describeEndpoint()})` +
        `${isRetry ? `,重连成功于第 ${attemptsUsed} 次重试` : ''}` +
        `:空闲滑动超时 ${seconds(t.idleMs)}s·心跳 ${seconds(t.heartbeatMs)}s`
    );
    return this;
  }

  /**
   * 排程下一次重连。日志**必须**写明连到哪、第几次、还要等多久——只说「重连中」的日志
   * 在真实故障里等于没有日志(排查者无法判断是在退避还是卡死)。
   */
  _scheduleReconnect(reason) {
    if (this._stopped || !this._autoReconnect) {
      return;
    }
    if (this._reconnectTimer) {
      return;
    }
    this._attempt += 1;
    const delay = this._backoffDelayMs(this._attempt);
    this._logInfo(
      `连接${this.displayName}(${this.describeEndpoint()}),第 ${this._attempt} 次重试,` +
        `退避 ${seconds(delay)}s 后开始(上次断开:${reason})`
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openOnce().catch(() => {
        /* _openOnce 内部已记日志并排程下一次;这里只是不让它变成未捕获拒绝 */
      });
    }, delay);
    if (this._reconnectTimer && typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
  }

  /**
   * 指数退避 + ±20% 抖动 + 上界封顶。
   * 复用 services/retryWithBackoff 不合适:那是「有限次数、跑完就抛」的语义,而重连是
   * **无限期的监督循环**(网关半夜恢复也得连上),两者的失败终局相反。
   * @param {number} attempt 第几次重试(1 起)
   * @returns {number} 毫秒
   */
  _backoffDelayMs(attempt) {
    const { reconnectMinMs, reconnectMaxMs } = this._timing;
    const n = Math.max(1, Math.floor(attempt));
    // 2**(n-1) 在 n 很大时会溢出成 Infinity;先封顶再抖动,Infinity 不会漏进 setTimeout。
    const exp = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, Math.min(30, n - 1)));
    const jitter = exp * RECONNECT_JITTER * (this._random() * 2 - 1);
    return Math.max(reconnectMinMs, Math.min(reconnectMaxMs, Math.round(exp + jitter)));
  }

  // ── 空闲滑动超时 + 心跳 ───────────────────────────────────────────────

  /** 重新武装空闲计时器(滑动窗口的「滑」就在这里:每次入站活动都整体推后)。 */
  _resetIdle() {
    this._clearIdleTimer();
    if (this._stopped || this._state !== STATE.OPEN) {
      return;
    }
    const idleMs = this._timing.idleMs;
    if (!(idleMs > 0)) {
      return; // 0 = 显式关闭空闲判定(如单测里只验心跳)
    }
    this._idleTimer = setTimeout(() => this._onIdleExpired(), idleMs);
    if (this._idleTimer && typeof this._idleTimer.unref === 'function') {
      this._idleTimer.unref();
    }
  }

  _onIdleExpired() {
    const silentMs = this._lastActivityAt ? Date.now() - this._lastActivityAt : this._timing.idleMs;
    this._logWarn(
      `${this.displayName}连接已静默 ${seconds(silentMs)}s(空闲滑动超时 ${seconds(this._timing.idleMs)}s),` +
        `判定为半开连接,主动重连`
    );
    this._noteChannelClosed(`idle-${seconds(silentMs)}s`);
  }

  _startHeartbeat() {
    this._clearHeartbeatTimer();
    const ms = this._timing.heartbeatMs;
    if (!(ms > 0)) {
      return;
    }
    this._heartbeatTimer = setInterval(() => {
      void this._beat();
    }, ms);
    if (this._heartbeatTimer && typeof this._heartbeatTimer.unref === 'function') {
      this._heartbeatTimer.unref();
    }
  }

  async _beat() {
    if (this._state !== STATE.OPEN || this._stopped) {
      return;
    }
    try {
      await this._sendHeartbeat();
    } catch (err) {
      this._logWarn(`${this.displayName} 心跳发送失败:${describeError(err)},按断开处理`);
      this._noteChannelClosed(`heartbeat-failed:${describeError(err)}`);
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _clearHeartbeatTimer() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = {
  BaseImAdapter,
  STATE,
  DEFAULTS,
  MAX_ATTACHMENT_BYTES,
  RECONNECT_JITTER,
  // 供子类/测试复用的小工具(非公开面,但比各自再抄一份好)。
  describeError,
  seconds,
  safeFileName,
  resolveNumericFlag,
};
