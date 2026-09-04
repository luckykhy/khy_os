'use strict';

/**
 * redpassCheckpoint.js — RedPass 破甲检查点系统
 *
 * 支持断点续传：破甲状态持久化到磁盘，TUI 关闭/重启后可恢复
 */

const path = require('path');
const fs = require('fs');

function _getCheckpointPath() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const khyDir = path.join(homeDir, '.khy');
  try {
    if (!fs.existsSync(khyDir)) {
      fs.mkdirSync(khyDir, { recursive: true });
    }
  } catch {
    /* ignore */
  }
  return path.join(khyDir, 'redpass_checkpoint.json');
}

/**
 * 保存破甲状态到磁盘
 * @param {object} state - 破甲状态
 * @param {string} state.originalTopic - 原始测试目标
 * @param {string} state.strategyId - 当前策略 ID
 * @param {number} state.retryCount - 当前重试次数
 * @param {number} state.maxRetries - 最大重试次数
 * @param {number} state.fixedStrategyCount - 固定策略数量
 * @param {Array} state.attackHistory - 攻击历史
 * @param {string} state.status - 状态: attacking | success | failed
 * @param {number} state.timestamp - 时间戳
 */
function saveCheckpoint(state) {
  try {
    const checkpoint = {
      ...state,
      timestamp: Date.now(),
      version: 1,
    };
    fs.writeFileSync(_getCheckpointPath(), JSON.stringify(checkpoint, null, 2), 'utf8');
  } catch {
    /* fail-soft */
  }
}

/**
 * 从磁盘加载破甲状态
 * @returns {object|null} 破甲状态，如果不存在则返回 null
 */
function loadCheckpoint() {
  try {
    const filePath = _getCheckpointPath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 检查是否过期（超过 24 小时）
    if (data.timestamp && Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      clearCheckpoint();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * 清除破甲状态
 */
function clearCheckpoint() {
  try {
    const filePath = _getCheckpointPath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 检查是否有可恢复的破甲状态
 * @returns {boolean}
 */
function hasCheckpoint() {
  return loadCheckpoint() !== null;
}

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  hasCheckpoint,
};
