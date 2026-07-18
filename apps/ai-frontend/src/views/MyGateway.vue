<template>
  <div class="my-gateway" v-loading="gw.loading.value">
    <div class="mg-intro">
      <h2 class="mg-title">我的网关</h2>
      <p class="mg-sub">配置你自己的上游中转、密钥池与 Claude Code 接入。一切都与其他用户隔离，仅你可见。</p>
    </div>

    <GatewayOnboarding
      scope="user"
      :presets="gw.providerPresets.value"
      :configured="isConfigured"
    />

    <!-- 按功能领域聚合:接入配置 / 密钥与供应商 / 模型管理 / 令牌接入。
         所有 pane 默认非 lazy 常驻 DOM,切页不卸载,数据与引用不受影响。 -->
    <el-tabs v-model="activeTab" class="mg-tabs">
      <el-tab-pane label="接入配置" name="access">
        <RelayConfigCard
          scope="user"
          :config="gw.relayConfig.value"
          :saving="gw.saving.value"
          :presets="gw.providerPresets.value"
          @save="onSaveRelay"
        />
      </el-tab-pane>

      <el-tab-pane label="密钥与供应商" name="keys">
        <CustomProviderCard
          id="mg-provider-card"
          scope="user"
          :providers="gw.providers.value"
          :models="gw.models.value"
          :busy="providerBusy"
          :presets="gw.providerPresets.value"
          @add="onAddProvider"
          @add-model="onAddProviderModel"
          @remove-entry="onRemoveEntry"
          @remove-provider="onRemoveProvider"
          @replace-entry="onReplaceEntry"
          @remove-model="onRemoveModel"
          @open-config="onOpenConfig"
        />
      </el-tab-pane>

      <el-tab-pane label="模型管理" name="models">
        <div class="mg-grid">
          <MyModelsCard
            :models="gw.models.value"
            :presets="gw.providerPresets.value"
            :busy="modelBusy"
            @add="onAddModel"
            @update="onUpdateModel"
            @remove="onRemoveModel"
          />

          <ImageModelCard
            :current="imageCurrent"
            :options="imageOptions"
            :busy="gw.loading.value"
            @update="onUpdateImageConfig"
          />
        </div>

    <!-- Multi-pivot view over my own providers / keys / relay model. Same data,
         grouped by different axes — identical client-side pivot as the global
         plane (composables/useModelPivots.js). -->
    <el-card class="mg-catalog-card" shadow="never">
      <template #header>
        <div class="mg-catalog-head">
          <span class="mg-catalog-title">模型总览 · 多视角</span>
          <div class="mg-catalog-controls">
            <el-radio-group v-model="viewMode" size="small">
              <el-radio-button v-for="v in pivotViews" :key="v.value" :value="v.value">{{ v.label }}</el-radio-button>
            </el-radio-group>
            <el-input v-model="search" size="small" clearable placeholder="搜索模型 / 供应商" class="mg-catalog-search" />
            <el-button size="small" type="primary" plain :loading="gw.detecting.value" @click="onDetect">检测 / 刷新</el-button>
          </div>
        </div>
      </template>

      <!-- State transparency: report what each detector saw on the last detect. -->
      <div v-if="detectionLine || detectionErrors.length || detectionSkipped.length" class="mg-detect-summary">
        <span v-if="detectionLine" class="mg-detect-text">{{ detectionLine }}</span>
        <el-tag
          v-for="(e, i) in detectionErrors"
          :key="i"
          size="small"
          type="danger"
          effect="plain"
        >{{ e }}</el-tag>
        <span v-if="detectionSkipped.length" class="mg-detect-skip">
          {{ detectionSkipped.join('、') }} 无 /models 接口，已跳过自动发现（可手动添加模型）
        </span>
      </div>

      <el-empty
        v-if="!pivotedGroups.length"
        :description="search.trim()
          ? `没有匹配「${search.trim()}」的项`
          : '暂无内容（先配置上游或添加供应商 Key）'"
        :image-size="64"
      />
      <div v-else class="mg-pivot-list" v-loading="modelBusy">
        <div v-for="group in pivotedGroups" :key="group.groupKey" class="mg-pivot-group">
          <div class="mg-pivot-group-head">
            <span class="mg-pivot-group-name">{{ groupHeadName(group) }}</span>
            <!-- Own-key group: show YOUR key as a masked preview (sk-…xxxx) + its
                 label, so "where is my key" is answered inline. Only the user's
                 own keys reach here (join by row id); system keys stay read-only
                 in the bucket below and never surface a value. -->
            <template v-if="keyGroupKind(group) === 'own-key' && ownKeyInfo(group)">
              <el-tag size="small" type="success" effect="plain" class="mg-key-mask">{{ ownKeyInfo(group).keyMasked || '已配置 Key' }}</el-tag>
              <span v-if="ownKeyInfo(group).label" class="mg-pivot-group-hint">{{ ownKeyInfo(group).label }}</span>
            </template>
            <!-- System-key bucket: spell out WHY it's read-only + what it covers,
                 instead of a bare "(系统密钥)" label. Managing system keys is the
                 admin "AI 网关 → API 密钥池" job; never editable on the user plane. -->
            <template v-if="keyGroupKind(group) === 'system'">
              <el-tag size="small" type="info" effect="plain">系统统管 · 只读</el-tag>
              <span class="mg-pivot-group-hint">{{ systemBucketSummary(group) }}</span>
            </template>
            <span class="mg-pivot-group-count">{{ group.edges.length }} 个</span>
            <!-- Own-key group: route to the provider/key editor (replace stays
                 single-source in CustomProviderCard — the pivot only navigates). -->
            <el-button
              v-if="keyGroupKind(group) === 'own-key' && ownKeyGroupProvider(group)"
              link
              size="small"
              @click="scrollToProviderEditor(ownKeyGroupProvider(group))"
            >编辑/替换此 Key</el-button>
            <!-- Add model: by-provider groups, and own-key groups resolvable to a
                 single provider. System / no-key buckets get no add affordance. -->
            <el-button
              v-if="addModelProvider(group)"
              link
              size="small"
              type="primary"
              @click="onAddModelToGroup(group)"
            >+ 添加模型</el-button>
          </div>
          <div class="mg-pivot-rows">
            <div v-for="edge in group.edges" :key="`${edge.provider}:${edge.model}:${edge.keyIds.join(',')}:${group.groupKey}`" class="mg-pivot-row">
              <span class="mg-pivot-model">{{ edge.model || '—' }}</span>
              <el-tag size="small" type="info" effect="plain">{{ edge.providerLabel || edge.provider }}</el-tag>
              <el-tag v-if="edge.isDefault" size="small" type="warning" effect="plain">默认</el-tag>
              <el-tag v-if="edge.tier" size="small" effect="plain">{{ edge.tier }}</el-tag>
              <!-- Editable rows expose capability via the el-select below; read-only
                   rows still show it as a tag so no info is lost. -->
              <el-tag v-if="!userEdgeEditable(edge, gw.models.value)" size="small" effect="plain">{{ capabilityLabel(edge.capability) }}</el-tag>
              <el-tag size="small" :type="statusTagType(edge.status)" effect="plain">{{ statusLabel(edge.status) }}</el-tag>
              <el-tag size="small" type="info" effect="plain">{{ connectionLabel(edge.connectionMode) }}</el-tag>
              <el-tag v-if="edge.source" size="small" :type="sourceTagType(edge.source)" effect="light">{{ sourceLabel(edge.source) }}</el-tag>

              <!-- Inline edit on a user-owned, row-backed edge: capability / active /
                   delete drive the SAME mutations as MyModelsCard. system / local /
                   rowless edges stay read-only (tenant isolation + state transparency). -->
              <template v-if="userEdgeEditable(edge, gw.models.value)">
                <el-select
                  :model-value="edge.capability"
                  size="small"
                  class="mg-pivot-cap"
                  @change="(v) => onPivotChangeCapability(edge, v)"
                >
                  <el-option v-for="c in CAPABILITIES" :key="c.value" :label="c.label" :value="c.value" />
                </el-select>
                <el-switch
                  :model-value="userEdgeRow(edge)?.isActive !== false"
                  size="small"
                  inline-prompt
                  active-text="启"
                  inactive-text="停"
                  @change="(v) => onPivotToggleActive(edge, v)"
                />
                <el-button link type="danger" size="small" @click="onPivotRemove(edge)">删除</el-button>
              </template>
              <el-tag v-else size="small" type="info" effect="plain">{{ userEdgeReadonlyTag(edge) }}</el-tag>
            </div>
          </div>
        </div>
      </div>
    </el-card>
      </el-tab-pane>

      <el-tab-pane label="令牌接入" name="tokens">
        <CcAccessCard
          scope="user"
          :endpoint="gw.ccEndpoint.value"
          :tokens="gw.ccTokens.value"
          :busy="ccBusy"
          :just-issued="justIssued"
          @issue="onIssueToken"
          @revoke="onRevokeToken"
        />
      </el-tab-pane>
    </el-tabs>

    <!-- Interactive provider/key wizard: configure a provider + key + models,
         dry-run "测试连接" to verify and import discovered models, or edit an
         existing entry (rotate key / rename provider / sync models). Hosted here
         so it overlays the whole page; CustomProviderCard only requests it. -->
    <ProviderConfigDialog
      v-model:visible="configVisible"
      :mode="configMode"
      :entry="configEntry"
      :initial-models="configInitialModels"
      :presets="gw.providerPresets.value"
      :tester="gw.testProviderConfig"
      :busy="configBusy"
      @submit="onConfigSubmit"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserGateway } from '@/composables/useUserGateway'
