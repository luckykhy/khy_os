'use strict';

/**
 * Message Router — routes incoming messages from external channels
 * to the AI pipeline or CLI handler, and sends responses back.
 *
 * Channels register themselves; incoming messages are dispatched
 * through a unified processing pipeline.
 */

const EventEmitter = require('events');

const log = require('../../../../utils/logger');

class MessageRouter extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('./_baseChannel').BaseChannel>} */
    this._channels = new Map();
    /** @type {((msg: object) => Promise<string>)|null} */
    this._aiHandler = null;
    /**
     * Per-channel inbound handlers. A channel with its own handler opts out of
     * the generic `_aiHandler` + auto-send path entirely: it receives the FULL
     * inbound message (threadId / images / messageId / raw — none of which the
     * generic path forwards) and owns its own sending.
     *
     * ilink(微信)需要这个:它要发「正在输入」、按 2048 分片、并在查询中途反向问用户
     * 权限——这些都无法用「返回一个字符串让 router 代发」表达。
     * @type {Map<string, (msg: object, channel: object) => Promise<void>>}
     */
    this._channelHandlers = new Map();
  }

  /**
   * Register a channel for routing.
   * @param {import('./_baseChannel').BaseChannel} channel
   * @param {object} [opts]
   * @param {(msg: object, channel: object) => Promise<void>} [opts.handler]
   *   Channel-specific inbound handler; receives the full message and sends its
   *   own replies. Falls back to the global `_aiHandler` when omitted.
   */
  registerChannel(channel, opts = {}) {
    if (this._channels.has(channel.name)) {
      log.warn(`Channel "${channel.name}" already registered, replacing`);
    }
    this._channels.set(channel.name, channel);
    if (opts && typeof opts.handler === 'function') {
      this._channelHandlers.set(channel.name, opts.handler);
    }

    channel.on('message', (msg) => this._handleMessage(channel.name, msg));
    channel.on('command', (cmd) => this._handleCommand(channel.name, cmd));
    channel.on('error', (err) => {
      log.error(`Channel "${channel.name}" error:`, err.error || err);
    });
  }

  /**
   * Unregister a channel.
   * @param {string} channelName
   */
  unregisterChannel(channelName) {
    const ch = this._channels.get(channelName);
    if (ch) {
      ch.removeAllListeners();
      this._channels.delete(channelName);
    }
    this._channelHandlers.delete(channelName);
  }

  /**
   * Set the AI handler that processes incoming messages.
   * @param {(msg: object) => Promise<string>} handler
   *   Receives { text, userId, channelId, channelName } and returns response text.
   */
  setAIHandler(handler) {
    this._aiHandler = handler;
  }

  /**
   * Get all registered channels.
   * @returns {Array<{name: string, connected: boolean}>}
   */
  getChannels() {
    return [...this._channels.values()].map((ch) => ch.toJSON());
  }

  /**
   * Handle an incoming message from an external channel.
   * @param {string} channelName
   * @param {object} msg - { channelId, userId, text, raw, threadId?, timestamp }
   */
  async _handleMessage(channelName, msg) {
    this.emit('message', { channelName, ...msg });

    // 该渠道自带 handler → 交给它全权处理(拿到完整报文,自己发回复),不走通用代发路径。
    const own = this._channelHandlers.get(channelName);
    if (own) {
      try {
        await own({ channelName, ...msg }, this._channels.get(channelName));
      } catch (err) {
        log.error(`Channel handler for ${channelName} failed:`, err.message);
      }
      return;
    }

    if (!this._aiHandler) {
      log.warn(`No AI handler registered; dropping message from ${channelName}`);
      return;
    }

    try {
      const response = await this._aiHandler({
        text: msg.text,
        userId: msg.userId,
        channelId: msg.channelId,
        channelName,
      });

      if (response) {
        const ch = this._channels.get(channelName);
        if (ch) {
          if (msg.threadId) {
            await ch.sendReply(msg.channelId, msg.threadId, response);
          } else {
            await ch.sendMessage(msg.channelId, response);
          }
        }
      }
    } catch (err) {
      log.error(`Error handling message from ${channelName}:`, err.message);
    }
  }

  /**
   * Handle an incoming command from an external channel.
   * @param {string} channelName
   * @param {object} cmd - { channelId, userId, command, args, raw }
   */
  async _handleCommand(channelName, cmd) {
    this.emit('command', { channelName, ...cmd });
    // Commands are forwarded as messages with a / prefix
    await this._handleMessage(channelName, {
      channelId: cmd.channelId,
      userId: cmd.userId,
      text: `/${cmd.command} ${cmd.args || ''}`.trim(),
      raw: cmd.raw,
    });
  }

  /**
   * Disconnect all channels.
   */
  async disconnectAll() {
    for (const ch of this._channels.values()) {
      try {
        await ch.disconnect();
      } catch {
        /* ignore */
      }
    }
    this._channels.clear();
  }

  /**
   * Send a message to a named channel's default target.
   * Used by cronScheduler and other internal services.
   * @param {string} channelName - Registered channel name (e.g. 'slack')
   * @param {string} text - Message content
   * @param {object} [opts] - Channel-specific options (channelId, blocks, etc.)
   * @returns {Promise<boolean>} true if sent
   */
  async sendToChannel(channelName, text, opts = {}) {
    const ch = this._channels.get(channelName);
    if (!ch || !ch.connected) {
      log.warn(`sendToChannel: channel "${channelName}" not registered or disconnected`);
      return false;
    }
    try {
      const channelId = opts.channelId || ch.config?.defaultChannelId || '';
      if (!channelId) {
        log.warn(`sendToChannel: no channelId for "${channelName}"`);
        return false;
      }
      await ch.sendMessage(channelId, text, opts);
      return true;
    } catch (err) {
      log.error(`sendToChannel "${channelName}" failed: ${err.message}`);
      return false;
    }
  }
}

