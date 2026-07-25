'use strict';

/**
 * Message Router — routes incoming messages from external channels
 * to the AI pipeline or CLI handler, and sends responses back.
 *
 * Channels register themselves; incoming messages are dispatched
 * through a unified processing pipeline.
 */

const EventEmitter = require('events');
const log = require('../../utils/logger');

class MessageRouter extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('./_baseChannel').BaseChannel>} */
    this._channels = new Map();
    /** @type {((msg: object) => Promise<string>)|null} */
    this._aiHandler = null;
  }

  /**
   * Register a channel for routing.
   * @param {import('./_baseChannel').BaseChannel} channel
   */
  registerChannel(channel) {
    if (this._channels.has(channel.name)) {
      log.warn(`Channel "${channel.name}" already registered, replacing`);
    }
    this._channels.set(channel.name, channel);

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
    return [...this._channels.values()].map(ch => ch.toJSON());
  }

  /**
   * Handle an incoming message from an external channel.
   * @param {string} channelName
   * @param {object} msg - { channelId, userId, text, raw, threadId?, timestamp }
   */
  async _handleMessage(channelName, msg) {
    this.emit('message', { channelName, ...msg });

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
      try { await ch.disconnect(); } catch { /* ignore */ }
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
  // Slack: register if SLACK_BOT_TOKEN is configured
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const { SlackChannel } = require('./slackChannel');
      const slack = new SlackChannel({
        defaultChannelId: process.env.SLACK_DEFAULT_CHANNEL || '',
      });
      router.registerChannel(slack);
      // Connect async — don't block startup
      slack.connect().catch(err => {
        log.warn(`Slack auto-connect failed: ${err.message}`);
      });
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
        if (!cfg) continue;
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
      // 仅在有渠道且未设 handler 时接线;纯 Slack 部署(无 msg 渠道)不受影响。fail-soft。
      if (registered > 0) {
        try {
          require('../messaging/msgReplyBridge').wireReplyBridge(router);
        } catch (err) {
          log.warn(`msg auto-reply bridge wiring failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.warn(`messaging channels bootstrap failed: ${err.message}`);
  }
}

module.exports = { MessageRouter, getMessageRouter };
