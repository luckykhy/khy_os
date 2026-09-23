'use strict';

/**
 * ilinkAccountStore.js — 微信 ilink bot 凭据与轮询游标的薄 IO 层。
 *
 * 两个文件,故意分开:
 *   ~/.khyos/ilink.json         凭据(bot_token 等)。低频写(仅扫码/登出),0600,原子写 + .bak。
 *   ~/.khyos/ilink-cursor.json  getupdates 游标。**每轮长轮询都写**(约 35s 一次)。
 *
 * 为什么分开:游标是高频写。若和凭据同文件,等于每 35 秒重写一次长期凭据——既无谓
 * 地放大凭据被写坏的窗口,又让 .bak 永远是 35 秒前的快照而失去备份意义。凭据只在
 * 扫码成功/登出时写,游标独立高频写,互不影响。
 *
 * **不复用 msgConfigStore**:那边的 getPlatform/setPlatform 强制要求非空 `webhook`
 * (msgConfigStore.js:70,:102),而 ilink 是纯长轮询、根本没有 webhook。把 baseUrl 硬塞进
 * webhook 字段是欺骗性设计,故独立存储。
 *
 * 契约:任何读写异常一律 fail-soft(读 → 空值,写 → { ok:false, error }),绝不抛。
 * 展示一律经 ilinkCore.maskToken,绝不回显完整 token。
 *
 * 本文件已收敛为「凭据家族 + context-token 家族」宿主:路径/权限位在 ilinkStorePaths,
 * 游标在 ilinkCursorStore,会话过期与心跳在 ilinkSessionState(三者均朝路径叶子单向
 * 依赖)。宿主按原样再导出各家族的公共符号以保持模块面逐字节不变。
 *
 * @module services/messaging/ilinkAccountStore
 */

const fs = require('fs');
const path = require('path');

const core = require('./ilinkCore');

const {
  FILE_MODE,
  _dir,
  _credFile,
  _credBak,
  _cursorFile,
  _stateFile,
  _ctxTokenFile,
  _isValidAccountId,
} = require('./ilinkStorePaths');

const { getSyncBuf, setSyncBuf, _setCursorRaw } = require('./ilinkCursorStore');

const {
  getSessionState,
  setSessionExpired,
  touchHeartbeat,
  getHeartbeat,
} = require('./ilinkSessionState');

