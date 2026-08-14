'use strict';

/**
 * ilinkLogin.js — 微信扫码登录(取二维码 + 轮询确认),薄 IO 层。
 *
 * 两个**免鉴权**的 GET(登录前还没有 token):
 *   GET /ilink/bot/get_bot_qrcode?bot_type=3
 *       → { ret:0, qrcode:<id>, qrcode_img_content:<待扫的 URL> }
 *   GET /ilink/bot/get_qrcode_status?qrcode=<id>
 *       → { ret:0, status:'wait'|'scaned'|'confirmed'|'expired', ... }
 *       confirmed 时附带 bot_token / ilink_bot_id / ilink_user_id / baseurl
 *
 * `bot_type=3` 是微信侧对「ClawBot 形态的第三方 bot」的类型编号,二维码指向
 * liteapp.weixin.qq.com。**未灰度到该能力的微信客户端会拒绝扫码**,这一环无法在
 * 本地绕过,故 login 会把服务端给的 retmsg 原样透出而不是自己编错误。
 *
 * 契约:fail-soft,返回 { ok, ... },绝不抛。二维码过期会自动换一张重来。
 *
 * @module services/messaging/ilinkLogin
 */

const defaults = require('../../constants/serviceDefaults');

const store = require('./ilinkAccountStore');
const core = require('./ilinkCore');

/** 第三方 bot 形态编号(ClawBot 同款)。 */
const BOT_TYPE = 3;

/** 二维码连续过期多少次后放弃,避免无人值守时无限刷码。 */
const MAX_QR_REFRESH = 3;

