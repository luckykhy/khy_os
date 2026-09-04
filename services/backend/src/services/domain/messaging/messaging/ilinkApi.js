'use strict';

/**
 * ilinkApi.js — 微信 ilink bot API 的薄 IO 层(仅 HTTP,零业务判断)。
 *
 * 报文结构与策略判定全在纯叶子 ilinkCore;本文件只负责「发请求、回 JSON」。
 *
 * 鉴权三件套(缺一不可):
 *   Authorization: Bearer <bot_token>
 *   AuthorizationType: ilink_bot_token
 *   X-WECHAT-UIN: <随机 uint32 的 base64>   ← 每个客户端实例一个,进程内稳定
 *
 * **契约例外**:本层的 request 会**抛**。轮询循环需要靠异常来驱动退避与失败计数
 * (见 ilinkChannel),把错误咽掉会让通道在服务端故障时静默空转。调用方必须 catch。
 * 其余 messaging 叶子的 fail-soft 约定不适用于此。
 *
 * @module services/messaging/ilinkApi
 */

const crypto = require('crypto');

const defaults = require('../../../../constants/serviceDefaults');

const core = require('./ilinkCore');

/** 随机 uint32 的 base64,作为 X-WECHAT-UIN。每个实例一个。 */
function _generateUin() {
  return crypto.randomBytes(4).toString('base64');
}

class IlinkApi {
  /**
   * @param {object} opts
   * @param {string} opts.botToken 扫码得到的长期凭据
   * @param {string} [opts.baseUrl] 服务端下发的 baseurl;不可信则回落默认值
   */
  constructor(opts = {}) {
    this.token = String(opts.botToken || '');
    // 服务端下发的 baseurl 不可盲信:非 https 或非白名单域名一律回落默认值。
    const candidate = String(opts.baseUrl || '');
    const trusted = candidate && core.isTrustedBaseUrl(candidate, defaults.ILINK_ALLOWED_HOSTS);
    this.baseUrl = (trusted ? candidate : defaults.ILINK_BASE_URL).replace(/\/+$/, '');
    this.baseUrlFellBack = !!candidate && !trusted;
    this.uin = _generateUin();
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  /**
   * POST 一个 JSON 报文。**会抛**(见文件头契约)。
   * @param {string} apiPath 如 'ilink/bot/getupdates'
   * @param {object} body
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  async _post(apiPath, body, timeoutMs) {
    const url = `${this.baseUrl}/${apiPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        // 带上结构化字段:上层判「这次失败值不值得重试」应看状态码,而不是正则猜消息。
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error(`请求 ${apiPath} 超时(${timeoutMs}ms)`);
        e.isTimeout = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 长轮询拉取新消息。服务端会挂起到有消息或接近超时才返回。
   * @param {string} [buf] 上一轮返回的 get_updates_buf 游标
   * @returns {Promise<{ret?:number, retmsg?:string, get_updates_buf?:string, msgs?:Array}>}
   */
  async getUpdates(buf) {
    return this._post(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      defaults.ILINK_GETUPDATES_TIMEOUT_MS
    );
  }

  /**
   * 发一条消息。
   * @param {{msg:object}} payload 由 ilinkCore.buildOutboundMessage 构造
   */
  async sendMessage(payload) {
    return this._post('ilink/bot/sendmessage', payload, defaults.ILINK_REQUEST_TIMEOUT_MS);
  }

  /**
   * 申请媒体上传地址。真实协议要求完整参数(缺一微信恒返回 ret:-2),报文字段:
   *   filekey/media_type/to_user_id/rawsize/rawfilemd5/filesize/aeskey/no_need_thumb/base_info。
   * media_type 数字编码:1=图片 2=视频 3=文件 4=音频。返回体关键字段 upload_param(供 CDN 用)。
   * @param {object} p
   * @param {string} p.filekey 32 位 hex
   * @param {number} p.mediaType 1/2/3/4
   * @param {string} p.toUserId 接收方 ilink_user_id
   * @param {number} p.rawsize 明文字节数
   * @param {string} p.rawfilemd5 明文 MD5(hex)
   * @param {number} p.filesize 加密后(块对齐)长度
   * @param {string} p.aeskey 32 位 hex 明文密钥
   * @param {boolean} [p.noNeedThumb=true]
   */
  async getUploadUrl(p = {}) {
    const body = {
      filekey: String(p.filekey || ''),
      media_type: Number(p.mediaType) || 0,
      to_user_id: String(p.toUserId || ''),
      rawsize: Number(p.rawsize) || 0,
      rawfilemd5: String(p.rawfilemd5 || ''),
      filesize: Number(p.filesize) || 0,
      aeskey: String(p.aeskey || ''),
      no_need_thumb: p.noNeedThumb !== false,
      base_info: { channel_version: core.CHANNEL_VERSION },
    };
    return this._post('ilink/bot/getuploadurl', body, defaults.ILINK_REQUEST_TIMEOUT_MS);
  }

  /**
   * 取该用户的 bot 配置,内含 typing_ticket(发「正在输入」必需)。
   * @param {string} ilinkUserId
   * @param {string} [contextToken]
   */
  async getConfig(ilinkUserId, contextToken) {
    return this._post(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      defaults.ILINK_GETCONFIG_TIMEOUT_MS
    );
  }

  /**
   * 发送/取消「正在输入」。
   * @param {string} toUserId
   * @param {string} typingTicket 来自 getConfig
   * @param {number} status 1=正在输入 2=取消
   */
  async sendTyping(toUserId, typingTicket, status) {
    return this._post(
      'ilink/bot/sendtyping',
      { ilink_user_id: toUserId, typing_ticket: typingTicket, status },
      defaults.ILINK_SENDTYPING_TIMEOUT_MS
    );
  }
}

module.exports = { IlinkApi };
