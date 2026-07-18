<template>
  <div class="ai-dashboard-page">
    <KhyPageHeader title="AI 管理总览">
      <template #actions>
        <el-switch
          v-model="autoRefresh"
          inline-prompt
          active-text="自动刷新"
          inactive-text="手动刷新"
          @change="handleAutoRefreshChange"
        />
        <el-button type="primary" @click="refreshAll" :loading="loading">刷新数据</el-button>
      </template>
    </KhyPageHeader>

    <el-row :gutter="16" class="stats-row">
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--blue" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--blue">
              <el-icon><Connection /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">适配器状态</div>
              <div class="metric-value">{{ adapterAvailableCount }}<span class="metric-unit">/{{ adapterTotal }}</span></div>
              <div class="metric-sub">可用 / 总数</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--amber" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--amber">
              <el-icon><Key /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">密钥池</div>
              <div class="metric-value">{{ keyPoolCount }}</div>
              <div class="metric-sub">{{ keyPoolProviderCount }} 个供应商</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--green" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--green">
              <el-icon><User /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">账号池</div>
              <div class="metric-value">{{ activeAccountCount }}<span class="metric-unit">/{{ totalAccountCount }}</span></div>
              <div class="metric-sub">可用 / 总账号</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--purple" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--purple">
              <el-icon><Ticket /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">客户与令牌</div>
              <div class="metric-value">{{ customerTotal }}</div>
              <div class="metric-sub">{{ customerTokenTotal }} 个令牌</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--cyan" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--cyan">
              <el-icon><DataAnalysis /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">请求总数</div>
              <div class="metric-value">{{ requestTotal }}</div>
              <div class="metric-sub">成功率 {{ successRate }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="metric-card metric-card--rose" shadow="hover">
          <div class="metric-row">
            <div class="metric-icon metric-icon--rose">
              <el-icon><Timer /></el-icon>
            </div>
            <div class="metric-body">
              <div class="metric-title">平均时延</div>
              <div class="metric-value">{{ avgLatency }}</div>
              <div class="metric-sub">监控缓冲 {{ bufferSize }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="section-row">
      <el-col :xs="24" :lg="10">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>快捷入口</span>
            </div>
          </template>
          <div class="quick-actions">
            <el-button @click="go('/gateway')"><el-icon><Setting /></el-icon> 网关管理</el-button>
            <el-button @click="go('/bridge-channels')"><el-icon><Link /></el-icon> 桥接渠道</el-button>
            <el-button @click="go('/accounts')"><el-icon><User /></el-icon> 账号池</el-button>
            <el-button @click="go('/assets-customers')"><el-icon><Wallet /></el-icon> 资产与客户</el-button>
            <el-button @click="go('/monitor')"><el-icon><Monitor /></el-icon> 监控中心</el-button>
            <el-button @click="go('/chat')"><el-icon><ChatDotSquare /></el-icon> AI 对话</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="14">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <span>最近请求</span>
              <el-button size="small" @click="fetchRecentTraces">刷新</el-button>
            </div>
          </template>
          <el-table :data="monitor.traces.value" size="small" stripe class="recent-table">
            <el-table-column prop="id" label="追踪 ID" width="150" />
            <el-table-column label="适配器" width="120">
              <template #default="{ row }">{{ row.request?.adapter || '-' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.success ? 'success' : 'danger'" size="small">{{ row.success ? '成功' : '失败' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="时延" width="90">
              <template #default="{ row }">{{ row.latencyMs ? `${row.latencyMs}ms` : '-' }}</template>
            </el-table-column>
            <el-table-column label="时间" width="160">
              <template #default="{ row }">{{ row.startTime ? new Date(row.startTime).toLocaleString() : '-' }}</template>
            </el-table-column>
            <el-table-column label="提示词" show-overflow-tooltip>
              <template #default="{ row }">{{ row.request?.prompt || '-' }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Connection, Key, User, Ticket, DataAnalysis, Timer, ChatDotSquare, Setting, Wallet, Monitor, Link } from '@element-plus/icons-vue'
import { useGateway } from '@/composables/useGateway'
import { useAIMonitor } from '@/composables/useAIMonitor'
import KhyPageHeader from '@/components/KhyPageHeader.vue'
import { useAccountPool } from '@/composables/useAccountPool'
import { useAssetCustomer } from '@/composables/useAssetCustomer'

const router = useRouter()
const gw = useGateway()
const monitor = useAIMonitor()
const accountPool = useAccountPool()
const asset = useAssetCustomer()

const loading = ref(false)
const autoRefresh = ref(true)
let refreshTimer = null

const adapters = computed(() => gw.status.value?.adapters || [])
const adapterTotal = computed(() => adapters.value.length)
const adapterAvailableCount = computed(() => adapters.value.filter(item => item.available).length)

const keyPoolProviderCount = computed(() => {
  const pool = gw.pool.value || {}
  return Object.keys(pool).length
})

const keyPoolCount = computed(() => {
  const pool = gw.pool.value || {}
  return Object.values(pool).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
})

const accounts = computed(() => accountPool.accounts.value || [])
const totalAccountCount = computed(() => accounts.value.length)
const activeAccountCount = computed(() => accounts.value.filter(item => item.status === 'active' && !item.disabled).length)

const assetsSummary = computed(() => asset.overview.value?.assets || {})
const customerTotal = computed(() => assetsSummary.value?.customers?.total || 0)
const customerTokenTotal = computed(() => assetsSummary.value?.customers?.tokens || 0)

const requestTotal = computed(() => monitor.stats.value?.total || 0)
const successRate = computed(() => monitor.stats.value?.successRate || '0.0%')
const avgLatency = computed(() => `${monitor.stats.value?.avgLatencyMs || 0}ms`)
const bufferSize = computed(() => {
  const current = monitor.stats.value?.bufferSize || 0
  const max = monitor.stats.value?.maxBufferSize || 0
  return `${current}/${max}`
})

function go(path) {
  router.push(path)
}

async function fetchRecentTraces() {
  await monitor.fetchTraces({ limit: 8 })
}

async function refreshAll() {
  loading.value = true
  try {
    await Promise.all([
      gw.fetchStatus(),
      gw.fetchPool(),
      accountPool.fetchAccounts(),
      asset.fetchOverview(),
      monitor.fetchStats(),
      fetchRecentTraces(),
    ])
  } catch (err) {
    ElMessage.error(err?.message || '刷新失败')
  } finally {
    loading.value = false
  }
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
  }, 30000)
}

function handleAutoRefreshChange() {
  startAutoRefresh()
}

onMounted(async () => {
  await refreshAll()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.ai-dashboard-page {
  max-width: 1320px;
  margin: 0 auto;
}

.stats-row {
  margin-bottom: 16px;
}

.metric-card {
  margin-bottom: 14px;
}

.metric-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.metric-body {
  flex: 1;
  min-width: 0;
}

.metric-title {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.metric-value {
  margin-top: 6px;
  font-size: 28px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  line-height: 1.1;
}

.metric-unit {
  font-size: 16px;
  font-weight: 500;
  color: var(--el-text-color-secondary);
}

.metric-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.section-row {
  margin-bottom: 16px;
}

.section-card {
  margin-bottom: 14px;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.quick-actions .el-button .el-icon {
  margin-right: 4px;
}

.recent-table {
  width: 100%;
}
</style>
