'use strict';

/**
 * ilinkMedia.js — 微信 ilink bot 媒体上传编排层(IO 层,与 ilinkCrypto 配合)。
 *
 * 出站图片/文件的完整链路(已按真实 ilink bot 协议收敛,参考权威 Python 实现):
 *   ① 生成 filekey(32 位 hex)、aeskey(32 位 hex 明文)、rawfilemd5=MD5(明文)、
 *      rawsize=明文字节数、filesize=aesEcbPaddedSize(rawsize)。
 *   ② getUploadUrl 拿 upload_param(缺完整参数微信恒返回 ret:-2)。
 *   ③ AES-128-ECB + PKCS#7 加密明文。
 *   ④ POST 到 CDN:`${CDN_BASE}/upload?encrypted_query_param=...&filekey=...`,
 *      Header 仅 Content-Type: application/octet-stream(无 Authorization),body=加密字节。
 *   ⑤ encrypt_query_param 从 CDN **响应头 x-encrypted-param** 取(不是响应体)。
 *   ⑥ 返回 { ok:true, media:{ encrypt_query_param, aesKeyOutbound, rawsize } },
 *      供 ilinkCore.buildImageItems / buildFileItems 组装出站 item_list。
 *
 * 契约:fail-soft,返回 { ok, ... },绝不抛。IO 与日志在本层;纯加解密在 ilinkCrypto。
 * 零硬编码:CDN base 域名从 constants/serviceDefaults.js 取,本文件不写死任何域名。
 *
 * @module services/messaging/ilinkMedia
 */

const nodeCrypto = require('crypto');

const defaults = require('../../../../constants/serviceDefaults');

const cryptoLeaf = require('./ilinkCrypto');

/** media_type 数字编码(见协议):1=图片 2=视频 3=文件 4=音频。 */
const MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, AUDIO: 4 };

/** 32 位随机 hex 的 filekey(16 字节)。 */
function _generateFileKey() {
  return nodeCrypto.randomBytes(16).toString('hex');
}

/**
 * 把明文媒体按真实协议加密并上传到微信 CDN,返回出站所需的 media 凭据。
 * uploadImage / uploadFile 的公共实现:差异仅 mediaType、CDN 超时、错误文案前缀。
 *
 * 契约:fail-soft,返回 { ok, ... },绝不抛。
 *
 * @param {object} api 已鉴权的 IlinkApi 实例(提供 getUploadUrl)
 * @param {Buffer} buffer 明文字节
 * @param {{mediaType:number, toUserId:string, timeoutMs:number, label:string}} opts
 * @returns {Promise<{ok:true, media:{encrypt_query_param:string, aesKeyOutbound:string, rawsize:number}}
 *                   |{ok:false, error:string}>}
 */
