'use strict';

/**
 * msgConfigStore.js — 多平台消息收发配置的薄 IO 层。落到 ~/.khyos/msg.json(0600)。
 *
 * 每个平台一组字段,同时覆盖发送(outbound)与接收(inbound):
 *   - dingtalk: { webhook, secret }            // secret 兼作发送加签 & 入站验签(同一 appSecret)
 *   - feishu  : { webhook, secret, encryptKey, verificationToken }
 *   - wecom   : { webhook, token, encodingAesKey }
 * webhook / secret / key 均属凭据,故文件 0600,复用 pushConfigStore 的原子写 + .bak 惯例。
 * 展示一律经 msgChannelCore.maskWebhook;明文仅供服务端发请求 / 验签用。任何读写异常 fail-soft。
 *
 * @module services/messaging/msgConfigStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../../utils/dataHome');
const core = require('./msgChannelCore');

const FILE_MODE = 0o600;

/** 每平台允许持久化的字段白名单(拒绝存入未知字段)。 */
const FIELDS = {
  dingtalk: ['webhook', 'secret'],
  feishu: ['webhook', 'secret', 'encryptKey', 'verificationToken'],
  wecom: ['webhook', 'token', 'encodingAesKey'],
};

function _dir() { return getBaseDataDir('.'); }               // ~/.khyos
function _file() { return path.join(_dir(), 'msg.json'); }
function _bak() { return path.join(_dir(), 'msg.bak'); }

/** 读原始文件对象;缺失/损坏 → { platforms:{} }。绝不抛。 */
function _readAll() {
  try {
    const file = _file();
    if (!fs.existsSync(file)) return { platforms: {} };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const platforms = raw && typeof raw.platforms === 'object' && raw.platforms ? raw.platforms : {};
    return { platforms, updatedAt: (raw && raw.updatedAt) || '' };
  } catch {
    return { platforms: {} };
  }
}

function _writeAll(state) {
  const dir = _dir();
  const file = _file();
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, _bak());
      try { fs.chmodSync(_bak(), FILE_MODE); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  const payload = { platforms: state.platforms || {}, updatedAt: new Date().toISOString() };
  const tmp = path.join(dir, `.msg.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, FILE_MODE); } catch { /* best-effort */ }
}

/** 取某平台配置(归一 platform 别名);无 → null。 */
function getPlatform(platform) {
  const p = core.normalizePlatform(platform);
  if (!p) return null;
  const cfg = _readAll().platforms[p];
  if (!cfg || typeof cfg !== 'object') return null;
  const webhook = typeof cfg.webhook === 'string' ? cfg.webhook : '';
  if (!webhook) return null;
  return { platform: p, ...cfg };
}

/** 是否已配置某平台(或任一平台)。 */
function isConfigured(platform) {
  if (platform) return getPlatform(platform) !== null;
  const all = _readAll().platforms;
  return Object.keys(all).some((p) => getPlatform(p) !== null);
}

/**
 * 合并写入某平台字段(仅接受白名单字段;空串字段删除)。
 * @param {string} platform
 * @param {object} fields
 * @returns {{ok:true, platform:string, preview:string}|{ok:false, error:string}}
 */
function setPlatform(platform, fields = {}) {
  const p = core.normalizePlatform(platform);
  if (!p) return { ok: false, error: `不支持的平台。可选:${Object.keys(FIELDS).join(' / ')}。` };
  const allowed = FIELDS[p];
  try {
    const state = _readAll();
    const prev = (state.platforms[p] && typeof state.platforms[p] === 'object') ? state.platforms[p] : {};
    const next = { ...prev };
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      const val = fields[key] == null ? '' : String(fields[key]).trim();
      if (val) next[key] = val;
      else delete next[key];
    }
    if (!next.webhook) return { ok: false, error: `${core.PLATFORMS[p].label} 至少需要 webhook。` };
    state.platforms[p] = next;
    _writeAll(state);
    return { ok: true, platform: p, preview: core.maskWebhook(next.webhook) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 清除某平台(不传则清空全部)。 */
function clearPlatform(platform) {
  try {
    if (!platform) {
      fs.rmSync(_file(), { force: true });
      return { ok: true };
    }
    const p = core.normalizePlatform(platform);
    if (!p) return { ok: false, error: '不支持的平台。' };
    const state = _readAll();
    delete state.platforms[p];
    _writeAll(state);
    return { ok: true, platform: p };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 列出所有已配置平台(遮蔽后),供 status 展示。 */
function listConfigured() {
  const all = _readAll().platforms;
  return Object.keys(all)
    .map((p) => getPlatform(p))
    .filter(Boolean)
    .map((cfg) => ({
      platform: cfg.platform,
      label: core.PLATFORMS[cfg.platform] ? core.PLATFORMS[cfg.platform].label : cfg.platform,
      webhook: core.maskWebhook(cfg.webhook),
      hasSecret: !!(cfg.secret || cfg.encryptKey || cfg.encodingAesKey || cfg.token),
    }));
}

module.exports = {
  FIELDS,
  getPlatform,
  isConfigured,
  setPlatform,
  clearPlatform,
  listConfigured,
};
