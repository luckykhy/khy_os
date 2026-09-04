'use strict';

/**
 * ilinkBindingStore.js — 微信多账号「策略二 Agent 级隔离」的绑定关系薄 IO 层。
 *
 * ~/.khyos/ilink-bindings.json  账号 → 工作空间/Agent 的绑定表。低频写(仅
 *   bind/unbind),0600,原子写 + .bak。
 *
 * 结构:{ bindings: { [accountId]: { workspace, agent } } }
 *   workspace 必填(该账号消息路由到哪个工作空间);agent 可选(指定专属 Agent,
 *   缺省则由 dispatcher 走默认 Agent)。
 *
 * 为什么独立成文件而不塞进 ilink.json:绑定关系是「路由配置」而非「登录凭据」,
 * 二者生命周期不同(凭据随扫码/登出变动,绑定随管理员配置变动),混写会互相放大
 * 被写坏的窗口。与同目录 ilinkAccountStore 的凭据/游标/状态三分家同理。
 *
 * 契约:任何读写异常一律 fail-soft(读 → 空绑定表,写 → { ok:false, error }),绝不抛。
 *
 * 复用说明:数据家解析、原子写、0600 权限、accountId 字符集与 fail-soft 模式,
 * 均对齐 ilinkAccountStore.js。accountId 校验因 ilinkAccountStore 未导出
 * `_isValidAccountId`,此处用等价的字符集正则复制(不改动既有文件)。
 *
 * @module services/messaging/ilinkBindingStore
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../../../../utils/dataHome');

const FILE_MODE = 0o600;

/** accountId 会作为对象键与日志内容,限定字符集以拒绝异常输入(对齐 ilinkAccountStore)。 */
const ACCOUNT_ID_RE = /^[a-zA-Z0-9_.@=-]+$/;

function _dir() {
  return getBaseDataDir('.');
} // ~/.khyos

function _bindingsFile() {
  return path.join(_dir(), 'ilink-bindings.json');
}

function _bindingsBak() {
  return path.join(_dir(), 'ilink-bindings.bak');
}

function _isValidAccountId(id) {
  return typeof id === 'string' && !!id && ACCOUNT_ID_RE.test(id);
}

/** 读绑定文件;缺失/损坏 → { bindings:{} }。绝不抛。 */
function _readBindings() {
  try {
    const file = _bindingsFile();
    if (!fs.existsSync(file)) {
      return { bindings: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const bindings = raw && typeof raw.bindings === 'object' && raw.bindings ? raw.bindings : {};
    return { bindings };
  } catch {
    return { bindings: {} };
  }
}

function _writeBindings(state) {
  const dir = _dir();
  const file = _bindingsFile();
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, _bindingsBak());
      try {
        fs.chmodSync(_bindingsBak(), FILE_MODE);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
  const payload = {
    bindings: state.bindings || {},
    updatedAt: new Date().toISOString(),
  };
  const tmp = path.join(dir, `.ilink-bindings.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best-effort */
  }
}

/**
 * 绑定账号到工作空间/Agent。workspace 必填,agent 可选。
 * @param {string} accountId
 * @param {{workspace:string, agent?:string}} data
 * @returns {{ok:true, accountId:string, binding:{workspace:string, agent:string}}|{ok:false, error:string}}
 */
function bindAccount(accountId, data) {
  if (!_isValidAccountId(accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  const d = data || {};
  if (typeof d.workspace !== 'string' || !d.workspace.trim()) {
    return { ok: false, error: '缺少 workspace' };
  }
  try {
    const state = _readBindings();
    const binding = {
      workspace: String(d.workspace),
      agent: String(d.agent || ''),
    };
    state.bindings[accountId] = binding;
    _writeBindings(state);
    return { ok: true, accountId: String(accountId), binding };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 解绑账号(幂等:不存在也算成功)。
 * @param {string} accountId
 * @returns {{ok:true, accountId:string}|{ok:false, error:string}}
 */
function unbindAccount(accountId) {
  if (!_isValidAccountId(accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  try {
    const state = _readBindings();
    if (state.bindings[accountId]) {
      delete state.bindings[accountId];
      _writeBindings(state);
    }
    return { ok: true, accountId: String(accountId) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 取某账号的绑定关系。
 * @param {string} accountId
 * @returns {{workspace:string, agent:string}|null} 无绑定或非法 id 返回 null
 */
function getBinding(accountId) {
  if (!_isValidAccountId(accountId)) {
    return null;
  }
  const b = _readBindings().bindings[accountId];
  if (!b || typeof b !== 'object') {
    return null;
  }
  return {
    workspace: typeof b.workspace === 'string' ? b.workspace : '',
    agent: typeof b.agent === 'string' ? b.agent : '',
  };
}

/**
 * 列出全部绑定关系。
 * @returns {Array<{accountId:string, workspace:string, agent:string}>}
 */
function listBindings() {
  const state = _readBindings();
  return Object.keys(state.bindings).map((id) => {
    const b = state.bindings[id] || {};
    return {
      accountId: id,
      workspace: typeof b.workspace === 'string' ? b.workspace : '',
      agent: typeof b.agent === 'string' ? b.agent : '',
    };
  });
}

module.exports = {
  bindAccount,
  unbindAccount,
  getBinding,
  listBindings,
  // 供测试
  _bindingsFile,
};
