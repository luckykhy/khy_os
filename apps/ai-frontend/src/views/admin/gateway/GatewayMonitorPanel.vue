<template>
  <div class="gateway-monitor-panel">
    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>适配器状态</span>
          <el-button size="small" @click="emit('refreshStatus')">刷新</el-button>
        </div>
      </template>
      <el-table
        v-loading="statusBusy"
        :data="adapters"
        empty-text="暂无适配器"
        size="small"
        stripe
      >
        <el-table-column label="名称" prop="name" width="140">
          <template #default="{ row }">
            <span class="adapter-name-cell">
              <span
                :class="[
                  'status-dot',
                  row.available
                    ? 'status-dot--green'
                    : row.enabled
                      ? 'status-dot--yellow'
                      : 'status-dot--gray',
                ]"
              ></span>
              {{ row.name }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="类型" prop="type" width="100" />
        <el-table-column label="优先级" prop="priority" width="80" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              effect="light"
              size="small"
              :type="row.available ? 'success' : row.enabled ? 'warning' : 'info'"
            >
              {{ row.available ? '可用' : row.enabled ? '不可用' : '已禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明" prop="detail" />
      </el-table>
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>调用监控</span>
          <el-button
            size="small"
            :type="monitor.connected.value ? 'success' : 'default'"
            @click="toggleMonitorStream"
          >
            {{ monitor.connected.value ? '实时中' : '连接实时流' }}
          </el-button>
        </div>
      </template>
      <div v-if="monitor.stats.value" class="monitor-stats">
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">总请求</div>
          <div class="monitor-stat-value">{{ monitor.stats.value.total }}</div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">成功率</div>
          <div class="monitor-stat-value monitor-stat--success">
            {{ monitor.stats.value.successRate }}
          </div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">平均时延</div>
          <div class="monitor-stat-value">{{ monitor.stats.value.avgLatencyMs }}ms</div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">缓冲区</div>
          <div class="monitor-stat-value">
            {{ monitor.stats.value.bufferSize }}/{{ monitor.stats.value.maxBufferSize }}
          </div>
        </div>
      </div>
      <el-table
        :data="monitor.traces.value.slice(0, 20)"
        max-height="300"
        size="small"
        stripe
      >
        <el-table-column label="时间" width="80">
          <template #default="{ row }">
            {{ new Date(row.startTime).toLocaleTimeString() }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="70">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.success ? 'success' : row.success === false ? 'danger' : 'info'"
            >
              {{ row.success ? '成功' : row.success === false ? '失败' : '执行中' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时延" prop="latencyMs" width="80">
          <template #default="{ row }">
            {{ row.latencyMs ? row.latencyMs + 'ms' : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="适配器" width="100">
          <template #default="{ row }">
            {{ row.response?.provider || row.request?.adapter || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="提示词" min-width="200">
          <template #default="{ row }">
            {{ row.request?.prompt?.slice(0, 80) || '-' }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue';
import { useAIMonitor } from '@/composables/useAIMonitor';

// The adapter table data comes from the parent's shared useGateway() instance
// (recreating it here would open a second, un-synced copy of the pool/config
// state). Only the live-call monitor is owned here, because it is a bounded
// EventSource that should be torn down with this panel.
defineProps({
  adapters: { type: Array, default: () => [] },
  statusBusy: { type: Boolean, default: false },
});

const emit = defineEmits(['refreshStatus']);

const monitor = useAIMonitor();

async function loadInitial() {
  // Silent so a gateway that is offline does not toast on every tab activation.
  await Promise.allSettled([
    monitor.fetchStats(),
    monitor.fetchTraces({ limit: 20 }),
  ]);
}

function toggleMonitorStream() {
  if (monitor.connected.value) {
    monitor.disconnect();
  } else {
    monitor.connectSSE();
  }
}

onMounted(loadInitial);

// Under keep-alive the panel is created once; refresh on later activations so
// the stats and trace tail stay current instead of going stale behind a tab.
let activatedOnce = false;
onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  loadInitial();
});

// The live tail is opened only through toggleMonitorStream, and this panel is
// hidden (not destroyed) by v-show. Close the stream when the cached view is
// deactivated or unmounted so caching cannot leak an open EventSource.
onDeactivated(() => {
  monitor.disconnect();
});
onUnmounted(() => {
  monitor.disconnect();
});
</script>

<style scoped>
.gateway-monitor-panel {
  display: contents;
}

.section-card {
  margin-bottom: 16px;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.adapter-name-cell {
  display: inline-flex;
  align-items: center;
  font-weight: 500;
}

.monitor-stats {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border: 1px solid var(--khy-border-light);
  border-radius: 10px;
  overflow: hidden;
}

.monitor-stat-item {
  flex: 1;
  padding: 14px 16px;
  text-align: center;
  border-right: 1px solid var(--khy-border-light);
  background: linear-gradient(180deg, var(--khy-bg-hover), var(--khy-white));
}

.monitor-stat-item:last-child {
  border-right: none;
}

.monitor-stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 600;
  margin-bottom: 6px;
}

.monitor-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.monitor-stat--success {
  color: var(--khy-success);
}
</style>