// Singleton
let _instance = null;
function getMessageRouter() {
  if (!_instance) {
    _instance = new MessageRouter();
    // Auto-register channels from environment
    _bootstrapChannels(_instance);
  }
  return _instance;
}

/**
 * Conditionally register available channels based on environment config.
 * Each channel only activates when its required env vars are present.
 */
function _bootstrapChannels(router) {
  // 记录是否注册了任意「能收 AI 应答」的渠道 —— 任一渠道在册即闭合 AI 应答回路。
  let aiReplyWired = false;
  const wireAiReply = () => {
    if (aiReplyWired) {
      return;
    }
    aiReplyWired = true;
    try {
      require('../messaging/msgReplyBridge').wireReplyBridge(router);
    } catch (err) {
      // 桥不可用/门关 → 保持现状(未接线,消息记录后丢弃)。fail-soft,绝不拖垮启动。
    }
  };

  // Slack: register if SLACK_BOT_TOKEN is configured
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const { SlackChannel } = require('./slackChannel');
      const slack = new SlackChannel({
        defaultChannelId: process.env.SLACK_DEFAULT_CHANNEL || '',
      });
      router.registerChannel(slack);
      // Connect async — don't block startup
      slack.connect().catch((err) => {
        log.warn(`Slack auto-connect failed: ${err.message}`);
      });
      // Slack 入站事件经 handleWebhookEvent → emit('message') → _handleMessage。
      // 与钉钉/飞书/企微一致,注册即闭合 AI 应答回路(否则消息被解析后丢弃)。
      wireAiReply();
    } catch (err) {
      log.warn(`Slack channel bootstrap failed: ${err.message}`);
    }
  }

  // 钉钉 / 飞书 / 企业微信:从 ~/.khyos/msg.json 读取已配置平台并注册(门 KHY_MSG)。
  // 每个平台仅在其配置(至少 webhook)存在时激活;fail-soft,任何异常只记日志不影响启动。
  try {
    const core = require('../messaging/msgChannelCore');
    if (core.isEnabled(process.env)) {
      const store = require('../messaging/msgConfigStore');
      const factories = {
        dingtalk: (cfg) => new (require('./dingtalkChannel').DingTalkChannel)(cfg),
        feishu: (cfg) => new (require('./feishuChannel').FeishuChannel)(cfg),
        wecom: (cfg) => new (require('./wecomChannel').WecomChannel)(cfg),
      };
      let registered = 0;
      for (const platform of Object.keys(factories)) {
        const cfg = store.getPlatform(platform);
        if (!cfg) {
          continue;
        }
        try {
          const ch = factories[platform](cfg);
          router.registerChannel(ch);
          registered += 1;
          ch.connect().catch((err) => log.warn(`${platform} auto-connect failed: ${err.message}`));
        } catch (err) {
          log.warn(`${platform} channel bootstrap failed: ${err.message}`);
        }
      }
      // 闭合双向环:有 IM 渠道时,把入站消息经 khy AI 回答回发给用户(门 KHY_MSG_AUTOREPLY)。
      // 仅在有渠道且未设 handler 时接线;纯 Slack 部署(无 msg 渠道)已由上方 Slack 分支接线。
      // fail-soft。
      if (registered > 0) {
        wireAiReply();
      }
    }
  } catch (err) {
    log.warn(`messaging channels bootstrap failed: ${err.message}`);
  }

  // 微信个人号(ilink):门 KHY_MSG + 已扫码绑定。长轮询通道,自带 dispatcher
  // (不走通用 wireReplyBridge——它只会把回复当成一个字符串代发,发不出 typing、
  // 分不了 2048 片、也没法在查询中途反向问权限)。多账号并行:每个已绑定账号各起
  // 一路 IlinkChannel + IlinkDispatcher,注册名 `ilink:<accountId>` 互不覆盖。
  // fail-soft:单账号异常只 warn,不影响其余账号与启动;账号列表为空时跳过。
  try {
    const ilinkCore = require('../messaging/ilinkCore');
    if (ilinkCore.isEnabled(process.env)) {
      const ilinkStore = require('../messaging/ilinkAccountStore');
      const { IlinkChannel } = require('./ilinkChannel');
      const { IlinkDispatcher } = require('./ilinkDispatcher');
      const list = ilinkStore.listAccounts();
      const total = list.length;
      list.forEach((entry, idx) => {
        try {
          const account = ilinkStore.getAccount(entry.accountId); // 明文凭据,仅供发请求用
          if (!account) {
            log.warn(`ilink account ${entry.accountId} skipped: credentials unavailable`);
            return;
          }
          const ch = new IlinkChannel({
            botToken: account.botToken,
            accountId: account.accountId,
            userId: account.userId,
            baseUrl: account.baseUrl,
            channelName: `ilink:${account.accountId}`,
          });
          const dispatcher = new IlinkDispatcher({ channel: ch, accountId: account.accountId });
          ch.dispatcher = dispatcher; // 供 status 诊断
          router.registerChannel(ch, { handler: (msg) => dispatcher.handle(msg) });
          ch.connect().catch((err) =>
            log.warn(`ilink account ${account.accountId} auto-connect failed: ${err.message}`)
          );
          log.info(`ilink(微信)通道已启动:账号 ${account.accountId}(第 ${idx + 1}/${total} 个)`);
        } catch (err) {
          log.warn(`ilink account ${entry && entry.accountId} bootstrap failed: ${err.message}`);
        }
      });
    }
  } catch (err) {
    log.warn(`ilink channel bootstrap failed: ${err.message}`);
  }

  // IM 长连接适配器(adapters/im):门 KHY_IM_ADAPTERS,未设置 = 零渠道且**渠道模块零加载**
  // (故这里的 require 只碰注册表本身,不会把飞书/ws 拉进来)。注册名带 `im:` 前缀,与
  // webhook 版 feishuChannel 并存互不覆盖。长连接是主动收信的通道:没人调它就永远不会
  // 开始收消息,所以这里和 ilink 一样必须 eager 注册 + eager connect。
  // fail-soft:单渠道异常只 warn;首连失败由适配器自己退避重连,不影响启动。
  try {
    const imRegistry = require('../../../../adapters/im/adapterRegistry');
    const { adapters } = imRegistry.createAdapters({ env: process.env, logger: log });
    if (adapters.length) {
      const { ImAdapterChannel } = require('./imAdapterChannel');
      let registered = 0;
      for (const adapter of adapters) {
        try {
          const ch = new ImAdapterChannel({ adapter });
          router.registerChannel(ch);
          registered += 1;
          ch.connect().catch((err) =>
            log.warn(`IM 渠道 ${ch.name} 首连未成功(后台按指数退避重连中):${err.message}`)
          );
          log.info(`IM 长连接通道已注册:${ch.name}(${adapter.describeEndpoint()})`);
        } catch (err) {
          log.warn(`IM 渠道 ${adapter && adapter.channel} bootstrap failed: ${err.message}`);
        }
      }
      if (registered > 0) {
        wireAiReply();
      }
    }
  } catch (err) {
    log.warn(`IM adapter channels bootstrap failed: ${err.message}`);
  }
}

module.exports = { MessageRouter, getMessageRouter, _bootstrapChannels };
