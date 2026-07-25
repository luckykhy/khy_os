'use strict';

/**
 * _readTracker.js — 进程级文件读取追踪器 + 时间戳防覆盖守护。
 *
 * FileReadTool 成功后调用 markRead(path, mtimeMs)，
 * FileWriteTool 对已存在文件调用 hasRead(path) 检查是否已读。
 * FileEditTool 编辑前调用 isStale(path) 检查文件是否在 Read 后被外部修改。
 *
 * 对标 CC: readFileState 时间戳守护 — 如果文件自上次 Read 后被修改则拒绝编辑。
 */

const path = require('path');
const fs = require('fs');

/** Map<resolvedPath, mtimeMs> — 记录 Read 时文件的修改时间 */
const _readState = new Map();

/**
 * 平台感知路径规范化 — 解决 Windows 上 POSIX 路径(/c/Users/...)
 * 与原生 Win 路径(C:\Users\...) 不一致导致 hasRead() 误判的问题。
 */
function _normalizePath(filePath) {
  let resolved = path.resolve(filePath);
  if (process.platform === 'win32') {
    // 统一为大写盘符 + 反斜杠，消除 /c/ vs C:\ 与 c:\ vs C:\ 差异
    resolved = resolved.replace(/\//g, '\\');
    // /c/Users/... → C:\Users\...  (Git Bash / MSYS2 风格)
    resolved = resolved.replace(/^\\([a-zA-Z])\\/, (_, d) => `${d.toUpperCase()}:\\`);
    // 大写化盘符前缀以统一 c:\ 和 C:\
    resolved = resolved.replace(/^([a-zA-Z]):\\/, (_, d) => `${d.toUpperCase()}:\\`);
  }
  return resolved;
}

/**
 * 标记文件已读并记录当时的 mtime。
 * @param {string} filePath 绝对或相对路径
 * @param {number} [mtimeMs] 读取时的 mtime；省略则自动 stat
 */
function markRead(filePath, mtimeMs) {
  if (!filePath) return;
  const resolved = _normalizePath(filePath);
  if (typeof mtimeMs !== 'number') {
    try { mtimeMs = fs.statSync(resolved).mtimeMs; } catch { /* best-effort */ }
  }
  _readState.set(resolved, mtimeMs || Date.now());
}

/**
 * 检查文件是否曾被 Read 过。
 */
function hasRead(filePath) {
  if (!filePath) return false;
  return _readState.has(_normalizePath(filePath));
}

/**
 * 检查文件自上次 Read 后是否被外部修改。
 * @returns {{ stale: boolean, reason?: string }}
 */
function isStale(filePath) {
  if (!filePath) return { stale: false };
  const resolved = _normalizePath(filePath);
  const savedMtime = _readState.get(resolved);
  if (savedMtime === undefined) {
    // 从未读过 — 不算 stale（由 hasRead 检查处理）
    return { stale: false };
  }
  try {
    const currentMtime = fs.statSync(resolved).mtimeMs;
    if (Math.abs(currentMtime - savedMtime) > 50) {
      return {
        stale: true,
        reason: `File was modified externally since last Read (saved: ${new Date(savedMtime).toISOString()}, current: ${new Date(currentMtime).toISOString()}). Please Read the file again before editing.`,
      };
    }
  } catch {
    // stat 失败 — 文件可能被删除，不阻止
  }
  return { stale: false };
}

function clear() {
  _readState.clear();
}

module.exports = { markRead, hasRead, isStale, clear, normalizePath: _normalizePath };
