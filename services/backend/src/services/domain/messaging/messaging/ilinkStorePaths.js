'use strict';

/**
 * ilinkStorePaths.js — 微信 ilink 存储的文件路径与校验叶子(零 IO 副作用)。
 *
 * 把「文件名怎么拼、accountId 合不合法、凭据文件权限位」这几个被各存储家族
 * (凭据 / 游标 / 会话状态 / context-token)共享的私有助手收在这里,使宿主与各
 * 叶子都朝本模块**单向**依赖(叶子 → 路径),不构成回边、不成环。
 *
 * _dir() 每次调用都过 getBaseDataDir(而非在 load 期定值),这样测试可通过设置
 * 家目录 env 把整套路径改到临时目录。
 *
 * @module services/messaging/ilinkStorePaths
 */

const path = require('path');

const { getBaseDataDir } = require('../../../../utils/dataHome');

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

function _ctxTokenFile() {
  return path.join(_dir(), 'ilink-context-tokens.json');
}

function _isValidAccountId(id) {
  return typeof id === 'string' && !!id && ACCOUNT_ID_RE.test(id);
}

module.exports = {
  FILE_MODE,
  ACCOUNT_ID_RE,
  _dir,
  _credFile,
  _credBak,
  _cursorFile,
  _stateFile,
  _ctxTokenFile,
  _isValidAccountId,
};
