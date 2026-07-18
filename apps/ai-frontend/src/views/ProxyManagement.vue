<template>
  <div class="proxy-page khy-page">
    <KhyPageHeader title="代理管理" subtitle="订阅、代理组与本地设置（仿 Clash Verge）">
      <template #actions>
        <el-button v-if="activeTabProxy === 'subs'" type="primary" :icon="Plus" @click="openImport">添加订阅</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="listGroups">刷新</el-button>
      </template>
    </KhyPageHeader>

    <!-- ── 出站状态条:全局启用/停用 + 当前激活节点 + 内核状态 ── -->
    <el-card shadow="never" class="egress-bar section-card">
      <div class="egress-row">
        <div class="egress-main">
          <el-switch
            :model-value="egressEnabled"
            :loading="busy"
            active-text="代理已启用"
            inactive-text="代理已停用"
            @change="onToggleEgress"
          />
          <span v-if="egressActiveNode" class="egress-node">
            当前节点:<strong>{{ egressActiveNode.name || '(未命名)' }}</strong>
            <el-tag size="small" class="egress-tag">{{ egressActiveNode.protocol || '—' }}</el-tag>
            <el-tag size="small" type="info" class="egress-tag">{{ egressModeLabel(egressActiveNode.egressMode) }}</el-tag>
          </span>
          <span v-else class="egress-none muted">未选择出站节点。到「代理组」页点某节点的「使用此节点」即可路由流量。</span>
        </div>
        <div class="egress-core">
          <el-tag :type="coreBinaryInstalled ? 'success' : 'warning'" size="small">
            内核{{ coreBinaryInstalled ? '已安装' : '未安装' }}
          </el-tag>
          <el-tag v-if="coreRunning" type="success" size="small">内核运行中</el-tag>
        </div>
      </div>
      <div v-if="!coreBinaryInstalled" class="egress-hint">
        <p>
          raw 协议节点(vmess/vless/trojan/ss)需本机 mihomo 内核承载。未安装时这些节点无法路由——
          直连型(http/https)节点无需内核即可使用。
        </p>
        <!-- 内核去哪下:确切官方固定 URL(来自后端 SSOT proxyCoreInstaller)+ 落地路径 + 一键复制。 -->
        <div v-if="coreDownload && coreDownload.supported" class="egress-dl">
          <div class="egress-dl-row">
            <span class="egress-dl-label">下载地址({{ coreDownload.version }}):</span>
            <a :href="coreDownload.url" target="_blank" rel="noopener" class="egress-dl-url">{{ coreDownload.url }}</a>
            <el-button size="small" text :icon="DocumentCopy" @click="copyText(coreDownload.url, '已复制下载地址')">复制</el-button>
          </div>
          <div class="egress-dl-row">
            <span class="egress-dl-label">解压后放到:</span>
            <code>{{ coreDownload.binDir }}/</code>
            <el-button size="small" text :icon="DocumentCopy" @click="copyText(coreDownload.binDir, '已复制落地目录')">复制</el-button>
          </div>
          <p class="egress-dl-note">
            下载后解压出可执行文件、赋可执行权限放入上面目录即可;或改用 http 类型节点 / 本机 Clash。
          </p>
        </div>
        <p v-else class="egress-dl-note">
          请下载 mihomo(clash-meta)内核放到 <code>~/.khyquant/bin/</code>
          (<a href="https://github.com/MetaCubeX/mihomo/releases" target="_blank" rel="noopener">官方 releases</a>),
          或改用 http 类型节点 / 本机 Clash。
        </p>
      </div>
    </el-card>

    <el-tabs v-model="activeTabProxy" class="proxy-tabs" tab-position="left">
      <!-- ── 订阅 ── -->
      <el-tab-pane name="subs">
        <template #label>
          <span class="tab-label"><el-icon><Connection /></el-icon> 订阅</span>
        </template>

        <div v-loading="loading" class="group-grid">
          <KhyEmpty
            v-if="!groups.length"
            :icon="Connection"
            title="还没有订阅组"
            description="点右上角「添加订阅」，粘贴机场 / Clash 订阅链接，即可导入代理节点并分组管理。"
          />
          <el-card v-for="g in groups" :key="g.id" shadow="hover" class="group-card section-card">
            <div class="group-head">
              <span class="group-name">{{ g.name }}</span>
              <el-tag size="small" type="info">{{ g.format }}</el-tag>
            </div>
            <div class="group-url" :title="g.url">{{ g.url }}</div>
            <div class="group-meta">
              <span class="node-count">{{ g.nodeCount }} 个节点</span>
              <div class="proto-tags">
                <el-tag
                  v-for="(count, proto) in g.protocolCount"
                  :key="proto"
                  size="small"
                  class="proto-tag"
                >{{ proto }} · {{ count }}</el-tag>
              </div>
            </div>
            <div v-if="g.lastError" class="group-error">上次刷新失败：{{ g.lastError }}</div>
            <div v-if="g.userinfo" class="group-usage">
              <el-progress
                v-if="g.userinfo.usedRatio != null"
                :percentage="Math.round(g.userinfo.usedRatio * 100)"
                :color="usageColor(g.userinfo.usedRatio)"
                :stroke-width="8"
              />
              <div class="usage-text">
                <span v-if="g.userinfo.total != null">
                  {{ formatBytes(g.userinfo.used) }} / {{ formatBytes(g.userinfo.total) }}
                </span>
                <span v-if="g.userinfo.expireAt" class="expire">到期 {{ formatDate(g.userinfo.expireAt) }}</span>
              </div>
            </div>
            <div class="group-time">更新于 {{ formatTime(g.updatedAt) }}</div>
            <div class="group-actions">
              <el-button text type="primary" :icon="View" @click="viewNodes(g)">查看节点</el-button>
              <el-button text type="primary" :icon="Refresh" :loading="busy" @click="doRefresh(g)">刷新</el-button>
              <el-button text type="danger" :icon="Delete" @click="confirmRemove(g)">删除</el-button>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- ── 代理组（诚实节点浏览器：仅浏览 / 筛选 / 搜索 / 复制，无选中/测速/导出） ── -->
      <el-tab-pane name="groups">
        <template #label>
          <span class="tab-label"><el-icon><Grid /></el-icon> 代理组</span>
        </template>

        <KhyEmpty
          v-if="!groups.length"
          :icon="Grid"
          title="还没有可浏览的节点"
          description="先到「订阅」页导入一个订阅组，这里就能按协议筛选、搜索并复制每个节点的配置。"
        />

        <template v-else>
          <div class="browser-toolbar">
            <el-select v-model="selectedGroupId" class="group-select" placeholder="选择订阅组">
              <el-option label="全部订阅组" value="all" />
              <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
            </el-select>
            <el-input
              v-model="nodeSearch"
              class="node-search"
              :prefix-icon="Search"
              placeholder="搜索节点名 / 服务器"
              clearable
            />
            <el-select v-model="sortKey" class="sort-select">
              <el-option label="按名称" value="name" />
              <el-option label="按协议" value="protocol" />
              <el-option label="按端口" value="port" />
            </el-select>
          </div>

          <div v-if="availableProtocols.length" class="proto-filter">
            <el-check-tag :checked="protoFilter === ''" @change="protoFilter = ''">全部</el-check-tag>
            <el-check-tag
              v-for="p in availableProtocols"
              :key="p"
              :checked="protoFilter === p"
              @change="protoFilter = protoFilter === p ? '' : p"
            >{{ p }}</el-check-tag>
          </div>

          <el-table
            v-loading="loadingNodes"
            :data="filteredNodes"
            :size="prefDensity"
            max-height="560"
            class="node-table section-card"
            empty-text="没有匹配的节点"
          >
            <el-table-column type="expand">
              <template #default="{ row }">
                <pre class="node-config">{{ prettyNode(row) }}</pre>
              </template>
            </el-table-column>
            <el-table-column v-if="selectedGroupId === 'all'" prop="__group" label="订阅组" min-width="120" show-overflow-tooltip />
            <el-table-column prop="name" label="节点名" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'active-node-name': isActiveNode(row) }">{{ row.name }}</span>
                <el-tag v-if="isActiveNode(row)" size="small" type="success" class="active-badge">使用中</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="协议" width="96">
              <template #default="{ row }">
                <el-tag size="small">{{ row.protocol || row.type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="server" label="服务器" min-width="140" show-overflow-tooltip />
            <el-table-column prop="port" label="端口" width="80" align="center" />
            <el-table-column label="TLS" width="64" align="center">
              <template #default="{ row }">
                <el-tag v-if="isTls(row)" size="small" type="success">on</el-tag>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" align="center">
              <template #default="{ row }">
                <el-button text type="primary" :icon="Connection" :loading="busy" @click="useNode(row)">使用此节点</el-button>
                <el-button text type="primary" :icon="DocumentCopy" @click="copyNode(row)">复制</el-button>
              </template>
            </el-table-column>
          </el-table>
          <p class="browser-hint">共 {{ filteredNodes.length }} 个节点。展开任意行可查看完整配置，「复制」将该节点配置复制到剪贴板。</p>
        </template>
      </el-tab-pane>

      <!-- ── 设置（本地偏好 + 仅本页打开时的自动刷新） ── -->
      <el-tab-pane name="settings">
        <template #label>
          <span class="tab-label"><el-icon><Setting /></el-icon> 设置</span>
        </template>

        <el-card shadow="never" class="settings-block section-card">
          <template #header>
            <div class="block-head">
              <span class="block-title">本地偏好</span>
              <el-button size="small" @click="resetPrefs">恢复默认</el-button>
            </div>
          </template>
          <el-form label-width="140px">
            <el-form-item label="默认标签页">
              <el-select v-model="prefDefaultTab" class="pref-input">
                <el-option label="订阅" value="subs" />
                <el-option label="代理组" value="groups" />
                <el-option label="设置" value="settings" />
              </el-select>
              <span class="form-hint">全新会话首次进入代理管理时默认停留的页面（本地保存）。</span>
            </el-form-item>
            <el-form-item label="默认协议筛选">
              <el-select v-model="prefProto" class="pref-input" placeholder="全部协议">
                <el-option label="全部协议" value="" />
                <el-option v-for="p in allKnownProtocols" :key="p" :label="p" :value="p" />
              </el-select>
              <span class="form-hint">进入「代理组」页时预选的协议筛选。</span>
            </el-form-item>
            <el-form-item label="列表密度">
              <el-radio-group v-model="prefDensity">
                <el-radio-button label="default">舒适</el-radio-button>
                <el-radio-button label="small">紧凑</el-radio-button>
              </el-radio-group>
              <span class="form-hint">控制「代理组」节点表格的行高。</span>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="settings-block section-card">
          <template #header><span class="block-title">自动刷新</span></template>
          <el-form label-width="140px">
            <el-form-item label="自动刷新订阅">
              <el-switch v-model="prefAuto" />
              <span class="form-hint">仅在本页面打开时生效：定时从远端重新拉取所有订阅组的流量、到期与节点。关闭页面即停止，后端不做后台调度。</span>
            </el-form-item>
            <el-form-item label="刷新间隔">
              <el-radio-group v-model="prefInterval" :disabled="!prefAuto">
                <el-radio-button :label="5">5 分钟</el-radio-button>
                <el-radio-button :label="10">10 分钟</el-radio-button>
                <el-radio-button :label="30">30 分钟</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="prefAuto" label="上次自动刷新">
              <span class="muted">{{ lastAutoRefresh ? formatTime(lastAutoRefresh) : '尚未触发' }}</span>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- Add subscription dialog -->
    <el-dialog v-model="importVisible" title="添加订阅组" width="560px">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="订阅地址">
          <el-input
            v-model="importForm.url"
            type="textarea"
            :rows="3"
            placeholder="https://example.com/subscribe?token=... （支持 Clash / vmess / vless / trojan / ss 订阅）"
          />
        </el-form-item>
        <el-form-item label="或导入">
          <el-button size="small" :icon="DocumentCopy" @click="pasteFromClipboard">从剪贴板粘贴</el-button>
          <el-button size="small" :icon="Upload" @click="triggerFilePick">从文件导入</el-button>
          <input
            ref="fileInput"
            type="file"
            accept=".txt,.yaml,.yml,.conf,.list,text/plain"
            style="display: none"
            @change="onFilePicked"
          />
          <span v-if="importForm.content" class="content-hint">已载入本地内容（{{ importForm.content.length }} 字符），点「导入」直接解析</span>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="importForm.name" placeholder="留空则自动取自订阅域名 / 本地导入" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus, Refresh, Delete, View, Connection, DocumentCopy, Upload,
  Grid, Search, Setting,
} from '@element-plus/icons-vue'
import { useProxies } from '@/composables/useProxies'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

defineOptions({ name: 'ProxyManagement' })

const proxies = useProxies()
const { groups, loading, busy, egressStatus } = proxies

function listGroups() {
  return proxies.listGroups()
}

// ── 出站状态(选节点实际路由 + 启用/停用开关)派生 ─────────────────────────────
const egressEnabled = computed(() => !!egressStatus.value?.enabled)
const egressActiveNode = computed(() => egressStatus.value?.activeNode || null)
const coreBinaryInstalled = computed(() => !!egressStatus.value?.coreStatus?.binaryInstalled)
const coreRunning = computed(() => !!egressStatus.value?.coreStatus?.running)
// 「内核去哪下」描述符(后端 SSOT proxyCoreInstaller.describeCoreDownload 经 getStatus 透传)。
// 门 KHY_PROXY_CORE_DOWNLOAD_HINT 关时后端返 null → 横幅回退到「官方 releases」通用指引。
const coreDownload = computed(() => egressStatus.value?.coreStatus?.download || null)

function egressModeLabel(mode) {
  if (mode === 'direct-connect') return '直连'
  if (mode === 'core-required') return '内核'
  return mode || '—'
}

// 该行是否为当前激活节点(按名字匹配 activeNode.name)。
function isActiveNode(row) {
  const active = egressActiveNode.value
  if (!active || !active.name) return false
  return String(row?.name || '') === String(active.name)
}

// 用选中节点激活真实出站。core-required 内核缺失时后端返 success=false + guidance,
// 这里**显式弹指引**(绝不静默、绝不谎报生效);直连节点即时生效。
async function useNode(row) {
  try {
    const { __group, ...node } = row || {}
    void __group
    const result = await proxies.enableNode(node)
    if (result?.success) {
      ElMessage.success(`已切换出站到「${node.name || '节点'}」(${egressModeLabel(result.egressMode)})`)
    } else {
      // 结构化 guidance / error 原样呈现,不谎报生效。
      const msg = result?.guidance || result?.error || '无法使用该节点'
      ElMessageBox.alert(msg, '未能启用该节点', { type: 'warning', confirmButtonText: '知道了' })
    }
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '启用节点失败')
  }
}

