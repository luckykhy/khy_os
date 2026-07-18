'use strict';

/**
 * vaultStore.js — 密钥保险库的薄 IO 层(磁盘读写),逻辑全部委派纯叶子 vaultCore。
 *
 * 数据落**底座领地** `~/.khyos/vault/vault.json`(随 pip 升级不丢),复用 goalStore 的
 * 原子写 + .bak 轮转惯例,并把文件权限收紧到 0600(只有属主可读)。读写任何异常都 fail-soft。
 *
 * 安全红线:
 *   - listSecrets / 任何展示路径只经 vaultCore.shapeListing —— 永不返回明文值;
 *   - getSecret / getSecrets 返回明文仅供工具在服务端发请求用,绝不进入展示层 / 模型上下文;
 *   - 文件 0600;.bak 同样 0600。
 *
 * @module services/vaultStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');
const core = require('./vaultCore');

const FILE_MODE = 0o600;

function _dir() { return getBaseDataDir('vault'); }                  // ~/.khyos/vault(已确保存在)
function _file() { return path.join(_dir(), 'vault.json'); }
function _bak() { return path.join(_dir(), 'vault.bak'); }

/** 读取保险库;缺失/损坏 → 空库。绝不抛。 */
function _read() {
  try {
    const file = _file();
    if (!fs.existsSync(file)) return { version: core.STORE_VERSION, secrets: {} };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !raw.secrets || typeof raw.secrets !== 'object') {
      return { version: core.STORE_VERSION, secrets: {} };
    }
    return { version: Number(raw.version) || core.STORE_VERSION, secrets: raw.secrets };
  } catch {
    return { version: core.STORE_VERSION, secrets: {} };
  }
}

/** 原子写(同目录临时文件 + rename)+ 单份 .bak 轮转 + 0600 权限。返回 {ok}。绝不抛。 */
function _write(state) {
  try {
    const dir = _dir();
    const file = _file();
    try {
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, _bak());
        try { fs.chmodSync(_bak(), FILE_MODE); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
    const payload = {
      version: core.STORE_VERSION,
      secrets: state && state.secrets && typeof state.secrets === 'object' ? state.secrets : {},
      updatedAt: new Date().toISOString(),
    };
    const tmp = path.join(dir, `.vault.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, FILE_MODE); } catch { /* best-effort */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 列出全部密钥的**掩码**清单(永不含明文)。 */
function listSecrets() {
  return core.shapeListing(_read().secrets);
}

/** 某密钥是否存在。 */
function hasSecret(name) {
  const key = core.normalizeName(name);
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(_read().secrets, key);
}

/**
 * 取单个密钥**明文**(仅供工具服务端发请求用,绝不展示)。不存在 → null。
 * @param {string} name
 * @returns {string|null}
 */
function getSecret(name) {
  const key = core.normalizeName(name);
  if (!key) return null;
  const entry = _read().secrets[key];
  return entry && typeof entry.value === 'string' ? entry.value : null;
}

/**
 * 批量取明文,返回 { found:{NAME:value}, missing:[NAME] }。仅供服务端注入。
 * @param {string[]} names
 */
function getSecrets(names) {
  const found = {};
  const missing = [];
  const secrets = _read().secrets;
  for (const raw of Array.isArray(names) ? names : []) {
    const key = core.normalizeName(raw);
    if (key && Object.prototype.hasOwnProperty.call(secrets, key) && typeof secrets[key].value === 'string') {
      found[key] = secrets[key].value;
    } else {
      missing.push(raw);
    }
  }
  return { found, missing };
}

/**
 * 写入/更新一个密钥。
 * @param {string} name
 * @param {string} value
 * @returns {{ok:true, name:string, preview:string}|{ok:false, error:string}}
 */
function setSecret(name, value) {
  const key = core.normalizeName(name);
  if (!key) return { ok: false, error: `非法密钥名「${name}」。须字母开头、仅字母数字下划线、长度 ≤64。` };
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: '密钥值不能为空。' };
  }
  const state = _read();
  const now = new Date().toISOString();
  const prev = state.secrets[key];
  state.secrets[key] = {
    value,
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
  };
  const w = _write(state);
  if (!w.ok) return { ok: false, error: w.error || '写入失败' };
  return { ok: true, name: key, preview: core.maskSecret(value) };
}

/**
 * 删除一个密钥。
 * @param {string} name
 * @returns {{ok:true, removed:boolean}|{ok:false, error:string}}
 */
function removeSecret(name) {
  const key = core.normalizeName(name);
  if (!key) return { ok: false, error: `非法密钥名「${name}」。` };
  const state = _read();
  if (!Object.prototype.hasOwnProperty.call(state.secrets, key)) {
    return { ok: true, removed: false };
  }
  delete state.secrets[key];
  const w = _write(state);
  if (!w.ok) return { ok: false, error: w.error || '写入失败' };
  return { ok: true, removed: true };
}

module.exports = {
  listSecrets,
  hasSecret,
  getSecret,
  getSecrets,
  setSecret,
  removeSecret,
};
