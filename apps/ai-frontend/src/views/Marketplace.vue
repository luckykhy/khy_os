<template>
  <div class="marketplace-page">
    <KhyPageHeader title="插件市场" subtitle="Coze 兼容 · OpenAPI 插件 · 工作流与对话 Agent 通用">
      <template #actions>
        <el-button :icon="Upload" @click="openImport">导入插件</el-button>
        <el-button :icon="Refresh" @click="reload">刷新</el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never" class="marketplace-card">
      <el-tabs v-model="activeTab">
        <!-- ── Browse catalog ──────────────────────────────────────────── -->
        <el-tab-pane label="浏览市场" name="browse">
          <div class="filters">
            <el-input
              v-model="search"
              placeholder="搜索插件名称 / 描述"
              clearable
              style="max-width: 280px"
              @keyup.enter="reloadCatalog"
              @clear="reloadCatalog"
            />
            <el-select v-model="category" placeholder="全部分类" clearable style="width: 160px" @change="reloadCatalog">
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
            <el-button :icon="Search" @click="reloadCatalog">搜索</el-button>
          </div>

          <div v-loading="loading" class="catalog-grid">
            <KhyEmpty
              v-if="!catalog.length"
              :icon="ShoppingCart"
              title="插件市场还空着"
              description="点右上角「导入」上传一个 OpenAPI 规范，就能把外部能力接入并在对话中直接调用。"
            />
            <el-card v-for="p in catalog" :key="p.id" shadow="hover" class="plugin-card">
              <div class="plugin-head">
                <span class="plugin-name">{{ p.name }}</span>
                <el-tag v-if="p.official" size="small" type="success">官方</el-tag>
              </div>
              <div class="plugin-desc">{{ p.description || '（无描述）' }}</div>
              <div class="plugin-meta">
                <el-tag size="small" type="info">{{ p.category }}</el-tag>
                <span class="plugin-ver">v{{ p.version }}</span>
              </div>
              <div class="plugin-actions">
                <el-button text type="primary" @click="openDetail(p.id)">详情</el-button>
                <el-button text type="primary" @click="quickInstall(p)">安装</el-button>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- ── Installed ───────────────────────────────────────────────── -->
        <el-tab-pane label="已安装" name="installed">
          <el-table v-loading="loading" :data="installed" empty-text="还没有安装插件">
            <el-table-column prop="name" label="名称" min-width="160">
              <template #default="{ row }">
                <span class="wf-name">{{ row.name }}</span>
                <el-tag v-if="row.official" size="small" type="success" style="margin-left:6px">官方</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
            <el-table-column label="工具数" width="90" align="center">
              <template #default="{ row }">{{ row.operations }}</template>
            </el-table-column>
            <el-table-column label="鉴权" width="120" align="center">
              <template #default="{ row }">
                <el-tag size="small" :type="row.auth.configured ? 'success' : 'info'">
                  {{ authLabel(row.auth) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="90" align="center">
              <template #default="{ row }">
                <el-switch :model-value="row.enabled" @change="(v) => toggle(row, v)" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="260" align="right">
              <template #default="{ row }">
                <el-button text type="primary" :icon="Key" @click="openAuth(row)">鉴权</el-button>
                <el-button text type="primary" :icon="VideoPlay" @click="openTest(row)">试调</el-button>
                <el-button text type="danger" :icon="Delete" @click="confirmUninstall(row)">卸载</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Import dialog -->
    <el-dialog v-model="importVisible" title="导入插件（Coze 兼容 / OpenAPI）" width="640px">
      <el-form label-width="92px" @submit.prevent>
        <el-form-item label="来源">
          <el-radio-group v-model="importMode">
            <el-radio-button label="url">OpenAPI URL</el-radio-button>
            <el-radio-button label="openapi">粘贴 OpenAPI</el-radio-button>
            <el-radio-button label="manifest">Coze manifest</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="importMode === 'url'" label="URL">
          <el-input v-model="importForm.url" placeholder="https://example.com/openapi.json" />
        </el-form-item>
        <el-form-item v-if="importMode === 'openapi'" label="OpenAPI">
          <el-input v-model="importForm.openapi" type="textarea" :rows="8" placeholder="粘贴 OpenAPI 3.x JSON / YAML" />
        </el-form-item>
        <el-form-item v-if="importMode === 'manifest'" label="manifest">
          <el-input v-model="importForm.manifest" type="textarea" :rows="6" placeholder="粘贴 ai-plugin.json（含 api.url）" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="importForm.name" placeholder="留空则自动取自文档标题" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="importForm.category" placeholder="general" />
        </el-form-item>
      </el-form>
      <div v-if="importPreview" class="gen-preview">
        <p><b>{{ importPreview.name }}</b>（{{ importPreview.operations?.length || 0 }} 个工具）</p>
        <p class="muted">{{ importPreview.description }}</p>
      </div>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button :loading="busy" @click="doPreview">预览</el-button>
        <el-button type="primary" :loading="busy" @click="doImport">导入并安装</el-button>
      </template>
    </el-dialog>

    <!-- Detail dialog -->
    <el-dialog v-model="detailVisible" :title="detail?.name || '插件详情'" width="600px">
      <template v-if="detail">
        <p class="muted">{{ detail.description }}</p>
        <p>鉴权类型：<el-tag size="small">{{ detail.auth?.type || 'none' }}</el-tag></p>
        <el-table :data="detail.operations" size="small" max-height="280">
          <el-table-column prop="method" label="方法" width="80" />
          <el-table-column prop="path" label="路径" min-width="180" show-overflow-tooltip />
          <el-table-column prop="summary" label="说明" min-width="160" show-overflow-tooltip />
        </el-table>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="quickInstall(detail)">安装</el-button>
      </template>
    </el-dialog>

    <!-- Auth dialog -->
    <el-dialog v-model="authVisible" title="配置鉴权" width="520px">
      <el-form label-width="110px" @submit.prevent>
        <el-form-item label="类型">
          <el-select v-model="authForm.type">
            <el-option label="无鉴权" value="none" />
            <el-option label="API Key" value="apiKey" />
            <el-option label="Bearer Token" value="bearer" />
            <el-option label="OAuth" value="oauth" />
          </el-select>
        </el-form-item>
        <template v-if="authForm.type === 'apiKey'">
          <el-form-item label="位置">
            <el-radio-group v-model="authForm.in">
              <el-radio-button label="header">Header</el-radio-button>
              <el-radio-button label="query">Query</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="参数名"><el-input v-model="authForm.name" placeholder="Authorization" /></el-form-item>
          <el-form-item label="值"><el-input v-model="authForm.value" type="password" show-password /></el-form-item>
        </template>
        <template v-else-if="authForm.type === 'bearer'">
          <el-form-item label="Token"><el-input v-model="authForm.token" type="password" show-password /></el-form-item>
        </template>
        <template v-else-if="authForm.type === 'oauth'">
          <el-form-item label="授权方式">
            <el-select v-model="authForm.grant">
              <el-option label="客户端凭证" value="client_credentials" />
              <el-option label="授权码" value="authorization_code" />
            </el-select>
          </el-form-item>
          <el-form-item label="Token URL"><el-input v-model="authForm.tokenUrl" /></el-form-item>
          <el-form-item label="Client ID"><el-input v-model="authForm.clientId" /></el-form-item>
          <el-form-item label="Client Secret"><el-input v-model="authForm.clientSecret" type="password" show-password /></el-form-item>
          <el-form-item label="Scope"><el-input v-model="authForm.scope" placeholder="可选" /></el-form-item>
          <el-form-item v-if="authForm.grant === 'authorization_code'" label="Access Token">
            <el-input v-model="authForm.accessToken" type="password" show-password placeholder="授权后获得" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="authVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="saveAuth">保存</el-button>
      </template>
    </el-dialog>

    <!-- Test dialog -->
    <el-dialog v-model="testVisible" title="试调插件工具" width="600px">
      <el-form label-width="92px" @submit.prevent>
        <el-form-item label="操作">
          <el-select v-model="testForm.operationId" placeholder="选择一个 operation" style="width:100%">
            <el-option
              v-for="op in testOperations"
              :key="op.operationId"
              :label="`${op.method} ${op.path}`"
              :value="op.operationId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="参数 JSON">
          <el-input v-model="testForm.argsText" type="textarea" :rows="5" placeholder='{ "city": "Beijing" }' />
        </el-form-item>
      </el-form>
      <div v-if="testResult" class="gen-preview">
        <p>HTTP {{ testResult.status }} · {{ testResult.ok ? '成功' : '失败' }}</p>
        <pre class="test-out">{{ prettyResult }}</pre>
      </div>
      <template #footer>
        <el-button @click="testVisible = false">关闭</el-button>
        <el-button type="primary" :loading="busy" @click="runTest">执行</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Upload, Refresh, Search, Delete, Key, VideoPlay, ShoppingCart } from '@element-plus/icons-vue'
import { useMarketplace } from '@/composables/useMarketplace'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const mp = useMarketplace()
const { catalog, categories, installed, loading, busy } = mp

const activeTab = ref('browse')
const search = ref('')
const category = ref('')

async function reloadCatalog() {
  await mp.listCatalog({
    search: search.value || undefined,
    category: category.value || undefined,
  })
}

async function reload() {
  await Promise.all([reloadCatalog(), mp.listInstalled(), mp.fetchCategories()])
}

onMounted(reload)

// ── Import ────────────────────────────────────────────────────────────────
const importVisible = ref(false)
const importMode = ref('url')
const importForm = ref({ url: '', openapi: '', manifest: '', name: '', category: '' })
const importPreview = ref(null)

function openImport() {
  importForm.value = { url: '', openapi: '', manifest: '', name: '', category: '' }
  importPreview.value = null
  importMode.value = 'url'
  importVisible.value = true
}

function importBody() {
  const f = importForm.value
  const body = { name: f.name || undefined, category: f.category || undefined }
  if (importMode.value === 'url') body.url = f.url
  else if (importMode.value === 'openapi') body.openapi = f.openapi
  else if (importMode.value === 'manifest') body.manifest = f.manifest
  return body
}

async function doPreview() {
  try {
    importPreview.value = await mp.previewImport(importBody())
    ElMessage.success('预览成功')
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '预览失败')
  }
}

