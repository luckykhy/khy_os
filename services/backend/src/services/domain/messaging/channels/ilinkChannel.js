'use strict';

/**
 * ilinkChannel.js — 微信(个人号)通道。长轮询收、HTTP 发。
 *
 * 与其他渠道(钉钉/飞书/企业微信)的根本差别:那些是 webhook 入站(被动等平台来敲),
 * 本通道是**主动长轮询**(getupdates 挂起 35s)。所以 connect() 会起一个自驱循环,
 * disconnect() 必须能把它掐干净——否则守护进程退不掉。
 *
 * **轮询循环里对每条消息 fire-and-forget 派发**,绝不 await 业务处理。这不是性能优化,
 * 是正确性要求:一次 agent 查询可能跑几分钟,期间用户要能发 `y`/`n` 审批工具执行。
 * 若在这里 await,那条 `y` 永远拉不下来,审批必然超时——参考实现在此处有同样的注释。
 * (派发目标 messageRouter._handleMessage 本身是 async 且 emit 不 await,天然不阻塞。)
 *
 * 契约:本类不吞协议错误——ilinkApi 抛出的异常在循环里被计数并驱动退避;
 * 但 connect()/disconnect() 与消息派发一律 fail-soft,不把守护进程拖崩。
 *
 * @module services/channels/ilinkChannel
 */

const defaults = require('../../../../constants/serviceDefaults');
const log = require('../../../../utils/logger');
const store = require('../messaging/ilinkAccountStore');
const { IlinkApi } = require('../messaging/ilinkApi');
const core = require('../messaging/ilinkCore');
const media = require('../messaging/ilinkMedia');

const { BaseChannel } = require('./_baseChannel');

class IlinkChannel extends BaseChannel {
  /**
   * @param {object} opts
   * @param {string} opts.botToken
   * @param {string} opts.accountId 自己的 ilink_bot_id(出站 from_user_id)
   * @param {string} [opts.userId]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.channelName] 每账号唯一注册名(多账号时区分通道);缺省回落到 core.PLATFORM(单账号兼容)。
   * @param {object} [opts.api] 注入的 api(测试用);默认自建 IlinkApi
   */
  constructor(opts = {}) {
    super({ name: opts.channelName || core.PLATFORM, config: { accountId: opts.accountId || '' } });
    this.accountId = String(opts.accountId || '');
    this.api = opts.api || new IlinkApi({ botToken: opts.botToken, baseUrl: opts.baseUrl });
    this._dedupe = core.createDedupe(defaults.ILINK_DEDUPE_MAX);
    this._abort = null;
    this._loop = null;
    this._seq = 0;
    this._failures = 0;
    // 会话过期(ret=-14)需要重新扫码;置位后 status 能如实告诉用户,而不是假装在跑。
    this.sessionExpired = false;
  }

  /** 起长轮询循环。立即返回,不等第一轮。 */
  async connect() {
    if (this._connected) {
      return;
    }
    if (!this.accountId) {
      throw new Error('ilink: 缺少 accountId,无法出站');
    }
    this._abort = new AbortController();
    this._connected = true;
    this.sessionExpired = false;
    this.emit('connected');
    // 循环自己吞掉全部异常;这里不 await,connect 不该被第一轮长轮询挂住 35 秒。
    this._loop = this._pollLoop(this._abort.signal);
  }

  /** 掐掉轮询并等循环真正退出(守护进程 shutdown 会调)。 */
  async disconnect() {
    if (this._abort) {
      this._abort.abort();
    }
    this._connected = false;
    // 等循环收尾,避免退出后还有 fetch 在飞导致进程挂着不退。
    if (this._loop) {
      try {
        await this._loop;
      } catch {
        /* 循环内部已 fail-soft */
      }
      this._loop = null;
    }
    this._abort = null;
    this.emit('disconnected');
  }