async function _uploadMedia(api, buffer, { mediaType, toUserId, timeoutMs, label }) {
  if (!api || typeof api.getUploadUrl !== 'function') {
    return { ok: false, error: `${label}失败:缺少可用的 ilink api` };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: `${label}失败:内容为空` };
  }

  // ① 生成上传参数:filekey、aeskey(hex 明文)、明文 MD5、明文长度、加密后(块对齐)长度。
  const filekey = _generateFileKey();
  const aeskey = cryptoLeaf.generateHexKey();
  const rawsize = buffer.length;
  const rawfilemd5 = nodeCrypto.createHash('md5').update(buffer).digest('hex');
  const filesize = cryptoLeaf.aesEcbPaddedSize(rawsize);

  // ② 申请上传参数,拿 upload_param。api.getUploadUrl 会抛(见 ilinkApi 契约),catch 成结构化 error。
  let resp;
  try {
    resp = await api.getUploadUrl({
      filekey,
      mediaType,
      toUserId: String(toUserId || ''),
      rawsize,
      rawfilemd5,
      filesize,
      aeskey,
    });
  } catch (e) {
    const status = e && Number.isFinite(Number(e.status)) ? `(HTTP ${e.status})` : '';
    return { ok: false, error: `${label}失败:申请上传地址出错${status}:${(e && e.message) || e}` };
  }

  const uploadParam = String((resp && resp.upload_param) || '');
  if (!uploadParam) {
    // 缺 upload_param 通常是参数不全导致微信返回 ret:-2;如实带上 ret 便于排查。
    const ret = resp && resp.ret != null ? `(ret=${resp.ret})` : '';
    return { ok: false, error: `${label}失败:上传参数返回体缺少 upload_param${ret}` };
  }

  // ③ AES-128-ECB + PKCS#7 加密明文。aeskey 是 32 位 hex,解出正好 16 字节。
  const keyBuffer = Buffer.from(aeskey, 'hex');
  const encrypted = cryptoLeaf.encryptAesEcb(keyBuffer, buffer);
  if (!encrypted.ok) {
    return { ok: false, error: `${label}失败:加密出错(${encrypted.error})` };
  }

  // ④ 上传到 CDN:POST,Content-Type octet-stream,无 Authorization。CDN base 取自
  //    serviceDefaults(零硬编码);upload_param 走 encodeURIComponent 防止 query 注入。
  const cdnBase = String(defaults.ILINK_CDN_BASE_URL).replace(/\/+$/, '');
  const cdnUrl =
    `${cdnBase}/upload` +
    `?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
    `&filekey=${encodeURIComponent(filekey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let cdnResp;
  try {
    cdnResp = await fetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted.data,
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, error: `${label}失败:上传到 CDN 超时(${timeoutMs}ms)` };
    }
    return { ok: false, error: `${label}失败:上传到 CDN 出错:${(e && e.message) || e}` };
  } finally {
    clearTimeout(timer);
  }

  if (!cdnResp || !cdnResp.ok) {
    const status = cdnResp ? cdnResp.status : '无响应';
    const body = cdnResp ? await cdnResp.text().catch(() => '') : '';
    return {
      ok: false,
      error: `${label}失败:CDN 返回非 2xx(${status})${body ? `:${body.slice(0, 200)}` : ''}`,
    };
  }

  // ⑤ encrypt_query_param 从 CDN **响应头 x-encrypted-param** 取(权威实现如此,不是响应体)。
  const encryptQueryParam = String(
    (cdnResp.headers &&
      typeof cdnResp.headers.get === 'function' &&
      cdnResp.headers.get('x-encrypted-param')) ||
      ''
  );
  if (!encryptQueryParam) {
    // 没有它下载方拼不出 CDN URL,发出去也是坏的,故如实失败让调用方降级。
    return { ok: false, error: `${label}失败:CDN 响应头缺少 x-encrypted-param(下载凭据)` };
  }

  // ⑥ 返回出站凭据。aesKeyOutbound = base64(hex),供 item 的 media.aes_key;rawsize 供图片 mid_size。
  return {
    ok: true,
    media: {
      encrypt_query_param: encryptQueryParam,
      aesKeyOutbound: cryptoLeaf.encodeAesKeyForOutbound(aeskey),
      rawsize,
    },
  };
}

/**
 * 把明文图片按真实协议加密并上传到微信 CDN,返回出站所需的 media 凭据。
 * @param {object} api 已鉴权的 IlinkApi 实例
 * @param {Buffer} imageBuffer 明文图片字节
 * @param {{fileName?:string, toUserId?:string}} [opts]
 * @returns {Promise<{ok:true, media:object}|{ok:false, error:string}>}
 */
async function uploadImage(api, imageBuffer, { toUserId = '' } = {}) {
  return _uploadMedia(api, imageBuffer, {
    mediaType: MEDIA_TYPE.IMAGE,
    toUserId,
    timeoutMs: defaults.ILINK_CDN_TIMEOUT_MS,
    label: '上传图片',
  });
}

/**
 * 把明文文件按真实协议加密并上传到微信 CDN,返回出站所需的 media 凭据。
 * 与 uploadImage 同构,唯一差异:mediaType=文件,且走大文件超时。
 * @param {object} api 已鉴权的 IlinkApi 实例
 * @param {Buffer} fileBuffer 明文文件字节
 * @param {{fileName?:string, toUserId?:string}} [opts]
 * @returns {Promise<{ok:true, media:object}|{ok:false, error:string}>}
 */
async function uploadFile(api, fileBuffer, { toUserId = '' } = {}) {
  return _uploadMedia(api, fileBuffer, {
    mediaType: MEDIA_TYPE.FILE,
    toUserId,
    timeoutMs: defaults.ILINK_FILE_UPLOAD_TIMEOUT_MS,
    label: '上传文件',
  });
}

module.exports = {
  MEDIA_TYPE,
  uploadImage,
  uploadFile,
  _uploadMedia,
};
