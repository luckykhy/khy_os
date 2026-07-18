<!--
  Settings.vue — Unified 6-Tab settings page (cc-switch SettingsPage inspired).

  Aggregates KHY's already-scattered settings entries into one tabbed surface:
    General  — appearance (theme) + sidebar/layout preferences
    Proxy    — TLS sidecar / outbound proxy status and controls
    Auth     — OAuth providers status + token refresh
    Advanced — local preference reset + quick links to gateway/pricing config
    Usage    — billing summary totals (read-only snapshot)
    About    — app version, runtime adapter status, links

  Zero-hardcoding: every value is fetched at runtime from existing composables /
  endpoints (useTheme, useGateway, useGatewayBilling). No new backend route is
  introduced; this view only re-composes existing admin data into one place.
  State transparency: each tab shows the live "current" snapshot it acts on.
-->
<template>
  <div class="settings-page">
    <KhyPageHeader title="统一设置" subtitle="外观、代理、鉴权、用量与系统信息集中管理">
      <template #actions>
        <el-button :loading="loading" @click="reloadAll">
          <el-icon><Refresh /></el-icon>
          <span>刷新</span>
        </el-button>
      </template>
    </KhyPageHeader>

    <el-tabs v-model="activeTabProxy" class="settings-tabs" tab-position="left">
      <!-- ── General ── -->
      <el-tab-pane name="general">
        <template #label>
          <span class="tab-label"><el-icon><Setting /></el-icon> 通用</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header><span class="block-title">外观</span></template>
          <el-form label-width="120px">
            <el-form-item label="主题">
              <el-radio-group :model-value="theme" @change="setTheme">
                <el-radio-button label="light">
                  <el-icon><Sunny /></el-icon> 亮色
                </el-radio-button>
                <el-radio-button label="dark">
                  <el-icon><Moon /></el-icon> 暗色
                </el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="侧边栏">
              <el-switch
                :model-value="sidebarCollapsed"
                inline-prompt
                active-text="收起"
                inactive-text="展开"
                @change="setSidebarCollapsed"
              />
              <span class="form-hint">控制管理布局侧边栏的默认折叠状态（本地保存）。</span>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <!-- ── Proxy ── -->
      <el-tab-pane name="proxy">
        <template #label>
          <span class="tab-label"><el-icon><Connection /></el-icon> 代理</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header>
            <div class="block-head">
              <span class="block-title">TLS Sidecar / 出站代理</span>
              <el-tag :type="tls?.running ? 'success' : 'info'" effect="plain" size="small">
                {{ tls?.running ? '运行中' : '未运行' }}
              </el-tag>
            </div>
          </template>
          <el-descriptions :column="2" border size="small" class="meta-desc">
            <el-descriptions-item label="启用">{{ tls?.enabled ? '是' : '否' }}</el-descriptions-item>
            <el-descriptions-item label="端口">{{ tls?.port || '—' }}</el-descriptions-item>
            <el-descriptions-item label="指纹">{{ tls?.fingerprint || '默认' }}</el-descriptions-item>
            <el-descriptions-item label="PID">{{ tls?.pid || '—' }}</el-descriptions-item>
            <el-descriptions-item label="二进制已安装">{{ tls?.binaryInstalled ? '是' : '否' }}</el-descriptions-item>
            <el-descriptions-item label="Go 可用">{{ tls?.goAvailable ? '是' : '否' }}</el-descriptions-item>
            <el-descriptions-item label="目标域名" :span="2">
              <template v-if="tlsTargets.length">
                <el-tag v-for="t in tlsTargets" :key="t" size="small" class="target-tag">{{ t }}</el-tag>
              </template>
              <span v-else class="form-hint">未配置目标域名</span>
            </el-descriptions-item>
          </el-descriptions>
          <div class="block-actions">
            <el-button
              v-if="!tls?.running"
              type="primary"
              :loading="busy.tls"
              :disabled="!tls?.binaryInstalled"
              @click="handleStartTls"
            >启动 Sidecar</el-button>
            <el-button v-else type="danger" :loading="busy.tls" @click="handleStopTls">停止 Sidecar</el-button>
          </div>
          <el-alert
            v-if="!tls?.binaryInstalled"
            type="warning"
            :closable="false"
            show-icon
            title="Sidecar 二进制未安装"
            class="block-alert"
          >
            <!-- 「二进制去哪来」:tls-sidecar 是内置第一方 Go 程序,无第三方预编译上游。
                 后端 SSOT installer.describeSidecarDownload() 经 getStatus 透传 download 描述符;
                 门 KHY_PROXY_CORE_DOWNLOAD_HINT 关时后端返 null → 回退到旧通用文案。 -->
            <template v-if="tls?.download">
              <p class="dl-note">
                tls-sidecar 是内置的第一方 Go 程序,<b>没有第三方预编译下载</b>;两种落地方式(二选一):
              </p>
              <div class="dl-row">
                <span class="dl-label">① 安装 Go {{ tls.download.minGoVersion }}+:</span>
                <a :href="tls.download.goDownloadUrl" target="_blank" rel="noopener" class="dl-url">{{ tls.download.goDownloadUrl }}</a>
                <el-button size="small" text type="primary" @click="copyText(tls.download.goDownloadUrl, '已复制 Go 下载地址')">复制</el-button>
                <span class="dl-hint">装好后点「启动 Sidecar」会自动从内置源码编译。</span>
              </div>
              <div class="dl-row">
                <span class="dl-label">② 或放入已编译二进制:</span>
                <code class="dl-path">{{ tls.download.dest }}</code>
                <el-button size="small" text type="primary" @click="copyText(tls.download.dest, '已复制落地路径')">复制</el-button>
              </div>
            </template>
            <template v-else>
              需要本机具备 Go 工具链以编译 sidecar，或预置二进制后再启动。
            </template>
          </el-alert>
        </el-card>
      </el-tab-pane>

      <!-- ── Auth ── -->
      <el-tab-pane name="auth">
        <template #label>
          <span class="tab-label"><el-icon><Key /></el-icon> 鉴权</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header>
            <div class="block-head">
              <span class="block-title">OAuth 提供商</span>
              <el-button size="small" link type="primary" @click="$router.push('/accounts')">前往账号池</el-button>
            </div>
          </template>
          <el-table :data="oauthRows" stripe size="small" empty-text="暂无 OAuth 提供商">
            <el-table-column prop="label" label="提供商" min-width="160" />
            <el-table-column label="状态" width="120">
              <template #default="{ row }">
                <el-tag :type="row.connected ? 'success' : 'info'" effect="plain" size="small">
                  {{ row.connected ? '已连接' : '未连接' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="过期时间" min-width="180">
              <template #default="{ row }">{{ row.expiresLabel }}</template>
            </el-table-column>
            <el-table-column label="操作" width="120" align="center">
              <template #default="{ row }">
                <el-button
                  size="small" link type="primary"
                  :loading="busy.oauth === row.id"
                  :disabled="!row.connected"
                  @click="handleRefreshOAuth(row.id)"
                >刷新 Token</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ── Advanced ── -->
      <el-tab-pane name="advanced">
        <template #label>
          <span class="tab-label"><el-icon><Tools /></el-icon> 高级</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header><span class="block-title">配置入口</span></template>
          <div class="quick-links">
            <el-button @click="$router.push('/gateway')">
              <el-icon><Connection /></el-icon> 网关管理
            </el-button>
            <el-button @click="$router.push('/pricing')">
              <el-icon><PriceTag /></el-icon> 计费定价
            </el-button>
            <el-button @click="$router.push('/usage')">
              <el-icon><Tickets /></el-icon> 用量日志
            </el-button>
            <el-button @click="$router.push('/monitor')">
              <el-icon><Monitor /></el-icon> 监控中心
            </el-button>
          </div>
        </el-card>
        <el-card shadow="never" class="block-card">
          <template #header><span class="block-title">本地偏好</span></template>
          <p class="form-hint">清除浏览器本地保存的偏好（主题、侧边栏状态、设置标签页）。不影响服务端配置。</p>
          <div class="block-actions">
            <el-button type="warning" plain @click="resetLocalPrefs">重置本地偏好</el-button>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ── Usage ── -->
      <el-tab-pane name="usage">
        <template #label>
          <span class="tab-label"><el-icon><DataAnalysis /></el-icon> 用量</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header>
            <div class="block-head">
              <span class="block-title">用量汇总</span>
              <el-button size="small" link type="primary" @click="$router.push('/usage')">查看明细</el-button>
            </div>
          </template>
          <div class="stat-grid">
            <div class="stat-item">
              <span class="stat-label">请求数</span>
              <span class="stat-value">{{ usageTotals.requests }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">输入 Tokens</span>
              <span class="stat-value">{{ usageTotals.inputTokens }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">输出 Tokens</span>
              <span class="stat-value">{{ usageTotals.outputTokens }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">计费金额</span>
              <span class="stat-value">¥{{ usageTotals.billedCny }}</span>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ── About ── -->
      <el-tab-pane name="about">
        <template #label>
          <span class="tab-label"><el-icon><InfoFilled /></el-icon> 关于</span>
        </template>
        <el-card shadow="never" class="block-card">
          <template #header><span class="block-title">系统信息</span></template>
          <el-descriptions :column="2" border size="small" class="meta-desc">
            <el-descriptions-item label="应用">KHY AI 管理平台</el-descriptions-item>
            <el-descriptions-item label="前端版本">{{ appVersion }}</el-descriptions-item>
            <el-descriptions-item label="当前用户">{{ userStore.user?.username || '—' }}</el-descriptions-item>
            <el-descriptions-item label="角色">{{ userStore.isAdmin ? '管理员' : '普通用户' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
        <el-card shadow="never" class="block-card">
          <template #header><span class="block-title">网关适配器状态</span></template>
          <el-table :data="adapterRows" stripe size="small" empty-text="暂无适配器状态">
            <el-table-column prop="name" label="适配器" min-width="140" />
            <el-table-column label="可用" width="100">
              <template #default="{ row }">
                <el-tag :type="row.available ? 'success' : 'info'" effect="plain" size="small">
                  {{ row.available ? '可用' : '未配置' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="detail" label="详情" min-width="300" />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { computed, onMounted, onActivated, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Refresh, Setting, Connection, Key, Tools, DataAnalysis, InfoFilled,
  Sunny, Moon, PriceTag, Tickets, Monitor,
} from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { useTheme } from '@/composables/useTheme'
import { useGateway } from '@/composables/useGateway'
import { useGatewayBilling } from '@/composables/useGatewayBilling'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

defineOptions({ name: 'Settings' })

const TAB_STORAGE_KEY = 'khy_ai_settings_tab'
const THEME_STORAGE_KEY = 'khy_ai_theme'
const SIDEBAR_STORAGE_KEY = 'khy_ai_sidebar_collapsed'
const VALID_TABS = ['general', 'proxy', 'auth', 'advanced', 'usage', 'about']

const userStore = useUserStore()
const { theme, setTheme } = useTheme()
const gateway = useGateway()
const billing = useGatewayBilling()

const appVersion = import.meta.env.VITE_APP_VERSION || '1.6.5'

const loading = ref(false)
const busy = reactive({ tls: false, oauth: '' })

function readStoredTab() {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY)
    if (v && VALID_TABS.includes(v)) return v
  } catch { /* ignore */ }
  return 'general'
}

const activeTab = ref(readStoredTab())

// Persist the active tab so a refresh lands the user back where they were.
// el-tabs binds to this proxy; the setter mirrors the value into localStorage.
const activeTabProxy = computed({
  get: () => activeTab.value,
  set: (v) => {
    activeTab.value = v
    try { localStorage.setItem(TAB_STORAGE_KEY, v) } catch { /* ignore */ }
  },
})

const tls = computed(() => gateway.tls.value)
const tlsTargets = computed(() => {
  const t = gateway.tls.value?.targets
  if (Array.isArray(t)) return t
  if (t && typeof t === 'object') return Object.keys(t)
  return []
})

// ── Sidebar preference (mirrors Layout.vue local storage) ──
const sidebarCollapsed = ref(readSidebar())
function readSidebar() {
  try { return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1' } catch { return false }
}
function setSidebarCollapsed(val) {
  sidebarCollapsed.value = !!val
  try { localStorage.setItem(SIDEBAR_STORAGE_KEY, val ? '1' : '0') } catch { /* ignore */ }
  ElMessage.success('侧边栏偏好已保存')
}

// ── OAuth providers ──
const oauthRows = computed(() => {
  const providers = gateway.oauthProviders.value || []
  const status = gateway.oauth.value || {}
  return providers.map((p) => {
    const id = typeof p === 'string' ? p : (p.id || p.provider || p.name)
    const label = typeof p === 'string' ? p : (p.label || p.name || id)
    const st = status[id] || (typeof p === 'object' ? p : {}) || {}
    const connected = !!(st.connected ?? st.authenticated ?? st.hasCredentials)
    const expiresAt = st.expiresAt || st.expiry || st.expires_at
    return {
      id,
      label,
      connected,
      expiresLabel: formatExpiry(expiresAt, connected),
    }
  })
})

function formatExpiry(value, connected) {
  if (!connected) return '—'
  if (!value) return '长期有效'
  const ts = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ts)) return String(value)
  const d = new Date(ts)
  return d.toLocaleString()
}

// ── Usage totals ──
const usageTotals = computed(() => {
  const totals = billing.summary.value?.totals || {}
  return {
    requests: formatNumber(totals.requests ?? totals.count ?? 0),
    inputTokens: formatNumber(totals.inputTokens ?? totals.input ?? 0),
    outputTokens: formatNumber(totals.outputTokens ?? totals.output ?? 0),
    billedCny: formatNumber(totals.billedCny ?? totals.cost ?? 0, 2),
  }
})

function formatNumber(v, decimals = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals })
}

// ── Adapter status ──
const adapterRows = computed(() => {
  const s = gateway.status.value
  const adapters = s?.adapters || s?.providers || []
  if (Array.isArray(adapters)) {
    return adapters.map((a) => ({
      name: a.name || a.type || 'adapter',
      available: !!a.available,
      detail: a.detail || '',
    }))
  }
  if (adapters && typeof adapters === 'object') {
    return Object.entries(adapters).map(([name, a]) => ({
      name,
      available: !!a.available,
      detail: a.detail || '',
    }))
  }
  return []
})

// ── Actions ──
// Copy-to-clipboard helper for the sidecar "去哪下载" guidance (mirrors ProxyManagement).
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(String(text || ''))
    ElMessage.success(okMsg || '已复制')
  } catch {
    ElMessage.warning('复制失败,请手动选中文本复制')
  }
}

async function handleStartTls() {
  busy.tls = true
  try {
    await gateway.startTls()
    ElMessage.success('Sidecar 已启动')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { busy.tls = false }
}

async function handleStopTls() {
  busy.tls = true
  try {
    await gateway.stopTls()
    ElMessage.success('Sidecar 已停止')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { busy.tls = false }
}

async function handleRefreshOAuth(provider) {
  busy.oauth = provider
  try {
    await gateway.refreshOAuth(provider)
    ElMessage.success(`${provider} Token 已刷新`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally { busy.oauth = '' }
}

function resetLocalPrefs() {
  for (const key of [THEME_STORAGE_KEY, SIDEBAR_STORAGE_KEY, TAB_STORAGE_KEY]) {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
  ElMessage.success('本地偏好已重置，刷新页面后生效')
}

async function reloadAll() {
  loading.value = true
  try {
    await Promise.all([
      gateway.fetchStatus(),
      gateway.fetchTls(),
      gateway.fetchOAuth(),
      gateway.fetchOAuthProviders(),
      billing.fetchSummary(),
    ])
  } finally {
    loading.value = false
  }
}

onMounted(reloadAll)

// keep-alive 重访刷新：跳过首挂避免双取。
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  reloadAll()
})
</script>

<style scoped>
.settings-page {
  padding: 4px;
  max-width: 1100px;
  margin: 0 auto;
}
.settings-tabs {
  min-height: 420px;
}
.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.block-card {
  margin-bottom: 16px;
  border: 1px solid var(--khy-border);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.block-title {
  font-weight: 700;
  color: var(--khy-text-strong);
}
.block-actions {
  margin-top: 14px;
  display: flex;
  gap: 12px;
}
.block-alert {
  margin-top: 14px;
}
/* Sidecar "去哪下载" guidance block (rendered inside the not-installed alert). */
.dl-note {
  margin: 0 0 8px;
  font-size: 13px;
}
.dl-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  font-size: 13px;
}
.dl-label {
  font-weight: 600;
}
.dl-url {
  color: var(--el-color-primary);
  word-break: break-all;
}
.dl-path {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  word-break: break-all;
}
.dl-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.meta-desc {
  margin-top: 4px;
}
.target-tag {
  margin-right: 6px;
  margin-bottom: 4px;
}
.form-hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.quick-links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.stat-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--khy-border-light, var(--khy-border));
  border-radius: var(--khy-radius-sm, 8px);
  background: var(--khy-bg-soft, transparent);
}
.stat-label {
  font-size: 12px;
  color: var(--khy-text-muted);
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--khy-text-strong);
}
</style>
