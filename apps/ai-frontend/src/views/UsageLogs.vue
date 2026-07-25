<template>
  <div class="usage-logs-page">
    <KhyPageHeader title="用量日志" subtitle="网关请求计量、计费与明细（CLI 适配器为估算值，标注 estimated）">
      <template #actions>
        <el-button :loading="billing.loading.value" @click="refresh">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>
    </KhyPageHeader>

    <!-- Summary metric cards -->
    <div class="metric-row">
      <div class="metric-card">
        <div class="metric-icon metric-icon--blue"><el-icon><Histogram /></el-icon></div>
        <div class="metric-body">
          <div class="metric-label">请求数</div>
          <div class="metric-value">{{ totals.requests || 0 }}</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon metric-icon--green"><el-icon><Coin /></el-icon></div>
        <div class="metric-body">
          <div class="metric-label">总 Tokens</div>
          <div class="metric-value">{{ formatNumber(totals.totalTokens || 0) }}</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon metric-icon--orange"><el-icon><Money /></el-icon></div>
        <div class="metric-body">
          <div class="metric-label">计费金额（CNY）</div>
          <div class="metric-value">¥{{ (totals.billedCny || 0).toFixed(4) }}</div>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon metric-icon--red"><el-icon><WarningFilled /></el-icon></div>
        <div class="metric-body">
          <div class="metric-label">错误数</div>
          <div class="metric-value">{{ totals.errors || 0 }}</div>
        </div>
      </div>
    </div>

    <!-- Filters -->
    <el-card shadow="never" class="filter-card">
      <div class="filter-bar">
        <el-input v-model="filters.model" placeholder="模型" clearable style="width: 180px" />
        <el-input v-model="filters.customerId" placeholder="客户 ID" clearable style="width: 200px" />
        <el-input v-model="filters.tokenId" placeholder="令牌 ID" clearable style="width: 180px" />
        <el-select v-model="filters.status" placeholder="状态" clearable style="width: 130px">
          <el-option label="成功" value="ok" />
          <el-option label="错误" value="error" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          value-format="YYYY-MM-DDTHH:mm:ss"
          style="width: 360px"
        />
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <!-- Table -->
    <el-card shadow="never" class="table-card">
      <el-table :data="logs.items" stripe size="small" v-loading="billing.loading.value" empty-text="暂无日志">
        <el-table-column prop="ts" label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.ts) }}</template>
        </el-table-column>
        <el-table-column prop="customerName" label="客户" min-width="120">
          <template #default="{ row }">{{ row.customerName || '—' }}</template>
        </el-table-column>
        <el-table-column prop="model" label="模型" min-width="160" show-overflow-tooltip />
        <el-table-column prop="group" label="分组" width="100" />
        <el-table-column label="输入" width="90" align="right">
          <template #default="{ row }">{{ row.inputTokens }}</template>
        </el-table-column>
        <el-table-column label="输出" width="90" align="right">
          <template #default="{ row }">{{ row.outputTokens }}</template>
        </el-table-column>
        <el-table-column label="计费" width="110" align="right">
          <template #default="{ row }">¥{{ Number(row.billedCny || 0).toFixed(5) }}</template>
        </el-table-column>
        <el-table-column label="计量" width="90" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.estimated" size="small" type="warning">估算</el-tag>
            <el-tag v-else size="small" type="success">实际</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'ok' ? 'success' : 'danger'">
              {{ row.status === 'ok' ? row.httpStatus : (row.httpStatus || 'err') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="延迟" width="90" align="right">
          <template #default="{ row }">{{ row.latencyMs }}ms</template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          layout="total, prev, pager, next, sizes"
          :total="logs.total"
          :page-size="pageSize"
          :current-page="currentPage"
          :page-sizes="[20, 50, 100, 200]"
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Refresh, Histogram, Coin, Money, WarningFilled,
} from '@element-plus/icons-vue'
import { useGatewayBilling } from '@/composables/useGatewayBilling'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const billing = useGatewayBilling()
const logs = billing.logs
const summary = billing.summary

const filters = reactive({ model: '', customerId: '', tokenId: '', status: '' })
const dateRange = ref(null)
const pageSize = ref(50)
const currentPage = ref(1)

const totals = computed(() => summary.value?.totals || {})

function buildParams() {
  const params = {
    limit: pageSize.value,
    offset: (currentPage.value - 1) * pageSize.value,
  }
  if (filters.model) params.model = filters.model
  if (filters.customerId) params.customerId = filters.customerId
  if (filters.tokenId) params.tokenId = filters.tokenId
  if (filters.status) params.status = filters.status
  if (Array.isArray(dateRange.value) && dateRange.value.length === 2) {
    params.from = dateRange.value[0]
    params.to = dateRange.value[1]
  }
  return params
}

async function load() {
  const params = buildParams()
  await Promise.all([
    billing.fetchLogs(params),
    billing.fetchSummary({ groupBy: 'model', from: params.from, to: params.to }),
  ])
}

function applyFilters() {
  currentPage.value = 1
  load()
}

function resetFilters() {
  filters.model = ''
  filters.customerId = ''
  filters.tokenId = ''
  filters.status = ''
  dateRange.value = null
  currentPage.value = 1
  load()
}

function refresh() { load() }

function onPageChange(page) {
  currentPage.value = page
  load()
}

function onSizeChange(size) {
  pageSize.value = size
  currentPage.value = 1
  load()
}

function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }) } catch { return ts }
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN')
}

onMounted(load)
</script>

<style scoped>
.usage-logs-page {
  padding: 4px;
  max-width: 1320px;
  margin: 0 auto;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 16px;
}

.metric-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border-radius: var(--khy-radius, 12px);
  background: var(--khy-bg-elevated);
  border: 1px solid var(--khy-border);
}

.metric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 11px;
  font-size: 20px;
  color: #fff;
  flex-shrink: 0;
}

.metric-icon--blue { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.metric-icon--green { background: linear-gradient(135deg, #10b981, #059669); }
.metric-icon--orange { background: linear-gradient(135deg, #f59e0b, #d97706); }
.metric-icon--red { background: linear-gradient(135deg, #ef4444, #dc2626); }

.metric-label {
  font-size: 12px;
  color: var(--khy-text-muted);
}

.metric-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--khy-text-strong);
  line-height: 1.2;
}

.filter-card {
  margin-bottom: 14px;
  border: 1px solid var(--khy-border);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.table-card {
  border: 1px solid var(--khy-border);
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

@media (max-width: 1024px) {
  .metric-row { grid-template-columns: repeat(2, 1fr); }
}
</style>
