'use strict';

/**
 * configSyncClient.js — CLI/TUI 端配置同步适配器。
 *
 * 职责:
 *   - 读取本地 ~/.khyquant/config.json 与远程配置, 合并(远程优先)
 *   - 写配置时: 本地立即写 + 异步推云端(不阻塞)
 *   - 后端不可用时: 静默降级本地, 不报错
 *   - SSE 监听远程变更, 实时更新本地缓存
 *
 * 用法:
 *     const sync = require('./configSyncClient');
 *     await sync.init({ userId: 1, deviceId: 'cli-mbp' });
 *     const apiKey = await sync.get('gateway.apiKey');
 *     await sync.set('gateway.apiKey', 'sk-xxx');
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 本地配置路径 ──────────────────────────────────────────────────
const LOCAL_CONFIG_PATH = (() => {
  try {
    const { getDataHome } = require('../utils/dataHome');
    return path.join(getDataHome(), 'config.json');
  } catch {
    return path.join(os.homedir(), '.khyquant', 'config.json');
  }
})();

// ── 状态 ───────────────────────────────────────────────────────────
let _userId = null;
let _deviceId = null;
let _backendUrl = null;
let _token = null;
let _cache = {}; // 本地缓存
let _dirty = new Set(); // 待推送的 key
let _pushTimer = null;
let _sseConnection = null;

// ── 初始化 ─────────────────────────────────────────────────────────
async function init(opts = {}) {
  _userId = opts.userId || null;
  _deviceId = opts.deviceId || `cli-${os.hostname()}`;
  _backendUrl = opts.backendUrl || _detectBackendUrl();
  _token = opts.token || null;

  // 加载本地配置
  _cache = _readLocal();

  // 尝试从云端拉取(不阻塞, 失败不影响)
  if (_backendUrl && _token) {
    _pullFromCloud().catch(() => {});
    _startSSE().catch(() => {});
  }

  return { ok: true, localKeys: Object.keys(_cache).length };
}

// ── 后端 URL 自动探测 ──────────────────────────────────────────────
function _detectBackendUrl() {
  // 环境变量 > serviceDefaults (零硬编码单一真源)
  try {
    const { BACKEND_HOST, BACKEND_PORT } = require('../constants/serviceDefaults');
    const host = process.env.VITE_BACKEND_HOST || BACKEND_HOST;
    const port = process.env.VITE_BACKEND_PORT || BACKEND_PORT;
    if (host && port) {
      return `http://${host}:${port}`;
    }
  } catch {
    // serviceDefaults 不可用
  }
  return null; // 无法探测, 返回 null 走本地模式
}

// ── 本地文件读写 ───────────────────────────────────────────────────
function _readLocal() {
  try {
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function _writeLocal() {
  try {
    const dir = path.dirname(LOCAL_CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(_cache, null, 2), 'utf8');
  } catch {
    // 本地写入失败不抛, 静默
  }
}

// ── 云端拉取 ───────────────────────────────────────────────────────
async function _pullFromCloud() {
  try {
    const url = `${_backendUrl}/api/config-sync`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${_token}`,
        'X-Device-Id': _deviceId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.data) {
      for (const [key, info] of Object.entries(data.data)) {
        // 远程优先(但本地 dirty 中的 key 不覆盖)
        if (!_dirty.has(key)) {
          _cache[key] = info.value;
        }
      }
      _writeLocal();
    }
  } catch {
    // 后端不可用, 静默降级
  }
}

// ── 云端推送(防抖批量) ────────────────────────────────────────────
function _schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushToCloud().catch(() => {});
  }, 1000); // 1s 防抖
}

async function _pushToCloud() {
  if (!_backendUrl || !_token || _dirty.size === 0) return;

  const keys = Array.from(_dirty);
  _dirty.clear();

  const settings = {};
  for (const key of keys) {
    if (key in _cache) {
      settings[key] = _cache[key];
    }
  }

  try {
    const url = `${_backendUrl}/api/config-sync/bulk`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_token}`,
        'X-Device-Id': _deviceId,
      },
      body: JSON.stringify({ settings, deviceId: _deviceId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // 推送失败, 重新标记为 dirty 等下次
    for (const key of keys) _dirty.add(key);
  }
}

// ── SSE 实时监听 ───────────────────────────────────────────────────
async function _startSSE() {
  if (!_backendUrl || !_token) return;
  try {
    const url = `${_backendUrl}/api/config-sync/stream`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${_token}`,
        'X-Device-Id': _deviceId,
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok || !res.body) return;

    // 简单 SSE 解析(Node 22+ 支持 Web Streams)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n\n');
      buf = lines.pop() || '';

      for (const chunk of lines) {
        if (!chunk.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(chunk.slice(6));
          if (event.type === 'config_change' && event.key) {
            if (!_dirty.has(event.key)) {
              _cache[event.key] = event.value;
              _writeLocal();
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  } catch {
    // SSE 断开, 不报错
  }
}

// ── 公共 API ───────────────────────────────────────────────────────

/**
 * 获取配置(本地缓存优先, 异步刷新)。
 * @param {string} key
 * @param {any} [defaultValue]
 * @returns {Promise<any>}
 */
async function get(key, defaultValue = undefined) {
  // 本地缓存命中
  if (key in _cache) {
    return _cache[key];
  }
  // 尝试云端拉取单个
  if (_backendUrl && _token) {
    try {
      const url = `${_backendUrl}/api/config-sync/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${_token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data?.value !== undefined) {
          _cache[key] = data.data.value;
          return data.data.value;
        }
      }
    } catch {
      // 降级本地
    }
  }
  return defaultValue;
}

/**
 * 设置配置(本地立即生效 + 异步推云端)。
 * @param {string} key
 * @param {any} value
 */
async function set(key, value) {
  _cache[key] = value;
  _dirty.add(key);
  _writeLocal();
  _schedulePush();
  return { ok: true };
}

/**
 * 批量获取所有配置。
 * @returns {Promise<Record<string, any>>}
 */
async function getAll() {
  return { ..._cache };
}

/**
 * 删除配置。
 * @param {string} key
 */
async function remove(key) {
  delete _cache[key];
  _dirty.add(key); // 标记删除, 推送时同步
  _writeLocal();
  _schedulePush();
}

/**
 * 手动触发同步(拉 + 推)。
 */
async function sync() {
  await _pullFromCloud();
  await _pushToCloud();
  return { ok: true, keys: Object.keys(_cache).length };
}

module.exports = {
  init,
  get,
  set,
  getAll,
  remove,
  sync,
  // 内部用
  _pushToCloud,
  _pullFromCloud,
};
