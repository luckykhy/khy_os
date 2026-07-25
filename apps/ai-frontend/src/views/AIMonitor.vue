<template>
  <div class="ai-monitor-page">
    <KhyPageHeader title="AI 请求监控">
      <template #actions>
        <el-switch
          v-model="autoRefresh"
          inline-prompt
          active-text="自动刷新"
          inactive-text="手动刷新"
          @change="handleAutoRefreshChange"
        />
        <el-button size="small" type="primary" :loading="loadingTraces || loadingStats" @click="refreshAll">刷新</el-button>
      </template>
    </KhyPageHeader>

    <el-card class="section-card" shadow="hover">
      <el-row :gutter="12">
        <el-col :xs="24" :md="6">
          <el-form-item label="适配器" class="filter-item">
            <el-select v-model="filters.provider" clearable placeholder="全部适配器">
              <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :md="6">
          <el-form-item label="状态" class="filter-item">
            <el-select v-model="filters.success" placeholder="全部状态">
              <el-option label="全部" value="" />
              <el-option label="成功" value="true" />
              <el-option label="失败" value="false" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :md="6">
          <el-form-item label="时间范围" class="filter-item">
            <el-select v-model="filters.since" placeholder="最近 24 小时">
              <el-option label="最近 15 分钟" value="15m" />
              <el-option label="最近 1 小时" value="1h" />
              <el-option label="最近 6 小时" value="6h" />
              <el-option label="最近 24 小时" value="24h" />
              <el-option label="最近 3 天" value="72h" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :md="6">
          <el-form-item label="关键词" class="filter-item">
            <el-input
              v-model="filters.keyword"
              clearable
              placeholder="匹配提示词/错误/模型"
              @keyup.enter="applyFilters"
            />
          </el-form-item>
        </el-col>
      </el-row>
      <div class="filter-actions">
        <el-button size="small" type="primary" :loading="loadingTraces" @click="applyFilters">应用筛选</el-button>
        <el-button size="small" @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <el-row :gutter="16" class="stats-row">
      <el-col :span="6">
        <div class="metric-tile metric-tile--blue">
          <div class="metric-tile-label">总请求数</div>
          <div class="metric-tile-value">{{ stats.total }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="metric-tile metric-tile--green">
          <div class="metric-tile-label">成功率</div>
          <div class="metric-tile-value">{{ stats.successRate }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="metric-tile metric-tile--amber">
          <div class="metric-tile-label">平均时延</div>
          <div class="metric-tile-value">{{ stats.avgLatencyMs }}ms</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="metric-tile metric-tile--purple">
          <div class="metric-tile-label">缓冲区大小</div>
          <div class="metric-tile-value">{{ stats.bufferSize }}/{{ stats.maxBufferSize }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>最近调用记录</span>
          <span class="trace-total">共 {{ traces.length }} 条</span>
        </div>
      </template>
      <el-table :data="traces" stripe class="traces-table" max-height="560" @row-click="openTraceDetail" v-loading="loadingTraces">
        <el-table-column prop="id" label="追踪 ID" width="150" />
        <el-table-column prop="request.adapter" label="适配器" width="120" />
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : 'danger'" size="small">
              {{ row.success ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latencyMs" label="时延" width="100">
          <template #default="{ row }">{{ row.latencyMs ? row.latencyMs + 'ms' : '-' }}</template>
        </el-table-column>
        <el-table-column prop="request.prompt" label="提示词" show-overflow-tooltip />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ new Date(row.startTime).toLocaleString() }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="traceDetail.visible" title="调用详情" width="900px">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="追踪 ID">{{ traceDetail.row?.id || '-' }}</el-descriptions-item>
        <el-descriptions-item label="适配器">{{ traceDetail.row?.request?.adapter || '-' }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="traceDetail.row?.success ? 'success' : 'danger'" size="small">
            {{ traceDetail.row?.success ? '成功' : '失败' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="时延">{{ traceDetail.row?.latencyMs ? `${traceDetail.row.latencyMs}ms` : '-' }}</el-descriptions-item>
        <el-descriptions-item label="开始时间">{{ traceDetail.row?.startTime ? new Date(traceDetail.row.startTime).toLocaleString() : '-' }}</el-descriptions-item>
        <el-descriptions-item label="结束时间">{{ traceDetail.row?.endTime ? new Date(traceDetail.row.endTime).toLocaleString() : '-' }}</el-descriptions-item>
      </el-descriptions>

      <el-divider>Prompt</el-divider>
      <pre class="detail-block">{{ traceDetail.row?.request?.prompt || '-' }}</pre>

      <el-divider>Response</el-divider>
      <pre class="detail-block">{{ traceDetail.row?.response?.content || '-' }}</pre>

      <el-divider>Error</el-divider>
      <pre class="detail-block">{{ traceDetail.row?.error || '-' }}</pre>

      <el-divider>Cascade</el-divider>
      <el-table :data="traceDetail.row?.cascade || []" size="small" stripe>
        <el-table-column prop="adapter" label="适配器" width="140" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : 'danger'" size="small">{{ row.success ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latencyMs" label="时延(ms)" width="110" />
        <el-table-column prop="model" label="模型" width="180" />
        <el-table-column prop="error" label="错误信息" min-width="220" />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import request from '@/api/request'
import { unwrap } from '@/api/unwrap'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const stats = ref({ total: 0, successRate: '0%', avgLatencyMs: 0, bufferSize: 0, maxBufferSize: 100 })
const traces = ref([])
const loadingStats = ref(false)
const loadingTraces = ref(false)
const autoRefresh = ref(true)
let refreshTimer = null

const filters = reactive({
  provider: '',
  success: '',
  since: '24h',
  keyword: '',
})

const traceDetail = reactive({
  visible: false,
  row: null,
})

async function fetchStats() {
  try {
    loadingStats.value = true
    const res = await request.get('/api/ai-gateway/monitor/stats')
    stats.value = unwrap(res)
  } catch {
    // ignore
  } finally {
    loadingStats.value = false
  }
}

function sinceToIso(since) {
  if (!since) return ''
  const now = Date.now()
  if (since === '15m') return new Date(now - 15 * 60 * 1000).toISOString()
  if (since === '1h') return new Date(now - 60 * 60 * 1000).toISOString()
  if (since === '6h') return new Date(now - 6 * 60 * 60 * 1000).toISOString()
  if (since === '24h') return new Date(now - 24 * 60 * 60 * 1000).toISOString()
  if (since === '72h') return new Date(now - 72 * 60 * 60 * 1000).toISOString()
  return ''
}

async function fetchTraces() {
  try {
    loadingTraces.value = true
    const params = new URLSearchParams()
    params.set('limit', '100')
    if (filters.provider) params.set('provider', filters.provider)
    if (filters.success !== '') params.set('success', filters.success)
    const sinceIso = sinceToIso(filters.since)
    if (sinceIso) params.set('since', sinceIso)

    const res = await request.get(`/api/ai-gateway/monitor/traces?${params.toString()}`)
    let rows = unwrap(res).traces || []

    const keyword = String(filters.keyword || '').trim().toLowerCase()
    if (keyword) {
      rows = rows.filter((row) => {
        const prompt = String(row?.request?.prompt || '').toLowerCase()
        const model = String(row?.request?.model || row?.response?.model || '').toLowerCase()
        const error = String(row?.error || '').toLowerCase()
        const adapter = String(row?.request?.adapter || '').toLowerCase()
        return prompt.includes(keyword) || model.includes(keyword) || error.includes(keyword) || adapter.includes(keyword)
      })
    }

    traces.value = rows
  } catch {
    // ignore
  } finally {
    loadingTraces.value = false
  }
}

const providerOptions = computed(() => {
  const set = new Set()
  const fromStats = stats.value?.providers ? Object.keys(stats.value.providers) : []
  for (const key of fromStats) if (key) set.add(String(key))
  for (const row of traces.value) {
    const adapter = String(row?.request?.adapter || '').trim()
    if (adapter) set.add(adapter)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

async function applyFilters() {
  await fetchTraces()
}

async function resetFilters() {
  filters.provider = ''
  filters.success = ''
  filters.since = '24h'
  filters.keyword = ''
  await fetchTraces()
}

function openTraceDetail(row) {
  traceDetail.row = row || null
  traceDetail.visible = !!row
}

async function refreshAll() {
  await Promise.all([fetchStats(), fetchTraces()])
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  if (!autoRefresh.value) return
  refreshTimer = setInterval(() => {
    refreshAll()
  }, 15000)
}

function handleAutoRefreshChange() {
  startAutoRefresh()
}

onMounted(() => {
  refreshAll()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.ai-monitor-page {
  max-width: 1280px;
  margin: 0 auto;
}

.stats-row {
  margin-bottom: 20px;
}

.metric-tile {
  padding: 16px 18px;
  border: 1px solid var(--khy-border);
  border-radius: 12px;
  background: var(--khy-bg-card-grad);
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.05);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.metric-tile:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
}

.metric-tile--blue  { border-left: 3px solid #3b82f6; }
.metric-tile--green { border-left: 3px solid #10b981; }
.metric-tile--amber { border-left: 3px solid #f59e0b; }
.metric-tile--purple { border-left: 3px solid #8b5cf6; }

.metric-tile-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.metric-tile-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.section-card {
  margin-bottom: 16px;
}

.filter-item {
  margin-bottom: 10px;
}

.filter-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.trace-total {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.traces-table {
  width: 100%;
}

.detail-block {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--khy-border);
  border-radius: 8px;
  background: var(--khy-bg-soft);
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
</style>
