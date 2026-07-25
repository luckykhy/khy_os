<template>
  <div class="account-pool-page">
    <KhyPageHeader title="账号池管理" subtitle="多账号轮转、冷却与熔断状态监控" />

    <!-- Overview -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="6">
        <div class="pool-stat pool-stat--blue">
          <div class="pool-stat-label">账号总数</div>
          <div class="pool-stat-value">{{ accounts.length }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="pool-stat pool-stat--green">
          <div class="pool-stat-label">可用中</div>
          <div class="pool-stat-value">{{ activeCount }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="pool-stat pool-stat--amber">
          <div class="pool-stat-label">冷却中</div>
          <div class="pool-stat-value">{{ cooldownCount }}</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="pool-stat pool-stat--rose">
          <div class="pool-stat-label">熔断中</div>
          <div class="pool-stat-value">{{ circuitCount }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- Credential Watcher -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>凭证监听器</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <el-tag :type="pool.watcher.value?.running ? 'success' : 'info'" size="small" effect="dark">
              {{ pool.watcher.value?.running ? '运行中' : '已停止' }}
            </el-tag>
            <el-button v-if="!pool.watcher.value?.running" size="small" type="success" :loading="watcherLoading" @click="handleStartWatcher">开启监听</el-button>
            <el-button v-else size="small" type="danger" :loading="watcherLoading" @click="handleStopWatcher">关闭监听</el-button>
            <el-button size="small" :loading="scanLoading" @click="handleScan">手动扫描</el-button>
          </div>
        </div>
      </template>
      <div class="watcher-body">
        <el-row :gutter="12" style="margin-bottom: 12px;">
          <el-col :span="6">
            <div class="watcher-mini-stat">
              <span class="watcher-mini-label">监听文件</span>
              <span class="watcher-mini-value">{{ pool.watcher.value?.watcherCount || 0 }}</span>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="watcher-mini-stat">
              <span class="watcher-mini-label">扫描次数</span>
              <span class="watcher-mini-value">{{ pool.watcher.value?.stats?.scans || 0 }}</span>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="watcher-mini-stat">
              <span class="watcher-mini-label">检测到凭证</span>
              <span class="watcher-mini-value">{{ pool.watcher.value?.stats?.detections || 0 }}</span>
            </div>
          </el-col>
          <el-col :span="6">
            <div class="watcher-mini-stat">
              <span class="watcher-mini-label">错误</span>
              <span class="watcher-mini-value">{{ pool.watcher.value?.stats?.errors || 0 }}</span>
            </div>
          </el-col>
        </el-row>
        <el-collapse v-if="watcherEvents.length">
          <el-collapse-item title="最近事件" name="events">
            <div class="watcher-events">
              <div v-for="(ev, i) in watcherEvents" :key="i" class="watcher-event-row">
                <el-tag :type="eventTagType(ev.action)" size="small" style="min-width: 110px; text-align: center;">{{ ev.action }}</el-tag>
                <span class="watcher-event-provider">{{ ev.provider }}</span>
                <span class="watcher-event-detail">{{ ev.detail }}</span>
                <span class="watcher-event-time">{{ formatEventTime(ev.ts) }}</span>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-card>

    <!-- Scheduling Config -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>调度模式</span>
          <el-button size="small" @click="saveScheduling" :loading="savingScheduling">保存</el-button>
        </div>
      </template>
      <el-radio-group v-model="localScheduling.schedulingMode" style="margin-bottom: 12px;">
        <el-radio-button value="PerformanceFirst">性能优先</el-radio-button>
        <el-radio-button value="Balance">均衡模式</el-radio-button>
        <el-radio-button value="CacheFirst">缓存优先</el-radio-button>
      </el-radio-group>
      <div v-if="localScheduling.schedulingMode === 'CacheFirst'" style="margin-top: 8px;">
        <span style="font-size: 13px; margin-right: 8px;">最大等待时间（秒）：</span>
        <el-input-number v-model="localScheduling.maxWaitSeconds" :min="5" :max="300" :step="5" size="small" />
      </div>
    </el-card>

    <!-- Accounts Table -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>账号列表</span>
          <el-button size="small" type="primary" @click="openAddDialog">新增账号</el-button>
        </div>
      </template>

      <!-- Bulk management toolbar -->
      <div class="bulk-toolbar">
        <el-select
          v-model="filterProvider"
          placeholder="按供应商筛选"
          clearable
          size="small"
          style="width: 180px;"
        >
          <el-option v-for="p in presentProviders" :key="p" :label="p" :value="p" />
        </el-select>
        <span class="bulk-count">已选 {{ selectedIds.length }} / {{ filteredAccounts.length }}</span>
        <el-button
          size="small"
          type="danger"
          plain
          :disabled="selectedIds.length === 0"
          :loading="bulkLoading"
          @click="handleBatchDelete"
        >删除选中</el-button>
        <el-button
          size="small"
          type="danger"
          :disabled="filteredAccounts.length === 0"
          :loading="bulkLoading"
          @click="handleClearAll"
        >{{ filterProvider ? `清空「${filterProvider}」` : '清空全部' }}</el-button>
      </div>

      <el-table
        ref="tableRef"
        :data="pagedAccounts"
        stripe
        size="small"
        v-loading="pool.loading.value"
        row-key="id"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" reserve-selection />
        <el-table-column prop="id" label="ID" width="50" />
        <el-table-column prop="provider" label="供应商" width="100" />
        <el-table-column prop="email" label="账号" width="180">
          <template #default="{ row }">
            <span>{{ row.email || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="label" label="标签" width="120" />
        <el-table-column label="等级" width="80">
          <template #default="{ row }">
            <el-tag :type="tierType(row.tier)" size="small">{{ tierLabel(row.tier) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-button v-if="row.disabled || row.status === 'disabled'" size="small" link type="success" @click="pool.enableAccount(row.id)">启用</el-button>
            <el-button v-else size="small" link type="warning" @click="pool.disableAccount(row.id)">禁用</el-button>
            <el-button size="small" link type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <KhyEmpty
        v-if="!filteredAccounts.length"
        compact
        :icon="Coin"
        title="账号池还是空的"
        description="导入或登录一个账号后，它会出现在这里，供网关统一调度与负载均衡。"
      />
      <div v-if="filteredAccounts.length > pageSize" class="table-pager">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="filteredAccounts.length"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          size="small"
          background
        />
      </div>
    </el-card>

    <!-- Circuit Breaker Config -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>熔断器</span>
          <el-switch v-model="localCB.enabled" @change="saveCB" />
        </div>
      </template>
      <div v-if="localCB.enabled">
        <span style="font-size: 13px;">退避阶梯（秒）：</span>
        <el-input v-model="cbStepsStr" size="small" style="width: 300px;" placeholder="例如：60, 300, 1800, 7200" @blur="saveCB" />
      </div>
    </el-card>

    <!-- Add/Edit Dialog -->
    <el-dialog v-model="dialog.visible" :title="dialog.title" width="500px">
      <el-form :model="dialog.form" label-width="100px">
        <el-form-item label="供应商">
          <el-select v-model="dialog.form.provider" placeholder="请选择供应商">
            <el-option v-for="p in providers" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="dialog.form.apiKey" type="password" show-password placeholder="访问令牌 access token（可选）" />
        </el-form-item>
        <el-form-item label="Refresh Token">
          <el-input v-model="dialog.form.refreshToken" type="password" show-password placeholder="刷新令牌（可选）" />
        </el-form-item>
        <el-form-item label="账号/邮箱">
          <el-input v-model="dialog.form.email" placeholder="例如 user@example.com（可选）" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="dialog.form.password" type="password" show-password placeholder="可选（仅用于本地记录/切换）" />
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="dialog.form.endpoint" placeholder="https://api.example.com/v1（可选）" />
        </el-form-item>
        <el-form-item label="等级">
          <el-radio-group v-model="dialog.form.tier">
            <el-radio value="FREE">FREE</el-radio>
            <el-radio value="PRO">PRO</el-radio>
            <el-radio value="ULTRA">ULTRA</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="dialog.form.label" placeholder="例如：主账号（可选）" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="dialog.form.priority" :min="0" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" @click="handleSave" :loading="dialog.saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, onActivated, computed, reactive, ref, watch } from 'vue'
import { Coin } from '@element-plus/icons-vue'
import { useAccountPool } from '@/composables/useAccountPool'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'
import { ElMessage, ElMessageBox } from 'element-plus'

defineOptions({ name: 'AccountPool' })

const pool = useAccountPool()
const providers = ['deepseek', 'openai', 'anthropic', 'alibaba', 'dashscope', 'qwen', 'huggingface', 'glm', 'doubao', 'wenxin', 'relay', 'trae', 'warp', 'cursor', 'kiro', 'windsurf', 'claude', 'codex', 'api', 'ollama']

const accounts = computed(() => pool.accounts.value || [])
const activeCount = computed(() => accounts.value.filter(a => (a.status === 'active' || a.status === 'available') && !a.disabled).length)
const cooldownCount = computed(() => accounts.value.filter(a => a.status === 'cooldown').length)
const circuitCount = computed(() => accounts.value.filter(a => a.status === 'circuit_open').length)

// ── Bulk management (selection + provider filter + batch delete) ──
const tableRef = ref(null)
const filterProvider = ref('')
const selectedRows = ref([])
const bulkLoading = ref(false)

// Providers actually present in the pool, for the filter dropdown.
const presentProviders = computed(() => {
  const set = new Set(accounts.value.map(a => a.provider).filter(Boolean))
  return [...set].sort()
})

const filteredAccounts = computed(() => {
  if (!filterProvider.value) return accounts.value
  return accounts.value.filter(a => a.provider === filterProvider.value)
})

// ── Client-side pagination (data is already fully loaded; slice only) ──
// row-key="id" + reserve-selection keeps bulk selection intact across pages.
const currentPage = ref(1)
const pageSize = ref(50)
const pagedAccounts = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredAccounts.value.slice(start, start + pageSize.value)
})
// Reset to first page whenever the filter or the underlying total shrinks past
// the current page, so we never strand the user on an empty page.
watch(filterProvider, () => { currentPage.value = 1 })
watch(() => filteredAccounts.value.length, (len) => {
  const maxPage = Math.max(1, Math.ceil(len / pageSize.value))
  if (currentPage.value > maxPage) currentPage.value = maxPage
})

const selectedIds = computed(() => selectedRows.value.map(r => r.id))

function handleSelectionChange(rows) {
  selectedRows.value = rows
}

async function handleBatchDelete() {
  const ids = selectedIds.value
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(`确认删除选中的 ${ids.length} 个账号吗？此操作不可恢复。`, '批量删除', { type: 'warning' })
  } catch { return }
  bulkLoading.value = true
  try {
    const result = await pool.batchRemoveAccounts(ids)
    tableRef.value?.clearSelection()
    selectedRows.value = []
    ElMessage.success(`已删除 ${result?.removed ?? ids.length} 个账号`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { bulkLoading.value = false }
}

async function handleClearAll() {
  const scope = filterProvider.value
  const label = scope ? `供应商「${scope}」的全部账号` : '全部账号'
  try {
    await ElMessageBox.confirm(`确认清空${label}吗？此操作不可恢复。`, '清空账号池', {
      type: 'warning',
      confirmButtonText: '确认清空',
      confirmButtonClass: 'el-button--danger',
    })
  } catch { return }
  bulkLoading.value = true
  try {
    const result = await pool.removeAllAccounts(scope)
    tableRef.value?.clearSelection()
    selectedRows.value = []
    ElMessage.success(`已清空 ${result?.removed ?? 0} 个账号`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { bulkLoading.value = false }
}

// Credential Watcher
const watcherLoading = ref(false)
const scanLoading = ref(false)
const watcherEvents = computed(() => (pool.watcher.value?.recentEvents || []).slice().reverse())

async function handleStartWatcher() {
  watcherLoading.value = true
  try {
    await pool.startWatcher()
    ElMessage.success('凭证监听已开启')
  } catch (err) { ElMessage.error(err.response?.data?.error || '启动失败') }
  finally { watcherLoading.value = false }
}

async function handleStopWatcher() {
  watcherLoading.value = true
  try {
    await pool.stopWatcher()
    ElMessage.success('凭证监听已关闭')
  } catch (err) { ElMessage.error(err.response?.data?.error || '停止失败') }
  finally { watcherLoading.value = false }
}

async function handleScan() {
  scanLoading.value = true
  try {
    const result = await pool.triggerWatcherScan()
    const total = Object.values(result?.results || {}).filter(r => r.changed).length
    ElMessage.success(total > 0 ? `扫描完成，发现 ${total} 个变更` : '扫描完成，无新凭证')
  } catch (err) { ElMessage.error(err.response?.data?.error || '扫描失败') }
  finally { scanLoading.value = false }
}

function eventTagType(action) {
  if (action === 'credential_detected') return 'success'
  if (action.includes('error') || action.includes('failed')) return 'danger'
  if (action.includes('started') || action === 'started') return 'primary'
  if (action === 'stopped') return 'info'
  return 'warning'
}

function formatEventTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// Scheduling
const localScheduling = reactive({ schedulingMode: 'PerformanceFirst', maxWaitSeconds: 30 })
const savingScheduling = ref(false)

watch(() => pool.scheduling.value, (val) => {
  if (val) Object.assign(localScheduling, val)
}, { immediate: true })

async function saveScheduling() {
  savingScheduling.value = true
  try {
    await pool.updateScheduling(localScheduling)
    ElMessage.success('调度配置已保存')
  } catch { ElMessage.error('保存失败') }
  finally { savingScheduling.value = false }
}

// Circuit Breaker
const localCB = reactive({ enabled: true, backoffSteps: [60, 300, 1800, 7200] })
const cbStepsStr = ref('60, 300, 1800, 7200')

watch(() => pool.circuitBreaker.value, (val) => {
  if (val) {
    localCB.enabled = val.enabled !== false
    localCB.backoffSteps = val.backoffSteps || [60, 300, 1800, 7200]
    cbStepsStr.value = localCB.backoffSteps.join(', ')
  }
}, { immediate: true })

async function saveCB() {
  const steps = cbStepsStr.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
  try {
    await pool.updateCircuitBreaker({ enabled: localCB.enabled, backoffSteps: steps })
    ElMessage.success('熔断器配置已保存')
  } catch { ElMessage.error('保存失败') }
}

// Add/Edit dialog
const dialog = reactive({
  visible: false,
  title: '新增账号',
  saving: false,
  form: { provider: '', apiKey: '', refreshToken: '', email: '', password: '', endpoint: '', tier: 'FREE', label: '', priority: 0 },
})

function openAddDialog() {
  dialog.title = '新增账号'
  dialog.form = { provider: '', apiKey: '', refreshToken: '', email: '', password: '', endpoint: '', tier: 'FREE', label: '', priority: 0 }
  dialog.saving = false
  dialog.visible = true
}

async function handleSave() {
  if (!dialog.form.provider) {
    ElMessage.warning('供应商必填')
    return
  }
  if (!dialog.form.apiKey && !dialog.form.refreshToken && !dialog.form.email) {
    ElMessage.warning('请至少填写 access token、refresh token 或账号/邮箱中的一个')
    return
  }
  dialog.saving = true
  try {
    await pool.addAccount({
      ...dialog.form,
      accessToken: dialog.form.apiKey,
      refreshToken: dialog.form.refreshToken,
      email: dialog.form.email,
      password: dialog.form.password,
    })
    ElMessage.success('账号已添加')
    dialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { dialog.saving = false }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.provider} 账号「${row.label || row.id}」吗？`, '确认删除', { type: 'warning' })
    await pool.removeAccount(row.id)
    ElMessage.success('账号已删除')
  } catch { /* cancelled */ }
}

function tierLabel(tier) {
  if (tier === 'ULTRA') return '旗舰'
  if (tier === 'PRO') return '专业'
  if (tier === 'FREE') return '免费'
  return tier || '-'
}

function statusLabel(status) {
  const map = {
    active: '活跃', available: '可用', cooldown: '冷却中',
    circuit_open: '熔断中', disabled: '已禁用',
    banned: '已封禁', invalid: '无效', exhausted: '已耗尽',
  }
  return map[status] || status || '-'
}

function tierType(tier) {
  if (tier === 'ULTRA') return 'warning'
  if (tier === 'PRO') return 'primary'
  return 'info'
}

function statusType(status) {
  const map = {
    active: 'success', available: 'success', cooldown: 'warning',
    circuit_open: 'danger', disabled: 'info',
    banned: 'danger', invalid: 'danger', exhausted: 'warning',
  }
  return map[status] || 'info'
}

onMounted(() => pool.fetchAll())

// keep-alive 重访刷新：跳过首挂避免双取。
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  pool.fetchAll()
})
</script>

<style scoped>
.account-pool-page {
  max-width: 1200px;
  margin: 0 auto;
}

.table-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.stats-row {
  margin-bottom: 16px;
}

.pool-stat {
  padding: 16px 18px;
  border: 1px solid var(--khy-border-light);
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff, #f8fbff);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.04);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.pool-stat:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
}

.pool-stat--blue  { border-left: 3px solid #3b82f6; }
.pool-stat--green { border-left: 3px solid #10b981; }
.pool-stat--amber { border-left: 3px solid #f59e0b; }
.pool-stat--rose  { border-left: 3px solid #f43f5e; }

.pool-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.pool-stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.section-card {
  margin-bottom: 16px;
}
.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.bulk-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.bulk-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-right: auto;
}

.watcher-body {
  font-size: 13px;
}
.watcher-mini-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
}
.watcher-mini-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}
.watcher-mini-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.watcher-events {
  max-height: 240px;
  overflow-y: auto;
}
.watcher-event-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.watcher-event-row:last-child { border-bottom: none; }
.watcher-event-provider {
  font-weight: 600;
  min-width: 60px;
}
.watcher-event-detail {
  flex: 1;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.watcher-event-time {
  color: var(--el-text-color-placeholder);
  min-width: 60px;
  text-align: right;
}
</style>
