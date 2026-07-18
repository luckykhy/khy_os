'use strict';

/**
 * proxySubscriptionStore.js — 订阅组持久化(内存 + JSON 文件)。
 *
 * 「代理管理」前端粘贴订阅地址后,后端把该订阅解析出的节点连同元信息作为一个**订阅组**存下来。
 * 存储形态镜像 apiKeyPool.js:内存 Map + `~/.khyquant/proxy_subscriptions.json` 持久化,无数据库。
 * 每个用户在路由层按 userId 命名空间隔离(store 只认 ownerId,路由传入 req.user.id)。
 *
 * 组结构:{ id, ownerId, name, url, format, nodeCount, protocolCount, nodes[], userinfo, addedAt,
 *          updatedAt, lastError }。nodes 为 proxyNodeParse 产出的节点对象数组;userinfo 为
 *          subscriptionUserinfo 解析的流量/到期元信息(或 null)。
 *
 * 本文件是**服务**(做 fs I/O),不自称纯叶子。fail-soft:加载损坏文件不崩(返回空集合)。
 *
 * @module services/proxySubscriptionStore
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataHome } = require('../utils/dataHome');

const STORE_FILE = path.join(getDataHome(), 'proxy_subscriptions.json');

// 每组最多保存的节点数(防止极大机场订阅撑爆存储文件)。
const MAX_NODES_PER_GROUP = 2000;

/** @type {Map<string, object>} id → group */
const _groups = new Map();
let _loaded = false;

function _load() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    for (const g of list) {
      if (g && typeof g === 'object' && g.id) _groups.set(String(g.id), g);
    }
  } catch {
    // 损坏文件 → 从空集合开始,绝不崩。
  }
}

function _persist() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = { version: 1, subscriptions: Array.from(_groups.values()) };
    fs.writeFileSync(STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // 写失败不影响内存态;下次仍会尝试持久化。
  }
}

function _genId() {
  return `sub_${crypto.randomBytes(8).toString('hex')}`;
}

function _now() {
  return new Date().toISOString();
}

function _clampNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.slice(0, MAX_NODES_PER_GROUP);
}

/**
 * 列出某用户的全部订阅组(不含 nodes 明细,减小列表体积)。
 * 若 withNodes=true 则含 nodes。
 */
function listGroups(ownerId, { withNodes = false } = {}) {
  _load();
  const owner = String(ownerId || '');
  const out = [];
  for (const g of _groups.values()) {
    if (String(g.ownerId || '') !== owner) continue;
    out.push(withNodes ? g : _summary(g));
  }
  out.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  return out;
}

function _summary(g) {
  const { nodes, ...rest } = g;
  return rest;
}

function getGroup(ownerId, id) {
  _load();
  const g = _groups.get(String(id || ''));
  if (!g || String(g.ownerId || '') !== String(ownerId || '')) return null;
  return g;
}

/**
 * 新增订阅组。
 * @param {object} input { ownerId, name, url, format, nodes, protocolCount, userinfo }
 */
function addGroup(input = {}) {
  _load();
  const nodes = _clampNodes(input.nodes);
  const now = _now();
  const group = {
    id: _genId(),
    ownerId: String(input.ownerId || ''),
    name: String(input.name || '').trim() || '未命名订阅组',
    url: String(input.url || '').trim(),
    format: String(input.format || 'unknown'),
    nodeCount: nodes.length,
    protocolCount: input.protocolCount && typeof input.protocolCount === 'object' ? input.protocolCount : {},
    nodes,
    userinfo: input.userinfo && typeof input.userinfo === 'object' ? input.userinfo : null,
    addedAt: now,
    updatedAt: now,
    lastError: null,
  };
  _groups.set(group.id, group);
  _persist();
  return group;
}

/**
 * 刷新已有订阅组的节点集(重新抓取后调用)。
 * @param {object} patch { nodes, protocolCount, format, userinfo, lastError }
 */
function updateGroup(ownerId, id, patch = {}) {
  const g = getGroup(ownerId, id);
  if (!g) return null;
  if (Array.isArray(patch.nodes)) {
    g.nodes = _clampNodes(patch.nodes);
    g.nodeCount = g.nodes.length;
  }
  if (patch.protocolCount && typeof patch.protocolCount === 'object') g.protocolCount = patch.protocolCount;
  if (patch.format) g.format = String(patch.format);
  if (patch.name) g.name = String(patch.name).trim() || g.name;
  // userinfo:显式传入(含 null)才覆盖;未传则保留原值(避免刷新失败清空进度条)。
  if (Object.prototype.hasOwnProperty.call(patch, 'userinfo')) {
    g.userinfo = patch.userinfo && typeof patch.userinfo === 'object' ? patch.userinfo : null;
  }
  g.lastError = patch.lastError != null ? String(patch.lastError) : null;
  g.updatedAt = _now();
  _groups.set(g.id, g);
  _persist();
  return g;
}

function removeGroup(ownerId, id) {
  const g = getGroup(ownerId, id);
  if (!g) return false;
  _groups.delete(g.id);
  _persist();
  return true;
}

// 测试可用:重置内存态(不删文件)。
function _resetForTest() {
  _groups.clear();
  _loaded = false;
}

module.exports = {
  listGroups,
  getGroup,
  addGroup,
  updateGroup,
  removeGroup,
  STORE_FILE,
  MAX_NODES_PER_GROUP,
  _resetForTest,
};
