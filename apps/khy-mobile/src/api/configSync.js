/**
 * configSync.js — Mobile 端配置同步适配器。
 *
 * 与 CLI/TUI 的 configSyncClient.js 对称:
 *   - 本地 Preferences/localStorage 兜底
 *   - 后端可达时推/拉云端
 *   - 后端不可用时静默降级本地
 *
 * 用法:
 *   import { syncGet, syncSet, syncAll } from '@/api/configSync';
 *   await syncSet('gateway.apiKey', 'sk-xxx');
 *   const val = await syncGet('gateway.apiKey');
 */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { apiFetch } from './client';

const SYNC_TIMEOUT = 5000;
const PUSH_DEBOUNCE_MS = 1000;

// 本地存储 key
const LOCAL_CACHE_KEY = 'khy_config_sync_cache_v1';
const DIRTY_KEY = 'khy_config_sync_dirty_v1';

// 内存缓存
let _cache = {};
let _dirty = new Set();
let _pushTimer = null;
let _token = null;

// ── 存储抽象 ──────────────────────────────────────────────────────
function _storage() {
  return Capacitor.isNativePlatform()
    ? Preferences
    : {
        async get({ key }) {
          return { value: localStorage.getItem(key) };
        },
        async set({ key, value }) {
          localStorage.setItem(key, value);
        },
        async remove({ key }) {
          localStorage.removeItem(key);
        },
      };
}

async function _loadLocal() {
  try {
    const { value } = await _storage().get({ key: LOCAL_CACHE_KEY });
    if (value) {
      _cache = JSON.parse(value) || {};
    }
  } catch {
    _cache = {};
  }
}

async function _saveLocal() {
  try {
    await _storage().set({ key: LOCAL_CACHE_KEY, value: JSON.stringify(_cache) });
  } catch {
    // ignore
  }
}

async function _loadDirty() {
  try {
    const { value } = await _storage().get({ key: DIRTY_KEY });
    if (value) {
      _dirty = new Set(JSON.parse(value));
    }
  } catch {
    _dirty = new Set();
  }
}

async function _saveDirty() {
  try {
    await _storage().set({ key: DIRTY_KEY, value: JSON.stringify([..._dirty]) });
  } catch {
    // ignore
  }
}

// ── 初始化 ─────────────────────────────────────────────────────────
export function initConfigSync(token) {
  _token = token;
  _loadLocal();
  _loadDirty();
}

// ── 公共 API ───────────────────────────────────────────────────────

/**
 * 获取配置(本地优先, 异步云端刷新)。
 */
export async function syncGet(key, defaultValue = undefined) {
  if (key in _cache) {
    return _cache[key];
  }
  // 尝试云端
  try {
    const res = await apiFetch(`/api/config-sync/${encodeURIComponent(key)}`, {
      timeout: SYNC_TIMEOUT,
    });
    const data = await res.json();
    if (data.success && data.data?.value !== undefined) {
      _cache[key] = data.data.value;
      _saveLocal();
      return data.data.value;
    }
  } catch {
    // 降级本地
  }
  return defaultValue;
}

/**
 * 设置配置(本地立即 + 异步推云端)。
 */
export async function syncSet(key, value) {
  _cache[key] = value;
  _dirty.add(key);
  _saveLocal();
  _saveDirty();
  _schedulePush();
}

/**
 * 批量获取所有配置。
 */
export async function syncAll() {
  try {
    const res = await apiFetch('/api/config-sync', { timeout: SYNC_TIMEOUT });
    const data = await res.json();
    if (data.success && data.data) {
      for (const [key, info] of Object.entries(data.data)) {
        if (!_dirty.has(key)) {
          _cache[key] = info.value;
        }
      }
      _saveLocal();
    }
  } catch {
    // 离线
  }
  return { ..._cache };
}

/**
 * 手动同步(推 + 拉)。
 */
export async function syncNow() {
  // 推 dirty
  if (_dirty.size > 0) {
    const settings = {};
    for (const key of _dirty) {
      if (key in _cache) settings[key] = _cache[key];
    }
    try {
      await apiFetch('/api/config-sync/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
        timeout: SYNC_TIMEOUT,
      });
      _dirty.clear();
      _saveDirty();
    } catch {
      // 保留 dirty 等下次
    }
  }
  // 拉云端
  await syncAll();
}

// ── 防抖推送 ──────────────────────────────────────────────────────
function _schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    syncNow();
  }, PUSH_DEBOUNCE_MS);
}
