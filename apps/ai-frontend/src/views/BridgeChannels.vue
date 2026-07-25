<template>
  <div class="bridge-page">
    <KhyPageHeader title="桥接渠道管理">
      <template #actions>
        <el-button type="primary" :loading="loading" @click="reloadAll">刷新渠道状态</el-button>
      </template>
    </KhyPageHeader>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="统一管理 Claude/Codex/Kiro 及其它中转通道的 Token、路由与 OAuth 凭据。"
      class="page-alert"
    />

    <el-row :gutter="16">
      <el-col v-for="channel in CHANNELS" :key="channel.id" :xs="24" :lg="12">
        <el-card class="section-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <div class="channel-head">
                <span class="channel-name">{{ channel.name }}</span>
                <el-tag :type="channelRuntime(channel.id).statusType" size="small">
                  {{ channelRuntime(channel.id).statusLabel }}
                </el-tag>
              </div>
              <span class="channel-detail">{{ channelRuntime(channel.id).detail }}</span>
            </div>
          </template>

          <el-form :model="channelForms[channel.id]" label-width="110px">
            <el-form-item label="默认模型">
              <el-input
                v-model="channelForms[channel.id].defaultModel"
                :placeholder="channel.defaultModel || '可选'"
              />
            </el-form-item>

            <el-form-item label="服务协议">
              <el-select v-model="channelForms[channel.id].service" placeholder="选择协议">
                <el-option label="OpenAI" value="openai" />
                <el-option label="Anthropic" value="anthropic" />
                <el-option label="Auto" value="auto" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button size="small" type="primary" @click="saveChannelRouting(channel.id)">保存路由配置</el-button>
            </el-form-item>

            <el-divider>Token / API Key 导入</el-divider>

            <el-form-item label="Token / Key">
              <el-input
                v-model="channelForms[channel.id].newKeys"
                type="textarea"
                :rows="3"
                placeholder="支持 sk-xxx / Bearer xxx / key=xxx / JSON / 多行"
              />
            </el-form-item>

            <el-form-item label="API Endpoint">
              <el-input
                v-model="channelForms[channel.id].endpoint"
                placeholder="https://api.example.com/v1（可选）"
              />
            </el-form-item>

            <el-form-item label="标签 / 优先级">
              <div class="inline-inputs">
                <el-input
                  v-model="channelForms[channel.id].label"
                  placeholder="例如：主通道"
                />
                <el-input-number v-model="channelForms[channel.id].priority" :min="0" :max="100" />
              </div>
            </el-form-item>

            <el-form-item>
              <el-button size="small" type="primary" @click="importChannelKeys(channel.id)">导入 Token</el-button>
            </el-form-item>
          </el-form>

          <el-divider>当前 Token 列表</el-divider>

          <el-table :data="pagedKeys(channel.id)" size="small" stripe class="keys-table">
            <el-table-column prop="keyPreview" label="Token 预览" min-width="140" />
            <el-table-column prop="endpoint" label="API Endpoint" min-width="220" />
            <el-table-column prop="label" label="标签" width="110" />
            <el-table-column prop="priority" label="优先级" width="86" />
            <el-table-column label="状态" width="96">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'warning'" size="small">
                  {{ row.status === 'active' ? '可用' : row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="openEditKeyDialog(channel.id, row)">编辑</el-button>
                <el-button size="small" link type="danger" @click="removeKey(channel.id, row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="keysByProvider(channel.id).length > keyPageSize" class="table-pager">
            <el-pagination
              :current-page="keyPageOf(channel.id)"
              :page-size="keyPageSize"
              :total="keysByProvider(channel.id).length"
              layout="total, prev, pager, next"
              size="small"
              background
              @current-change="(p) => setKeyPage(channel.id, p)"
            />
          </div>
          <el-empty v-if="keysByProvider(channel.id).length === 0" description="暂无 Token" />
        </el-card>
      </el-col>
    </el-row>

    <el-card class="section-card oauth-card" shadow="hover">
      <template #header>
        <div class="card-header-row oauth-head">
          <div class="channel-head">
            <span class="channel-name">OAuth 凭据管理</span>
          </div>
          <el-button size="small" @click="refreshOAuthProviders">刷新 OAuth 状态</el-button>
        </div>
      </template>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="页面仅显示 OAuth 凭据状态，不回显完整敏感 Token。"
        class="oauth-alert"
      />

      <el-table :data="oauthRows" size="small" stripe>
        <el-table-column prop="name" label="Provider" min-width="130" />
        <el-table-column label="能力" min-width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="row.supportsRefresh ? 'success' : 'info'">
              {{ row.supportsRefresh ? '可自动刷新' : '手动维护' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="凭据状态" min-width="260">
          <template #default="{ row }">
            <div class="oauth-state-tags">
              <el-tag v-if="row.registered" size="small" type="success">已配置</el-tag>
              <el-tag v-else size="small" type="warning">未配置</el-tag>
              <el-tag v-if="row.hasClientId" size="small">Client ID</el-tag>
              <el-tag v-if="row.hasClientSecret" size="small">Client Secret</el-tag>
              <el-tag v-if="row.hasRefreshToken" size="small">Refresh Token</el-tag>
              <el-tag v-if="row.hasAccessToken" size="small">Access Token</el-tag>
            </div>
            <div class="oauth-subtext" v-if="row.clientIdMasked">Client: {{ row.clientIdMasked }}</div>
            <div class="oauth-subtext" v-if="row.error">错误: {{ row.error }}</div>
          </template>
        </el-table-column>
        <el-table-column label="过期" width="110">
          <template #default="{ row }">
            <span>{{ row.expiresIn > 0 ? `${Math.ceil(row.expiresIn / 60)} 分钟` : '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openOAuthDialog(row)">配置</el-button>
            <el-button size="small" link type="primary" :disabled="!row.supportsRefresh" @click="refreshOAuthNow(row)">刷新 Token</el-button>
            <el-button size="small" link type="danger" :disabled="!row.registered" @click="clearOAuth(row)">清除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="oauthRows.length === 0" description="暂无 OAuth Provider" />
    </el-card>

    <el-dialog v-model="keyDialog.visible" title="编辑 Token 配置" width="560px">
      <el-form :model="keyDialog" label-width="110px">
        <el-form-item label="Token 预览">
          <span>{{ keyDialog.keyPreview }}</span>
        </el-form-item>
        <el-form-item label="API Endpoint">
          <el-input v-model="keyDialog.endpoint" placeholder="https://api.example.com/v1（可选）" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="keyDialog.label" placeholder="例如：备用通道" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="keyDialog.priority" :min="0" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="keyDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="keyDialog.saving" @click="saveEditedKey">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="oauthDialog.visible" title="配置 OAuth 凭据" width="640px">
      <el-form :model="oauthDialog" label-width="140px">
        <el-form-item label="Provider">
          <span>{{ oauthDialog.providerName }} ({{ oauthDialog.provider }})</span>
        </el-form-item>
        <el-form-item label="Client ID">
          <el-input v-model="oauthDialog.clientId" placeholder="OAuth client id" />
        </el-form-item>
        <el-form-item label="Client Secret">
          <el-input
            v-model="oauthDialog.clientSecret"
            type="password"
            show-password
            placeholder="OAuth client secret"
          />
        </el-form-item>
        <el-form-item label="Refresh Token">
          <el-input
            v-model="oauthDialog.refreshToken"
            type="textarea"
            :rows="2"
            placeholder="refresh_token"
          />
        </el-form-item>
        <el-form-item label="Access Token">
          <el-input
            v-model="oauthDialog.accessToken"
            type="textarea"
            :rows="2"
            placeholder="access_token"
          />
        </el-form-item>
        <el-form-item label="Expires At">
          <el-input
            v-model="oauthDialog.expiresAt"
            placeholder="Unix 毫秒时间戳或 ISO 时间（可选）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oauthDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="oauthDialog.saving" @click="saveOAuthDialog">保存凭据</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onActivated, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useGateway } from '@/composables/useGateway'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

defineOptions({ name: 'BridgeChannels' })

const CHANNELS = [
  { id: 'claude', name: 'Claude Code', defaultModel: 'claude-sonnet-4-6', defaultService: 'anthropic', adapterTypes: ['claude'] },
  { id: 'codex', name: 'Codex', defaultModel: 'o4-mini', defaultService: 'openai', adapterTypes: ['codex'] },
  { id: 'kiro', name: 'Kiro', defaultModel: '', defaultService: 'openai', adapterTypes: ['kiro'] },
  { id: 'cursor', name: 'Cursor', defaultModel: '', defaultService: 'openai', adapterTypes: ['cursor'] },
  { id: 'trae', name: 'Trae', defaultModel: '', defaultService: 'openai', adapterTypes: ['trae'] },
  { id: 'windsurf', name: 'Windsurf', defaultModel: '', defaultService: 'openai', adapterTypes: ['windsurf'] },
  { id: 'api', name: '通用 API 中转', defaultModel: '', defaultService: 'openai', adapterTypes: ['api', 'relay_api'] },
  { id: 'relay', name: '手动中转桥接', defaultModel: '', defaultService: 'openai', adapterTypes: ['relay', 'clipboard'] },
  { id: 'ollama', name: 'Ollama', defaultModel: '', defaultService: 'openai', adapterTypes: ['ollama'] },
]

const CHANNEL_MAP = CHANNELS.reduce((acc, channel) => {
  acc[channel.id] = channel
  return acc
}, {})

const OAUTH_PRIORITY = ['codex', 'kiro', 'gemini', 'qwen', 'claude', 'cursor', 'trae', 'windsurf']

const gw = useGateway()
const loading = ref(false)

const channelForms = reactive(CHANNELS.reduce((acc, channel) => {
  acc[channel.id] = {
    defaultModel: '',
    service: channel.defaultService || 'openai',
    newKeys: '',
    endpoint: '',
    label: `${channel.id}-bridge`,
    priority: 20,
  }
  return acc
}, {}))

const keyDialog = reactive({
  visible: false,
  saving: false,
  provider: '',
  keyId: '',
  keyPreview: '',
  endpoint: '',
  label: '',
  priority: 10,
})

const oauthDialog = reactive({
  visible: false,
  saving: false,
  provider: '',
  providerName: '',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  accessToken: '',
  expiresAt: '',
})

const oauthRows = computed(() => {
  const listed = Array.isArray(gw.oauthProviders.value) ? [...gw.oauthProviders.value] : []
  if (listed.length === 0) {
    const fallback = []
    const status = gw.oauth.value || {}
    for (const [key, item] of Object.entries(status)) {
      fallback.push({
        key,
        name: item?.provider || key,
        supportsRefresh: !!item?.supportsRefresh,
        registered: !!item?.registered,
        valid: !!item?.valid,
        expiresIn: Number(item?.expiresIn || 0),
        hasRefreshToken: !!item?.hasRefreshToken,
        hasClientId: !!item?.hasClientId,
        hasClientSecret: !!item?.hasClientSecret,
        hasAccessToken: !!item?.hasAccessToken,
        clientIdMasked: item?.clientIdMasked || '',
        error: item?.error || null,
      })
    }
    return fallback
  }

  listed.sort((a, b) => {
    const ai = OAUTH_PRIORITY.indexOf(String(a?.key || '').toLowerCase())
    const bi = OAUTH_PRIORITY.indexOf(String(b?.key || '').toLowerCase())
    const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
    const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
    if (av !== bv) return av - bv
    return String(a?.name || a?.key || '').localeCompare(String(b?.name || b?.key || ''))
  })
  return listed
})

function keysByProvider(provider) {
  const pool = gw.pool.value || {}
  return Array.isArray(pool[provider]) ? pool[provider] : []
}

// ── Per-channel client-side pagination for the token tables ──
// Each channel keeps its own current page in `keyPages`; data is already in
// memory so we only slice. The pager is shown only when a channel overflows.
const keyPageSize = ref(20)
const keyPages = reactive({})
function keyPageOf(provider) {
  return keyPages[provider] || 1
}
function setKeyPage(provider, page) {
  keyPages[provider] = page
}
function pagedKeys(provider) {
  const all = keysByProvider(provider)
  const page = keyPageOf(provider)
  const start = (page - 1) * keyPageSize.value
  return all.slice(start, start + keyPageSize.value)
}

function expectedProviderIds(provider) {
  const channel = CHANNEL_MAP[provider]
  const expected = Array.isArray(channel?.adapterTypes) && channel.adapterTypes.length
    ? channel.adapterTypes.map(item => String(item).toLowerCase())
    : [String(provider).toLowerCase()]
  return [...new Set(expected)]
}

function adapterStatus(provider) {
  const adapters = Array.isArray(gw.status.value?.adapters) ? gw.status.value.adapters : []
  const expected = expectedProviderIds(provider)
  const matched = adapters.find(item => expected.includes(String(item?.type || '').toLowerCase()))
  if (matched) return matched
  return { available: false, detail: '未检测到适配器状态' }
}

function channelRuntime(provider) {
  const expected = expectedProviderIds(provider)
  const adapters = Array.isArray(gw.status.value?.adapters) ? gw.status.value.adapters : []
  const matchedAdapters = adapters.filter(item => expected.includes(String(item?.type || '').toLowerCase()))
  const hasAvailableAdapter = matchedAdapters.some(item => item?.available === true)
  if (hasAvailableAdapter) {
    const detail = matchedAdapters.find(item => String(item?.detail || '').trim())?.detail || '渠道可用'
    return { status: 'available', statusLabel: '可用', statusType: 'success', detail }
  }

  const configuredKeyCount = expected.reduce((sum, id) => sum + keysByProvider(id).length, 0)
  const hasConfigured = configuredKeyCount > 0 || matchedAdapters.length > 0
  if (hasConfigured) {
    const detail = matchedAdapters.find(item => String(item?.detail || '').trim())?.detail || '已配置但当前不可用'
    return { status: 'unavailable', statusLabel: '不可用', statusType: 'warning', detail }
  }

  return { status: 'unconfigured', statusLabel: '未配置', statusType: 'info', detail: '未配置 API Key / Token' }
}

function syncFormsFromConfig() {
  const config = gw.config.value || {}
  const defaultModelMap = config.apiPoolDefaultModelMap || {}
  const serviceMap = config.apiPoolServiceMap || {}
  for (const channel of CHANNELS) {
    const form = channelForms[channel.id]
    form.defaultModel = String(defaultModelMap[channel.id] || channel.defaultModel || '').trim()
    form.service = String(serviceMap[channel.id] || channel.defaultService || 'openai').trim()
    if (!form.endpoint) {
      const first = keysByProvider(channel.id)[0]
      if (first?.endpoint) form.endpoint = String(first.endpoint)
    }
  }
}

async function reloadAll() {
  loading.value = true
  try {
    await Promise.all([
      gw.fetchStatus(),
      gw.fetchPool(),
      gw.fetchConfig(),
      gw.fetchOAuthProviders(),
    ])
    syncFormsFromConfig()
  } catch (err) {
    ElMessage.error(err?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function saveChannelRouting(provider) {
  const config = gw.config.value || {}
  const modelMap = { ...(config.apiPoolDefaultModelMap || {}) }
  const serviceMap = { ...(config.apiPoolServiceMap || {}) }
  const model = String(channelForms[provider].defaultModel || '').trim()
  const service = String(channelForms[provider].service || '').trim()

  if (model) modelMap[provider] = model
  else delete modelMap[provider]

  if (service) serviceMap[provider] = service
  else delete serviceMap[provider]

  try {
    await gw.updateConfig({
      apiPoolDefaultModelMap: modelMap,
      apiPoolServiceMap: serviceMap,
    })
    ElMessage.success('路由配置已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '保存失败')
  }
}

async function importChannelKeys(provider) {
  const form = channelForms[provider]
  const keyInput = String(form.newKeys || '').trim()
  if (!keyInput) {
    ElMessage.warning('请先输入 Token / API Key')
    return
  }
  try {
    const result = await gw.addPoolKey(provider, {
      key: keyInput,
      endpoint: String(form.endpoint || '').trim(),
      priority: Number(form.priority || 10),
      label: String(form.label || `${provider}-bridge`).trim(),
    })
    const added = Number(result?.addedCount || 0)
    const skipped = Number(result?.skippedCount || 0)
    ElMessage.success(`已导入 ${added} 个，跳过 ${skipped} 个`)
    form.newKeys = ''
    await gw.fetchPool()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '导入失败')
  }
}

function openEditKeyDialog(provider, row) {
  keyDialog.visible = true
  keyDialog.provider = provider
  keyDialog.keyId = row.keyId
  keyDialog.keyPreview = row.keyPreview || ''
  keyDialog.endpoint = row.endpoint || ''
  keyDialog.label = row.label || ''
  keyDialog.priority = Number(row.priority || 0)
  keyDialog.saving = false
}

async function saveEditedKey() {
  keyDialog.saving = true
  try {
    await gw.updatePoolKey(keyDialog.provider, keyDialog.keyId, {
      endpoint: String(keyDialog.endpoint || '').trim(),
      label: String(keyDialog.label || '').trim(),
      priority: Number(keyDialog.priority || 0),
    })
    keyDialog.visible = false
    ElMessage.success('Token 配置已更新')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '更新失败')
  } finally {
    keyDialog.saving = false
  }
}

async function removeKey(provider, row) {
  try {
    await ElMessageBox.confirm(`确认删除 ${provider} 的 Token ${row.keyPreview || row.keyId} 吗？`, '确认删除', { type: 'warning' })
    await gw.removePoolKey(provider, row.keyId)
    ElMessage.success('已删除')
  } catch {
    // ignore cancel
  }
}

function openOAuthDialog(row) {
  oauthDialog.visible = true
  oauthDialog.provider = String(row?.key || '').trim()
  oauthDialog.providerName = String(row?.name || row?.key || '').trim()
  oauthDialog.clientId = ''
  oauthDialog.clientSecret = ''
  oauthDialog.refreshToken = ''
  oauthDialog.accessToken = ''
  oauthDialog.expiresAt = ''
  oauthDialog.saving = false
}

async function saveOAuthDialog() {
  const provider = String(oauthDialog.provider || '').trim().toLowerCase()
  if (!provider) {
    ElMessage.warning('Provider 不能为空')
    return
  }

  const payload = {}
  const clientId = String(oauthDialog.clientId || '').trim()
  const clientSecret = String(oauthDialog.clientSecret || '').trim()
  const refreshToken = String(oauthDialog.refreshToken || '').trim()
  const accessToken = String(oauthDialog.accessToken || '').trim()
  const expiresAt = String(oauthDialog.expiresAt || '').trim()

  if (clientId) payload.clientId = clientId
  if (clientSecret) payload.clientSecret = clientSecret
  if (refreshToken) payload.refreshToken = refreshToken
  if (accessToken) payload.accessToken = accessToken
  if (expiresAt) {
    const asNumber = Number(expiresAt)
    payload.expiresAt = Number.isFinite(asNumber) ? asNumber : expiresAt
  }

  if (Object.keys(payload).length === 0) {
    ElMessage.warning('至少填写一项凭据字段')
    return
  }

  oauthDialog.saving = true
  try {
    await gw.saveOAuthCredentials(provider, payload)
    oauthDialog.visible = false
    ElMessage.success('OAuth 凭据已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '保存失败')
  } finally {
    oauthDialog.saving = false
  }
}

async function refreshOAuthProviders() {
  try {
    await gw.fetchOAuthProviders()
    ElMessage.success('OAuth 状态已刷新')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '刷新失败')
  }
}

async function refreshOAuthNow(row) {
  try {
    await gw.refreshOAuth(String(row?.key || '').toLowerCase())
    ElMessage.success(`${row?.name || row?.key} Token 刷新请求已发送`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err?.message || '刷新失败')
  }
}

async function clearOAuth(row) {
  try {
    await ElMessageBox.confirm(`确认清除 ${row?.name || row?.key} 的 OAuth 凭据吗？`, '确认清除', { type: 'warning' })
    await gw.deleteOAuthCredentials(String(row?.key || '').toLowerCase())
    ElMessage.success('OAuth 凭据已清除')
  } catch {
    // ignore cancel
  }
}

onMounted(async () => {
  await reloadAll()
})

// keep-alive 重访刷新：跳过首挂避免双取。
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  reloadAll()
})
</script>

<style scoped>
.bridge-page {
  max-width: 1320px;
  margin: 0 auto;
}

.page-alert {
  margin-bottom: 14px;
}

.section-card {
  margin-bottom: 16px;
}

.card-header-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.channel-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-name {
  font-size: 16px;
  font-weight: 700;
}

.channel-detail {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.inline-inputs {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 130px;
  gap: 10px;
}

.keys-table {
  width: 100%;
}

.table-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.oauth-card {
  margin-top: 4px;
}

.oauth-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.oauth-alert {
  margin-bottom: 10px;
}

.oauth-state-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.oauth-subtext {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}
</style>