/** 读凭据文件;缺失/损坏 → { accounts:{}, active:'' }。绝不抛。 */
function _readCreds() {
  try {
    const file = _credFile();
    if (!fs.existsSync(file)) {
      return { accounts: {}, active: '' };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const accounts = raw && typeof raw.accounts === 'object' && raw.accounts ? raw.accounts : {};
    return { accounts, active: raw && typeof raw.active === 'string' ? raw.active : '' };
  } catch {
    return { accounts: {}, active: '' };
  }
}

function _writeCreds(state) {
  const dir = _dir();
  const file = _credFile();
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, _credBak());
      try {
        fs.chmodSync(_credBak(), FILE_MODE);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
  const payload = {
    accounts: state.accounts || {},
    active: state.active || '',
    updatedAt: new Date().toISOString(),
  };
  const tmp = path.join(dir, `.ilink.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best-effort */
  }
}

/**
 * 保存扫码得到的账号凭据,并置为当前活动账号。
 * @param {{botToken:string, accountId:string, userId:string, baseUrl:string}} data
 * @returns {{ok:true, accountId:string, preview:string, isNew:boolean, firstBoundAt:string}|{ok:false, error:string}}
 */
function saveAccount(data) {
  const d = data || {};
  if (!_isValidAccountId(d.accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  if (!d.botToken) {
    return { ok: false, error: '缺少 botToken' };
  }
  try {
    const state = _readCreds();
    // Read the on-disk record BEFORE overwriting the slot: isNew is decided purely
    // by whether this accountId already existed. Capturing it after the assignment
    // below would always see the fresh record and misreport every re-login as new.
    const existing = state.accounts[d.accountId];
    const isNew = !existing;
    state.accounts[d.accountId] = {
      botToken: String(d.botToken),
      accountId: String(d.accountId),
      userId: String(d.userId || ''),
      baseUrl: String(d.baseUrl || ''),
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    };
    state.active = String(d.accountId);
    _writeCreds(state);
    // 重新扫码成功 = 会话又活了。不清的话会留一条陈旧的「已过期」,让 status 一直误报。
    setSessionExpired(d.accountId, false);
    return {
      ok: true,
      accountId: state.active,
      preview: core.maskToken(d.botToken),
      isNew,
      // firstBoundAt sticks to the preserved createdAt, so a re-login reports the
      // original bind time rather than "now".
      firstBoundAt: state.accounts[d.accountId].createdAt,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 切换当前活动账号。多账号绑定时由 `khy wx use <accountId>` 驱动。
 * @param {string} accountId
 * @returns {{ok:true, accountId:string}|{ok:false, error:string}}
 */
function setActiveAccount(accountId) {
  if (!_isValidAccountId(accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  try {
    const state = _readCreds();
    if (!state.accounts[accountId]) {
      return { ok: false, error: '账号不存在' };
    }
    state.active = String(accountId);
    _writeCreds(state);
    return { ok: true, accountId: state.active };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 取账号凭据(**含明文 token**,仅供发请求用,绝不可直接打印)。
 * 省略 accountId 时返回当前活动账号;无活动账号则返回唯一的那个(若恰好只有一个)。
 * @param {string} [accountId]
 * @returns {object|null}
 */
function getAccount(accountId) {
  const state = _readCreds();
  if (accountId) {
    if (!_isValidAccountId(accountId)) {
      return null;
    }
    return state.accounts[accountId] || null;
  }
  if (state.active && state.accounts[state.active]) {
    return state.accounts[state.active];
  }
  const ids = Object.keys(state.accounts);
  return ids.length === 1 ? state.accounts[ids[0]] : null;
}

/** 是否已有可用账号。 */
function isConfigured() {
  return getAccount() !== null;
}

/**
 * 列出全部账号(**已脱敏**),供 `khy wx status` 展示。
 * @returns {Array<{accountId:string, userId:string, baseUrl:string, token:string, active:boolean, createdAt:string}>}
 */
function listAccounts() {
  const state = _readCreds();
  return Object.keys(state.accounts).map((id) => {
    const a = state.accounts[id] || {};
    return {
      accountId: id,
      userId: a.userId || '',
      baseUrl: a.baseUrl || '',
      token: core.maskToken(a.botToken),
      active: id === state.active,
      createdAt: a.createdAt || '',
    };
  });
}

/**
 * 删除账号(省略则清空全部并连带删除游标)。
 * @param {string} [accountId]
 * @returns {{ok:true, accountId?:string}|{ok:false, error:string}}
 */
function clearAccount(accountId) {
  try {
    if (!accountId) {
      fs.rmSync(_credFile(), { force: true });
      fs.rmSync(_cursorFile(), { force: true });
      fs.rmSync(_stateFile(), { force: true });
      return { ok: true };
    }
    if (!_isValidAccountId(accountId)) {
      return { ok: false, error: 'accountId 非法' };
    }
    const state = _readCreds();
    delete state.accounts[accountId];
    if (state.active === accountId) {
      const ids = Object.keys(state.accounts);
      state.active = ids.length === 1 ? ids[0] : '';
    }
    _writeCreds(state);
    _setCursorRaw(accountId, '');
    setSessionExpired(accountId, false);
    return { ok: true, accountId };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ── context-token(主动发送凭据,按 accountId→userId 归档)──────────────────────
//
// 为什么需要落盘:微信 ilink 主动发消息(发图/发文件)必须带回该会话的 context_token,
// 而它只在入站消息里出现。守护进程重启后内存丢失,后续主动推送就没了 token。独立小文件
// 持久化最近一次入站带来的 token,供 _sendBindQrCode 等主动发送路径 fallback 取用。
//
// 结构:{ [accountId]: { [userId]: token } }。0600,原子写。绝不打印明文 token。

function _readContextTokens() {
  try {
    const file = _ctxTokenFile();
    if (!fs.existsSync(file)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 持久化一条会话的 context-token(入站时调用)。空 token 视为清除该会话条目。
 * fail-soft:写不进去只是后续主动发送少一个 fallback,绝不该中断入站处理。
 * @param {string} accountId
 * @param {string} userId
 * @param {string} token
 * @returns {boolean} 是否落盘成功
 */
function setContextToken(accountId, userId, token) {
  if (!_isValidAccountId(accountId)) {
    return false;
  }
  const uid = String(userId == null ? '' : userId);
  if (!uid) {
    return false;
  }
  try {
    const all = _readContextTokens();
    const bucket = all[accountId] && typeof all[accountId] === 'object' ? all[accountId] : {};
    const tok = String(token == null ? '' : token);
    if (tok) {
      bucket[uid] = tok;
    } else {
      delete bucket[uid];
    }
    if (Object.keys(bucket).length) {
      all[accountId] = bucket;
    } else {
      delete all[accountId];
    }
    const tmp = path.join(_dir(), `.ilink-context-tokens.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmp, _ctxTokenFile());
    try {
      fs.chmodSync(_ctxTokenFile(), FILE_MODE);
    } catch {
      /* best-effort */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 取一条会话的 context-token(主动发送时 fallback 用)。
 * @param {string} accountId
 * @param {string} userId
 * @returns {string} 无则空串
 */
function getContextToken(accountId, userId) {
  if (!_isValidAccountId(accountId)) {
    return '';
  }
  const uid = String(userId == null ? '' : userId);
  if (!uid) {
    return '';
  }
  const bucket = _readContextTokens()[accountId];
  const v = bucket && bucket[uid];
  return typeof v === 'string' ? v : '';
}

module.exports = {
  saveAccount,
  setActiveAccount,
  getAccount,
  isConfigured,
  listAccounts,
  clearAccount,
  getSyncBuf,
  setSyncBuf,
  getSessionState,
  setSessionExpired,
  touchHeartbeat,
  getHeartbeat,
  setContextToken,
  getContextToken,
  // 供测试
  _credFile,
  _cursorFile,
  _stateFile,
  _ctxTokenFile,
};
