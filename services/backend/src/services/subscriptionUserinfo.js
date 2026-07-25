'use strict';

/**
 * subscriptionUserinfo.js — 纯叶子:解析订阅响应头 `subscription-userinfo` 的流量/到期元信息,
 * 供「代理管理」订阅卡片渲染已用/总量进度条与到期日(仿 Clash Verge profiles 卡片,Image#3)。
 *
 * 机场订阅 URL 常在响应头返 `subscription-userinfo: upload=1024; download=2048; total=107374182400;
 * expire=1710000000`(字节 + Unix 秒)。本叶子把它解成结构化对象:
 *   { upload, download, total, used, remaining, usedRatio, expireAt(ms), expireDays }
 * 全为纯字符串/算术。`expireDays` 需「现在」故由 caller 传 nowMs(不传则为 null,避免叶子碰时钟)。
 *
 * 契约:纯叶子 —— 零 I/O(纯字符串/算术,不碰 fs / 网络 / 子进程 / 时钟 / 随机)、确定性、
 * fail-soft(**绝不抛**:门关 / 空头 / 坏输入 → null)。门控 KHY_PROXY_SUB_USERINFO
 * (parent=KHY_PROXY_SUBSCRIPTION);相对 require 仅 leaf→leaf(本文件零依赖)。
 *
 * @module services/subscriptionUserinfo
 */

const FLAG = 'KHY_PROXY_SUB_USERINFO';
const PARENT_FLAG = 'KHY_PROXY_SUBSCRIPTION';

const CANON_OFF = new Set(['0', 'off', 'false', 'no']);

function _flagOff(env, name) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || raw === '') return false; // default-on
  return CANON_OFF.has(String(raw).trim().toLowerCase());
}

// 门控:自身或父门任一为 CANON off → 关(父关⇒子恒关)。
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : {};
  if (_flagOff(e, PARENT_FLAG)) return false;
  if (_flagOff(e, FLAG)) return false;
  return true;
}

function _toNonNegInt(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * 解析 `subscription-userinfo` 头值。
 *
 * @param {string} headerValue  形如 `upload=..; download=..; total=..; expire=..`。
 * @param {object} [env]        环境变量(门控)。
 * @param {object} [opts]       { nowMs?: number } 传入「现在」以算 expireDays(不传则 null)。
 * @returns {object|null} { upload, download, total, used, remaining, usedRatio, expireAt, expireDays } 或 null。
 */
function parseSubscriptionUserinfo(headerValue, env, opts) {
  try {
    if (!isEnabled(env || {})) return null;
    const raw = String(headerValue == null ? '' : headerValue).trim();
    if (!raw) return null;

    const fields = {};
    for (const part of raw.split(';')) {
      const seg = part.trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq === -1) continue;
      const key = seg.slice(0, eq).trim().toLowerCase();
      const val = seg.slice(eq + 1).trim();
      if (key) fields[key] = val;
    }

    const upload = _toNonNegInt(fields.upload);
    const download = _toNonNegInt(fields.download);
    const total = _toNonNegInt(fields.total);
    const expireSec = _toNonNegInt(fields.expire);

    // 没有任何可识别字段 → 视为无元信息。
    if (upload === undefined && download === undefined && total === undefined && expireSec === undefined) {
      return null;
    }

    const used = (upload || 0) + (download || 0);
    let remaining = null;
    let usedRatio = null;
    if (total !== undefined && total > 0) {
      remaining = Math.max(0, total - used);
      // 比值夹在 [0, 1](上传+下载可能超总量)。
      usedRatio = Math.min(1, used / total);
    }

    let expireAt = null;
    let expireDays = null;
    if (expireSec !== undefined && expireSec > 0) {
      expireAt = expireSec * 1000;
      const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : null;
      if (nowMs !== null) {
        expireDays = Math.floor((expireAt - nowMs) / 86400000);
      }
    }

    return {
      upload: upload === undefined ? null : upload,
      download: download === undefined ? null : download,
      total: total === undefined ? null : total,
      used,
      remaining,
      usedRatio,
      expireAt,
      expireDays,
    };
  } catch {
    return null;
  }
}

module.exports = {
  parseSubscriptionUserinfo,
  isEnabled,
};