import { VIEWS as pivotViews, pivotEdges, capabilityLabel, statusLabel, connectionLabel, statusTagType, sourceLabel, sourceTagType, SYSTEM_KEY_BUCKET, NO_KEY_BUCKET } from '@/composables/useModelPivots'
import { userEdgeRowId, userEdgeEditable, userEdgeReadonlyTag, ownKeyRowForGroup } from '@/composables/gatewayInlineEdit'
import RelayConfigCard from '@/components/gateway/RelayConfigCard.vue'
import CustomProviderCard from '@/components/gateway/CustomProviderCard.vue'
import ProviderConfigDialog from '@/components/gateway/ProviderConfigDialog.vue'
import MyModelsCard from '@/components/gateway/MyModelsCard.vue'
import CcAccessCard from '@/components/gateway/CcAccessCard.vue'
import ImageModelCard from '@/components/gateway/ImageModelCard.vue'
import GatewayOnboarding from '@/components/gateway/GatewayOnboarding.vue'

const gw = useUserGateway()
const providerBusy = ref(false)
const modelBusy = ref(false)
const ccBusy = ref(false)
const justIssued = ref('')

// 分类标签页:按功能领域聚合(接入 / 密钥 / 模型 / 令牌),选中项记忆到 localStorage。
// 读失败(隐私模式等)或值非法时回落到「接入配置」。
const TAB_STORAGE_KEY = 'khy_my_gateway_tab'
const VALID_TABS = ['access', 'keys', 'models', 'tokens']
function readGatewayTab() {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY)
    return VALID_TABS.includes(v) ? v : 'access'
  } catch {
    return 'access'
  }
}
const activeTab = ref(readGatewayTab())
watch(activeTab, (v) => {
  try { localStorage.setItem(TAB_STORAGE_KEY, v) } catch { /* noop */ }
})

