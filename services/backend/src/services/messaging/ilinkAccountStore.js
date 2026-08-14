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
 * @module services/messaging/ilinkAccountStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../../utils/dataHome');

const core = require('./ilinkCore');

const FILE_MODE = 0o600;

/** accountId 会作为对象键与日志内容,限定字符集以拒绝异常输入。 */
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_.@=-]+$/;

function _dir() {
  return getBaseDataDir('.');
} // ~/.khyos

function _credFile() {
  return path.join(_dir(), 'ilink.json');
}

function _credBak() {
  return path.join(_dir(), 'ilink.bak');
}

function _cursorFile() {
  return path.join(_dir(), 'ilink-cursor.json');
}

function _stateFile() {
  return path.join(_dir(), 'ilink-state.json');
}

function _isValidAccountId(id) {
  return typeof id === 'string' && !!id && ACCOUNT_ID_RE.test(id);
}

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

// ── 游标(高频写,独立文件,不带 .bak)────────────────────────────────────────

function _readCursors() {
  try {
    const file = _cursorFile();
    if (!fs.existsSync(file)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function _setCursorRaw(accountId, buf) {
  const all = _readCursors();
  if (buf) {
    all[accountId] = String(buf);
  } else {
    delete all[accountId];
  }
  const tmp = path.join(_dir(), `.ilink-cursor.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf-8', mode: FILE_MODE });
  fs.renameSync(tmp, _cursorFile());
}

/**
 * 读 getupdates 游标。
 * @param {string} accountId
 * @returns {string} 无则空串
 */
function getSyncBuf(accountId) {
  if (!_isValidAccountId(accountId)) {
    return '';
  }
  const v = _readCursors()[accountId];
  return typeof v === 'string' ? v : '';
}

/**
 * 写 getupdates 游标。fail-soft:写不进去只是下轮可能重复拉取(去重器会挡),不该中断轮询。
 * @param {string} accountId
 * @param {string} buf
 * @returns {boolean}
 */
function setSyncBuf(accountId, buf) {
  if (!_isValidAccountId(accountId)) {
    return false;
  }
  try {
    _setCursorRaw(accountId, buf);
    return true;
  } catch {
    return false;
  }
}

// ── context-token(主动发送凭据,按 accountId→userId 归档)──────────────────────
//
// 为什么需要落盘:微信 ilink 主动发消息(发图/发文件)必须带回该会话的 context_token,
// 而它只在入站消息里出现。守护进程重启后内存丢失,后续主动推送就没了 token。独立小文件
// 持久化最近一次入站带来的 token,供 _sendBindQrCode 等主动发送路径 fallback 取用。
//
// 结构:{ [accountId]: { [userId]: token } }。0600,原子写。绝不打印明文 token。

function _ctxTokenFile() {
  return path.join(_dir(), 'ilink-context-tokens.json');
}

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

// ── 会话状态(跨进程可见)─────────────────────────────────────────────────────
//
// 为什么需要落盘:会话过期(getupdates ret=-14)发生在**守护进程**里,而你是在**CLI**
// 里跑 khy wx status —— 两个进程,内存标志读不到。更要命的是过期时微信那头也通知不了
// (会话都死了,消息发不出去),于是「它怎么不理我了」变成一个从任何地方都看不出原因的
// 静默故障。这个小文件是唯一能跨进程说清楚「需要重新扫码」的载体。
//
// 独立于游标文件:游标每轮长轮询(约 35s)都写,而状态**只在变化时**写(过期一次、恢复
// 一次),混在一起等于把一个罕见事件塞进高频写路径。

function _readStates() {
  try {
    const file = _stateFile();
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
 * 读会话状态。**只在「当前确实处于过期」时返回对象,否则一律 null。**
 *
 * 为什么不返回 `{expired:false}`:这个文件还同住着心跳,清除过期后条目仍然存在。若按
 * 「条目在不在」来判,调用方就得写两层判断(有对象 + expired 为真),而漏掉第二层的后果
 * 是把正常状态误报成故障。null = 没过期,是唯一不会被误用的契约。
 *
 * @param {string} accountId
 * @returns {{expired:true, at:string, reason:string}|null}
 */
function getSessionState(accountId) {
  if (!_isValidAccountId(accountId)) {
    return null;
  }
  const s = _readStates()[accountId];
  if (!s || typeof s !== 'object' || s.expired !== true) {
    return null;
  }
  return {
    expired: true,
    at: typeof s.at === 'string' ? s.at : '',
    reason: typeof s.reason === 'string' ? s.reason : '',
  };
}

/**
 * 记录/清除「会话已过期」。**幂等且只在状态真的变化时落盘** —— 轮询恢复正常后每轮都会
 * 调一次 setSessionExpired(id,false),不能让它变成每 35 秒一次的写。
 *
 * fail-soft:写不进去只是 status 少一条提示,绝不该中断轮询。
 *
 * @param {string} accountId
 * @param {boolean} expired
 * @param {string} [reason]
 * @returns {boolean} 是否发生了状态变化(true = 本次真的写盘了)
 */
function setSessionExpired(accountId, expired, reason = '') {
  if (!_isValidAccountId(accountId)) {
    return false;
  }
  try {
    const all = _readStates();
    // 必须强制成布尔:无记录时 all[id] 是 undefined,而 `undefined === false` 为假,
    // 会让「本来就没过期,又调一次 false」被误判成状态变化 → 每轮长轮询都写一次盘。
    const prev = !!(all[accountId] && all[accountId].expired === true);
    const next = expired === true;
    if (prev === next) {
      return false;
    } // 无变化 → 不写盘
    if (next) {
      all[accountId] = {
        ...(all[accountId] || {}),
        expired: true,
        at: new Date().toISOString(),
        reason: String(reason || ''),
      };
    } else {
      // 只清过期相关字段 —— 整条 delete 会把同住一个文件的心跳一起抹掉,
      // 于是「会话恢复」看起来会像「通道从没心跳过」。
      const cur = { ...(all[accountId] || {}) };
      delete cur.expired;
      delete cur.at;
      delete cur.reason;
      if (Object.keys(cur).length) {
        all[accountId] = cur;
      } else {
        delete all[accountId];
      }
    }
    const tmp = path.join(_dir(), `.ilink-state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmp, _stateFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * 打一次通道心跳。**自带限流**:距上次落盘不足 minIntervalMs 就直接返回,不写。
 *
 * 为什么需要:守护进程 PID 还在 ≠ 长轮询还在转。进程崩了、循环卡死、通道 disconnect
 * 了但进程没退 —— 这三种情况从 CLI 看全都是「守护进程在运行」。心跳是唯一能区分
 * 「活着」和「看起来活着」的信号。
 *
 * 为什么限流:轮询约 35s 一轮,不限流就是每 35s 一次写 —— 又变成一个高频写路径。
 *
 * fail-soft:写不进去只是 status 少一条信息,绝不该中断轮询。
 *
 * @param {string} accountId
 * @param {number} [minIntervalMs] 默认 60s
 * @returns {boolean} 本次是否真的落盘了
 */
function touchHeartbeat(accountId, minIntervalMs = 60000) {
  if (!_isValidAccountId(accountId)) {
    return false;
  }
  try {
    const all = _readStates();
    const cur = all[accountId] || {};
    const now = Date.now();
    const last = Number(cur.beatAt) || 0;
    if (now - last < (Number(minIntervalMs) || 0)) {
      return false;
    }
    all[accountId] = { ...cur, beatAt: now };
    const tmp = path.join(_dir(), `.ilink-state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf-8', mode: FILE_MODE });
    fs.renameSync(tmp, _stateFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * 读最后一次心跳。
 * @param {string} accountId
 * @returns {{beatAt:number, ageMs:number}|null} 从未打过心跳返回 null
 */
function getHeartbeat(accountId) {
  if (!_isValidAccountId(accountId)) {
    return null;
  }
  const s = _readStates()[accountId];
  const beatAt = s && Number(s.beatAt);
  if (!beatAt || !Number.isFinite(beatAt)) {
    return null;
  }
  return { beatAt, ageMs: Math.max(0, Date.now() - beatAt) };
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
