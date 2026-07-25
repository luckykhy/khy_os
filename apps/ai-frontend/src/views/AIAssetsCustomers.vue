<template>
  <div class="assets-customers-page khy-page">
    <KhyPageHeader title="AI 资产与客户管理" subtitle="集中查看网关适配器、桥接渠道与客户资产。" />

    <el-row :gutter="16" class="summary-row">
      <el-col :span="4">
        <div class="asset-stat asset-stat--blue">
          <div class="asset-stat-label">适配器数</div>
          <div class="asset-stat-value">{{ gatewaySummary.enabledAdapters }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="asset-stat asset-stat--cyan">
          <div class="asset-stat-label">模型数</div>
          <div class="asset-stat-value">{{ gatewaySummary.totalModels }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="asset-stat asset-stat--amber">
          <div class="asset-stat-label">API 密钥数</div>
          <div class="asset-stat-value">{{ apiKeySummary.totalKeys }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="asset-stat asset-stat--green">
          <div class="asset-stat-label">账号数</div>
          <div class="asset-stat-value">{{ accountSummary.totalAccounts }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="asset-stat asset-stat--purple">
          <div class="asset-stat-label">客户数</div>
          <div class="asset-stat-value">{{ customerSummary.total }}</div>
        </div>
      </el-col>
      <el-col :span="4">
        <div class="asset-stat asset-stat--rose">
          <div class="asset-stat-label">客户令牌数</div>
          <div class="asset-stat-value">{{ customerSummary.tokens }}</div>
        </div>
      </el-col>
    </el-row>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>统一 API 接入</span>
          <el-tag size="small" type="success">可供 Trae / Claude Code / 其他应用调用</el-tag>
        </div>
      </template>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="推荐 Base URL">
          {{ preferredProxyBase || '未检测到代理地址（请先启动 proxy）' }}
        </el-descriptions-item>
        <el-descriptions-item label="HTTP Base URL">{{ proxyHttpUrl || '未启用' }}</el-descriptions-item>
        <el-descriptions-item label="HTTPS Base URL">{{ proxyHttpsUrl || '未启用' }}</el-descriptions-item>
        <el-descriptions-item label="鉴权 Header">
          <div class="copy-row">
            <span>Authorization: Bearer {{ selectedTokenDisplay }}</span>
            <el-button size="small" @click="copySelectedToken">复制令牌</el-button>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="OpenAI Chat 端点">{{ proxyChatEndpoint }}</el-descriptions-item>
        <el-descriptions-item label="模型列表端点">{{ proxyModelsEndpoint }}</el-descriptions-item>
        <el-descriptions-item label="快速复制">
          <div class="copy-row">
            <el-button size="small" @click="copyPreferredBase">复制 Base URL</el-button>
            <el-button size="small" @click="copyChatEndpoint">复制 Chat 端点</el-button>
            <el-button size="small" @click="copyModelsEndpoint">复制 Models 端点</el-button>
          </div>
        </el-descriptions-item>
      </el-descriptions>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        style="margin-top: 12px;"
        title="自动导入后会生成“自动共享 API”客户与令牌，可直接用于外部应用接入。"
      />
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>模型清单与令牌映射</span>
          <div class="header-actions">
            <el-switch v-model="showSecrets" inline-prompt active-text="显示令牌" inactive-text="隐藏令牌" />
            <el-button size="small" @click="refreshAll" :loading="svc.loadingOverview.value || svc.loadingCustomers.value">刷新</el-button>
          </div>
        </div>
      </template>

      <el-row :gutter="16">
        <el-col :span="10">
          <el-form label-width="90px">
            <el-form-item label="模型">
              <el-select v-model="selectedModel" clearable filterable placeholder="请选择模型">
                <el-option v-for="m in modelOptions" :key="m.id" :label="m.id" :value="m.id" />
              </el-select>
            </el-form-item>
          </el-form>

          <el-table :data="adapterRows" size="small" stripe>
            <el-table-column prop="key" label="适配器" width="120" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="row.available ? 'success' : (row.enabled ? 'warning' : 'info')" size="small">
                  {{ row.available ? '可用' : (row.enabled ? '不可用' : '已禁用') }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="modelCount" label="模型数" width="100" />
            <el-table-column prop="modelError" label="错误信息" min-width="120" />
          </el-table>
        </el-col>

        <el-col :span="14">
          <el-alert
            v-if="selectedModel"
            type="info"
            :closable="false"
            show-icon
            :title="`模型：${selectedModel}`"
            style="margin-bottom: 12px;"
          />
          <el-table :data="modelTokenRows" size="small" stripe>
            <el-table-column prop="customerName" label="客户" width="180" />
            <el-table-column prop="tokenId" label="令牌 ID" width="120" />
            <el-table-column prop="tokenLabel" label="标签" width="140" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="令牌" min-width="220">
              <template #default="{ row }">{{ row.tokenDisplay }}</template>
            </el-table-column>
            <el-table-column label="复制" width="90">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="copyTokenById(row.tokenId)">复制</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!modelTokenRows.length" description="暂无令牌可访问所选模型" />
        </el-col>
      </el-row>
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>客户列表</span>
          <el-button size="small" type="primary" @click="openCreateDialog">新增客户</el-button>
        </div>
      </template>

      <el-table
        :data="pagedCustomers"
        size="small"
        stripe
        highlight-current-row
        :current-row-key="selectedCustomerId"
        row-key="id"
        @current-change="onSelectCustomer"
      >
        <el-table-column prop="id" label="ID" width="150" />
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '禁用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="供应商范围" min-width="140">
          <template #default="{ row }">{{ row.allowedProviders?.length ? row.allowedProviders.join(', ') : '全部' }}</template>
        </el-table-column>
        <el-table-column label="模型数" width="100">
          <template #default="{ row }">{{ row.allowedModels?.length || 0 }}</template>
        </el-table-column>
        <el-table-column label="令牌数" width="100">
          <template #default="{ row }">{{ row.enabledTokenCount }}/{{ row.tokenCount }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click.stop="openEditDialog(row)">编辑</el-button>
            <el-button v-if="row.enabled" size="small" link type="warning" @click.stop="toggleCustomer(row, false)">禁用</el-button>
            <el-button v-else size="small" link type="success" @click.stop="toggleCustomer(row, true)">启用</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="customers.length > customerPageSize" class="table-pager">
        <el-pagination
          v-model:current-page="customerPage"
          v-model:page-size="customerPageSize"
          :total="customers.length"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          size="small"
          background
        />
      </div>
    </el-card>

    <el-card class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>客户令牌</span>
          <div class="header-actions">
            <el-button size="small" :disabled="!selectedCustomer" @click="openChannelIssueDialog">按渠道签发</el-button>
            <el-button size="small" type="primary" :disabled="!selectedCustomer" @click="openIssueTokenDialog">签发令牌</el-button>
          </div>
        </div>
      </template>

      <div v-if="selectedCustomer">
        <el-alert
          :title="`当前客户：${selectedCustomer.name} (${selectedCustomer.id})`"
          type="success"
          :closable="false"
          show-icon
          style="margin-bottom: 12px;"
        />
        <el-table :data="selectedCustomer.tokens" size="small" stripe>
          <el-table-column prop="id" label="令牌 ID" width="130" />
          <el-table-column prop="label" label="标签" width="150" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '禁用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="令牌" min-width="220">
            <template #default="{ row }">{{ showSecrets ? (row.token || row.tokenMasked) : row.tokenMasked }}</template>
          </el-table-column>
          <el-table-column label="操作" width="220">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="rotateToken(row)">轮换</el-button>
              <el-button size="small" link type="primary" @click="copyTokenById(row.id)">复制</el-button>
              <el-button
                v-if="row.enabled"
                size="small"
                link
                type="warning"
                @click="toggleToken(selectedCustomer, row, false)"
              >
                禁用
              </el-button>
              <el-button
                v-else
                size="small"
                link
                type="success"
                @click="toggleToken(selectedCustomer, row, true)"
              >
                启用
              </el-button>
              <el-button size="small" link type="danger" @click="removeToken(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!selectedCustomer.tokens?.length" description="暂无令牌" />
      </div>
      <el-empty v-else description="请先选择客户" />
    </el-card>

    <el-dialog v-model="customerDialog.visible" :title="customerDialog.mode === 'create' ? '创建客户' : '编辑客户'" width="640px">
      <el-form :model="customerDialog.form" label-width="120px">
        <el-form-item label="客户名称">
          <el-input v-model="customerDialog.form.name" placeholder="请输入客户名称" />
        </el-form-item>
        <el-form-item label="启用状态">
          <el-switch v-model="customerDialog.form.enabled" />
        </el-form-item>
        <el-form-item label="定价分组">
          <el-input v-model="customerDialog.form.group" placeholder="default" style="width: 220px" />
          <span class="form-hint">对应「计费定价」页的分组倍率/默认限额</span>
        </el-form-item>
        <el-form-item label="允许的供应商">
          <el-select v-model="customerDialog.form.allowedProviders" multiple filterable placeholder="留空表示允许全部供应商">
            <el-option v-for="p in providers" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="允许的模型">
          <el-input
            v-model="customerDialog.form.allowedModelsText"
            type="textarea"
            :rows="3"
            placeholder="逗号分隔，支持通配符，例如：claude/*, openai/gpt-4o-mini"
          />
        </el-form-item>
        <el-form-item label="速率限制 RPM">
          <el-input-number v-model="customerDialog.form.rpm" :min="0" :max="100000" />
          <span class="form-hint">每分钟请求数，0 表示不限（回退分组/全局默认）</span>
        </el-form-item>
        <el-form-item label="速率限制 TPM">
          <el-input-number v-model="customerDialog.form.tpm" :min="0" :max="100000000" />
          <span class="form-hint">每分钟 Token 数，0 表示不限</span>
        </el-form-item>
        <el-form-item label="月请求上限">
          <el-input-number v-model="customerDialog.form.monthlyRequests" :min="0" :max="100000000" />
        </el-form-item>
        <el-form-item label="月 Token 上限">
          <el-input-number v-model="customerDialog.form.monthlyTokens" :min="0" :max="1000000000" />
        </el-form-item>
        <el-form-item label="月预算（CNY）">
          <el-input-number v-model="customerDialog.form.monthlyBudgetCny" :min="0" :max="100000000" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="customerDialog.form.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="customerDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="customerDialog.saving" @click="saveCustomer">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="tokenDialog.visible" title="签发令牌" width="520px">
      <el-form :model="tokenDialog.form" label-width="120px">
        <el-form-item label="标签">
          <el-input v-model="tokenDialog.form.label" placeholder="令牌标签（可选）" />
        </el-form-item>
        <el-form-item label="自定义令牌">
          <el-input v-model="tokenDialog.form.token" placeholder="可选，留空自动生成" />
        </el-form-item>
        <el-form-item label="签发数量">
          <el-input-number v-model="tokenDialog.form.count" :min="1" :max="20" />
          <div style="margin-top: 6px; color: var(--el-text-color-secondary); font-size: 12px;">
            建议为第三方应用至少签发 2 个令牌（主用 + 备用）。
          </div>
        </el-form-item>
        <el-form-item label="启用状态">
          <el-switch v-model="tokenDialog.form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="tokenDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="tokenDialog.saving" @click="submitIssueToken">签发</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="channelTokenDialog.visible" title="按渠道一键签发 Key" width="680px">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="支持桥接渠道 + 模型供应商直连渠道。默认每渠道 1 个，可增加每渠道生成数量。"
        style="margin-bottom: 12px;"
      />
      <el-form :model="channelTokenDialog.form" label-width="120px">
        <el-form-item label="选择渠道">
          <el-checkbox-group v-model="channelTokenDialog.form.channelIds">
            <el-checkbox v-for="channel in channelCandidates" :key="channel.id" :label="channel.id">
              <span class="channel-picker-name">{{ channel.name }}（{{ channel.rawId }}）</span>
              <el-tag :type="channel.statusType" size="small">{{ channel.statusLabel }}</el-tag>
              <span class="channel-picker-detail" v-if="channel.detail">{{ channel.detail }}</span>
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="每渠道数量">
          <el-input-number v-model="channelTokenDialog.form.count" :min="1" :max="20" />
        </el-form-item>
        <el-form-item label="已存在处理">
          <el-switch
            v-model="channelTokenDialog.form.skipExisting"
            inline-prompt
            active-text="跳过"
            inactive-text="追加"
          />
        </el-form-item>
        <el-form-item label="签发状态">
          <el-switch v-model="channelTokenDialog.form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="channelTokenDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="channelTokenDialog.saving" @click="submitChannelIssue">
          按渠道签发
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onActivated, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAssetCustomer } from '@/composables/useAssetCustomer'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

defineOptions({ name: 'AIAssetsCustomers' })

const svc = useAssetCustomer()
const providers = ['deepseek', 'openai', 'anthropic', 'qwen', 'glm', 'doubao', 'wenxin', 'relay', 'kiro', 'cursor', 'claude', 'codex', 'trae', 'windsurf', 'vscode', 'ollama', 'api']
const BRIDGE_CHANNELS = [
  { id: 'claude', name: 'Claude Code', adapterKeys: ['claude'] },
  { id: 'codex', name: 'Codex', adapterKeys: ['codex'] },
  { id: 'kiro', name: 'Kiro', adapterKeys: ['kiro'] },
  { id: 'cursor', name: 'Cursor', adapterKeys: ['cursor'] },
  { id: 'trae', name: 'Trae', adapterKeys: ['trae'] },
  { id: 'windsurf', name: 'Windsurf', adapterKeys: ['windsurf'] },
  { id: 'api', name: '通用 API 中转', adapterKeys: ['api', 'relay_api'] },
  { id: 'relay', name: '手动中转桥接', adapterKeys: ['relay', 'clipboard'] },
  { id: 'ollama', name: 'Ollama', adapterKeys: ['ollama'] },
]
const DIRECT_PROVIDER_HINTS = ['deepseek', 'openai', 'anthropic', 'qwen', 'glm', 'doubao', 'wenxin']
const PROVIDER_NAME_MAP = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  qwen: 'Qwen',
  glm: 'GLM',
  doubao: 'Doubao',
  wenxin: 'Wenxin',
}
const BRIDGE_CHANNEL_IDS = new Set(BRIDGE_CHANNELS.map(channel => channel.id))

const selectedModel = ref('')
const selectedCustomerId = ref('')
const showSecrets = ref(false)

const customerDialog = reactive({
  visible: false,
  mode: 'create',
  saving: false,
  form: {
    id: '',
    name: '',
    enabled: true,
    group: 'default',
    allowedProviders: [],
    allowedModelsText: '',
    rpm: 0,
    tpm: 0,
    monthlyRequests: 0,
    monthlyTokens: 0,
    monthlyBudgetCny: 0,
    note: '',
  },
})

const tokenDialog = reactive({
  visible: false,
  saving: false,
  form: {
    label: '',
    token: '',
    count: 1,
    enabled: true,
  },
})

const channelTokenDialog = reactive({
  visible: false,
  saving: false,
  form: {
    channelIds: [],
    count: 1,
    skipExisting: true,
    enabled: true,
  },
})

const customers = computed(() => svc.customers.value || [])
const selectedCustomer = computed(() => customers.value.find(c => c.id === selectedCustomerId.value) || null)

// ── Client-side pagination for the customer list (already fully loaded) ──
const customerPage = ref(1)
const customerPageSize = ref(50)
const pagedCustomers = computed(() => {
  const start = (customerPage.value - 1) * customerPageSize.value
  return customers.value.slice(start, start + customerPageSize.value)
})
watch(() => customers.value.length, (len) => {
  const maxPage = Math.max(1, Math.ceil(len / customerPageSize.value))
  if (customerPage.value > maxPage) customerPage.value = maxPage
})

const overview = computed(() => svc.overview.value?.assets || {})
const gatewaySummary = computed(() => overview.value.gateway || { enabledAdapters: 0, totalModels: 0 })
const apiKeySummary = computed(() => overview.value.apiKeyPool || { totalKeys: 0, providers: [], byProvider: {} })
const accountSummary = computed(() => overview.value.accountPool || { totalAccounts: 0 })
const customerSummary = computed(() => overview.value.customers || { total: 0, tokens: 0 })
const proxySummary = computed(() => overview.value.proxy || {})
const proxyRuntime = computed(() => proxySummary.value.runtime || {})
const proxyHttpUrl = computed(() => proxyRuntime.value.http?.enabled ? proxyRuntime.value.http.url : '')
const proxyHttpsUrl = computed(() => proxyRuntime.value.https?.enabled ? proxyRuntime.value.https.url : '')
const preferredProxyBase = computed(() => proxyHttpsUrl.value || proxyHttpUrl.value || '')
const proxyChatEndpoint = computed(() => preferredProxyBase.value ? `${preferredProxyBase.value}/v1/chat/completions` : '—')
const proxyModelsEndpoint = computed(() => preferredProxyBase.value ? `${preferredProxyBase.value}/v1/models` : '—')

const selectedTokenDisplay = computed(() => {
  const preferred = selectedCustomer.value
    || customers.value.find(c => c.id === 'auto_shared')
    || customers.value[0]
    || null
  const token = preferred?.tokens?.find(t => t.enabled) || preferred?.tokens?.[0] || null
  if (!token) return '<请先签发令牌>'
  return showSecrets.value ? (token.token || token.tokenMasked || '<隐藏>') : (token.tokenMasked || '<隐藏>')
})

const adapterRows = computed(() => {
  const rows = overview.value.gateway?.adapters || []
  return rows.map(r => ({
    key: r.key,
    enabled: r.enabled,
    available: r.available,
    modelCount: r.modelCount || 0,
    modelError: r.modelError || '',
  }))
})

const bridgeChannelCandidates = computed(() => {
  const rows = adapterRows.value || []
  const connected = BRIDGE_CHANNELS.filter((channel) => channel.adapterKeys.some((key) => {
    const row = rows.find(item => item.key === key)
    if (!row) return false
    return row.available || Number(row.modelCount || 0) > 0
  }))
  const list = connected.length > 0 ? connected : BRIDGE_CHANNELS
  return list.map(channel => ({
    id: `bridge:${channel.id}`,
    rawId: channel.id,
    type: 'bridge',
    name: channel.name,
    adapterKeys: channel.adapterKeys,
  }))
})

function normalizeProviderId(raw = '') {
  return String(raw || '').trim().toLowerCase()
}

function formatProviderName(provider = '') {
  const id = normalizeProviderId(provider)
  if (!id) return ''
  return PROVIDER_NAME_MAP[id] || id.toUpperCase()
}

function getSummaryCount(row) {
  if (Number.isFinite(Number(row))) return Number(row)
  if (!row || typeof row !== 'object') return 0
  const fields = ['total', 'active', 'count', 'enabled', 'available']
  for (const field of fields) {
    const value = Number(row[field] || 0)
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function hasConfiguredProvider(provider = '') {
  const normalized = normalizeProviderId(provider)
  if (!normalized) return false

  const apiProviders = Array.isArray(apiKeySummary.value?.providers) ? apiKeySummary.value.providers : []
  if (apiProviders.map(normalizeProviderId).includes(normalized)) return true

  const apiByProvider = apiKeySummary.value?.byProvider
  if (apiByProvider && typeof apiByProvider === 'object') {
    const row = apiByProvider[normalized]
    if (getSummaryCount(row) > 0) return true
  }

  const accountByProvider = accountSummary.value?.byProvider
  if (accountByProvider && typeof accountByProvider === 'object') {
    const row = accountByProvider[normalized]
    if (getSummaryCount(row) > 0) return true
  }

  return false
}

function computeChannelStatus(channel) {
  const keys = Array.isArray(channel?.adapterKeys) && channel.adapterKeys.length > 0
    ? channel.adapterKeys
    : [channel?.rawId]
  const keySet = new Set(keys.map(normalizeProviderId).filter(Boolean))
  const matched = adapterRows.value.filter(row => keySet.has(normalizeProviderId(row.key)))
  const available = matched.some(row => row.available === true)
  const hasAdapterRecord = matched.length > 0
  const configuredByProvider = keys.some(provider => hasConfiguredProvider(provider))
  const configured = configuredByProvider || hasAdapterRecord

  if (available) {
    const modelCount = matched.reduce((sum, row) => sum + Number(row.modelCount || 0), 0)
    const detail = modelCount > 0 ? `已检测模型 ${modelCount} 个` : '已连通'
    return { status: 'available', statusLabel: '可用', statusType: 'success', detail }
  }
  if (configured) {
    const detail = matched.find(row => String(row.modelError || '').trim())?.modelError || '已配置但当前不可用'
    return { status: 'unavailable', statusLabel: '不可用', statusType: 'warning', detail }
  }
  return { status: 'unconfigured', statusLabel: '未配置', statusType: 'info', detail: '未配置 key/token' }
}

const providerChannelCandidates = computed(() => {
  const set = new Set(DIRECT_PROVIDER_HINTS)
  const apiProviders = apiKeySummary.value?.providers
  if (Array.isArray(apiProviders)) {
    for (const provider of apiProviders) set.add(normalizeProviderId(provider))
  }
  const apiByProvider = apiKeySummary.value?.byProvider
  if (apiByProvider && typeof apiByProvider === 'object') {
    for (const provider of Object.keys(apiByProvider)) set.add(normalizeProviderId(provider))
  }
  const accountByProvider = accountSummary.value?.byProvider
  if (accountByProvider && typeof accountByProvider === 'object') {
    for (const provider of Object.keys(accountByProvider)) set.add(normalizeProviderId(provider))
  }

  const rows = []
  for (const provider of set) {
    const normalized = normalizeProviderId(provider)
    if (!normalized) continue
    if (BRIDGE_CHANNEL_IDS.has(normalized)) continue
    if (!/^[a-z0-9._-]{2,40}$/.test(normalized)) continue
    rows.push({
      id: `provider:${normalized}`,
      rawId: normalized,
      type: 'provider',
      provider: normalized,
      name: `${formatProviderName(normalized)} 直连`,
      adapterKeys: [normalized],
    })
  }
  return rows.sort((a, b) => a.rawId.localeCompare(b.rawId))
})

const channelCandidates = computed(() => {
  const byId = new Map()
  for (const channel of [...bridgeChannelCandidates.value, ...providerChannelCandidates.value]) {
    byId.set(channel.id, channel)
  }
  return [...byId.values()].map((channel) => ({
    ...channel,
    ...computeChannelStatus(channel),
  }))
})

const modelOptions = computed(() => {
  const rows = overview.value.gateway?.list || []
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))
})

function parseCsv(text = '') {
  return String(text)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function hasModelAccess(customer, modelId) {
  if (!modelId) return true
  const normalizedModel = String(modelId).toLowerCase()
  const slash = normalizedModel.indexOf('/')
  const provider = slash > 0 ? normalizedModel.slice(0, slash) : ''

  if (customer.allowedProviders?.length) {
    if (!provider || !customer.allowedProviders.includes(provider)) return false
  }

  if (!customer.allowedModels?.length) return true
  const matchRule = (rule) => {
    const normalizedRule = String(rule || '').toLowerCase()
    if (!normalizedRule) return false
    if (normalizedRule === '*') return true
    if (!normalizedRule.includes('*')) return normalizedRule === normalizedModel
    const escaped = normalizedRule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(normalizedModel)
  }
  return customer.allowedModels.some(matchRule)
}

const modelTokenRows = computed(() => {
  const rows = []
  for (const customer of customers.value) {
    if (!customer.enabled) continue
    if (!hasModelAccess(customer, selectedModel.value)) continue
    for (const token of customer.tokens || []) {
      rows.push({
        customerId: customer.id,
        customerName: customer.name,
        tokenId: token.id,
        tokenLabel: token.label || '',
        enabled: token.enabled,
        tokenDisplay: showSecrets.value ? (token.token || token.tokenMasked) : token.tokenMasked,
      })
    }
  }
  return rows
})

function findTokenById(tokenId) {
  const id = String(tokenId || '').trim()
  if (!id) return null
  for (const customer of customers.value) {
    for (const token of customer.tokens || []) {
      if (String(token.id || '').trim() === id) {
        return token
      }
    }
  }
  return null
}

function channelLabelPrefix(channel) {
  if (channel?.type === 'provider') {
    return `[provider:${channel.rawId}]`
  }
  return `[channel:${channel?.rawId || ''}]`
}

function findChannelToken(customer, channel) {
  const prefix = channelLabelPrefix(channel)
  return (customer?.tokens || []).find(token => String(token.label || '').startsWith(prefix))
}

function getPreferredToken() {
  const preferred = selectedCustomer.value
    || customers.value.find(c => c.id === 'auto_shared')
    || customers.value[0]
    || null
  return preferred?.tokens?.find(t => t.enabled) || preferred?.tokens?.[0] || null
}

async function ensureTokenSecretsLoaded() {
  const hasAnyRawToken = customers.value.some(c => (c.tokens || []).some(t => t.token))
  if (!hasAnyRawToken) {
    await svc.fetchCustomers({ includeSecrets: true, model: selectedModel.value || '' })
  }
}

async function copyText(text, label = '内容') {
  const value = String(text || '').trim()
  if (!value || value === '—') {
    ElMessage.warning(`${label}为空，无法复制`)
    return false
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      ElMessage.success(`${label}已复制`)
      return true
    }
  } catch {
    // fallback below
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', 'readonly')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (ok) {
      ElMessage.success(`${label}已复制`)
      return true
    }
  } catch {
    // ignore
  }

  ElMessage.error(`复制${label}失败，请手动复制`)
  return false
}

async function copySelectedToken() {
  try {
    await ensureTokenSecretsLoaded()
    const token = getPreferredToken()
    const raw = String(token?.token || '').trim()
    if (!raw) {
      ElMessage.warning('未获取到明文令牌，请先开启“显示令牌”并刷新后重试')
      return
    }
    await copyText(raw, '令牌')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '复制失败')
  }
}

async function copyTokenById(tokenId) {
  try {
    await ensureTokenSecretsLoaded()
    const token = findTokenById(tokenId)
    const raw = String(token?.token || '').trim()
    if (!raw) {
      ElMessage.warning('该令牌暂无明文，请先刷新后重试')
      return
    }
    await copyText(raw, '令牌')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '复制失败')
  }
}