async function doImport() {
  try {
    await mp.importPlugin(importBody())
    ElMessage.success('已导入并安装')
    importVisible.value = false
    activeTab.value = 'installed'
    await reload()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '导入失败')
  }
}

// ── Detail ────────────────────────────────────────────────────────────────
const detailVisible = ref(false)
const detail = ref(null)

async function openDetail(id) {
  try {
    detail.value = await mp.getDetail(id)
    detailVisible.value = true
  } catch (e) {
    ElMessage.error(e.message || '加载详情失败')
  }
}

async function quickInstall(p) {
  if (!p) return
  try {
    await mp.install(p.id)
    ElMessage.success(`已安装「${p.name}」，可在「已安装」中配置鉴权`)
    detailVisible.value = false
    await reload()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '安装失败')
  }
}

// ── Installed: toggle / uninstall ──────────────────────────────────────────
async function toggle(row, enabled) {
  try {
    await mp.setEnabled(row.id, enabled)
  } catch (e) {
    ElMessage.error(e.message || '操作失败')
    await mp.listInstalled()
  }
}

async function confirmUninstall(row) {
  try {
    await ElMessageBox.confirm(`确定卸载「${row.name}」？`, '卸载插件', { type: 'warning' })
    await mp.uninstall(row.id)
    ElMessage.success('已卸载')
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e.message || '卸载失败')
  }
}