// 顶部开关:开→若已有 activeNode 则不重复(仅刷新);实际启用靠选节点。关→停用出站。
async function onToggleEgress(val) {
  try {
    if (!val) {
      await proxies.disableEgress()
      ElMessage.success('已停用代理出站')
    } else if (!egressActiveNode.value) {
      // 无激活节点时打开开关:引导去选节点,不凭空启用。
      await proxies.fetchEgressStatus()
      ElMessage.info('请先到「代理组」页点某节点的「使用此节点」来选择出站节点。')
      activeTabProxy.value = 'groups'
    } else {
      await proxies.fetchEgressStatus()
    }
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '操作失败')
  }
}

// ── Local preferences (localStorage) ─────────────────────────────────────────
// Every key is a pure frontend preference: it changes how THIS page renders /
// behaves. Nothing here is persisted server-side — the backend has no settings
// store for proxy subscriptions, so we do not pretend it does.
const PREF = {
  tab: 'khy_ai_proxy_tab',                 // last-visited tab (refresh persistence)
  defaultTab: 'khy_ai_proxy_default_tab',  // preferred landing tab (fresh session)
  proto: 'khy_ai_proxy_node_proto',        // default protocol filter
  density: 'khy_ai_proxy_density',         // node table row height
  auto: 'khy_ai_proxy_autorefresh',        // '1' | '0'
  interval: 'khy_ai_proxy_autorefresh_interval', // minutes
}
const VALID_TABS = ['subs', 'groups', 'settings']

function readPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

// Initial tab: last-visited wins (so a refresh lands where you were); otherwise
// fall back to the user's configured default tab; otherwise 订阅.
function readInitialTab() {
  const last = readPref(PREF.tab, '')
  if (VALID_TABS.includes(last)) return last
  const def = readPref(PREF.defaultTab, '')
  if (VALID_TABS.includes(def)) return def
  return 'subs'
}

const activeTab = ref(readInitialTab())
const activeTabProxy = computed({
  get: () => activeTab.value,
  set: (v) => { activeTab.value = v; writePref(PREF.tab, v) },
})

// Preference form models — persisted on change via watchers below.
const prefDefaultTab = ref(readPref(PREF.defaultTab, 'subs'))
const prefProto = ref(readPref(PREF.proto, ''))
const prefDensity = ref(readPref(PREF.density, 'default'))
const prefAuto = ref(readPref(PREF.auto, '0') === '1')
const prefInterval = ref(Number(readPref(PREF.interval, '10')) || 10)

watch(prefDefaultTab, (v) => writePref(PREF.defaultTab, v))
watch(prefDensity, (v) => writePref(PREF.density, v))
watch(prefProto, (v) => { writePref(PREF.proto, v); protoFilter.value = v })
watch(prefAuto, (v) => { writePref(PREF.auto, v ? '1' : '0'); setupAutoRefresh() })
watch(prefInterval, (v) => { writePref(PREF.interval, String(v)); setupAutoRefresh() })

