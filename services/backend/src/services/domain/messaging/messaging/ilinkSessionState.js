'use strict';

/**
 * ilinkSessionState.js — 微信 ilink 会话过期标志与心跳的薄 IO 叶子(跨进程可见)。
 *
 * 为什么需要落盘:会话过期(getupdates ret=-14)发生在**守护进程**里,而你是在**CLI**
 * 里跑 khy wx status —— 两个进程,内存标志读不到。更要命的是过期时微信那头也通知不了
 * (会话都死了,消息发不出去),于是「它怎么不理我了」变成一个从任何地方都看不出原因的
 * 静默故障。这个小文件是唯一能跨进程说清楚「需要重新扫码」的载体。
 *
 * 独立于游标文件:游标每轮长轮询(约 35s)都写,而状态**只在变化时**写(过期一次、恢复
 * 一次),混在一起等于把一个罕见事件塞进高频写路径。
 *
 * 契约:任何读写异常一律 fail-soft,绝不抛。路径与权限位从 ilinkStorePaths 取。
 *
 * @module services/messaging/ilinkSessionState
 */

const fs = require('fs');
const path = require('path');

const { _dir, _stateFile, FILE_MODE, _isValidAccountId } = require('./ilinkStorePaths');

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
  getSessionState,
  setSessionExpired,
  touchHeartbeat,
  getHeartbeat,
};
