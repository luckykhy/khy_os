'use strict';

/**
 * gitTrackWhitelist.js — 纯叶子：用户手动标记的「允许 git init」目录白名单。
 *
 * 契约 (CONTRACT)：纯 JSON 读写，确定性，fail-soft（读写失败返回 []）。
 *   配置文件：~/.khy/git-track-whitelist.json（数组，存储绝对路径）。
 *
 * 设计意图：让用户显式声明「这个目录即使不满足自动判定条件，也要 git 化」。
 *   示例：外部挂载点 /mnt/external、共享目录 /opt/myapp 等。
 *   白名单目录仍受最小安全约束：文件系统根 / 盘符根永远拒绝。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WHITELIST_FILE = path.join(os.homedir(), '.khy', 'git-track-whitelist.json');

/**
 * 读取用户白名单（绝对路径数组）。fail-soft：文件不存在/损坏 → 返回 []。
 * @returns {string[]} 绝对路径数组（已去重、归一化）
 */
function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // 归一化：去尾部分隔符、去重
    const normalized = list
      .filter(p => typeof p === 'string' && path.isAbsolute(p))
      .map(_norm)
      .filter(Boolean);
    return [...new Set(normalized)];
  } catch {
    return [];
  }
}

/**
 * 保存用户白名单。fail-soft：写入失败不抛（返回 false）。
 * @param {string[]} list 绝对路径数组
 * @returns {boolean} 是否成功写入
 */
function saveWhitelist(list) {
  try {
    if (!Array.isArray(list)) return false;
    const normalized = list
      .filter(p => typeof p === 'string' && path.isAbsolute(p))
      .map(_norm)
      .filter(Boolean);
    const unique = [...new Set(normalized)];
    const dir = path.dirname(WHITELIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(unique, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查目录是否在用户白名单中。
 * @param {string} dir 目录绝对路径
 * @returns {boolean}
 */
function isWhitelisted(dir) {
  const list = loadWhitelist();
  const normalized = _norm(dir);
  return list.includes(normalized);
}

/**
 * 添加目录到白名单（幂等）。
 * @param {string} dir 目录绝对路径
 * @returns {boolean} 是否成功保存
 */
function addToWhitelist(dir) {
  const normalized = _norm(dir);
  if (!normalized || !path.isAbsolute(normalized)) return false;
  const list = loadWhitelist();
  if (list.includes(normalized)) return true; // 已存在，幂等
  list.push(normalized);
  return saveWhitelist(list);
}

/**
 * 从白名单移除目录。
 * @param {string} dir 目录绝对路径
 * @returns {boolean} 是否成功保存
 */
function removeFromWhitelist(dir) {
  const normalized = _norm(dir);
  const list = loadWhitelist();
  const filtered = list.filter(p => p !== normalized);
  if (filtered.length === list.length) return true; // 本来就不在，幂等
  return saveWhitelist(filtered);
}

/** 归一化路径：去尾部分隔符（保留根），fail-soft 返回 ''。 */
function _norm(p) {
  try {
    if (typeof p !== 'string' || !p.trim()) return '';
    let n = path.normalize(p.trim());
    while (n.length > 1 && (n.endsWith('/') || n.endsWith('\\'))) n = n.slice(0, -1);
    return n;
  } catch {
    return '';
  }
}

module.exports = {
  loadWhitelist,
  saveWhitelist,
  isWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  WHITELIST_FILE,
};
