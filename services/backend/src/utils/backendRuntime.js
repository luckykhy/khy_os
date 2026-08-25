'use strict';

/**
 * backendRuntime.js — 后端 HTTP 服务的运行时坐标落盘 / 读取。
 *
 * 为什么需要它：server.js 在端口被占用时会自动顺延重试（listenWithAutoPort），
 * 所以「配置里的端口」并不等于「实际监听的端口」。CLI 是独立进程，拿不到
 * server.js 的内存状态，只能通过磁盘上的运行时文件得知真实坐标。
 *
 * 沿用仓库既有的 `<数据家>/*_runtime.json` 约定（对照 ai_manage_runtime.json）。
 * 该文件描述的是「本机后端此刻在哪」，属于易失状态，进程退出时清除。
 */

const fs = require('fs');
const path = require('path');

const { getDataHome } = require('./dataHome');

const RUNTIME_FILENAME = 'backend_runtime.json';

function runtimeFilePath() {
  return path.join(getDataHome(), RUNTIME_FILENAME);
}

function isValidPort(value) {
  const port = parseInt(String(value ?? ''), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * 记录后端已监听的端口。写失败不影响服务本身，因此整段 fail-soft。
 * @param {number} port
 * @returns {boolean} 是否写入成功
 */
function writeBackendRuntime(port) {
  const validPort = isValidPort(port);
  if (!validPort) {
    return false;
  }
  try {
    const file = runtimeFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ apiPort: validPort, pid: process.pid, startedAt: Date.now() }, null, 2),
      'utf-8'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取后端运行时坐标。
 * @returns {{ apiPort: number, pid: number|null, startedAt: number|null }|null}
 */
function readBackendRuntime() {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFilePath(), 'utf-8'));
    const apiPort = isValidPort(raw?.apiPort);
    if (!apiPort) {
      return null;
    }
    return {
      apiPort,
      pid: Number.isFinite(raw?.pid) ? raw.pid : null,
      startedAt: Number.isFinite(raw?.startedAt) ? raw.startedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * 清除运行时文件（进程退出时调用）。
 */
function clearBackendRuntime() {
  try {
    fs.unlinkSync(runtimeFilePath());
  } catch {
    // 文件不存在或已被清理，无需处理
  }
}

module.exports = {
  RUNTIME_FILENAME,
  runtimeFilePath,
  writeBackendRuntime,
  readBackendRuntime,
  clearBackendRuntime,
};