function authLabel(auth) {
  const t = auth?.type || 'none'
  if (t === 'none') return '无'
  return auth.configured ? t : `${t}（未配）`
}

// ── Auth config ─────────────────────────────────────────────────────────────
const authVisible = ref(false)
const authRow = ref(null)
const authForm = ref({ type: 'none' })

function openAuth(row) {
  authRow.value = row
  authForm.value = { type: row.auth?.type || 'none', in: row.auth?.in || 'header', name: row.auth?.name || 'Authorization', grant: row.auth?.grant || 'client_credentials', tokenUrl: row.auth?.tokenUrl || '', scope: row.auth?.scope || '' }
  authVisible.value = true
}

function buildAuthConfig() {
  const f = authForm.value
  if (f.type === 'none') return { type: 'none' }
  if (f.type === 'apiKey') return { type: 'apiKey', in: f.in, name: f.name, value: f.value }
  if (f.type === 'bearer') return { type: 'bearer', token: f.token }
  if (f.type === 'oauth') {
    return {
      type: 'oauth', grant: f.grant, tokenUrl: f.tokenUrl, clientId: f.clientId,
      clientSecret: f.clientSecret, scope: f.scope || undefined,
      ...(f.grant === 'authorization_code' && f.accessToken ? { accessToken: f.accessToken } : {}),
    }
  }
  return { type: 'none' }
}

async function saveAuth() {
  try {
    await mp.setAuth(authRow.value.id, buildAuthConfig())
    ElMessage.success('鉴权已保存')
    authVisible.value = false
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '保存失败')
  }
}

// ── Test invoke ───────────────────────────────────────────────────────────
const testVisible = ref(false)
const testRow = ref(null)
const testOperations = ref([])
const testForm = ref({ operationId: '', argsText: '' })
const testResult = ref(null)

async function openTest(row) {
  testRow.value = row
  testForm.value = { operationId: '', argsText: '' }
  testResult.value = null
  testOperations.value = []
  try {
    const d = await mp.getDetail(row.pluginId)
    testOperations.value = d.operations || []
  } catch { /* non-fatal */ }
  testVisible.value = true
}

const prettyResult = computed(() => {
  try { return JSON.stringify(testResult.value?.data, null, 2) } catch { return String(testResult.value?.data) }
})

async function runTest() {
  let args = {}
  if (testForm.value.argsText.trim()) {
    try { args = JSON.parse(testForm.value.argsText) } catch { return ElMessage.error('参数 JSON 解析失败') }
  }
  if (!testForm.value.operationId) return ElMessage.error('请选择一个操作')
  try {
    testResult.value = await mp.testInvoke(testRow.value.id, testForm.value.operationId, args)
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e.message || '调用失败')
  }
}
</script>

<style scoped>
.filters { display: flex; gap: 10px; margin-bottom: 14px; }
.catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.plugin-card { display: flex; flex-direction: column; }
.plugin-head { display: flex; justify-content: space-between; align-items: center; }
.plugin-name { font-weight: 600; }
.plugin-desc { color: var(--khy-text-secondary); font-size: 12px; margin: 8px 0; min-height: 32px; }
.plugin-meta { display: flex; justify-content: space-between; align-items: center; }
.plugin-ver { color: var(--khy-text-secondary); font-size: 12px; }
.plugin-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.wf-name { font-weight: 500; }
.muted { color: var(--khy-text-secondary); }
.gen-preview { margin-top: 12px; padding: 10px; background: var(--khy-bg-soft); border-radius: 6px; }
.test-out { max-height: 200px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
</style>
