'use strict';

/**
 * pushConfigStore.js — 推送配置的薄 IO 层。把「provider + target」落到 ~/.khyos/push.json(0600)。
 *
 * target 常含密钥(Bark key、含 token 的 webhook URL),故文件权限收紧到 0600,复用 vaultStore 的
 * 原子写 + .bak 惯例;getConfig 返回的明文 target 仅供工具服务端发请求用,展示一律经 pushNotifyCore.maskTarget。
 * 任何读写异常 fail-soft。
 *
 * @module services/pushConfigStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');
const core = require('./pushNotifyCore');

const FILE_MODE = 0o600;

function _dir() { return getBaseDataDir('.'); }                        // ~/.khyos
function _file() { return path.join(_dir(), 'push.json'); }
function _bak() { return path.join(_dir(), 'push.bak'); }

/** 读配置;缺失/损坏 → null。绝不抛。 */
function getConfig() {
  try {
    const file = _file();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const provider = core.normalizeProvider(raw && raw.provider);
    const target = raw && typeof raw.target === 'string' ? raw.target : '';
    if (!provider || !target) return null;
    return { provider, target, updatedAt: (raw && raw.updatedAt) || '' };
  } catch {
    return null;
  }
}

/** 是否已配置。 */
function isConfigured() { return getConfig() !== null; }

/**
 * 写入推送配置。
 * @param {string} provider
 * @param {string} target
 * @returns {{ok:true, provider:string, preview:string}|{ok:false, error:string}}
 */
function setConfig(provider, target) {
  const p = core.normalizeProvider(provider);
  if (!p) return { ok: false, error: `未知推送服务商「${provider}」。支持:${Object.keys(core.PROVIDERS).join(' / ')}。` };
  const t = String(target == null ? '' : target).trim();
  if (!t) return { ok: false, error: '推送目标(target)不能为空。' };
  try {
    const dir = _dir();
    const file = _file();
    try {
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, _bak());
        try { fs.chmodSync(_bak(), FILE_MODE); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
    const payload = { provider: p, target: t, updatedAt: new Date().toISOString() };
    const tmp = path.join(dir, `.push.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best-effort */ }
    return { ok: true, provider: p, preview: core.maskTarget(t) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 清除推送配置。 */
function clearConfig() {
  try {
    fs.rmSync(_file(), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  getConfig,
  isConfigured,
  setConfig,
  clearConfig,
};