async function copyPreferredBase() {
  await copyText(preferredProxyBase.value, 'Base URL')
}

async function copyChatEndpoint() {
  await copyText(proxyChatEndpoint.value, 'Chat 端点')
}

async function copyModelsEndpoint() {
  await copyText(proxyModelsEndpoint.value, 'Models 端点')
}

async function refreshAll() {
  try {
    await svc.refreshAll({ includeSecrets: showSecrets.value })
    if (!selectedCustomerId.value && customers.value.length) {
      selectedCustomerId.value = customers.value[0].id
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  }
}

function onSelectCustomer(row) {
  selectedCustomerId.value = row?.id || ''
}

function openCreateDialog() {
  customerDialog.mode = 'create'
  customerDialog.visible = true
  customerDialog.saving = false
  customerDialog.form = {
    id: '',
    name: '',
    enabled: true,
    group: 'default',
    allowedProviders: [],
    allowedModelsText: '',
    rpm: 0,
    tpm: 0,
    monthlyRequests: 0,
    monthlyTokens: 0,
    monthlyBudgetCny: 0,
    note: '',
  }
}

function openEditDialog(row) {
  customerDialog.mode = 'edit'
  customerDialog.visible = true
  customerDialog.saving = false
  customerDialog.form = {
    id: row.id,
    name: row.name,
    enabled: row.enabled !== false,
    group: row.group || 'default',
    allowedProviders: [...(row.allowedProviders || [])],
    allowedModelsText: (row.allowedModels || []).join(', '),
    rpm: row.limits?.rpm || 0,
    tpm: row.limits?.tpm || 0,
    monthlyRequests: row.quota?.monthlyRequests || 0,
    monthlyTokens: row.quota?.monthlyTokens || 0,
    monthlyBudgetCny: row.quota?.monthlyBudgetCny || 0,
    note: row.note || '',
  }
}

async function saveCustomer() {
  if (!customerDialog.form.name?.trim()) {
    ElMessage.warning('客户名称不能为空')
    return
  }

  customerDialog.saving = true
  const payload = {
    name: customerDialog.form.name,
    enabled: customerDialog.form.enabled,
    group: (customerDialog.form.group || 'default').trim() || 'default',
    allowedProviders: customerDialog.form.allowedProviders || [],
    allowedModels: parseCsv(customerDialog.form.allowedModelsText),
    limits: {
      rpm: customerDialog.form.rpm || 0,
      tpm: customerDialog.form.tpm || 0,
    },
    quota: {
      monthlyRequests: customerDialog.form.monthlyRequests || 0,
      monthlyTokens: customerDialog.form.monthlyTokens || 0,
      monthlyBudgetCny: customerDialog.form.monthlyBudgetCny || 0,
    },
    note: customerDialog.form.note || '',
  }

  try {
    if (customerDialog.mode === 'create') {
      const created = await svc.createCustomer(payload)
      selectedCustomerId.value = created.id
      ElMessage.success('客户已创建')
    } else {
      await svc.updateCustomer(customerDialog.form.id, payload)
      selectedCustomerId.value = customerDialog.form.id
      ElMessage.success('客户已更新')
    }
    await svc.fetchOverview()
    await svc.fetchCustomers({ includeSecrets: showSecrets.value })
    customerDialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    customerDialog.saving = false
  }
}

async function toggleCustomer(row, enabled) {
  try {
    if (enabled) await svc.enableCustomer(row.id)
    else await svc.disableCustomer(row.id)
    await svc.fetchOverview()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  }
}

function openIssueTokenDialog() {
  if (!selectedCustomer.value) return
  tokenDialog.visible = true
  tokenDialog.saving = false
  tokenDialog.form = { label: '', token: '', count: 1, enabled: true }
}

function openChannelIssueDialog() {
  if (!selectedCustomer.value) return
  const defaultIds = channelCandidates.value.map(channel => channel.id)
  channelTokenDialog.visible = true
  channelTokenDialog.saving = false
  channelTokenDialog.form = {
    channelIds: defaultIds,
    count: 1,
    skipExisting: true,
    enabled: true,
  }
}

async function submitChannelIssue() {
  if (!selectedCustomer.value) return
  const selectedIds = [...new Set((channelTokenDialog.form.channelIds || []).map(id => String(id || '').trim()).filter(Boolean))]
  if (selectedIds.length === 0) {
    ElMessage.warning('请至少选择一个渠道')
    return
  }
  const perChannelCount = Number(channelTokenDialog.form.count || 1)
  if (!Number.isFinite(perChannelCount) || perChannelCount <= 0) {
    ElMessage.warning('每渠道数量必须大于 0')
    return
  }

  channelTokenDialog.saving = true
  const selectedMap = new Map(channelCandidates.value.map(channel => [channel.id, channel]))
  let createdCount = 0
  const skipped = []
  const failed = []
  const customerId = selectedCustomer.value.id

  try {
    for (const channelId of selectedIds) {
      const channel = selectedMap.get(channelId)
      if (!channel) continue
      if (channelTokenDialog.form.skipExisting && findChannelToken(selectedCustomer.value, channel)) {
        skipped.push(channel.name)
        continue
      }
      try {
        await svc.issueToken(customerId, {
          label: `${channelLabelPrefix(channel)} ${channel.name}`,
          enabled: channelTokenDialog.form.enabled,
          count: perChannelCount,
        }, { refresh: false })
        createdCount += perChannelCount
      } catch (err) {
        failed.push({
          name: channel.name,
          error: err?.response?.data?.error || err?.message || '签发失败',
        })
      }
    }

    await Promise.all([
      svc.fetchOverview(),
      svc.fetchCustomers({ includeSecrets: showSecrets.value }),
    ])

    const statusParts = []
    statusParts.push(`新增 ${createdCount} 个`)
    if (skipped.length > 0) statusParts.push(`已存在跳过 ${skipped.length} 个`)
    if (failed.length > 0) statusParts.push(`失败 ${failed.length} 个`)

    if (failed.length > 0) {
      ElMessage.warning(`按渠道签发完成：${statusParts.join('，')}`)
      const details = failed.map(item => `${item.name}: ${item.error}`).join('\n')
      await ElMessageBox.alert(details || '部分渠道签发失败', '失败详情', { type: 'warning' })
    } else {
      ElMessage.success(`按渠道签发完成：${statusParts.join('，')}`)
      channelTokenDialog.visible = false
    }
  } finally {
    channelTokenDialog.saving = false
  }
}

async function submitIssueToken() {
  if (!selectedCustomer.value) return
  const count = Number(tokenDialog.form.count || 1)
  if (!Number.isFinite(count) || count <= 0) {
    ElMessage.warning('签发数量必须大于 0')
    return
  }
  tokenDialog.saving = true
  try {
    const created = await svc.issueToken(selectedCustomer.value.id, tokenDialog.form)
    const createdTokens = Array.isArray(created?.tokens) ? created.tokens : [created].filter(Boolean)
    if (createdTokens.length > 1) {
      ElMessage.success(`已签发 ${createdTokens.length} 个令牌`)
    } else {
      ElMessage.success(`令牌已签发：${createdTokens[0]?.tokenMasked || ''}`)
    }
    await svc.fetchOverview()
    tokenDialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    tokenDialog.saving = false
  }
}

async function rotateToken(tokenRow) {
  if (!selectedCustomer.value) return
  try {
    const { value } = await ElMessageBox.prompt(
      '留空则自动生成，或输入自定义令牌',
      `轮换令牌（${tokenRow.id}）`,
      {
        confirmButtonText: '确认轮换',
        cancelButtonText: '取消',
        inputPlaceholder: 'khy-xxxxx',
      },
    )
    const rotated = await svc.rotateToken(selectedCustomer.value.id, tokenRow.id, value || '')
    ElMessage.success(`已轮换：${rotated.tokenMasked}`)
    await svc.fetchOverview()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.error || err.message)
    }
  }
}