  /** 可中断的睡眠;abort 时立刻醒。 */
  _sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        return resolve();
      }
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      }
    });
  }

  /**
   * 长轮询主循环。每轮:getupdates → 派发新消息 → 存游标。
   * 失败按 ilinkCore.decideBackoffMs 退避;ret=-14 长暂停(需重新扫码,快速重试无意义)。
   * @param {AbortSignal} signal
   */
  async _pollLoop(signal) {
    while (!signal.aborted) {
      try {
        const buf = store.getSyncBuf(this.accountId);
        const resp = await this.api.getUpdates(buf);
        if (signal.aborted) {
          break;
        }

        if (core.isSessionExpired(resp)) {
          this.sessionExpired = true;
          // 落盘:过期发生在守护进程里,而用户是在 CLI 跑 khy wx status —— 内存标志跨不了
          // 进程。且此刻微信那头也通知不了(会话已死),这个文件是唯一能说清原因的载体。
          store.setSessionExpired(
            this.accountId,
            true,
            `getupdates ret=${core.RET_SESSION_EXPIRED}`
          );
          log.warn(
            `ilink: 会话已过期(ret=${core.RET_SESSION_EXPIRED}),需重新扫码 khy wx login。暂停轮询。`
          );
          this.emit('error', { error: new Error('ilink 会话已过期,请重新扫码') });
          await this._sleep(defaults.ILINK_SESSION_EXPIRED_PAUSE_MS, signal);
          continue;
        }

        this._failures = 0;
        if (this.sessionExpired) {
          // 恢复了(极少见,但会话可能被服务端续上)。setSessionExpired 内部只在状态真的
          // 变化时才写盘,所以这里无需自己判重。
          store.setSessionExpired(this.accountId, false);
        }
        this.sessionExpired = false;
        // 心跳:让 CLI 跨进程看出「长轮询确实还在转」。守护进程 PID 还在 ≠ 通道还活着。
        // 自带 60s 限流,不会变成每轮一次的写。
        store.touchHeartbeat(this.accountId, defaults.ILINK_HEARTBEAT_MIN_INTERVAL_MS);

        // 先存游标再派发:派发是 fire-and-forget,若先派发后存,进程在此刻崩会重复拉取
        // (去重器能挡,但没必要);游标写失败只影响下一轮可能重复,不该中断轮询。
        if (resp && resp.get_updates_buf) {
          store.setSyncBuf(this.accountId, resp.get_updates_buf);
        }

        const msgs = Array.isArray(resp && resp.msgs) ? resp.msgs : [];
        for (const raw of msgs) {
          const parsed = core.parseInboundMessage(raw);
          if (!parsed) {
            continue;
          } // BOT 回声 / 缺字段 → 丢
          if (!this._dedupe.accept(parsed.messageId)) {
            continue;
          }
          // ⚠️ 绝不 await:一次查询可能跑几分钟,期间必须能继续拉到用户的 y/n。
          this.emit('message', parsed);
        }
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        this._failures += 1;
        const wait = core.decideBackoffMs(this._failures, {
          shortMs: defaults.ILINK_BACKOFF_SHORT_MS,
          longMs: defaults.ILINK_BACKOFF_LONG_MS,
          threshold: defaults.ILINK_BACKOFF_THRESHOLD,
        });
        // 前几次只 debug:长轮询超时是正常现象,不该刷 warn 刷屏。
        const line = `ilink 轮询失败(连续 ${this._failures} 次),${wait}ms 后重试:${(err && err.message) || err}`;
        if (this._failures >= defaults.ILINK_BACKOFF_THRESHOLD) {
          log.warn(line);
        } else {
          log.debug(line);
        }
        await this._sleep(wait, signal);
      }
    }
  }

  /**
   * 发一片,带瞬时故障重试。
   *
   * 零重试时一次网络抖动就把整条回复丢了 —— 而微信那头**看不出区别**:没有回复和
   * 回复失败长得一模一样。所以瞬时故障(网络错/超时/429/5xx)要退避重试;永久错
   * (4xx 报文/鉴权问题)立即放弃,重发多少次都一样。
   *
   * @param {object} payload
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>} 重试用尽仍失败则抛最后一次的错误
   */
  async _sendChunkWithRetry(payload, signal) {
    const maxRetries = Math.max(0, Number(defaults.ILINK_SEND_MAX_RETRIES) || 0);
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal && signal.aborted) {
        throw new Error('已取消');
      }
      try {
        await this.api.sendMessage(payload);
        if (attempt > 0) {
          log.debug(`ilink 出站第 ${attempt} 次重试后成功`);
        }
        return;
      } catch (err) {
        lastErr = err;
        if (attempt >= maxRetries || !core.isRetryableSendError(err)) {
          throw err;
        }
        const wait = core.sendBackoffMs(attempt + 1, defaults.ILINK_SEND_RETRY_BASE_MS);
        log.debug(`ilink 出站失败(${(err && err.message) || err}),${wait}ms 后重试`);
        await this._sleep(wait, signal);
      }
    }
    throw lastErr;
  }

  /**
   * 发一条文本(自动按上限分片,顺序发)。
   * @param {string} channelId 对方 ilink_user_id
   * @param {string} text
   * @param {object} [opts] { threadId } —— context_token,微信端靠它把回答挂到本轮对话
   * @returns {Promise<{ok:boolean, sent:number, error?:string}>}
   */
  async sendMessage(channelId, text, opts = {}) {
    const chunks = core.splitMessage(text, defaults.ILINK_MAX_MESSAGE_LENGTH);
    if (!chunks.length) {
      return { ok: true, sent: 0 };
    }
    let sent = 0;
    for (const chunk of chunks) {
      this._seq += 1;
      const payload = core.buildOutboundMessage({
        toUserId: String(channelId || ''),
        clientId: core.buildClientId(this._seq, Date.now()),
        contextToken: this._resolveContextToken(channelId, opts),
        items: core.buildTextItems(chunk),
      });
      try {
        await this._sendChunkWithRetry(payload, opts && opts.signal);
        sent += 1;
      } catch (err) {
        // 分片中途失败:如实返回已发出的片数,不假装全部成功。
        return { ok: false, sent, error: (err && err.message) || String(err) };
      }
    }
    return { ok: true, sent };
  }

  /** 回复(threadId = context_token)。 */
  async sendReply(channelId, threadId, text, opts = {}) {
    return this.sendMessage(channelId, text, { ...opts, threadId });
  }

  /**
   * 解析出站 context_token:优先用入站 threadId 带的,缺失时 fallback 到
   * 落盘的最近一次入站 token(store.getContextToken)。主动推送(如发绑定二维码)
   * 常常没有 threadId,靠这个 fallback 才能把消息挂回同一会话。
   * @param {string} channelId 对方 ilink_user_id
   * @param {object} [opts] { threadId }
   * @returns {string}
   */
  _resolveContextToken(channelId, opts = {}) {
    const fromInbound = String((opts && opts.threadId) || '');
    if (fromInbound) {
      return fromInbound;
    }
    return store.getContextToken(this.accountId, String(channelId || ''));
  }

  /**
   * 发一张图片。先把图片加密上传到 CDN(ilinkMedia),再把 media 凭据
   * 组装成出站 item_list 发出。复用 sendMessage 同一条带重试的发送路径。
   *
   * @param {string} channelId 对方 ilink_user_id
   * @param {Buffer} imageBuffer 明文图片字节
   * @param {object} [opts] { threadId, fileName, signal }
   * @returns {Promise<{ok:boolean, sent?:number, error?:string}>}
   */
  async sendImage(channelId, imageBuffer, opts = {}) {
    const up = await media.uploadImage(this.api, imageBuffer, {
      toUserId: String(channelId || ''),
      fileName: opts && opts.fileName,
    });
    if (!up.ok) {
      return { ok: false, error: up.error };
    }

    this._seq += 1;
    const payload = core.buildOutboundMessage({
      toUserId: String(channelId || ''),
      clientId: core.buildClientId(this._seq, Date.now()),
      contextToken: this._resolveContextToken(channelId, opts),
      items: core.buildImageItems(
        { encrypt_query_param: up.media.encrypt_query_param, aes_key: up.media.aesKeyOutbound },
        { rawsize: up.media.rawsize }
      ),
    });
    try {
      await this._sendChunkWithRetry(payload, opts && opts.signal);
      return { ok: true, sent: 1 };
    } catch (err) {
      return { ok: false, sent: 0, error: (err && err.message) || String(err) };
    }
  }

  /**
   * 发一个文件。与 sendImage 对称:先把文件加密上传到 CDN(ilinkMedia),再把
   * media 凭据连同 file_name 组装成出站 item_list 发出。复用 sendMessage 同一条
   * 带重试的发送路径。
   *
   * @param {string} channelId 对方 ilink_user_id
   * @param {Buffer} fileBuffer 明文文件字节
   * @param {object} [opts] { threadId, fileName, signal }
   * @returns {Promise<{ok:boolean, sent?:number, error?:string}>}
   */
  async sendFile(channelId, fileBuffer, opts = {}) {
    const up = await media.uploadFile(this.api, fileBuffer, {
      toUserId: String(channelId || ''),
      fileName: opts && opts.fileName,
    });
    if (!up.ok) {
      return { ok: false, error: up.error };
    }

    this._seq += 1;
    const payload = core.buildOutboundMessage({
      toUserId: String(channelId || ''),
      clientId: core.buildClientId(this._seq, Date.now()),
      contextToken: this._resolveContextToken(channelId, opts),
      items: core.buildFileItems(
        { encrypt_query_param: up.media.encrypt_query_param, aes_key: up.media.aesKeyOutbound },
        { fileName: opts && opts.fileName }
      ),
    });
    try {
      await this._sendChunkWithRetry(payload, opts && opts.signal);
      return { ok: true, sent: 1 };
    } catch (err) {
      return { ok: false, sent: 0, error: (err && err.message) || String(err) };
    }
  }

  /**
   * 发/停「正在输入」。需要先 getConfig 取 typing_ticket。
   * 纯装饰性能力,任何失败一律静默——绝不因为输入指示器发不出就影响回答。
   * @param {string} toUserId
   * @param {boolean} on
   * @param {string} [contextToken]
   */
  async setTyping(toUserId, on, contextToken) {
    try {
      const cfg = await this.api.getConfig(String(toUserId || ''), contextToken);
      const ticket = cfg && (cfg.typing_ticket || (cfg.config && cfg.config.typing_ticket));
      if (!ticket) {
        return false;
      }
      await this.api.sendTyping(String(toUserId || ''), String(ticket), on ? 1 : 2);
      return true;
    } catch {
      return false;
    }
  }

  toJSON() {
    return {
      name: this.name,
      connected: this._connected,
      accountId: this.accountId,
      sessionExpired: this.sessionExpired,
      failures: this._failures,
      baseUrlFellBack: !!(this.api && this.api.baseUrlFellBack),
    };
  }
}

module.exports = { IlinkChannel };