function resetPrefs() {
  for (const key of Object.values(PREF)) {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
  prefDefaultTab.value = 'subs'
  prefProto.value = ''
  prefDensity.value = 'default'
  prefAuto.value = false
  prefInterval.value = 10
  protoFilter.value = ''
  ElMessage.success('已恢复默认设置')
}

// ── Node browser (代理组) ─────────────────────────────────────────────────────
const selectedGroupId = ref('all')
const nodes = ref([])
const loadingNodes = ref(false)
const nodeSearch = ref('')
const protoFilter = ref(prefProto.value)
const sortKey = ref('name')

// Load nodes for the selected group (or aggregate across all groups). Each node
// is tagged with __group so the aggregate view can show its origin.
async function loadNodes() {
  if (!groups.value.length) { nodes.value = []; return }
  loadingNodes.value = true
  try {
    if (selectedGroupId.value === 'all') {
      const detailed = await Promise.all(groups.value.map((g) => proxies.getGroup(g.id).catch(() => null)))
      nodes.value = detailed
        .filter(Boolean)
        .flatMap((grp) => (grp.nodes || []).map((n) => ({ ...n, __group: grp.name })))
    } else {
      const grp = await proxies.getGroup(selectedGroupId.value)
      nodes.value = (grp?.nodes || []).map((n) => ({ ...n, __group: grp?.name }))
    }
  } catch (e) {
    nodes.value = []
    ElMessage.error(e?.response?.data?.message || e.message || '加载节点失败')
  } finally {
    loadingNodes.value = false
  }
}

watch(selectedGroupId, loadNodes)

const availableProtocols = computed(() => {
  const set = new Set()
  for (const n of nodes.value) { const p = n.protocol || n.type; if (p) set.add(p) }
  return [...set].sort()
})

// Protocols across ALL groups — used to populate the settings default-filter
// dropdown even before the browser tab has loaded nodes.
const allKnownProtocols = computed(() => {
  const set = new Set(availableProtocols.value)
  for (const g of groups.value) {
    for (const p of Object.keys(g.protocolCount || {})) set.add(p)
  }
  return [...set].sort()
})

const filteredNodes = computed(() => {
  const q = nodeSearch.value.trim().toLowerCase()
  let list = nodes.value.filter((n) => {
    const proto = n.protocol || n.type || ''
    if (protoFilter.value && proto !== protoFilter.value) return false
    if (q) {
      const hay = `${n.name || ''} ${n.server || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  const key = sortKey.value
  list = [...list].sort((a, b) => {
    if (key === 'port') return (Number(a.port) || 0) - (Number(b.port) || 0)
    if (key === 'protocol') return String(a.protocol || a.type || '').localeCompare(String(b.protocol || b.type || ''))
    return String(a.name || '').localeCompare(String(b.name || ''))
  })
  return list
})

async function copyNode(row) {
  try {
    await navigator.clipboard.writeText(prettyNode(row))
    ElMessage.success('已复制节点配置')
  } catch {
    ElMessage.warning('复制失败,请手动展开该行复制')
  }
}

// 通用复制(内核下载地址 / 落地目录用)。失败给可操作提示,不静默。
async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(String(text || ''))
    ElMessage.success(okMsg || '已复制')
  } catch {
    ElMessage.warning('复制失败,请手动选中文本复制')
  }
}

// From a subscription card: jump to the 代理组 tab focused on that group.
function viewNodes(g) {
  selectedGroupId.value = g.id
  activeTabProxy.value = 'groups'
}

// ── Auto-refresh (page-scoped only) ──────────────────────────────────────────
let autoTimer = null
const lastAutoRefresh = ref(null)

function setupAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  if (!prefAuto.value) return
  const ms = Math.max(1, Number(prefInterval.value) || 10) * 60 * 1000
  autoTimer = setInterval(autoRefreshTick, ms)
}

// Best-effort remote refresh of every group, then reload the browser view.
// Errors are swallowed (no toast spam) — this runs unattended in the background.
async function autoRefreshTick() {
  for (const g of [...groups.value]) {
    try { await proxies.refreshGroup(g.id) } catch { /* best-effort */ }
  }
  lastAutoRefresh.value = new Date().toISOString()
  if (activeTab.value === 'groups') { try { await loadNodes() } catch { /* ignore */ } }
}

// ── Formatting helpers (reused by subs cards + node browser) ──────────────────
function formatTime(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function formatDate(ms) {
  if (!ms) return '—'
  try { return new Date(ms).toLocaleDateString() } catch { return String(ms) }
}

// 字节 → 人类可读(GB/MB…)。用于订阅流量进度条。
function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  let v = Number(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

// 进度条着色:越接近用满越红。走设计令牌,暗色模式随之响应。
function usageColor(ratio) {
  if (ratio >= 0.9) return 'var(--khy-danger)'
  if (ratio >= 0.7) return 'var(--khy-warning)'
  return 'var(--khy-success)'
}

// 该节点是否启用 TLS(clash 字段各协议命名不一)。
function isTls(row) {
  return row?.tls === true || row?.tls === 'tls' || row?.security === 'tls' || row?.security === 'reality'
}

// 节点完整 clash 配置的可读 JSON(展开行 / 复制用)。
function prettyNode(row) {
  // Strip our internal __group tag from the copied/expanded config.
  const { __group, ...rest } = row || {}
  void __group
  try { return JSON.stringify(rest, null, 2) } catch { return String(row) }
}

// ── Add subscription ─────────────────────────────────────────────────────────
const importVisible = ref(false)
const importForm = ref({ url: '', name: '', content: '' })
const fileInput = ref(null)

function openImport() {
  importForm.value = { url: '', name: '', content: '' }
  importVisible.value = true
}

// 剪贴板 → 订阅地址框(失败静默,浏览器可能拒绝权限)。
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.trim()) {
      importForm.value.url = text.trim()
      importForm.value.content = ''
    } else {
      ElMessage.warning('剪贴板为空')
    }
  } catch {
    ElMessage.warning('无法读取剪贴板，请手动粘贴')
  }
}

function triggerFilePick() {
  fileInput.value?.click()
}

// 文件导入:是 http(s) 单行则填地址框走抓取;否则当原始内容(免 fetch/SSRF)。
async function onFilePicked(ev) {
  const file = ev?.target?.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const trimmed = text.trim()
    if (/^https?:\/\/\S+$/i.test(trimmed) && !/\n/.test(trimmed)) {
      importForm.value.url = trimmed
      importForm.value.content = ''
    } else {
      importForm.value.content = text
      importForm.value.url = ''
      if (!importForm.value.name) importForm.value.name = file.name.replace(/\.[^.]+$/, '')
    }
  } catch {
    ElMessage.error('读取文件失败')
  } finally {
    if (ev?.target) ev.target.value = ''
  }
}

async function doImport() {
  const url = importForm.value.url.trim()
  const content = importForm.value.content
  const name = importForm.value.name.trim()
  if (!url && !content) return ElMessage.warning('请填写订阅地址，或从剪贴板 / 文件导入内容')
  try {
    const group = content
      ? await proxies.addByContent(content, name)
      : await proxies.addSubscription(url, name)
    ElMessage.success(`已导入「${group?.name || '订阅组'}」，共 ${group?.nodeCount || 0} 个节点`)
    importVisible.value = false
    if (activeTab.value === 'groups') loadNodes()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '导入失败')
  }
}

// ── Refresh / remove ─────────────────────────────────────────────────────────
async function doRefresh(g) {
  try {
    const updated = await proxies.refreshGroup(g.id)
    ElMessage.success(`已刷新，共 ${updated?.nodeCount || 0} 个节点`)
    if (activeTab.value === 'groups') loadNodes()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '刷新失败')
  }
}

async function confirmRemove(g) {
  try {
    await ElMessageBox.confirm(`确定删除订阅组「${g.name}」？`, '删除订阅组', { type: 'warning' })
    await proxies.removeGroup(g.id)
    ElMessage.success('已删除')
    if (selectedGroupId.value === g.id) selectedGroupId.value = 'all'
    else if (activeTab.value === 'groups') loadNodes()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e?.response?.data?.message || e.message || '删除失败')
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(async () => {
  await listGroups()
  await loadNodes()
  try { await proxies.fetchEgressStatus() } catch { /* fail-soft:出站状态拿不到不阻塞页面 */ }
  setupAutoRefresh()
})

onUnmounted(() => {
  // Page-scoped timer must not survive navigation away — the whole honesty of
  // the "仅本页面打开时生效" auto-refresh rests on this cleanup.
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
})
</script>

<style scoped>
.proxy-tabs { margin-top: 4px; }
.tab-label { display: inline-flex; align-items: center; gap: 6px; }

/* ── 订阅 cards ── */
.group-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.group-card { display: flex; flex-direction: column; }
.group-head { display: flex; justify-content: space-between; align-items: center; }
.group-name { font-weight: 600; }
.group-url { color: var(--khy-text-secondary); font-size: 12px; margin: 8px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.node-count { font-size: 13px; color: var(--khy-text-strong); }
.proto-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.proto-tag { margin: 0; }
.group-error { color: var(--khy-danger); font-size: 12px; margin-top: 8px; }
.group-usage { margin-top: 8px; }
.usage-text { display: flex; justify-content: space-between; font-size: 12px; color: var(--khy-text-secondary); margin-top: 2px; }
.usage-text .expire { color: var(--khy-text-secondary); }
.group-time { color: var(--khy-text-secondary); font-size: 12px; margin-top: 8px; }
.group-actions { display: flex; justify-content: flex-end; margin-top: 8px; gap: 4px; }

/* ── 代理组 node browser ── */
.browser-toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.group-select { width: 220px; }
.node-search { width: 260px; flex: 1 1 200px; }
.sort-select { width: 130px; }
.proto-filter { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.node-table { border-radius: var(--khy-radius); overflow: hidden; }
.node-config { margin: 0; padding: 8px 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; background: var(--khy-bg-soft); border-radius: 4px; font-family: var(--khy-font-mono, monospace); }
.browser-hint { color: var(--khy-text-muted); font-size: 12px; margin: 10px 2px 0; }

/* ── 设置 ── */
.settings-block { margin-bottom: 16px; }
.block-head { display: flex; justify-content: space-between; align-items: center; }
.block-title { font-weight: 700; color: var(--khy-text-strong); }
.pref-input { width: 220px; }
.form-hint { margin-left: 12px; font-size: 12px; color: var(--khy-text-muted); }

.content-hint { margin-left: 8px; font-size: 12px; color: var(--khy-success); }
.muted { color: var(--khy-text-secondary); }

/* ── 出站状态条 ── */
.egress-bar { margin: 4px 0 12px; }
.egress-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.egress-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.egress-node { font-size: 13px; color: var(--khy-text-strong); display: inline-flex; align-items: center; gap: 6px; }
.egress-tag { margin-left: 2px; }
.egress-none { font-size: 12px; }
.egress-core { display: flex; gap: 6px; align-items: center; }
.egress-hint { margin: 8px 2px 0; font-size: 12px; color: var(--khy-text-muted); line-height: 1.6; }
.egress-hint p { margin: 0 0 6px; }
.egress-hint code { background: var(--khy-bg-soft); padding: 1px 5px; border-radius: 3px; font-family: var(--khy-font-mono, monospace); }
.egress-dl { margin-top: 4px; padding: 8px 10px; background: var(--khy-bg-soft); border-radius: 6px; }
.egress-dl-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.egress-dl-label { color: var(--khy-text-strong); flex-shrink: 0; }
.egress-dl-url { word-break: break-all; color: var(--khy-primary, #409eff); text-decoration: none; }
.egress-dl-url:hover { text-decoration: underline; }
.egress-dl-note { margin: 4px 0 0; color: var(--khy-text-muted); }
.active-node-name { font-weight: 600; color: var(--khy-success); }
.active-badge { margin-left: 6px; }
</style>
