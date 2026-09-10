'use strict';

/**
 * ccHistory.js — 输入历史管理
 * 
 * 持久化到 ~/.khyquant/.khy_history
 * 支持搜索、去重、容量限制
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_DIR = path.join(os.homedir(), '.khyquant');
const HISTORY_FILE = path.join(HISTORY_DIR, '.khy_history');
const MAX_HISTORY = 100;

let _cache = null;
let _dirty = false;

/**
 * 加载历史
 */
function loadHistory() {
  if (_cache) return _cache;
  try {
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    _cache = text.split('\n').filter(Boolean).slice(-MAX_HISTORY);
  } catch {
    _cache = [];
  }
  return _cache;
}

/**
 * 保存历史（延迟写入）
 */
function saveHistoryImmediate() {
  if (!_dirty || !_cache) return;
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, _cache.join('\n') + '\n');
    _dirty = false;
  } catch {
    // fail-soft
  }
}

/**
 * 添加历史条目
 */
function addHistory(entry) {
  if (!entry || !entry.trim()) return;
  const history = loadHistory();
  // 去重
  if (history[history.length - 1] === entry) return;
  history.push(entry);
  _cache = history.slice(-MAX_HISTORY);
  _dirty = true;
}

/**
 * 搜索历史
 */
function searchHistory(query) {
  const history = loadHistory();
  if (!query) return history.slice().reverse();
  const q = query.toLowerCase();
  return history.filter(h => h.toLowerCase().includes(q)).reverse();
}

/**
 * 获取上一条历史
 */
function getPreviousHistory(currentIndex = -1) {
  const history = loadHistory();
  if (history.length === 0) return '';
  const idx = currentIndex <= 0 ? history.length - 1 : currentIndex - 1;
  return history[idx] || '';
}

/**
 * 获取下一条历史
 */
function getNextHistory(currentIndex = 0) {
  const history = loadHistory();
  if (history.length === 0) return '';
  const idx = currentIndex >= history.length - 1 ? 0 : currentIndex + 1;
  return history[idx] || '';
}

// 退出时保存
process.on('exit', saveHistoryImmediate);
process.on('SIGINT', () => { saveHistoryImmediate(); process.exit(0); });

module.exports = {
  loadHistory,
  addHistory,
  searchHistory,
  getPreviousHistory,
  getNextHistory,
};