function _sleep(ms, signal) {
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

async function _getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function _base() {
  return String(defaults.ILINK_BASE_URL).replace(/\/+$/, '');
}

/**
 * 取一张登录二维码。
 * @returns {Promise<{ok:true, qrcodeId:string, qrcodeUrl:string}|{ok:false, error:string}>}
 */
async function requestQrCode() {
  try {
    const url = `${_base()}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const data = await _getJson(url, defaults.ILINK_REQUEST_TIMEOUT_MS);
    if (!data || data.ret !== 0 || !data.qrcode || !data.qrcode_img_content) {
      return {
        ok: false,
        error: `取二维码失败(ret=${data && data.ret})${data && data.retmsg ? `:${data.retmsg}` : ''}`,
      };
    }
    return { ok: true, qrcodeId: String(data.qrcode), qrcodeUrl: String(data.qrcode_img_content) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 查一次二维码状态。
 * @param {string} qrcodeId
 * @returns {Promise<{ok:true, status:string, data:object}|{ok:false, error:string}>}
 */
async function pollQrStatus(qrcodeId) {
  try {
    const url = `${_base()}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
    const data = await _getJson(url, defaults.ILINK_QR_POLL_TIMEOUT_MS);
    return { ok: true, status: String((data && data.status) || ''), data: data || {} };
  } catch (e) {
    // 单次查询失败(网络抖动/长轮询超时)不算致命,交由上层继续轮询。
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 把 confirmed 应答转成待落盘的账号结构;字段缺失返回 null。 */
function _accountFromConfirmed(data) {
  if (!data || !data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
    return null;
  }
  const baseUrl = String(data.baseurl || '');
  // 服务端下发的 baseurl 只在可信时采纳,否则留空让 IlinkApi 用默认值。
  const trusted = baseUrl && core.isTrustedBaseUrl(baseUrl, defaults.ILINK_ALLOWED_HOSTS);
  return {
    botToken: String(data.bot_token),
    accountId: String(data.ilink_bot_id),
    userId: String(data.ilink_user_id),
    baseUrl: trusted ? baseUrl : '',
  };
}

/** 终端色彩转义,量宽度时必须先剥掉,否则会把不可见字符算进列数。 */
const _ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * 量字符画的**可见**尺寸(行数 × 列数)。纯函数。
 *
 * 为什么单独做:terminal 渲染出来的每一行都裹着 ANSI 色彩码,直接取 length 会得到
 * 几百列的假数字(实测 39 列的码会被算成 794 列),据此判断「终端放不放得下」必然误判。
 *
 * @param {string} art
 * @returns {{rows:number, cols:number}}
 */
function measureQrArt(art) {
  const s = String(art == null ? '' : art).replace(_ANSI_RE, '');
  const lines = s.split('\n');
  // 只砍掉首尾的**空串**行。不能用 trim() 过滤「全空白行」——terminal 模式是用带背景色的
  // 空格作画的,剥掉 ANSI 后一整行纯色区块就是一串空格,按空白过滤会把它算漏、行数偏少。
  while (lines.length && lines[0] === '') {
    lines.shift();
  }
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (!lines.length) {
    return { rows: 0, cols: 0 };
  }
  return { rows: lines.length, cols: Math.max(...lines.map((l) => [...l].length)) };
}

/**
 * 在终端渲染二维码字符画。
 *
 * 尺寸只由**纠错等级**决定 —— `margin` 选项对 terminal 渲染器无效(静区固定),
 * 实测 L/M/Q/H 分别是 20/22/26/28 行。默认取 L:屏幕上的码没有污损风险,L 足够稳且最紧凑。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.errorCorrectionLevel] 覆盖纠错等级(L/M/Q/H)
 * @returns {Promise<string|null>} 失败返回 null(调用方应改为打印链接)
 */
async function renderQrToTerminal(url, opts = {}) {
  try {
    if (!url) {
      return null;
    }
    const QRCode = require('qrcode');
    const ec = String(
      (opts && opts.errorCorrectionLevel) || defaults.ILINK_QR_ERROR_CORRECTION || 'L'
    ).toUpperCase();
    return await QRCode.toString(url, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(ec) ? ec : 'L',
    });
  } catch {
    return null;
  }
}

/**
 * 渲染二维码为 **PNG data URL**(供 Web 前端 <img src> 直接内联显示)。
 *
 * 仿 renderQrToTerminal:复用同一 defaults.ILINK_QR_ERROR_CORRECTION 纠错等级默认,
 * 但输出为 image/png 的 data URL 而非终端字符画。失败(缺 url / qrcode 抛错)返回 null,
 * 调用方应降级为直接给出 qrcodeUrl 链接。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.errorCorrectionLevel] 覆盖纠错等级(L/M/Q/H)
 * @returns {Promise<string|null>} 形如 data:image/png;base64,...;失败返回 null
 */
async function renderQrToDataUrl(url, opts = {}) {
  try {
    if (!url) {
      return null;
    }
    const QRCode = require('qrcode');
    const ec = String(
      (opts && opts.errorCorrectionLevel) || defaults.ILINK_QR_ERROR_CORRECTION || 'L'
    ).toUpperCase();
    return await QRCode.toDataURL(url, {
      type: 'image/png',
      errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(ec) ? ec : 'L',
    });
  } catch {
    return null;
  }
}

/**
 * 完整扫码登录流程:取码 → 交给调用方展示 → 轮询至确认 → 落盘。
 *
 * 二维码过期会自动换一张(最多 MAX_QR_REFRESH 次)。
 *
 * @param {object} [opts]
 * @param {(info:{qrcodeUrl:string, art:(string|null), attempt:number}) => void} [opts.onQr] 展示二维码
 * @param {(line:string) => void} [opts.onStatus] 状态提示(已扫码待确认等)
 * @param {AbortSignal} [opts.signal] 取消
 * @returns {Promise<{ok:true, account:object, isNew:boolean, firstBoundAt:string}|{ok:false, error:string}>}
 */
async function login(opts = {}) {
  const onQr = typeof opts.onQr === 'function' ? opts.onQr : () => {};
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const signal = opts.signal;

  for (let attempt = 1; attempt <= MAX_QR_REFRESH; attempt++) {
    if (signal && signal.aborted) {
      return { ok: false, error: '已取消' };
    }

    const qr = await requestQrCode();
    if (!qr.ok) {
      return { ok: false, error: qr.error };
    }

    const art = await renderQrToTerminal(qr.qrcodeUrl);
    onQr({ qrcodeUrl: qr.qrcodeUrl, art, attempt });

    let scanedNotified = false;
    let expired = false;

    while (!expired) {
      if (signal && signal.aborted) {
        return { ok: false, error: '已取消' };
      }

      const res = await pollQrStatus(qr.qrcodeId);
      if (res.ok) {
        const { status, data } = res;
        if (status === 'confirmed') {
          const account = _accountFromConfirmed(data);
          if (!account) {
            return { ok: false, error: '扫码已确认,但应答缺少必要字段' };
          }
          const saved = store.saveAccount(account);
          if (!saved.ok) {
            return { ok: false, error: `凭据落盘失败:${saved.error}` };
          }
          return {
            ok: true,
            account: { ...account, preview: saved.preview },
            isNew: saved.isNew,
            firstBoundAt: saved.firstBoundAt,
          };
        }
        if (status === 'expired') {
          expired = true;
          onStatus(attempt < MAX_QR_REFRESH ? '⏳ 二维码已过期,正在换一张…' : '⏳ 二维码已过期。');
          break;
        }
        if (status === 'scaned' && !scanedNotified) {
          scanedNotified = true;
          onStatus('📱 已扫码,请在手机上确认。');
        }
        if (status && status !== 'wait' && status !== 'scaned') {
          // 已知的失败类状态(未灰度/版本过低/被拒/取消)——把服务端原话透出,不自己编。
          const known = ['not_support', 'version', 'forbid', 'reject', 'cancel'];
          if (known.some((k) => status.includes(k))) {
            return { ok: false, error: `扫码失败:${data.retmsg || status}` };
          }
          if (data.retmsg) {
            return { ok: false, error: `扫码失败:${data.retmsg}` };
          }
        }
      }
      await _sleep(defaults.ILINK_QR_POLL_INTERVAL_MS, signal);
    }
  }

  return { ok: false, error: `二维码连续过期 ${MAX_QR_REFRESH} 次,已放弃。请重试 khy wx login。` };
}

module.exports = {
  BOT_TYPE,
  MAX_QR_REFRESH,
  requestQrCode,
  pollQrStatus,
  renderQrToTerminal,
  renderQrToDataUrl,
  measureQrArt,
  login,
  _accountFromConfirmed,
};
