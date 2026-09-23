'use strict';

/**
 * ilinkCursorStore.js — 微信 ilink getupdates 游标的薄 IO 叶子。
 *
 * 游标是**高频写**(每轮长轮询约 35s 一次),故独立文件、不带 .bak,与长期凭据
 * 彻底分开(见 ilinkAccountStore 头部说明)。契约:读 → 空值,写 fail-soft,绝不抛。
 *
 * _setCursorRaw 导出给宿主 clearAccount 复用(删账号时连带清游标)。路径与权限位
 * 从 ilinkStorePaths 取(单向依赖)。
 *
 * @module services/messaging/ilinkCursorStore
 */

const fs = require('fs');
const path = require('path');

const { _dir, _cursorFile, FILE_MODE, _isValidAccountId } = require('./ilinkStorePaths');

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

module.exports = {
  getSyncBuf,
  setSyncBuf,
  // 供宿主 clearAccount 复用
  _setCursorRaw,
};