async function toggleToken(customer, token, enabled) {
  try {
    if (enabled) await svc.enableToken(customer.id, token.id)
    else await svc.disableToken(customer.id, token.id)
    await svc.fetchOverview()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  }
}

async function removeToken(tokenRow) {
  if (!selectedCustomer.value) return
  try {
    await ElMessageBox.confirm(`确认删除令牌 ${tokenRow.id} 吗？`, '确认删除', { type: 'warning' })
    await svc.deleteToken(selectedCustomer.value.id, tokenRow.id)
    await svc.fetchOverview()
    ElMessage.success('令牌已删除')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.error || err.message)
    }
  }
}

watch(showSecrets, async (val) => {
  try {
    await svc.fetchCustomers({ includeSecrets: val })
  } catch { /* ignore */ }
})

onMounted(async () => {
  await refreshAll()
})

// keep-alive 重访刷新：跳过首挂（Vue 3 首挂时 onActivated 紧随 onMounted，会双取）。
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  refreshAll()
})
</script>

<style scoped>
.assets-customers-page {
  max-width: 1280px;
  margin: 0 auto;
}

.table-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--khy-text-muted, #909399);
}

.summary-row {
  margin-bottom: 16px;
}

.asset-stat {
  padding: 14px 16px;
  border: 1px solid #e5ebf5;
  border-radius: 10px;
  background: linear-gradient(180deg, #ffffff, #f8fbff);
  box-shadow: 0 4px 10px rgba(15, 23, 42, 0.04);
  transition: transform 0.2s ease;
}

.asset-stat:hover {
  transform: translateY(-2px);
}

.asset-stat--blue   { border-left: 3px solid #3b82f6; }
.asset-stat--cyan   { border-left: 3px solid #06b6d4; }
.asset-stat--amber  { border-left: 3px solid #f59e0b; }
.asset-stat--green  { border-left: 3px solid #10b981; }
.asset-stat--purple { border-left: 3px solid #8b5cf6; }
.asset-stat--rose   { border-left: 3px solid #f43f5e; }

.asset-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.asset-stat-value {
  font-size: 24px;
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.channel-picker-name {
  margin-right: 8px;
}

.channel-picker-detail {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
