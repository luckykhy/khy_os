#!/usr/bin/env node
'use strict';

/**
 * start-daemon.js — 带 .env 加载的 daemon 启动器
 * 用法: node start-daemon.js [port]
 * 
 * 解决 daemonEntry.js 不加载 .env 的问题：
 * 1. 先调用 init() 加载 .env + ~/.khy/.env overlay
 * 2. 再 require daemonEntry（继承当前 process.env）
 */

const path = require('path');

async function main() {
  // 1. 加载 .env
  try {
    const { init } = require('./src/bootstrap/init');
    await init();
    console.log('[start-daemon] .env loaded via init()');
  } catch (err) {
    // 内联兜底：直接 dotenv
    try {
      const envPath = path.resolve(__dirname, '.env');
      require('dotenv').config({ path: envPath });
      console.log('[start-daemon] .env loaded via dotenv fallback');
    } catch {
      console.warn('[start-daemon] .env load skipped:', err.message);
    }
  }

  // 2. 设置端口（CLI 参数 > env > 默认 3000）
  const port = parseInt(process.argv[2] || process.env.KHY_DAEMON_PORT || process.env.PORT || '3000', 10);
  process.env.KHY_DAEMON_PORT = String(port);
  
  // 确保 PID_FILE 路径存在
  if (!process.env.KHY_DAEMON_PID_FILE) {
    const os = require('os');
    const dataHome = path.join(os.homedir(), '.khyquant');
    process.env.KHY_DAEMON_PID_FILE = path.join(dataHome, 'daemon.pid');
  }

  console.log(`[start-daemon] Starting daemon on port ${port}...`);

  // 3. 启动 daemonEntry（会继承当前 process.env）
  require('./src/services/daemonEntry');
}

main().catch(err => {
  console.error('[start-daemon] Fatal:', err.message);
  process.exit(1);
});