// 新手引导：是否已有任何配置（已配 relay / 供应商 Key / 模型）。决定引导默认展开还是折叠。
const isConfigured = computed(() => {
  if (Array.isArray(gw.providers.value) && gw.providers.value.length) return true
  if (Array.isArray(gw.models.value) && gw.models.value.length) return true
  const relay = gw.relayConfig.value
  if (relay && (relay.baseUrl || relay.apiKey || relay.model)) return true
  return false
})

// ── Interactive provider/key config wizard (ProviderConfigDialog) ──
// `configEntry` is the provider's primary key row when editing (null when adding);
// `configInitialModels` are that provider's current models so the dialog can show
// them as removable tags and the submit handler can diff add/remove.
const configVisible = ref(false)
const configMode = ref('add')
const configEntry = ref(null)
const configBusy = ref(false)
const configInitialModels = computed(() => {
  if (configMode.value !== 'edit' || !configEntry.value) return []
  const provider = String(configEntry.value.provider || '').toLowerCase()
  return (gw.models.value || []).filter(m => m && String(m.provider || '').toLowerCase() === provider)
})

function onOpenConfig({ mode, entry }) {
  configMode.value = mode === 'edit' ? 'edit' : 'add'
  configEntry.value = entry || null
  configVisible.value = true
}

