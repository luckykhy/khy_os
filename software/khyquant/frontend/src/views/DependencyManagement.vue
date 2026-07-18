<template>
  <div class="dependency-page">
    <el-alert
      type="info"
      show-icon
      :closable="false"
      style="margin-bottom: 20px"
    >
      <template #title>
        统一管理运行时/工具链与应用依赖。低风险依赖可一键安装；系统级或需管理员授权的依赖仅提供命令，请手动执行。
      </template>
    </el-alert>

    <!-- ========================= 运行时与工具链 ========================= -->
    <el-card shadow="never" style="margin-bottom: 24px">
      <template #header>
        <div class="card-header">
          <span class="card-title">运行时与工具链</span>
          <el-button size="small" :loading="loading" @click="fetchInventory">刷新</el-button>
        </div>
      </template>

      <el-table :data="runtime" v-loading="loading" size="small" stripe>
        <el-table-column prop="label" label="名称" min-width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.present" type="success" size="small">已安装</el-tag>
            <el-tag v-else type="info" size="small">未安装</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="140">
          <template #default="{ row }">
            <span v-if="row.version">{{ row.version }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="path" label="路径" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.path">{{ row.path }}</span>
            <span v-else class="muted">不在 PATH</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="260">
          <template #default="{ row }">
            <template v-if="!row.present && row.installHint">
              <code class="cmd">{{ row.installHint }}</code>
              <el-button size="small" text type="primary" @click="copyCmd(row.installHint)">复制命令</el-button>
            </template>
            <el-link v-if="row.docsUrl" :href="row.docsUrl" target="_blank" type="primary" :underline="false" style="margin-left: 8px">文档</el-link>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- ========================= 应用依赖 ========================= -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-title">应用依赖</span>
        </div>
      </template>

      <el-table :data="packages" v-loading="loading" size="small" stripe>
        <el-table-column prop="label" label="名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.present" type="success" size="small">已安装</el-tag>
            <el-tag v-else type="info" size="small">未安装</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="作用域" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.scope === 'global'" type="warning" size="small" effect="plain">系统级</el-tag>
            <el-tag v-else size="small" effect="plain">项目级</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="风险" width="90">
          <template #default="{ row }">
            <el-tag :type="riskTagType(row.risk)" size="small" effect="plain">{{ riskLabel(row.risk) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="300">
          <template #default="{ row }">
            <el-button
              v-if="row.installable"
              size="small"
              type="primary"
              :loading="installing === row.id"
              :disabled="row.present"
              @click="confirmInstall(row)"
            >
              {{ row.present ? '已安装' : '下载安装' }}
            </el-button>
            <template v-else-if="row.installHint">
              <code class="cmd">{{ row.installHint }}</code>
              <el-button size="small" text type="primary" @click="copyCmd(row.installHint)">复制命令</el-button>
            </template>
            <el-link v-if="row.docsUrl" :href="row.docsUrl" target="_blank" type="primary" :underline="false" style="margin-left: 8px">文档</el-link>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 安装日志 -->
    <el-dialog v-model="logVisible" title="安装日志" width="640px">
      <pre class="log-block">{{ logText }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dependenciesAPI } from '@/api/dependencies'

const loading = ref(false)
const installing = ref(null)
const runtime = ref([])
const packages = ref([])
const logVisible = ref(false)
const logText = ref('')

function riskTagType(risk) {
  if (risk === 'high') return 'danger'
  if (risk === 'medium') return 'warning'
  return 'success'
}
function riskLabel(risk) {
  if (risk === 'high') return '高'
  if (risk === 'medium') return '中'
  if (risk === 'low') return '低'
  return '—'
}

async function fetchInventory() {
  loading.value = true
  try {
    const res = await dependenciesAPI.getInventory()
    if (res && res.success && res.data) {
      runtime.value = res.data.runtime || []
      packages.value = res.data.packages || []
    } else {
      ElMessage.error((res && res.error) || '获取依赖清单失败')
    }
  } catch (err) {
    ElMessage.error(err.message || '获取依赖清单失败')
  } finally {
    loading.value = false
  }
}

async function copyCmd(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('命令已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择命令')
  }
}

async function confirmInstall(row) {
  try {
    await ElMessageBox.confirm(
      `将执行安装：${row.displayCommand || row.label}`,
      `安装 ${row.label}`,
      { confirmButtonText: '安装', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  installing.value = row.id
  try {
    const res = await dependenciesAPI.install(row.id)
    if (res && res.success) {
      ElMessage.success(`${row.label} 安装成功`)
      logText.value = formatSteps(res.steps)
      if (logText.value) logVisible.value = true
      fetchInventory()
    } else if (res && res.manualOnly) {
      ElMessageBox.alert(
        `该依赖需手动安装：\n${res.displayCommand}`,
        '需要手动安装',
        { confirmButtonText: '复制命令' }
      ).then(() => copyCmd(res.displayCommand)).catch(() => {})
    } else {
      logText.value = formatSteps(res && res.steps) || (res && res.error) || ''
      if (logText.value) logVisible.value = true
      ElMessage.error((res && (res.error || res.hint)) || `${row.label} 安装失败`)
    }
  } catch (err) {
    ElMessage.error(err.message || '安装失败')
  } finally {
    installing.value = null
  }
}

function formatSteps(steps) {
  if (!Array.isArray(steps)) return ''
  return steps.map((s) => {
    const head = `$ ${Array.isArray(s.command) ? s.command.join(' ') : s.command}  (exit ${s.code})`
    const out = [s.stdout, s.stderr].filter(Boolean).join('\n')
    return out ? `${head}\n${out}` : head
  }).join('\n\n')
}

onMounted(fetchInventory)
</script>

<style scoped>
.dependency-page {
  padding: 4px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-title {
  font-weight: 600;
  font-size: 15px;
}
.muted {
  color: var(--el-text-color-placeholder);
}
.cmd {
  font-family: monospace;
  font-size: 12px;
  background: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
}
.log-block {
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 50vh;
  overflow: auto;
  background: var(--el-fill-color-light);
  padding: 12px;
  border-radius: 6px;
}
</style>
