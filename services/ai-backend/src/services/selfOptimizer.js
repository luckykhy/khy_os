/**
 * selfOptimizer 存根 — ai-backend 不含完整自优化引擎，
 * 提供安全默认行为防止 require 崩溃。
 */
const path = require('path');

function isProtectedPath(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const khyRoot = path.resolve(__dirname, '../..');
  return resolved.startsWith(khyRoot);
}

async function applyOptimization() {
  return { success: false, error: '自优化功能在 ai-backend 中不可用' };
}

async function proposeCodeChange() {
  return { success: false, error: '代码修改提议功能在 ai-backend 中不可用' };
}

module.exports = { isProtectedPath, applyOptimization, proposeCodeChange };
