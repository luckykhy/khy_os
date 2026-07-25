<template>
  <div class="agent-dashboard">
    <KhyPageHeader title="Agent 监控">
      <template #actions>
        <el-switch
          v-model="autoRefresh"
          inline-prompt
          active-text="自动"
          inactive-text="手动"
          @change="toggleAutoRefresh"
        />
        <el-button size="small" type="primary" :loading="loading" @click="manualRefresh">
          刷新
        </el-button>
      </template>
    </KhyPageHeader>

    <!-- 连接降级提示:轮询连续失败后自动暂停,给一条非侵入的横幅 + 手动重试入口,
         而不是每 5 秒弹一次 toast 刷屏。 -->
    <el-alert
      v-if="degraded"
      class="degraded-banner"
      type="warning"
      show-icon
      :closable="false"
      title="暂时连不上 Agent 监控服务"
    >
      <template #default>
        <span>已自动暂停刷新以避免持续报错。后端恢复后点「重试」即可继续。</span>
        <el-button size="small" type="warning" plain class="degraded-retry" @click="manualRefresh">
          重试
        </el-button>
      </template>
    </el-alert>

    <!-- Stats summary -->
    <el-row :gutter="12" class="stats-row">
      <el-col :xs="12" :sm="6" v-for="s in statCards" :key="s.label">
        <el-card shadow="never" class="stat-card">
          <div class="stat-value" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Agent tree -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <span>Agent 层级</span>
        <el-tag v-if="dashboard.stats" size="small" type="info" style="margin-left:8px">
          最大深度：{{ dashboard.stats.maxDepth }}
        </el-tag>
      </template>

      <KhyEmpty
        v-if="!tree.length"
        compact
        :icon="Cpu"
        title="当前没有正在运行的 Agent"
        description="当你在对话中触发多智能体协作时，它们的层级会实时出现在这里。"
      />

      <el-tree
        v-else
        :data="tree"
        node-key="id"
        default-expand-all
        :props="{ children: 'children', label: 'id' }"
      >
        <template #default="{ data }">
          <div class="agent-node">
            <el-tag :type="statusTagType(data.status)" size="small" effect="dark">
              {{ data.status }}
            </el-tag>
            <span class="agent-id">{{ data.id }}</span>
            <el-tag size="small" type="info">{{ data.role }}</el-tag>
            <span class="agent-time" v-if="data.runningMs">
              {{ formatMs(data.runningMs) }}
            </span>
            <el-badge
              v-if="data.mailboxSize > 0"
              :value="data.mailboxSize"
              type="warning"
              class="agent-badge"
            />
          </div>
        </template>
      </el-tree>
    </el-card>

    <!-- Flat agent table -->
    <el-card class="section-card" shadow="hover">
      <template #header><span>全部 Agent</span></template>
      <el-table :data="agents" stripe size="small" empty-text="暂无 Agent 记录">
        <el-table-column prop="id" label="ID" width="180" show-overflow-tooltip />
        <el-table-column prop="role" label="角色" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.role }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="depth" label="深度" width="70" align="center" />
        <el-table-column label="耗时" width="100">
          <template #default="{ row }">{{ formatMs(row.runningMs) }}</template>
        </el-table-column>
        <el-table-column prop="parentId" label="父节点" width="180" show-overflow-tooltip />
        <el-table-column prop="mailboxSize" label="信箱" width="80" align="center" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Cpu } from '@element-plus/icons-vue'
import request from '@/api/request'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const loading = ref(false)
const autoRefresh = ref(true)
const degraded = ref(false)
const dashboard = ref({ agents: [], tree: [], stats: {} })

// 轮询退避:正常 5s 一次;连续失败按指数退避(封顶 60s),连续失败达上限后
// 停摆并亮出降级横幅,等待用户手动重试。避免后端不可用时的固定高频空转。
const BASE_INTERVAL = 5000
const MAX_INTERVAL = 60000
const MAX_FAILURES = 3
let timer = null
let failures = 0

const agents = computed(() => dashboard.value.agents || [])
const tree = computed(() => dashboard.value.tree || [])

const statCards = computed(() => {
  const s = dashboard.value.stats || {}
  return [
    { label: '总计', value: s.total || 0, color: 'var(--khy-primary)' },
    { label: '运行中', value: s.running || 0, color: 'var(--khy-warning)' },
    { label: '已完成', value: s.completed || 0, color: 'var(--khy-success)' },
    { label: '失败', value: s.failed || 0, color: 'var(--khy-danger)' },
  ]
})

function statusTagType(status) {
  const map = { running: 'warning', completed: 'success', failed: 'danger', idle: 'info' }
  return map[status] || 'info'
}

function formatMs(ms) {
  if (!ms || ms <= 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null }
}

// 退避轮询下一拍:成功恢复基准间隔,失败按 2^n 增长封顶 60s。
function scheduleNext() {
  if (!autoRefresh.value || degraded.value) return
  const delay = failures > 0
    ? Math.min(BASE_INTERVAL * 2 ** failures, MAX_INTERVAL)
    : BASE_INTERVAL
  clearTimer()
  timer = setTimeout(fetchDashboard, delay)
}

async function fetchDashboard() {
  loading.value = true
  try {
    // silent:轮询自带降级横幅,不需要全局拦截器再弹 toast。
    const res = await request.get('/api/ai-gateway-admin/agents/dashboard', { silent: true })
    const data = res?.data?.data || res?.data || res
    if (data && typeof data === 'object') {
      dashboard.value = data
    }
    failures = 0
    degraded.value = false
  } catch {
    failures += 1
    if (failures >= MAX_FAILURES) {
      degraded.value = true
      clearTimer()
    }
  } finally {
    loading.value = false
    scheduleNext()
  }
}

// 手动刷新 / 重试:清零退避状态并立即拉取,失败计数归零后自动恢复轮询。
function manualRefresh() {
  failures = 0
  degraded.value = false
  clearTimer()
  fetchDashboard()
}

function toggleAutoRefresh(val) {
  if (val) {
    failures = 0
    degraded.value = false
    fetchDashboard()
  } else {
    clearTimer()
  }
}

onMounted(() => {
  fetchDashboard()
})

onUnmounted(() => {
  clearTimer()
})
</script>

<style scoped>
.agent-dashboard {
  padding: 16px;
}
.stats-row {
  margin-bottom: 16px;
}
.degraded-banner {
  margin-bottom: 16px;
}
.degraded-retry {
  margin-left: 12px;
}
.stat-card {
  text-align: center;
  padding: 8px 0;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-label {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
.section-card {
  margin-bottom: 16px;
}
.agent-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.agent-id {
  font-family: var(--khy-font-mono, monospace);
  font-size: 13px;
}
.agent-time {
  font-size: 12px;
  color: #909399;
}
</style>
