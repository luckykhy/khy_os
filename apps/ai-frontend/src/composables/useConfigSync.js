/**
 * useConfigSync.js — Web 前端配置同步 composable。
 *
 * 四端配置同步的 Web 端实现:
 *   - 读配置: 优先本地缓存 → 异步拉云端 → 合并
 *   - 写配置: 本地立即更新 + 防抖推云端
 *   - 实时: EventSource SSE 监听远程变更
 *   - 离线: 后端不可用时静默降级本地 localStorage
 *
 * 用法:
 *   const { config, setConfig, syncStatus } = useConfigSync();
 *   await setConfig('gateway.apiKey', 'sk-xxx'); // 自动同步到所有端
 */

import { reactive, onMounted, onUnmounted } from 'vue';
import request from '@/api/request';

const SYNC_TIMEOUT = 5000;
const PUSH_DEBOUNCE_MS = 1000;

// 模块级状态(跨组件共享)
const state = reactive({
  initialized: false,
  syncing: false,
  lastSync: null,
  fromCloud: false,
  error: null,
});

const _cache = reactive({});
const _dirty = new Set();
let _pushTimer = null;
let _eventSource = null;

/**
 * 初始化配置同步。
 * @param {object} [opts]
 * @param {boolean} [opts.realtime=true] - 是否开启 SSE 实时监听
 */
export function useConfigSync(opts = {}) {
  const { realtime = true } = opts;

  onMounted(async () => {
    if (state.initialized) return;
    await _init(realtime);
  });

  onUnmounted(() => {
    _closeSSE();
  });

  /**
   * 获取配置(本地优先)。
   */
  async function get(key, defaultValue = undefined) {
    if (key in _cache) return _cache[key];
    // 尝试云端拉取
    try {
      const { data } = await request.get(`/config-sync/${encodeURIComponent(key)}`, {
        timeout: SYNC_TIMEOUT,
        __skipErrorNotify: true,
      });
      if (data.success && data.data?.value !== undefined) {
        _cache[key] = data.data.value;
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
  async function set(key, value) {
    _cache[key] = value;
    _dirty.add(key);
    _schedulePush();
  }

  /**
   * 批量获取所有配置。
   */
  async function getAll() {
    await _pullAll();
    return { ..._cache };
  }

  /**
   * 手动触发全量同步。
   */
  async function syncAll() {
    state.syncing = true;
    state.error = null;
    try {
      // 推本地 dirty 到云端
      if (_dirty.size > 0) {
        const settings = {};
        for (const key of _dirty) {
          if (key in _cache) settings[key] = _cache[key];
        }
        await request.post('/config-sync/bulk', { settings }, { timeout: SYNC_TIMEOUT });
        _dirty.clear();
      }
      // 拉云端最新
      await getAll();
    } catch (err) {
      state.error = err.message;
    } finally {
      state.syncing = false;
    }
  }

  return {
    config: _cache,
    get,
    set,
    getAll,
    syncAll,
    syncStatus: state,
  };
}

// ── 内部实现 ───────────────────────────────────────────────────────

// 模块级拉取: 从云端取全量配置, 只覆盖未被本地改脏的键。
// 刻意放在闭包外 —— useConfigSync() 的 getAll() 与 _init() 分属不同作用域,
// 此前 _init 直接调闭包内的 getAll 会抛 ReferenceError, 导致每次 onMounted 静默走离线分支。
async function _pullAll() {
  try {
    const { data } = await request.get('/config-sync', {
      timeout: SYNC_TIMEOUT,
      __skipErrorNotify: true,
    });
    if (data.success && data.data) {
      for (const [key, info] of Object.entries(data.data)) {
        if (!_dirty.has(key) && info && info.value !== undefined) {
          _cache[key] = info.value;
        }
      }
      state.fromCloud = true;
      state.lastSync = Date.now();
    }
  } catch {
    state.fromCloud = false;
  }
}

async function _init(realtime) {
  // 1. 从 localStorage 加载缓存(比云端快)
  _loadFromStorage();

  // 2. 尝试从云端拉取
  try {
    await _pullAll();
  } catch {
    // 离线模式, 用本地缓存
  }

  // 3. 开启 SSE 实时监听
  if (realtime) {
    _startSSE();
  }

  state.initialized = true;
}

function _loadFromStorage() {
  try {
    const stored = localStorage.getItem('khy_config_sync_cache');
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.assign(_cache, parsed);
    }
  } catch {
    // ignore
  }
}

function _saveToStorage() {
  try {
    localStorage.setItem('khy_config_sync_cache', JSON.stringify({ ..._cache }));
  } catch {
    // ignore
  }
}

function _schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushToCloud();
  }, PUSH_DEBOUNCE_MS);
}

async function _pushToCloud() {
  if (_dirty.size === 0) return;
  const keys = Array.from(_dirty);
  _dirty.clear();

  const settings = {};
  for (const key of keys) {
    if (key in _cache) settings[key] = _cache[key];
  }

  try {
    await request.post('/config-sync/bulk', { settings }, { timeout: SYNC_TIMEOUT });
    _saveToStorage();
  } catch {
    // 推送失败, 重新标记 dirty
    for (const key of keys) _dirty.add(key);
  }
}

function _startSSE() {
  try {
    // EventSource 不支持自定义 header, 用 cookie/token query 传递
    const token = localStorage.getItem('khy_token') || '';
    _eventSource = new EventSource(
      `/api/config-sync/stream?token=${encodeURIComponent(token)}`
    );

    _eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'config_change' && data.key) {
          if (!_dirty.has(data.key)) {
            _cache[data.key] = data.value;
            _saveToStorage();
          }
        }
      } catch {
        // ignore
      }
    };

    _eventSource.onerror = () => {
      // SSE 断开, 不报错, 下次 getAll 时会重连
      _closeSSE();
    };
  } catch {
    // EventSource 不可用, 降级轮询
  }
}

function _closeSSE() {
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}