// Multi-pivot view over my own catalog edges (shared pivot logic with global plane).
const viewMode = ref('by-provider')
const search = ref('')
const pivotedGroups = computed(() =>
  pivotEdges(Array.isArray(gw.catalogEdges.value) ? gw.catalogEdges.value : [], viewMode.value, { search: search.value }))

// Capability options for the inline pivot editor (mirrors MyModelsCard).
const CAPABILITIES = [
  { value: 'text', label: '文本' },
  { value: 'audio', label: '语音' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
]

// ── Image-generation model selection (per-user) ──
// `imageConfig` is { backend, model, source }; options come from the image edges
// already present in the per-user catalog (capability/source = 'image').
const imageCurrent = computed(() => ({
  backend: gw.imageConfig.value?.backend || 'auto',
  model: gw.imageConfig.value?.model || '',
}))
const imageOptions = computed(() => {
  const edges = Array.isArray(gw.catalogEdges.value) ? gw.catalogEdges.value : []
  const seen = new Set()
  const out = []
  for (const e of edges) {
    if (!e || (e.capability !== 'image' && e.source !== 'image')) continue
    const backend = e.provider || e.backend
    const model = e.model || ''
    if (!backend) continue
    const key = `${backend}::${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ backend, model, supportsEdit: !!e.supportsEdit })
  }
  return out
})
async function onUpdateImageConfig(payload) {
  try {
    await gw.updateImageConfig(payload)
    ElMessage.success('图像模型已更新')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '更新失败')
  }
}

// Resolve the user_provider_models row backing an editable edge (by provider+model).
function userEdgeRow(edge) {
  const id = userEdgeRowId(edge, gw.models.value)
  if (id == null) return null
  return (gw.models.value || []).find(r => r && r.id === id) || null
}

// ── by-key group classification (header affordances) ────────────────────────
// Only meaningful in the by-key view. 'system'  = the read-only (系统密钥) bucket
// (system key real but id hidden for tenant isolation); 'no-key' = the (无 Key)
// bucket; 'own-key' = a real group keyed by one of the user's OWN key ids.
function keyGroupKind(group) {
  if (viewMode.value !== 'by-key') return 'other'
  if (group.groupKey === SYSTEM_KEY_BUCKET) return 'system'
  if (group.groupKey === NO_KEY_BUCKET) return 'no-key'
  return 'own-key'
}

// The user's own provider/key row backing an own-key group (or null). Source for
// the masked preview + the authoritative target provider for add/edit jumps. The
// join (group key → masked row) is the single-source pure helper in
// gatewayInlineEdit; system keys never match here (tenant isolation).
function ownKeyInfo(group) {
  if (keyGroupKind(group) !== 'own-key') return null
  return ownKeyRowForGroup(group.groupKey, gw.providers.value)
}

// Group-head display name: own-key groups show the friendly provider name
// (display name → provider) rather than the opaque numeric key id; everything
// else keeps the pivot's own label.
function groupHeadName(group) {
  const info = ownKeyInfo(group)
  if (info) return info.displayName || info.provider || group.groupLabel
  return group.groupLabel
}

// The single provider an own-key group belongs to (for + 添加模型 / edit jump).
// Prefer the joined own-key row (authoritative); fall back to the edges' single
// provider. '' when synthetic, multi-provider, or no user-owned edge — then we
// expose no affordance (honest, never guess a target).
function ownKeyGroupProvider(group) {
  if (keyGroupKind(group) !== 'own-key') return ''
  const info = ownKeyInfo(group)
  if (info && info.provider) return String(info.provider)
  const owned = (group.edges || []).filter(e => e && (e.source === 'provider' || e.source === 'relay'))
  if (!owned.length) return ''
  const providers = new Set(owned.map(e => String(e.provider || '')))
  return providers.size === 1 ? owned[0].provider : ''
}

// The provider to add a model into for this group: by-provider uses the group
// key directly; by-key uses the resolved own-key provider; otherwise none.
function addModelProvider(group) {
  if (viewMode.value === 'by-provider' && group.groupKey) return group.groupKey
  if (viewMode.value === 'by-key') return ownKeyGroupProvider(group)
  return ''
}

// Coverage summary for the read-only system-key bucket (state transparency:
// explain WHAT it covers and WHY it's read-only, instead of a bare label).
function systemBucketSummary(group) {
  const edges = group.edges || []
  const providers = new Set(edges.map(e => String(e.provider || '')).filter(Boolean))
  return `系统统管 · 只读 · 覆盖 ${providers.size} 个供应商 / ${edges.length} 个模型`
}

// Jump to the provider/key editor card. Replacing a key is a one-click action
// on each key entry there (the「替换」button), so the pivot only routes there.
function scrollToProviderEditor(provider) {
  // 供应商 / 密钥卡现在位于「密钥与供应商」标签页。若目标 pane 未激活,
  // 元素处于 display:none 无法滚动定位 —— 先切到该页,nextTick 后再滚动。
  activeTab.value = 'keys'
  nextTick(() => {
    const el = typeof document !== 'undefined' ? document.getElementById('mg-provider-card') : null
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  if (provider) {
    ElMessage.info(`请在「自定义供应商 / 密钥池」里点供应商「${provider}」某条密钥旁的「替换」按钮更新 Key`)
  }
}

// Human-readable summary of the last detection / catalog read (state transparency).
const detectionLine = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value
  if (!s) return ''
  const parts = []
  if (s.upstream) parts.push(`上游探测新增 ${s.upstream.added ?? 0}（共 ${s.upstream.total ?? 0}）`)
  if (s.local) parts.push(s.local.running ? `本地 Ollama ${s.local.count ?? 0} 个` : '本地 Ollama 未运行')
  if (s.system) parts.push(`系统/全局 ${s.system.count ?? 0} 个`)
  return parts.join(' · ')
})
const detectionErrors = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value
  const errs = (s && Array.isArray(s.errors)) ? s.errors : []
  // Only REAL failures get a red tag. Benign outcomes (an upstream simply has no
  // /models endpoint, e.g. anthropic) are folded into the soft note below instead
  // of flashing a scary "not found" on every detect.
  return errs
    .filter(e => e && !e.benign)
    .map(e => `${e.provider ? e.provider + ': ' : ''}${e.error || ''}`.trim())
    .filter(Boolean)
})
// Providers that were probed but legitimately advertise no catalog — shown as a
// muted note (state transparency) rather than an error.
const detectionSkipped = computed(() => {
  const s = gw.detectionSummary.value || gw.catalogSources.value
  const errs = (s && Array.isArray(s.errors)) ? s.errors : []
  const names = errs.filter(e => e && e.benign && e.provider).map(e => e.provider)
  return Array.from(new Set(names))
})

onMounted(() => { gw.fetchAll() })

async function onDetect() {
  try {
    await gw.detectModels()
    ElMessage.success('检测完成')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '检测失败')
  }
}

async function onSaveRelay(payload) {
  try {
    await gw.saveRelayConfig(payload)
    ElMessage.success('上游配置已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '保存失败')
  }
}

async function onAddProvider(payload) {
  providerBusy.value = true
  try {
    // The card always sends a `models` array (possibly empty); the provider+key
    // is created first, then each seed model is added to it so a brand-new
    // provider/key/model trio lands in one submit. Key creation must succeed
    // before seeding; seeding failures are reported but never undo the key.
    const seedModels = Array.isArray(payload?.models) ? payload.models : []
    const provider = String(payload?.provider || '').trim().toLowerCase()
    const providerPayload = { ...payload }
    delete providerPayload.models
    await gw.addProvider(providerPayload)

    let seeded = 0
    const failed = []
    for (const model of seedModels) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await gw.addModel({ provider, model })
        seeded += 1
      } catch (e) {
        // A 409 (already present) is benign — the model is effectively there.
        if (e?.response?.status === 409) seeded += 1
        else failed.push(model)
      }
    }

    if (!seedModels.length) ElMessage.success('已添加密钥')
    else if (!failed.length) ElMessage.success(`已添加密钥，并新增 ${seeded} 个模型`)
    else ElMessage.warning(`已添加密钥；${seeded} 个模型已加，${failed.length} 个失败：${failed.join(', ')}`)
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '该密钥已存在' : (err?.response?.data?.message || '添加失败'))
  } finally {
    providerBusy.value = false
  }
}

// ── Config wizard submit (ProviderConfigDialog) ──
// add  → create the provider+key, then seed each chosen model.
// edit → updateProvider (may rotate key / rename provider — backend migrates the
//        provider's models), then diff the chosen model set against the original
//        and add/remove rows keyed by the (possibly new) provider name.
async function onConfigSubmit(payload) {
  configBusy.value = true
  try {
    if (payload.mode === 'edit') await submitEditConfig(payload)
    else await submitAddConfig(payload)
    configVisible.value = false
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '该供应商 / 密钥已存在' : (err?.response?.data?.message || '保存失败'))
  } finally {
    configBusy.value = false
  }
}

async function submitAddConfig(payload) {
  const provider = payload.provider
  const providerPayload = { provider, displayName: payload.displayName, key: payload.key }
  if (payload.baseUrl) providerPayload.baseUrl = payload.baseUrl
  if (payload.apiFormat) providerPayload.apiFormat = payload.apiFormat
  if (payload.endpoint) providerPayload.endpoint = payload.endpoint
  await gw.addProvider(providerPayload)

  let seeded = 0
  const failed = []
  for (const model of payload.models) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await gw.addModel({ provider, model })
      seeded += 1
    } catch (e) {
      if (e?.response?.status === 409) seeded += 1
      else failed.push(model)
    }
  }
  if (!payload.models.length) ElMessage.success('已添加供应商')
  else if (!failed.length) ElMessage.success(`已添加供应商，并新增 ${seeded} 个模型`)
  else ElMessage.warning(`已添加供应商；${seeded} 个模型已加，${failed.length} 个失败：${failed.join(', ')}`)
}

async function submitEditConfig(payload) {
  const patch = {
    provider: payload.provider,
    displayName: payload.displayName,
    baseUrl: payload.baseUrl,
    apiFormat: payload.apiFormat,
    endpoint: payload.endpoint,
  }
  // Empty key means "keep the current secret" — only send a rotation when typed.
  if (payload.key) patch.key = payload.key
  await gw.updateProvider(payload.id, patch)
  // Rename migrates the provider's models to the new name; refresh before diffing.
  await gw.fetchModels()

  const provider = payload.provider
  const finalSet = new Set(payload.models)
  const initialSet = new Set(payload.initialModels)

  // Add models the user introduced in the dialog (409 = already there, benign).
  for (const model of payload.models) {
    if (initialSet.has(model)) continue
    try {
      // eslint-disable-next-line no-await-in-loop
      await gw.addModel({ provider, model })
    } catch (e) {
      if (e?.response?.status !== 409) throw e
    }
  }
  // Remove models the user dropped — resolve each to its row id under the (new)
  // provider name. Only touch rows that were in the original set (never delete a
  // model that detection added between open and submit).
  const rows = (gw.models.value || []).filter(m => m && String(m.provider || '').toLowerCase() === provider)
  for (const row of rows) {
    if (initialSet.has(row.model) && !finalSet.has(row.model)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await gw.removeModel(row.id)
      } catch { /* ignore — best effort */ }
    }
  }
  ElMessage.success('供应商配置已保存')
}


async function onAddProviderModel(provider) {
  await promptAddModelForProvider(String(provider || '').trim().toLowerCase())
}

async function onRemoveEntry(id) {
  try {
    await gw.removeProviderEntry(id)
    ElMessage.success('已移除密钥')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '移除失败')
  }
}

async function onReplaceEntry({ id, key }) {
  try {
    await gw.replaceProviderKey(id, key)
    ElMessage.success('密钥已替换')
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '该密钥已存在' : (err?.response?.data?.message || '替换失败'))
  }
}

async function onRemoveProvider(provider) {
  try {
    await gw.removeProvider(provider)
    ElMessage.success(`已删除 provider「${provider}」`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '删除失败')
  }
}

async function onAddModel(payload) {
  modelBusy.value = true
  try {
    await gw.addModel(payload)
    ElMessage.success('已添加模型')
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '该模型已存在' : (err?.response?.data?.message || '添加失败'))
  } finally {
    modelBusy.value = false
  }
}

async function onUpdateModel({ id, patch }) {
  try {
    await gw.updateModel(id, patch)
    ElMessage.success('已更新')
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '同名模型已存在' : (err?.response?.data?.message || '更新失败'))
  }
}

async function onRemoveModel(id) {
  try {
    await gw.removeModel(id)
    ElMessage.success('已删除模型')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '删除失败')
  }
}

// ── Inline pivot edits (any view) — drive the SAME row mutations as MyModelsCard.
//    gw.updateModel/removeModel refetch the catalog internally, so the change is
//    immediately visible in every pivot view. Only row-backed user edges reach
//    here (template gate userEdgeEditable); system / local / rowless stay read-only.

async function onPivotChangeCapability(edge, capability) {
  const id = userEdgeRowId(edge, gw.models.value)
  if (id == null || capability === edge.capability) return
  modelBusy.value = true
  try {
    await gw.updateModel(id, { capability })
    ElMessage.success('已更新能力')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '更新失败')
  } finally {
    modelBusy.value = false
  }
}

async function onPivotToggleActive(edge, isActive) {
  const id = userEdgeRowId(edge, gw.models.value)
  if (id == null) return
  modelBusy.value = true
  try {
    await gw.updateModel(id, { isActive })
    ElMessage.success(isActive ? '已启用' : '已停用')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '更新失败')
  } finally {
    modelBusy.value = false
  }
}

async function onPivotRemove(edge) {
  const id = userEdgeRowId(edge, gw.models.value)
  if (id == null) return
  try {
    await ElMessageBox.confirm(`确认从你的列表删除「${edge.model}」吗？`, '删除模型', { type: 'warning' })
  } catch { return /* cancelled */ }
  modelBusy.value = true
  try {
    await gw.removeModel(id)
    ElMessage.success('已删除模型')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '删除失败')
  } finally {
    modelBusy.value = false
  }
}

// Single source for "add one model to a resolved provider": prompt for the id,
// then call the per-user models API. Shared by the catalog pivot affordance and
// the provider-key card's "+ 添加模型".
async function promptAddModelForProvider(provider) {
  if (!provider) return ElMessage.warning('该分组无法确定归属供应商，无法添加')
  let model = ''
  try {
    const res = await ElMessageBox.prompt(
      `为供应商「${provider}」添加一个模型 ID`,
      '添加模型',
      { inputPlaceholder: '如 deepseek-chat / gpt-4o-mini', confirmButtonText: '添加', cancelButtonText: '取消' },
    )
    model = String(res?.value || '').trim()
  } catch { return /* cancelled */ }
  if (!model) return ElMessage.warning('请填写模型 ID')
  modelBusy.value = true
  try {
    await gw.addModel({ provider, model })
    ElMessage.success('已添加模型')
  } catch (err) {
    const code = err?.response?.status
    ElMessage.error(code === 409 ? '该模型已存在' : (err?.response?.data?.message || '添加失败'))
  } finally {
    modelBusy.value = false
  }
}

async function onAddModelToGroup(group) {
  // by-provider → group key is the provider; by-key own-key → resolved provider.
  await promptAddModelForProvider(addModelProvider(group))
}

async function onIssueToken(label) {
  ccBusy.value = true
  try {
    const row = await gw.issueCcToken(label)
    if (row?.key) {
      justIssued.value = row.key
      ElMessage.success('已签发新 Token')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '签发失败')
  } finally {
    ccBusy.value = false
  }
}

async function onRevokeToken(id) {
  try {
    await gw.revokeCcToken(id)
    ElMessage.success('Token 已撤销')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '撤销失败')
  }
}
</script>

<style scoped>
.my-gateway { max-width: 1280px; margin: 0 auto; }
.mg-intro {
  margin-bottom: 20px;
  padding: 16px 20px;
  border: 1px solid var(--khy-border-light);
  border-radius: var(--khy-radius);
  background:
    radial-gradient(120% 140% at 0% 0%, var(--khy-primary-soft), transparent 55%),
    var(--khy-bg-card-grad);
  box-shadow: var(--khy-shadow);
}
.mg-title {
  margin: 0 0 4px;
  padding-left: 12px;
  font-size: 20px;
  font-weight: 700;
  color: var(--khy-text-strong);
  position: relative;
}
.mg-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 4px;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--khy-primary), var(--khy-primary-strong));
}
.mg-sub { margin: 0; color: var(--khy-text-secondary); font-size: 13px; line-height: 1.5; }
.mg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; align-items: start; }
.mg-tabs { margin-top: 4px; }
.mg-catalog-card { margin-top: 16px; }
.mg-catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mg-catalog-title { font-weight: 600; color: var(--khy-text-strong); }
.mg-catalog-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mg-catalog-search { max-width: 220px; }
.mg-detect-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.mg-detect-text { font-size: 12px; color: var(--el-text-color-secondary); }
.mg-detect-skip { font-size: 12px; color: var(--el-text-color-secondary); opacity: 0.8; }
.mg-pivot-list { display: flex; flex-direction: column; gap: 14px; }
.mg-pivot-group {
  padding: 12px 14px;
  border: 1px solid var(--khy-border-light);
  border-radius: var(--khy-radius-sm);
  background: var(--khy-bg-card);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}
.mg-pivot-group:hover {
  border-color: var(--khy-border);
  box-shadow: var(--khy-shadow);
  transform: translateY(-1px);
}
.mg-pivot-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mg-pivot-group-name { font-weight: 600; color: var(--el-text-color-primary); }
.mg-pivot-group-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.mg-key-mask { font-family: var(--el-font-family, monospace); letter-spacing: 0.5px; }
.mg-pivot-group-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
.mg-pivot-rows { display: flex; flex-direction: column; gap: 6px; }
.mg-pivot-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 10px; border-radius: var(--khy-radius-sm);
  background: var(--khy-bg-soft);
  transition: background-color 0.15s ease;
}
.mg-pivot-row:hover { background: var(--khy-bg-hover); }
.mg-pivot-model { font-family: var(--el-font-family, monospace); font-size: 13px; color: var(--el-text-color-primary); }
.mg-pivot-cap { width: 92px; }
</style>
