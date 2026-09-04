<template>
  <div class="traffic-monitor">
    <!-- 顶部统计栏 -->
    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-label">总请求</div>
        <div class="stat-value">{{ stats.totalRequests || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">失败</div>
        <div class="stat-value" :class="{ error: stats.totalErrors > 0 }">
          {{ stats.totalErrors || 0 }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">输入 Tokens</div>
        <div class="stat-value">{{ formatTokens(stats.totalInputTokens) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">输出 Tokens</div>
        <div class="stat-value">{{ formatTokens(stats.totalOutputTokens) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">平均延迟</div>
        <div class="stat-value">{{ stats.avgDurationMs || 0 }}ms</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">缓冲区</div>
        <div class="stat-value">{{ stats.bufferedEntries || 0 }} / {{ stats.maxEntries || 0 }}</div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <button
          :class="['btn', captureEnabled ? 'btn-danger' : 'btn-success']"
          @click="toggleCapture"
        >
          {{ captureEnabled ? '⏸ 暂停捕获' : '▶ 启用捕获' }}
        </button>
        <button class="btn btn-secondary" @click="refreshData">🔄 刷新</button>
        <button class="btn btn-secondary" @click="clearData">🗑 清空</button>
        <button class="btn btn-secondary" @click="exportHAR">📥 导出 HAR</button>
      </div>
      <div class="toolbar-right">
        <select v-model="filterProvider" class="filter-select">
          <option value="">全部 Provider</option>
          <option v-for="p in providers" :key="p" :value="p">{{ p }}</option>
        </select>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索 URL..."
          class="search-input"
        />
      </div>
    </div>

    <!-- Provider 分布 -->
    <div class="provider-bars">
      <div
        v-for="(ps, name) in stats.providers"
        :key="name"
        class="provider-bar"
        :class="{ active: filterProvider === name }"
        @click="filterProvider = filterProvider === name ? '' : name"
      >
        <span class="provider-name">{{ name }}</span>
        <span class="provider-count">{{ ps.requests }}</span>
        <span v-if="ps.errors > 0" class="provider-errors">{{ ps.errors }}</span>
      </div>
    </div>

    <!-- 流量列表 -->
    <div class="traffic-list">
      <div v-if="loading" class="empty-state">加载中...</div>
      <div v-else-if="entries.length === 0" class="empty-state">
        暂无流量记录
      </div>
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="traffic-entry"
        :class="{ error: !entry.success }"
        @click="selectEntry(entry)"
      >
        <div class="entry-main">
          <span class="entry-time">{{ formatTimestamp(entry.timestamp) }}</span>
          <span class="entry-status" :class="{ success: entry.success }">
            {{ entry.success ? '✓' : '✗' }}
          </span>
          <span class="entry-provider">{{ entry.provider }}</span>
          <span class="entry-model">{{ entry.model }}</span>
          <span class="entry-method">{{ entry.method }}</span>
          <span class="entry-code">{{ entry.statusCode || '—' }}</span>
          <span class="entry-duration">{{ formatDuration(entry.durationMs) }}</span>
          <span class="entry-tokens">{{ formatTokens(entry.tokenUsage?.totalTokens) }}</span>
          <span class="entry-url" :title="entry.url">{{ truncate(entry.url, 40) }}</span>
        </div>
      </div>
    </div>

    <!-- 详情面板 -->
    <div v-if="selectedEntry" class="detail-panel" @click.self="selectedEntry = null">
      <div class="detail-content">
        <div class="detail-header">
          <h3>流量详情</h3>
          <button class="btn btn-icon" @click="selectedEntry = null">✕</button>
        </div>
        <div class="detail-body">
          <div class="detail-row">
            <span class="detail-label">ID</span>
            <span class="detail-value">{{ selectedEntry.id }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">时间</span>
            <span class="detail-value">{{ formatTimestamp(selectedEntry.timestamp) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Provider</span>
            <span class="detail-value">{{ selectedEntry.provider }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">模型</span>
            <span class="detail-value">{{ selectedEntry.model }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">URL</span>
            <span class="detail-value break">{{ selectedEntry.url }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">状态码</span>
            <span class="detail-value">{{ selectedEntry.statusCode || '—' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">耗时</span>
            <span class="detail-value">{{ formatDuration(selectedEntry.durationMs) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Tokens</span>
            <span class="detail-value">
              输入 {{ formatTokens(selectedEntry.tokenUsage?.inputTokens) }} /
              输出 {{ formatTokens(selectedEntry.tokenUsage?.outputTokens) }}
            </span>
          </div>
          <div v-if="selectedEntry.errorMessage" class="detail-row">
            <span class="detail-label">错误</span>
            <span class="detail-value error">{{ selectedEntry.errorMessage }}</span>
          </div>

          <!-- 请求头 -->
          <div v-if="selectedEntry.requestHeaders && Object.keys(selectedEntry.requestHeaders).length > 0" class="detail-section">
            <h4>请求头</h4>
            <div v-for="(v, k) in selectedEntry.requestHeaders" :key="k" class="detail-row">
              <span class="detail-label">{{ k }}</span>
              <span class="detail-value break">{{ v }}</span>
            </div>
          </div>

          <!-- 响应头 -->
          <div v-if="selectedEntry.responseHeaders && Object.keys(selectedEntry.responseHeaders).length > 0" class="detail-section">
            <h4>响应头</h4>
            <div v-for="(v, k) in selectedEntry.responseHeaders" :key="k" class="detail-row">
              <span class="detail-label">{{ k }}</span>
              <span class="detail-value break">{{ v }}</span>
            </div>
          </div>

          <!-- 请求体 -->
          <div v-if="selectedEntry.requestBody" class="detail-section">
            <h4>请求体</h4>
            <pre class="detail-body-content">{{ selectedEntry.requestBody }}</pre>
          </div>

          <!-- 响应体 -->
          <div v-if="selectedEntry.responseBody" class="detail-section">
            <h4>响应体</h4>
            <pre class="detail-body-content">{{ selectedEntry.responseBody }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

// ── 状态 ────────────────────────────────────────────────────────
const entries = ref([]);
const stats = ref({});
const providers = ref([]);
const loading = ref(true);
const captureEnabled = ref(true);
const filterProvider = ref('');
const searchQuery = ref('');
const selectedEntry = ref(null);
let ws = null;
let refreshTimer = null;

// ── 计算属性 ────────────────────────────────────────────────────
const filteredEntries = computed(() => {
  let result = entries.value;
  if (filterProvider.value) {
    result = result.filter((e) => e.provider === filterProvider.value);
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    result = result.filter((e) => e.url?.toLowerCase().includes(q));
  }
  return result;
});

// ── 工具函数 ────────────────────────────────────────────────────
function formatTokens(t) {
  if (!t) return '—';
  if (t >= 1000000) return `${(t / 1000000).toFixed(1)}M`;
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return String(t);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function truncate(str, maxLen = 60) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

// ── WebSocket 连接 ──────────────────────────────────────────────
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/traffic`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (import.meta.env.DEV) { console.log('[TrafficMonitor] WebSocket 已连接'); }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      if (import.meta.env.DEV) { console.log('[TrafficMonitor] WebSocket 断开，5s 后重连...'); }
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    /* WebSocket 不可用，降级到轮询 */
  }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      entries.value = msg.payload.entries || [];
      stats.value = msg.payload.stats || {};
      updateProviders();
      loading.value = false;
      break;
    case 'traffic':
      entries.value.unshift(msg.payload);
      if (entries.value.length > 2000) entries.value.pop();
      refreshStats();
      break;
    case 'stats':
      stats.value = msg.payload;
      updateProviders();
      break;
    case 'cleared':
      entries.value = [];
      refreshStats();
      break;
    case 'enabled':
      captureEnabled.value = msg.payload.enabled;
      break;
    default:
      break;
  }
}

function updateProviders() {
  providers.value = Object.keys(stats.value.providers || {});
}

// ── 操作 ────────────────────────────────────────────────────────
function toggleCapture() {
  ws?.send(JSON.stringify({ type: 'setEnabled', enabled: !captureEnabled.value }));
}

function refreshData() {
  ws?.send(JSON.stringify({ type: 'getStats' }));
  ws?.send(JSON.stringify({ type: 'query', filters: { limit: 100 } }));
}

function clearData() {
  ws?.send(JSON.stringify({ type: 'clear' }));
}

function exportHAR() {
  ws?.send(JSON.stringify({ type: 'exportHAR' }));
  // 等待服务端推送 HAR 数据
  const handler = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'har') {
        const blob = new Blob([JSON.stringify(msg.payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `khy-traffic-${Date.now()}.har`;
        a.click();
        URL.revokeObjectURL(url);
        ws?.removeEventListener('message', handler);
      }
    } catch {
      /* ignore */
    }
  };
  ws?.addEventListener('message', handler);
}

function selectEntry(entry) {
  selectedEntry.value = entry;
}

function refreshStats() {
  ws?.send(JSON.stringify({ type: 'getStats' }));
}

// ── 生命周期 ────────────────────────────────────────────────────
onMounted(() => {
  connectWebSocket();
  // 降级轮询（WebSocket 不可用时）
  refreshTimer = setInterval(() => {
    if (!ws || ws.readyState !== 1) {
      refreshStats();
    }
  }, 5000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (ws) ws.close();
});
</script>

<style scoped>
.traffic-monitor {
  padding: 16px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

/* ── 统计栏 ─────────────────────────────────────────────────── */
.stats-bar {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.stat-card {
  background: var(--surface-color, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 100px;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-color, #eee);
  margin-top: 2px;
}

.stat-value.error {
  color: #f87171;
}

/* ── 工具栏 ─────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.btn-success {
  background: var(--khy-success);
  color: white;
}

.btn-danger {
  background: var(--khy-danger);
  color: white;
}

.btn-secondary {
  background: var(--surface-color, #1e1e2e);
  border-color: var(--border-color, #333);
  color: var(--text-color, #eee);
}

.btn-secondary:hover {
  background: var(--hover-color, #2a2a3e);
}

.btn-icon {
  background: transparent;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: var(--text-muted, #888);
}

.filter-select,
.search-input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #333);
  background: var(--surface-color, #1e1e2e);
  color: var(--text-color, #eee);
  font-size: 13px;
}

.search-input {
  width: 200px;
}

/* ── Provider 分布 ───────────────────────────────────────────── */
.provider-bars {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.provider-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 16px;
  background: var(--surface-color, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.provider-bar:hover,
.provider-bar.active {
  border-color: #6366f1;
  background: #6366f120;
}

.provider-name {
  font-weight: 500;
}

.provider-count {
  background: #6366f140;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
}

.provider-errors {
  background: #ef444440;
  color: #f87171;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
}

/* ── 流量列表 ────────────────────────────────────────────────── */
.traffic-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-muted, #888);
  font-size: 14px;
}

.traffic-entry {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
}

.traffic-entry:hover {
  background: var(--hover-color, #2a2a3e);
}

.traffic-entry.error {
  border-left: 3px solid #f87171;
}

.entry-main {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

.entry-time {
  color: var(--text-muted, #888);
  min-width: 65px;
}

.entry-status {
  font-weight: 600;
  min-width: 14px;
}

.entry-status.success {
  color: var(--khy-success);
}

.entry-status:not(.success) {
  color: #f87171;
}

.entry-provider {
  font-weight: 600;
  color: #6366f1;
  min-width: 80px;
}

.entry-model {
  color: var(--text-color, #eee);
  min-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-method {
  color: var(--text-muted, #888);
  min-width: 50px;
}

.entry-code {
  min-width: 35px;
  text-align: center;
}

.entry-duration {
  color: var(--text-muted, #888);
  min-width: 55px;
  text-align: right;
}

.entry-tokens {
  color: #a78bfa;
  min-width: 50px;
  text-align: right;
}

.entry-url {
  color: var(--text-muted, #888);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 详情面板 ────────────────────────────────────────────────── */
.detail-panel {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.detail-content {
  background: var(--surface-color, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  width: 90%;
  max-width: 800px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color, #333);
}

.detail-header h3 {
  margin: 0;
  font-size: 16px;
}

.detail-body {
  padding: 14px 18px;
  overflow-y: auto;
  flex: 1;
}

.detail-row {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color, #222);
}

.detail-label {
  min-width: 80px;
  color: var(--text-muted, #888);
  font-size: 13px;
  flex-shrink: 0;
}

.detail-value {
  color: var(--text-color, #eee);
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  word-break: break-word;
}

.detail-value.break {
  word-break: break-all;
}

.detail-value.error {
  color: #f87171;
}

.detail-section {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color, #333);
}

.detail-section h4 {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: #6366f1;
}

.detail-body-content {
  background: var(--bg-color, #16161e);
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>
