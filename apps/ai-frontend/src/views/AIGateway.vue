<template>
  <div class="ai-gateway-admin khy-page">
    <KhyPageHeader
      title="AI 网关管理"
      subtitle="把 khy 连上 AI 模型：选供应商 → 填 API Key → 选模型。下面的引导会带你完成。"
    />

    <GatewayOnboarding
      scope="admin"
      :presets="gw.customProviderPresets.value"
      :configured="isConfigured"
    />

    <!-- 按功能领域分类的标签栏。仅作分区选择器：pane 保持为空，真正的 section
         内容留在原位并靠 v-show 按当前分类显隐（避免搬动 400+ 行大块、无需重定位
         弹窗）。scoped CSS 隐藏空的 .el-tabs__content。 -->
    <el-tabs v-model="activeTab" class="gateway-tabs">
      <el-tab-pane label="接入配置" name="access" />
      <el-tab-pane label="模型管理" name="models" />
      <el-tab-pane label="密钥与供应商" name="keys" />
      <el-tab-pane label="账号与令牌" name="accounts" />
      <el-tab-pane label="路由与高级" name="routing" />
      <el-tab-pane label="监控诊断" name="monitor" />
    </el-tabs>

    <!-- Relay Model Config -->
    <el-card v-show="activeTab === 'access'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <div>
            <div class="section-title">模型与 API Key 配置</div>
            <div class="section-subtitle">兼容 Hermes / OpenClaw / OpenCode 的 OpenAI-compatible 输入方式</div>
          </div>
          <el-button size="small" @click="loadRelayModelConfig" :loading="isRelayConfigBusy">刷新</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="此处配置的是中转 Relay Key；直连供应商 Key 请在下方 API 密钥池按供应商添加。模型 ID 动态可配，Base URL 自动规范化为 /v1，API Key 支持单行/多行/Bearer/JSON。"
        style="margin-bottom: 12px;"
      />
      <el-form :model="relayConfig.form" label-width="112px">
        <el-form-item label="配置预设">
          <div class="preset-pills">
            <div v-for="group in relayPresetGroups" :key="group.key" class="preset-group">
              <span class="preset-group-label">{{ group.label }}</span>
              <el-button
                v-for="preset in group.items"
                :key="preset.value"
                size="small"
                :type="relayConfig.form.profile === preset.value ? 'primary' : 'default'"
                class="preset-pill"
                @click="handleRelayProfileChange(preset.value); relayConfig.form.profile = preset.value"
              >
                {{ preset.label }}
                <el-tag v-if="preset.category === 'partner'" size="small" type="warning" effect="plain" class="preset-badge">合作</el-tag>
                <el-tag v-else-if="preset.category === 'official'" size="small" type="success" effect="plain" class="preset-badge">官方</el-tag>
              </el-button>
            </div>
          </div>
          <div class="preset-hint">{{ relayPresetHint }}</div>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :xs="24" :md="8">
            <el-form-item label="上游协议">
              <el-select v-model="relayConfig.form.apiFormat" style="width: 100%">
                <el-option v-for="opt in relayApiFormatOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item label="鉴权头">
              <el-select v-model="relayConfig.form.apiKeyField" style="width: 100%">
                <el-option v-for="opt in relayApiKeyFieldOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item label="模型 ID">
              <el-input v-model="relayConfig.form.modelId" placeholder="如：gpt-4o-mini / claude-sonnet-4 / gemini-2.0-flash" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="Base URL">
              <el-input v-model="relayConfig.form.baseUrl" placeholder="https://your-provider.com（OpenAI 风格自动补 /v1）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="API Key">
              <el-input
                v-model="relayConfig.form.apiKey"
                type="textarea"
                :rows="3"
                placeholder="支持 sk-xxx / Bearer sk-xxx / key=sk-xxx / JSON / 多行多 Key"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="候选端点">
              <el-input
                v-model="relayConfig.form.endpoints"
                type="textarea"
                :rows="2"
                placeholder="可选：备用上游地址，每行一个；主端点失败（网络/5xx）时自动按序切换"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="兼容协议">
              <el-select v-model="relayConfig.form.compatibility" style="width: 100%">
                <el-option v-for="opt in relayCompatibilityOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
              <span class="form-hint-inline">仅作响应解析提示；实际转换由“上游协议”决定。</span>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="18">
            <el-form-item label="当前生效">
              <div class="gateway-current-meta">
                <div>Adapter：{{ relayConfig.snapshot.preferredAdapter || '未指定' }}</div>
                <div>Model：{{ relayConfig.snapshot.preferredModel || relayConfig.snapshot.modelId || '未指定' }}</div>
                <div>Base URL：{{ relayConfig.snapshot.baseUrl || '未配置' }}</div>
                <div>协议：{{ relayConfig.snapshot.apiFormat || 'openai' }} · 鉴权头：{{ relayConfig.snapshot.apiKeyField || 'authorization_bearer' }}</div>
                <div v-if="relayConfig.snapshot.endpoints.length">候选端点：{{ relayConfig.snapshot.endpoints.length }} 个备用</div>
                <div>API Key：{{ relayConfig.snapshot.hasApiKey ? relayConfig.snapshot.apiKeyMasked : '未配置' }}</div>
              </div>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="6">
            <el-form-item label="清空 Key">
              <el-switch v-model="relayConfig.form.clearApiKey" />
            </el-form-item>
          </el-col>
        </el-row>
        <div class="config-actions">
          <el-button type="primary" @click="saveRelayModelConfig" :loading="relayConfig.saving">保存模型配置</el-button>
          <span class="config-hint">不勾选“清空 Key”且留空 API Key 时，会保留当前 Key。</span>
        </div>
      </el-form>
    </el-card>

    <!-- Codex Upstream Provider Config -->
    <el-card v-show="activeTab === 'access'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <div>
            <div class="section-title">Codex 上游接入配置</div>
            <div class="section-subtitle">为 codex CLI 配置任意 OpenAI-compatible 上游（写入 ~/.codex/config.toml + auth.json，非 mindflow 专属）</div>
          </div>
          <el-button size="small" @click="loadCodexConfig" :loading="codexConfig.loading">刷新</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="选择预设可一键填充 Base URL 与默认模型；也可手动填写任意上游。保存即写入 codex 配置文件，原文件自动备份为 .khy-bak。勾选“设为当前适配器”会把网关首选适配器切到 codex。"
        style="margin-bottom: 12px;"
      />
      <el-form :model="codexConfig.form" label-width="120px">
        <el-row :gutter="12">
          <el-col :xs="24" :md="8">
            <el-form-item label="上游预设">
              <el-select v-model="codexConfig.form.preset" style="width: 100%" @change="handleCodexPresetChange">
                <el-option v-for="p in codexProviderPresets" :key="p.value" :label="p.label" :value="p.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item label="供应商名称">
              <el-input v-model="codexConfig.form.providerName" placeholder="如：mindflow / openai / my_provider" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="8">
            <el-form-item label="模型 ID">
              <el-input v-model="codexConfig.form.model" placeholder="如：gpt-5.3-codex / gpt-5-codex" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="Base URL">
              <el-input v-model="codexConfig.form.baseUrl" placeholder="https://your-upstream.com/v1" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="6">
            <el-form-item label="推理强度">
              <el-select v-model="codexConfig.form.reasoningEffort" style="width: 100%" clearable>
                <el-option v-for="opt in codexEffortOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="6">
            <el-form-item label="Wire API">
              <el-select v-model="codexConfig.form.wireApi" style="width: 100%">
                <el-option label="responses" value="responses" />
                <el-option label="chat" value="chat" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="API Key">
              <el-input
                v-model="codexConfig.form.apiKey"
                type="textarea"
                :rows="2"
                placeholder="OPENAI_API_KEY → ~/.codex/auth.json，留空则保留现有 Key"
              />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="当前生效">
              <div class="gateway-current-meta">
                <div>供应商：{{ codexConfig.snapshot.provider || '未配置' }}</div>
                <div>模型：{{ codexConfig.snapshot.model || '未配置' }}</div>
                <div>Base URL：{{ codexConfig.snapshot.baseUrl || '未配置' }}</div>
                <div>强度：{{ codexConfig.snapshot.reasoningEffort || '默认' }} · API Key：{{ codexConfig.snapshot.hasApiKey ? '已配置' : '未配置' }}</div>
                <div>适配器激活：{{ codexConfig.snapshot.active ? '是（codex）' : '否' }}</div>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="8">
            <el-form-item label="设为当前适配器">
              <el-switch v-model="codexConfig.form.activate" />
            </el-form-item>
          </el-col>
        </el-row>
        <div class="config-actions">
          <el-button type="primary" @click="saveCodexConfig" :loading="codexConfig.saving">保存 Codex 上游</el-button>
          <span class="config-hint">仅写入 codex 配置文件；KHY 其它适配器不受影响。</span>
        </div>
      </el-form>
    </el-card>

    <!-- Claude Code Model Slots -->
    <el-card v-show="activeTab === 'models'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <div>
            <div class="section-title">Claude Code 模型槽位</div>
            <div class="section-subtitle">映射 Claude Code 的 /model 五个槽位到 KHY 代理中的真实模型</div>
          </div>
          <el-button size="small" @click="loadModelSlots" :loading="isSlotRefreshBusy">刷新</el-button>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="修改后 Claude Code 需切换模型或新建会话生效。模型名支持 adapter/model 前缀（如 kiro/claude-sonnet-4.5）或内置路由名（如 deepseek-v4-flash）。"
        style="margin-bottom: 12px;"
      />
      <el-form label-width="100px" class="model-slots-form">
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="预设模板">
              <el-select v-model="slotPreset" @change="applySlotPreset" style="width: 100%" placeholder="选择预设或手动配置">
                <el-option label="自定义（当前配置）" value="custom" />
                <el-option label="Kiro 最优" value="kiro" />
                <el-option label="Trae 混合" value="trae" />
                <el-option label="SenseNova 全栈" value="sensenova" />
                <el-option label="纯本地 Ollama" value="local" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="Base URL">
              <el-input :model-value="slotForm.baseUrl" disabled />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="Default">
              <el-select-v2 v-model="slotForm.default" :options="slotModelOptionsV2" filterable allow-create
                            default-first-option style="width: 100%" placeholder="日常主力模型" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="Opus">
              <el-select-v2 v-model="slotForm.opus" :options="slotModelOptionsV2" filterable allow-create
                            default-first-option style="width: 100%" placeholder="Opus 槽位" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="Sonnet">
              <el-select-v2 v-model="slotForm.sonnet" :options="slotModelOptionsV2" filterable allow-create
                            default-first-option style="width: 100%" placeholder="Sonnet 槽位" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :md="12">
            <el-form-item label="Haiku">
              <el-select-v2 v-model="slotForm.haiku" :options="slotModelOptionsV2" filterable allow-create
                            default-first-option style="width: 100%" placeholder="Haiku 快速模型" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :xs="24" :md="12">
            <el-form-item label="Subagent">
              <el-select-v2 v-model="slotForm.subagent" :options="slotModelOptionsV2" filterable allow-create
                            default-first-option style="width: 100%" placeholder="子代理模型" />
            </el-form-item>
          </el-col>
        </el-row>
        <div class="config-actions">
          <el-button type="primary" :loading="slotsSaving" @click="saveModelSlots">保存槽位配置</el-button>
        </div>
      </el-form>
    </el-card>

    <!-- Image-generation model selection (global) -->
    <ImageModelCard
      v-show="activeTab === 'models'"
      class="section-card"
      :current="imageCurrent"
      :options="imageOptions"
      :auto-order="imageAutoOrder"
      :busy="gw.loading.value"
      @update="onUpdateImageConfig"
    />

    <!-- Status Overview -->
    <el-card v-show="activeTab === 'monitor'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>适配器状态</span>
          <el-button size="small" @click="gw.fetchStatus()">刷新</el-button>
        </div>
      </template>
      <el-table :data="adapterList" stripe size="small" v-loading="isGatewayStatusBusy">
        <el-table-column prop="name" label="名称" width="140">
          <template #default="{ row }">
            <span class="adapter-name-cell">
              <span :class="['status-dot', row.available ? 'status-dot--green' : (row.enabled ? 'status-dot--yellow' : 'status-dot--gray')]"></span>
              {{ row.name }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="100" />
        <el-table-column prop="priority" label="优先级" width="80" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.available ? 'success' : (row.enabled ? 'warning' : 'info')" size="small" effect="light">
              {{ row.available ? '可用' : (row.enabled ? '不可用' : '已禁用') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" />
      </el-table>
    </el-card>

    <!-- Available Models -->
    <el-card v-show="activeTab === 'models'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>
            可用模型
            <el-tag v-if="availableModelTotal" size="small" type="info" effect="plain">{{ availableModelTotal }}</el-tag>
          </span>
          <el-button size="small" :loading="modelsLoading" @click="refreshModels">刷新</el-button>
        </div>
      </template>

      <!-- Multi-pivot view selector: the same providers / models / keys data,
           grouped by different axes. by-provider keeps the rich curation card. -->
      <div class="model-pivot-bar">
        <el-radio-group v-model="modelViewMode" size="small">
          <el-radio-button v-for="v in modelViews" :key="v.value" :value="v.value">{{ v.label }}</el-radio-button>
        </el-radio-group>
        <el-input
          v-model="modelSearch"
          size="small"
          clearable
          placeholder="搜索模型 / 供应商"
          class="model-pivot-search"
        />
      </div>

      <!-- Legacy rich per-provider card: full per-model curation (默认 view). -->
      <template v-if="usesLegacyModelCard">
        <KhyEmpty
          v-if="!availableModelGroups.length"
          :icon="MagicStick"
          title="还没有可用模型"
          description="确认对应适配器已在本地安装并登录后，模型会自动出现在这里，供网关统一编排。"
        />
        <div v-else class="model-group-list" v-loading="modelEditBusy">
        <div v-for="group in availableModelGroups" :key="group.key" class="model-group">
          <div class="model-group-head">
            <span class="status-dot status-dot--green"></span>
            <span class="model-group-name">{{ group.name }}</span>
            <el-tag v-if="group.kind" size="small" :type="modelKindTagType(group.kind)" effect="plain">{{ modelKindLabel(group.kind) }}</el-tag>
            <span class="model-group-type">{{ group.adapter }}</span>
            <span class="model-group-count">{{ group.models.length }} 个</span>
            <el-button class="model-group-verify" link type="primary" size="small" @click="verifyAdapterModelList(group.adapter)">验证全部</el-button>
          </div>
          <div v-if="group.source" class="model-group-source">来源：{{ group.source }}</div>
          <div class="model-row-list">
            <div v-for="model in group.models" :key="model.id" class="model-row">
              <div class="model-row-main">
                <span class="model-row-name" :title="model.id">{{ model.name }}</span>
                <el-tag v-if="model.isDefault" size="small" type="warning" effect="plain">默认</el-tag>
                <el-tag v-if="model.discoverySource" size="small" :type="modelSourceTagType(model.discoverySource)" effect="plain">{{ modelSourceLabel(model.discoverySource) }}</el-tag>
                <el-tag size="small" :type="modelVerifyTagType(model.verifyStatus)" effect="plain">{{ modelVerifyLabel(model.verifyStatus) }}</el-tag>
              </div>
              <div class="model-row-ops">
                <el-button link size="small" @click="setAdapterDefaultModel(group.adapter, model.id)">默认</el-button>
                <el-button link size="small" @click="renameAdapterModel(group.adapter, model.id, model.name)">改名</el-button>
                <el-button v-if="model.custom" link type="danger" size="small" @click="deleteAdapterCustomModel(group.adapter, model.id)">删除</el-button>
                <el-button v-else link type="warning" size="small" @click="hideAdapterModel(group.adapter, model.id)">隐藏</el-button>
              </div>
            </div>
          </div>
          <el-button class="model-group-add" link type="primary" size="small" @click="addAdapterModel(group.adapter)">+ 添加模型</el-button>
        </div>
        </div>
      </template>

      <!-- Pivot renderer: any non-default view, or an active search. Read-and-route
           over the joined catalog edges; every edge reports its real resolved
           provider / key / capability / tier / status / connection. -->
      <template v-else>
        <el-empty
          v-if="!pivotedModelGroups.length"
          :description="modelSearch.trim()
            ? `没有匹配「${modelSearch.trim()}」的模型`
            : '暂无模型（请先在下方“API 密钥池”接入供应商 / Key）'"
          :image-size="72"
        />
        <div v-else class="model-pivot-list">
          <div v-for="group in pivotedModelGroups" :key="group.groupKey" class="model-pivot-group">
            <div class="model-pivot-group-head">
              <span class="status-dot status-dot--green"></span>
              <!-- by-key: masked key preview (sk-…xxxx) as the header, with this
                   key's models listed underneath. title keeps the raw group key
                   for reference. -->
              <span class="model-group-name" :class="{ 'model-group-name--key': modelViewMode === 'by-key' && pivotGroupHeadLabel(group) !== group.groupLabel }" :title="group.groupLabel">{{ pivotGroupHeadLabel(group) }}</span>
              <el-tag v-if="pivotGroupKeyLabel(group)" size="small" type="info" effect="plain">{{ pivotGroupKeyLabel(group) }}</el-tag>
              <span class="model-group-count">{{ group.edges.length }} 个</span>
            </div>
            <div class="model-row-list" v-loading="modelEditBusy">
              <div v-for="edge in group.edges" :key="`${edge.provider}:${edge.model}:${group.groupKey}`" class="model-row">
                <div class="model-row-main">
                  <span class="model-row-name" :title="edge.model">{{ edge.displayName || edge.model }}</span>
                  <el-tag size="small" type="info" effect="plain">{{ edge.providerLabel || edge.provider }}</el-tag>
                  <el-tag v-if="edge.isDefault" size="small" type="warning" effect="plain">默认</el-tag>
                  <el-tag size="small" effect="plain">{{ pivotCapabilityLabel(edge.capability) }}</el-tag>
                  <el-tag v-if="edge.tier" size="small" effect="plain">{{ edge.tier }}</el-tag>
                  <el-tag size="small" :type="pivotStatusTagType(edge.status)" effect="plain">{{ pivotStatusLabel(edge.status) }}</el-tag>
                  <el-tag size="small" type="info" effect="plain">{{ pivotConnectionLabel(edge.connectionMode) }}</el-tag>
                  <el-tag v-if="edge.keyCount" size="small" type="success" effect="plain">{{ edge.keyCount }} Key</el-tag>
                </div>
                <!-- Inline curation: chat edges reuse the same override ops as the
                     by-provider card (keyed by the qualified `api:<provider>:<model>`
                     id). image/video edges are not registry-backed → read-only. -->
                <div class="model-row-ops" v-if="edge.editable">
                  <el-button link size="small" @click="setAdapterDefaultModel('api', edge.qualifiedId)">默认</el-button>
                  <el-button link size="small" @click="renameAdapterModel('api', edge.qualifiedId, edge.displayName)">改名</el-button>
                  <el-button v-if="edge.custom" link type="danger" size="small" @click="deleteAdapterCustomModel('api', edge.qualifiedId)">删除</el-button>
                  <el-button v-else link type="warning" size="small" @click="hideAdapterModel('api', edge.qualifiedId)">隐藏</el-button>
                </div>
                <div class="model-row-ops" v-else>
                  <el-tag size="small" type="info" effect="plain">只读</el-tag>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="model-pivot-foot">
          共 {{ pivotedModelTotal }} 条 · 视角：{{ (modelViews.find(v => v.value === modelViewMode) || {}).label }}
        </div>
      </template>
    </el-card>

    <!-- API Key Pool -->
    <el-card v-show="activeTab === 'keys'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>API 密钥池</span>
          <div class="header-actions">
            <el-button size="small" type="primary" @click="openAddPoolKeyDialog">添加 Key</el-button>
            <el-button size="small" type="success" @click="openAddCustomProviderDialog">添加自定义 Provider</el-button>
            <el-button size="small" @click="gw.fetchPool()">刷新</el-button>
          </div>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="这里主要管理直连供应商 Key；中转 Relay Key 请在上方“模型与 API Key 配置”中管理。"
        style="margin-bottom: 12px;"
      />
      <div v-if="poolProviderSections.length" class="pool-section-list">
        <div v-for="section in poolProviderSections" :key="section.key" class="pool-section">
          <div class="pool-section-head">
            <div>
              <div class="pool-section-title">{{ section.title }}</div>
              <div class="pool-section-subtitle">{{ section.subtitle }}</div>
            </div>
          </div>
          <div class="pool-grid">
            <div v-for="item in section.items" :key="item.provider" class="pool-provider">
              <h4>{{ item.label }}（{{ item.provider }} / {{ item.keys.length }} 个密钥）</h4>
              <div v-for="k in item.keys" :key="k.keyId" class="pool-key">
                <el-tag :type="k.status === 'active' ? 'success' : 'warning'" size="small">{{ mapKeyStatus(k.status) }}</el-tag>
                <span class="key-preview">{{ k.keyPreview }}</span>
                <span v-if="k.label" class="key-label">{{ k.label }}</span>
                <span class="key-stats">优先级: {{ k.priority }} | 请求: {{ k.totalRequests }}</span>
                <el-button
                  size="small"
                  link
                  type="primary"
                  @click="openEditPoolKeyDialog(item.provider, k)"
                >
                  编辑
                </el-button>
                <el-button
                  size="small"
                  link
                  type="danger"
                  @click="handleRemovePoolKey(item.provider, k.keyId)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-else description="暂无密钥池数据" />

      <!-- Registered custom OpenAI-compatible providers -->
      <div v-if="gw.customProviders.value.length" class="custom-provider-list" style="margin-top: 16px;">
        <el-divider content-position="left">自定义 Provider</el-divider>
        <div v-for="p in gw.customProviders.value" :key="p.poolKey" class="pool-provider">
          <h4>
            {{ p.name }}（{{ p.poolKey }}）
            <el-tag v-if="p.tier" size="small" type="info" style="margin-left: 6px;">{{ p.tier }}</el-tag>
          </h4>
          <div class="form-tip">{{ p.endpoint }} · 默认模型 {{ p.defaultModel }} · 模型 {{ (p.models || []).join(', ') }}</div>
          <el-button size="small" link type="primary" @click="handleReplaceCustomProviderKey(p.poolKey)">替换 Key</el-button>
          <el-button size="small" link type="danger" @click="handleRemoveCustomProvider(p.poolKey)">删除</el-button>
        </div>
      </div>
    </el-card>

    <!-- Gateway Config -->
    <el-card v-show="activeTab === 'routing'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>网关配置</span>
          <el-button size="small" @click="loadGatewayConfig">刷新</el-button>
        </div>
      </template>
      <el-form :model="configForm" label-width="220px" class="config-form">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  默认优先适配器
                  <el-tooltip :content="helpText('preferredAdapter')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-select
                v-model="configForm.preferredAdapter"
                style="width: 100%"
                filterable
                clearable
                allow-create
                default-first-option
                placeholder="可选择或手填，如：auto / api / relay_api / kiro"
              >
                <el-option v-for="opt in preferredAdapterOptions" :key="opt" :label="opt" :value="opt" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  默认优先模型
                  <el-tooltip :content="helpText('preferredModel')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-select
                v-model="configForm.preferredModel"
                style="width: 100%"
                filterable
                clearable
                allow-create
                default-first-option
                placeholder="可选择或手填，如：provider:model 或 adapter/model"
              >
                <el-option v-for="opt in preferredModelOptions" :key="opt" :label="opt" :value="opt" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  密钥选择策略
                  <el-tooltip :content="helpText('keySelectionStrategy')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-select v-model="configForm.keySelectionStrategy" style="width: 100%">
                <el-option label="轮询 (round-robin)" value="round-robin" />
                <el-option label="最少失败 (least-fail)" value="least-fail" />
                <el-option label="最少使用 (least-used)" value="least-used" />
                <el-option label="混合策略 (hybrid)" value="hybrid" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  API 池默认供应商
                  <el-tooltip :content="helpText('apiPoolProvider')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-select
                v-model="configForm.apiPoolProvider"
                style="width: 100%"
                filterable
                clearable
                allow-create
                default-first-option
                placeholder="可选择或手填，如：openai / alibaba / huggingface / relay"
              >
                <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  模型路由严格模式
                  <el-tooltip :content="helpText('modelRouteStrict')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-switch v-model="configForm.modelRouteStrict" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  启用 CLI 适配器
                  <el-tooltip :content="helpText('cliEnabled')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-switch v-model="configForm.cliEnabled" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  Relay 端口
                  <el-tooltip :content="helpText('relayPort')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-input v-model="configForm.relayPort" placeholder="9099" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  Ollama 地址
                  <el-tooltip :content="helpText('ollamaHost')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-input v-model="configForm.ollamaHost" placeholder="例如：https://ollama.example.com（可留空）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item>
              <template #label>
                <span class="config-label">
                  Ollama 默认模型
                  <el-tooltip :content="helpText('ollamaModel')" placement="top" effect="dark">
                    <el-icon class="help-icon"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </span>
              </template>
              <el-input v-model="configForm.ollamaModel" placeholder="qwen2.5:7b" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item>
          <template #label>
            <span class="config-label">
              模型路由映射
              <el-tooltip :content="helpText('modelRouteMap')" placement="top" effect="dark">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-table :data="modelRouteRows" size="small" border style="width: 100%">
            <el-table-column label="匹配规则" min-width="220">
              <template #default="{ row }">
                <el-input v-model="row.match" placeholder="如：claude-* 或 gpt-4o-mini" />
              </template>
            </el-table-column>
            <el-table-column label="目标模型" min-width="260">
              <template #default="{ row }">
                <el-select
                  v-model="row.target"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="可选择或手填，如：kiro/claude-sonnet-4"
                >
                  <el-option v-for="opt in routeTargetOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="严格" width="90">
              <template #default="{ row }">
                <el-switch v-model="row.strict" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeMapRow(modelRouteRows, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="example-actions">
            <el-button link type="primary" @click="addModelRouteRow">新增一行</el-button>
            <el-button link @click="resetMapRows('modelRouteMap')">填充示例</el-button>
            <el-button link @click="modelRouteRows = []">清空</el-button>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="config-label">
              密钥策略映射
              <el-tooltip :content="helpText('keySelectionStrategyMap')" placement="top" effect="dark">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-table :data="keyStrategyRows" size="small" border style="width: 100%">
            <el-table-column label="供应商" min-width="220">
              <template #default="{ row }">
                <el-select
                  v-model="row.key"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="如：openai / alibaba / huggingface"
                >
                  <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="策略" min-width="220">
              <template #default="{ row }">
                <el-select v-model="row.value" style="width: 100%">
                  <el-option label="轮询 (round-robin)" value="round-robin" />
                  <el-option label="最少失败 (least-fail)" value="least-fail" />
                  <el-option label="最少使用 (least-used)" value="least-used" />
                  <el-option label="混合策略 (hybrid)" value="hybrid" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeMapRow(keyStrategyRows, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="example-actions">
            <el-button link type="primary" @click="addSimpleMapRow(keyStrategyRows)">新增一行</el-button>
            <el-button link @click="resetMapRows('keySelectionStrategyMap')">填充示例</el-button>
            <el-button link @click="keyStrategyRows = []">清空</el-button>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="config-label">
              供应商别名映射
              <el-tooltip :content="helpText('apiPoolProviderAliasMap')" placement="top" effect="dark">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-table :data="providerAliasRows" size="small" border style="width: 100%">
            <el-table-column label="别名" min-width="220">
              <template #default="{ row }">
                <el-input v-model="row.key" placeholder="如：openai-sb / relaycn" />
              </template>
            </el-table-column>
            <el-table-column label="标准供应商" min-width="220">
              <template #default="{ row }">
                <el-select
                  v-model="row.value"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="如：openai / relay"
                >
                  <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeMapRow(providerAliasRows, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="example-actions">
            <el-button link type="primary" @click="addSimpleMapRow(providerAliasRows)">新增一行</el-button>
            <el-button link @click="resetMapRows('apiPoolProviderAliasMap')">填充示例</el-button>
            <el-button link @click="providerAliasRows = []">清空</el-button>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="config-label">
              供应商服务映射
              <el-tooltip :content="helpText('apiPoolServiceMap')" placement="top" effect="dark">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-table :data="serviceMapRows" size="small" border style="width: 100%">
            <el-table-column label="供应商" min-width="220">
              <template #default="{ row }">
                <el-select
                  v-model="row.key"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="如：relay / openai / alibaba"
                >
                  <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="服务实现" min-width="220">
              <template #default="{ row }">
                <el-select
                  v-model="row.value"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="如：openai / alibaba / huggingface"
                >
                  <el-option v-for="opt in serviceOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeMapRow(serviceMapRows, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="example-actions">
            <el-button link type="primary" @click="addSimpleMapRow(serviceMapRows)">新增一行</el-button>
            <el-button link @click="resetMapRows('apiPoolServiceMap')">填充示例</el-button>
            <el-button link @click="serviceMapRows = []">清空</el-button>
          </div>
        </el-form-item>

        <el-form-item>
          <template #label>
            <span class="config-label">
              供应商默认模型映射
              <el-tooltip :content="helpText('apiPoolDefaultModelMap')" placement="top" effect="dark">
                <el-icon class="help-icon"><QuestionFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-table :data="defaultModelRows" size="small" border style="width: 100%">
            <el-table-column label="供应商" min-width="220">
              <template #default="{ row }">
                <el-select
                  v-model="row.key"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="如：relay / alibaba / huggingface"
                >
                  <el-option v-for="opt in providerOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="默认模型" min-width="260">
              <template #default="{ row }">
                <el-select
                  v-model="row.value"
                  style="width: 100%"
                  filterable
                  clearable
                  allow-create
                  default-first-option
                  placeholder="可选择或手填，如：gpt-4o-mini / qwen-plus / mistralai/Mistral-7B-Instruct-v0.2"
                >
                  <el-option v-for="opt in preferredModelOptions" :key="opt" :label="opt" :value="opt" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ $index }">
                <el-button link type="danger" @click="removeMapRow(defaultModelRows, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="example-actions">
            <el-button link type="primary" @click="addSimpleMapRow(defaultModelRows)">新增一行</el-button>
            <el-button link @click="resetMapRows('apiPoolDefaultModelMap')">填充示例</el-button>
            <el-button link @click="defaultModelRows = []">清空</el-button>
          </div>
        </el-form-item>
      </el-form>
      <div class="config-actions">
        <el-button type="primary" @click="saveGatewayConfig">保存配置</el-button>
      </div>
    </el-card>

    <!-- Monitor -->
    <el-card v-show="activeTab === 'monitor'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>调用监控</span>
          <el-button size="small" :type="monitor.connected.value ? 'success' : 'default'" @click="toggleMonitorStream">
            {{ monitor.connected.value ? '实时中' : '连接实时流' }}
          </el-button>
        </div>
      </template>
      <div v-if="monitor.stats.value" class="monitor-stats">
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">总请求</div>
          <div class="monitor-stat-value">{{ monitor.stats.value.total }}</div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">成功率</div>
          <div class="monitor-stat-value monitor-stat--success">{{ monitor.stats.value.successRate }}</div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">平均时延</div>
          <div class="monitor-stat-value">{{ monitor.stats.value.avgLatencyMs }}ms</div>
        </div>
        <div class="monitor-stat-item">
          <div class="monitor-stat-label">缓冲区</div>
          <div class="monitor-stat-value">{{ monitor.stats.value.bufferSize }}/{{ monitor.stats.value.maxBufferSize }}</div>
        </div>
      </div>
      <el-table :data="monitor.traces.value.slice(0, 20)" stripe size="small" max-height="300">
        <el-table-column label="时间" width="80">
          <template #default="{ row }">{{ new Date(row.startTime).toLocaleTimeString() }}</template>
        </el-table-column>
        <el-table-column label="状态" width="70">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : (row.success === false ? 'danger' : 'info')" size="small">
              {{ row.success ? '成功' : (row.success === false ? '失败' : '执行中') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latencyMs" label="时延" width="80">
          <template #default="{ row }">{{ row.latencyMs ? row.latencyMs + 'ms' : '-' }}</template>
        </el-table-column>
        <el-table-column label="适配器" width="100">
          <template #default="{ row }">{{ row.response?.provider || row.request?.adapter || '-' }}</template>
        </el-table-column>
        <el-table-column label="提示词" min-width="200">
          <template #default="{ row }">{{ row.request?.prompt?.slice(0, 80) || '-' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Plugins -->
    <el-card v-show="activeTab === 'routing'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>网关插件</span>
          <div>
            <el-button size="small" type="primary" @click="openNewPlugin">新建插件</el-button>
            <el-button size="small" @click="gw.reloadPlugins()">重载全部</el-button>
          </div>
        </div>
      </template>
      <el-table :data="gw.plugins.value" stripe size="small">
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="priority" label="优先级" width="80" />
        <el-table-column label="启用" width="100">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="gw.togglePlugin(row.name, $event)" />
          </template>
        </el-table-column>
        <el-table-column label="钩子">
          <template #default="{ row }">{{ row.hooks?.join(', ') || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openEditPlugin(row.name)">编辑</el-button>
            <el-button size="small" link type="danger" @click="handleDeletePlugin(row.name)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!gw.plugins.value?.length" description="暂无已加载插件" />
    </el-card>

    <!-- Plugin Editor Dialog -->
    <el-dialog v-model="pluginDialog.visible" :title="pluginDialog.isNew ? '创建插件' : `编辑：${pluginDialog.name}`" width="700px" :close-on-click-modal="false">
      <el-form v-if="pluginDialog.isNew" label-width="80px" style="margin-bottom: 12px;">
        <el-form-item label="名称">
          <el-input v-model="pluginDialog.name" placeholder="如：my-plugin（字母、数字、连字符、下划线）" />
        </el-form-item>
      </el-form>
      <el-input v-model="pluginDialog.code" type="textarea" :rows="22" style="font-family: monospace; font-size: 13px;" placeholder="插件源码..." />
      <div class="plugin-validate-row">
        <el-button size="small" @click="handleValidatePlugin">校验</el-button>
        <el-tag v-if="pluginDialog.validResult" :type="pluginDialog.validResult.valid ? 'success' : 'danger'" size="small">
          {{ pluginDialog.validResult.valid ? '语法通过' : pluginDialog.validResult.error }}
        </el-tag>
      </div>
      <template #footer>
        <el-button @click="pluginDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="handleSavePlugin" :loading="pluginDialog.saving">保存</el-button>
      </template>
    </el-dialog>

    <!-- OAuth & TLS row -->
    <el-row :gutter="16">
      <el-col v-show="activeTab === 'accounts'" :span="12">
        <el-card class="section-card" shadow="hover">
          <template #header><span>OAuth 令牌</span></template>
          <div v-if="gw.oauth.value" class="oauth-list">
            <div v-for="(status, provider) in gw.oauth.value" :key="provider" class="oauth-item">
              <el-tag :type="status.valid ? 'success' : (status.registered ? 'warning' : 'info')" size="small">
                {{ status.valid ? '有效' : (status.registered ? '已过期' : '未配置') }}
              </el-tag>
              <span class="oauth-name">{{ status.provider || provider }}</span>
              <span v-if="status.expiresIn > 0" class="oauth-expiry">{{ Math.round(status.expiresIn / 60) }} 分钟</span>
              <el-button v-if="status.registered" size="small" link @click="gw.refreshOAuth(provider)">刷新</el-button>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col v-show="activeTab === 'routing'" :span="12">
        <el-card class="section-card" shadow="hover">
          <template #header><span>TLS 侧车</span></template>
          <div v-if="gw.tls.value" class="tls-info">
            <p><strong>状态：</strong> <el-tag :type="gw.tls.value.running ? 'success' : 'info'" size="small">{{ gw.tls.value.running ? '运行中' : '已停止' }}</el-tag></p>
            <p><strong>端口：</strong> {{ gw.tls.value.port }}</p>
            <p><strong>指纹：</strong> {{ gw.tls.value.fingerprint }}</p>
            <p><strong>目标域名：</strong> {{ gw.tls.value.targets?.join(', ') }}</p>
            <div class="tls-actions">
              <el-button v-if="!gw.tls.value.running" size="small" type="primary" @click="gw.startTls()">启动</el-button>
              <el-button v-else size="small" type="danger" @click="gw.stopTls()">停止</el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Protocols -->
    <el-card v-show="activeTab === 'routing'" class="section-card" shadow="hover">
      <template #header><span>协议转换</span></template>
      <el-tag v-for="p in gw.protocols.value" :key="p" class="protocol-tag" type="success">{{ p }}</el-tag>
      <p v-if="gw.protocols.value.length" class="protocol-note">所有协议都可通过规范中间格式进行相互转换。</p>
    </el-card>

    <!-- Account Pool -->
    <el-card v-show="activeTab === 'accounts'" class="section-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <div>
            <div class="section-title">账号池</div>
            <div class="section-subtitle">管理 IDE 适配器（Kiro / Cursor / Windsurf 等）自动收录的登录账号，支持一键切换</div>
          </div>
          <div class="header-actions">
            <el-select v-model="accountImportProvider" size="small" style="width: 100px;" placeholder="选择">
              <el-option label="Kiro" value="kiro" />
              <el-option label="Cursor" value="cursor" />
              <el-option label="Windsurf" value="windsurf" />
            </el-select>
            <el-button size="small" type="primary" :loading="accountImporting" @click="handleImportAccounts">导入</el-button>
            <el-button size="small" @click="gw.fetchAccounts()">刷新</el-button>
          </div>
        </div>
      </template>
      <div v-if="accountsByProvider.length">
        <div v-for="group in accountsByProvider" :key="group.provider" class="account-provider-group">
          <div class="account-provider-title">{{ displayProviderName(group.provider) }}（{{ group.accounts.length }} 个账号）</div>
          <el-table :data="group.accounts" stripe size="small" :row-class-name="accountRowClass">
            <el-table-column label="#" width="50">
              <template #default="{ row }">{{ row.id }}</template>
            </el-table-column>
            <el-table-column label="邮箱 / 标识" min-width="200">
              <template #default="{ row }">
                <span class="account-email">{{ row.email || row.label || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="accountStatusType(row.status)" size="small" effect="light">
                  {{ accountStatusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="Token" width="120">
              <template #default="{ row }">
                <span class="token-preview">{{ row.tokenPreview || row.token_hash?.slice(0, 8) || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">{{ row.source || '-' }}</template>
            </el-table-column>
            <el-table-column label="最后使用" width="140">
              <template #default="{ row }">{{ row.last_used ? new Date(row.last_used).toLocaleString() : '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <el-button
                  v-if="row.status !== 'active'"
                  size="small" link type="primary"
                  @click="handleUseAccount(group.provider, row.id)"
                >切换</el-button>
                <el-tag v-else size="small" type="success" effect="plain" style="margin-right:4px;">当前</el-tag>
                <el-button
                  v-if="row.status === 'disabled'"
                  size="small" link type="success"
                  @click="handleToggleAccount(row.id, true)"
                >启用</el-button>
                <el-button
                  v-if="row.status !== 'disabled'"
                  size="small" link type="warning"
                  @click="handleToggleAccount(row.id, false)"
                >禁用</el-button>
                <el-button
                  v-if="row.status === 'banned'"
                  size="small" link type="info"
                  @click="handleUnbanAccount(row.id)"
                >解封</el-button>
                <el-button
                  size="small" link type="danger"
                  @click="handleRemoveAccount(row.id)"
                >删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      <KhyEmpty
        v-else
        compact
        :icon="Connection"
        title="还没有收录任何账号"
        description="通过 IDE 登录后导入，或等待系统自动收录，账号会显示在这里参与网关调度。"
      />
    </el-card>

    <el-dialog v-model="poolKeyDialog.visible" title="添加 API Key" width="560px">
      <el-form :model="poolKeyDialog.form" label-width="112px">
        <el-form-item label="供应商">
          <el-select v-model="poolKeyDialog.form.provider" filterable allow-create default-first-option style="width: 100%">
            <el-option-group v-for="group in poolProviderGroups" :key="group.label" :label="group.label">
              <el-option v-for="opt in group.options" :key="opt" :label="opt" :value="opt" />
            </el-option-group>
          </el-select>
          <div class="form-tip">
            {{ poolProviderType === 'relay'
              ? '当前为中转服务 Key（relay），用于第三方或自建 OpenAI-compatible 中转。'
              : '当前为直连供应商 Key，建议填写该供应商官方 endpoint（可选）。' }}
          </div>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="poolKeyDialog.form.key"
            type="textarea"
            :rows="3"
            :placeholder="poolProviderType === 'relay'
              ? '中转 Key：支持 sk-xxx / Bearer sk-xxx / key=sk-xxx / JSON / 多行多 Key'
              : '直连 Key：支持 sk-xxx / Bearer sk-xxx / key=sk-xxx / JSON / 多行多 Key'"
          />
          <div class="form-tip">可一次粘贴多个 Key，系统会自动拆分并跳过重复项。</div>
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input
            v-model="poolKeyDialog.form.endpoint"
            :placeholder="poolProviderType === 'relay'
              ? '中转地址，例如 https://your-relay.example.com/v1（可选）'
              : '直连地址，例如 https://api.openai.com/v1（可选）'"
          />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="poolKeyDialog.form.label" placeholder="例如：主账号 / 备用账号" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="poolKeyDialog.form.priority" :min="0" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="poolKeyDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="poolKeyDialog.saving" @click="handleAddPoolKey">保存</el-button>
      </template>
    </el-dialog>

    <!-- Add Custom Provider Dialog -->
    <el-dialog v-model="customProviderDialog.visible" title="添加自定义 Provider (OpenAI 兼容)" width="600px">
      <el-form :model="customProviderDialog.form" label-width="120px">
        <el-form-item label="预设">
          <el-select v-model="customProviderDialog.presetId" style="width: 100%" @change="applyCustomPreset">
            <el-option label="手动填写（其它 OpenAI 兼容服务）" value="__manual__" />
            <el-option
              v-for="preset in gw.customProviderPresets.value"
              :key="preset.id"
              :label="`${preset.name} (${preset.endpoint})`"
              :value="preset.id"
            />
          </el-select>
          <div class="form-tip">选择预设可自动填充 Base URL / 默认模型 / 显示名。</div>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="customProviderDialog.form.displayName" placeholder="例如：Agnes AI" />
        </el-form-item>
        <el-form-item label="Provider ID">
          <el-input v-model="customProviderDialog.form.poolKey" placeholder="内部标识，小写字母/数字/连字符，例如 agnes" />
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input v-model="customProviderDialog.form.endpoint" placeholder="例如 https://apihub.agnes-ai.com/v1" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="customProviderDialog.form.keyInput"
            type="textarea"
            :rows="3"
            :placeholder="customKeyPlaceholder"
          />
        </el-form-item>
        <el-form-item label="默认模型">
          <el-input v-model="customProviderDialog.form.defaultModel" placeholder="例如 agnes-2.0-flash" />
        </el-form-item>
        <el-form-item label="其他模型">
          <el-input v-model="customProviderDialog.form.extraModels" placeholder="逗号分隔，可留空" />
        </el-form-item>
        <el-form-item label="能力分级">
          <el-select v-model="customProviderDialog.form.tier" style="width: 100%">
            <el-option label="自动判定（推荐）" value="" />
            <el-option label="T0 前沿" value="T0" />
            <el-option label="T1 强" value="T1" />
            <el-option label="T2 默认" value="T2" />
            <el-option label="T3 弱" value="T3" />
          </el-select>
          <div class="form-tip">名字含 flash/mini 等会被自动判为弱模型；如需纠正可在此显式声明。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="customProviderDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="customProviderDialog.saving" @click="handleAddCustomProvider">保存</el-button>
      </template>
    </el-dialog>

    <!-- Edit Pool Key Dialog -->
    <el-dialog v-model="poolKeyEditDialog.visible" title="编辑密钥" width="480px">
      <el-form :model="poolKeyEditDialog.form" label-width="112px">
        <el-form-item label="供应商">
          <el-input :model-value="poolKeyEditDialog.form.provider" disabled />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input :model-value="poolKeyEditDialog.form.keyPreview" disabled />
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="poolKeyEditDialog.form.endpoint" placeholder="https://api.provider.com/v1" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="poolKeyEditDialog.form.label" placeholder="例如：主账号 / 备用账号" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="poolKeyEditDialog.form.priority" :min="0" :max="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="poolKeyEditDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="poolKeyEditDialog.saving" @click="handleSavePoolKeyEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onActivated, onDeactivated, reactive, ref, watch } from 'vue'
import { useGateway } from '@/composables/useGateway'
import { VIEWS as PIVOT_VIEWS, pivotEdges, capabilityLabel, statusLabel, connectionLabel, statusTagType } from '@/composables/useModelPivots'
import { applyApiOverridesToEdges, poolKeyForGroup } from '@/composables/gatewayInlineEdit'
import { useAIMonitor } from '@/composables/useAIMonitor'
import ImageModelCard from '@/components/gateway/ImageModelCard.vue'
import GatewayOnboarding from '@/components/gateway/GatewayOnboarding.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { QuestionFilled, MagicStick, Connection } from '@element-plus/icons-vue'
import request from '@/api/request'
import KhyEmpty from '@/components/KhyEmpty.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

// keep-alive matches on component name (see Layout.vue CACHED). This heavy,
// leak-free config view is cached so revisits don't re-pay its full mount render.
defineOptions({ name: 'AIGateway' })

// 分类标签栏状态：仅驱动各 section 的 v-show 显隐，不影响任何数据流（pane 内容
// 始终挂载）。轻量持久化到 localStorage，读写 fail-soft（沿用 Layout.vue 侧栏折叠写法）。
const GATEWAY_TAB_KEY = 'khy_ai_gateway_tab'
const VALID_GATEWAY_TABS = ['access', 'models', 'keys', 'accounts', 'routing', 'monitor']
function readGatewayTab() {
  try {
    const v = localStorage.getItem(GATEWAY_TAB_KEY)
    return VALID_GATEWAY_TABS.includes(v) ? v : 'access'
  } catch {
    return 'access'
  }
}
const activeTab = ref(readGatewayTab())
watch(activeTab, (v) => {
  try { localStorage.setItem(GATEWAY_TAB_KEY, v) } catch { /* noop */ }
})

const gw = useGateway()
const monitor = useAIMonitor()

// 新手引导：是否已有任何网关配置（可用模型 / 自定义供应商 / 密钥池）。
// 决定「从这里开始」引导默认展开还是折叠。宽松判定，宁可多展开一次。
const isConfigured = computed(() => {
  const cat = gw.modelCatalog.value
  if (Array.isArray(cat) && cat.length) return true
  const cps = gw.customProviders.value
  if (Array.isArray(cps) && cps.length) return true
  const pool = gw.pool.value
  if (Array.isArray(pool) && pool.length) return true
  if (pool && typeof pool === 'object') {
    if (Object.values(pool).some(v => (Array.isArray(v) ? v.length : !!v))) return true
  }
  return false
})

// ── Image-generation model selection (global) ──
// The global route returns { current:{backend,model}, options:[...], autoOrder, status }.
const imageCurrent = computed(() => ({
  backend: gw.imageConfig.value?.current?.backend || 'auto',
  model: gw.imageConfig.value?.current?.model || '',
}))
const imageOptions = computed(() => gw.imageConfig.value?.options || [])
const imageAutoOrder = computed(() =>
  gw.imageConfig.value?.autoOrder || ['openai', 'agnes', 'domestic', 'sd_webui'])

async function onUpdateImageConfig(payload) {
  try {
    await gw.updateImageConfig(payload)
    ElMessage.success('图像模型已更新')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '图像模型更新失败')
  }
}

const adapterList = computed(() => {
  if (!gw.status.value?.adapters) return []
  return gw.status.value.adapters
})

function mapKeyStatus(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'active') return '可用'
  if (normalized === 'cooldown') return '冷却中'
  if (normalized === 'disabled') return '已禁用'
  return status || '-'
}

function toSortedUnique(values = []) {
  return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
}

const providerOptions = [
  'openai', 'anthropic', 'deepseek', 'alibaba', 'dashscope', 'qwen', 'huggingface', 'glm', 'doubao', 'wenxin',
  'relay', 'api', 'trae', 'warp', 'kiro', 'cursor', 'windsurf', 'claude', 'codex', 'ollama',
]
const directProviderOptions = [
  'openai', 'anthropic', 'deepseek', 'alibaba', 'dashscope', 'qwen', 'huggingface', 'glm', 'doubao', 'wenxin',
]
const relayProviderOptions = ['relay']
const extensionProviderOptions = providerOptions.filter(
  opt => !directProviderOptions.includes(opt) && !relayProviderOptions.includes(opt),
)
const serviceOptions = [
  'openai', 'anthropic', 'alibaba', 'dashscope', 'qwen', 'huggingface', 'zhipu', 'baidu', 'relay',
]
const providerDisplayNameMap = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  alibaba: '阿里百炼/通义',
  dashscope: '阿里 DashScope',
  qwen: '通义千问',
  huggingface: 'Hugging Face',
  glm: '智谱 GLM',
  doubao: '豆包',
  wenxin: '文心一言',
  relay: '中转 Relay',
})
const adapterPresetOptions = [
  'auto', 'api', 'relay_api', 'relay', 'kiro', 'cursor', 'claude', 'codex', 'trae',
  'warp', 'windsurf', 'vscode', 'ollama', 'localllm',
]

// ── Relay upstream presets (cc-switch-inspired) ──
// Presets carry ONLY connection metadata: baseUrl + wire protocol (apiFormat) +
// auth header field (apiKeyField) + optional failover endpoints + a default
// model hint. No model-capability hardcoding — context window / effort stay
// runtime-sourced. Picking a preset just fills the form; every field stays editable.
const relayProfilePresets = [
  { value: 'custom', label: '自定义', category: 'custom', baseUrl: '', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: '', endpoints: [] },
  // Official
  { value: 'openai', label: 'OpenAI 官方', category: 'official', baseUrl: 'https://api.openai.com/v1', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: 'gpt-4o-mini', endpoints: [] },
  { value: 'anthropic', label: 'Anthropic 官方', category: 'official', baseUrl: 'https://api.anthropic.com', compatibility: 'anthropic', apiFormat: 'anthropic', apiKeyField: 'x-api-key', defaultModel: 'claude-sonnet-4-20250514', endpoints: [] },
  { value: 'gemini', label: 'Google Gemini', category: 'official', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', compatibility: 'unknown', apiFormat: 'gemini', apiKeyField: 'x-goog-api-key', defaultModel: 'gemini-2.0-flash', endpoints: [] },
  { value: 'deepseek', label: 'DeepSeek', category: 'official', baseUrl: 'https://api.deepseek.com/v1', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: 'deepseek-chat', endpoints: [] },
  // Partner relays
  { value: 'shengsuanyun', label: '胜算云', category: 'partner', baseUrl: 'https://router.shengsuanyun.com/api/v1', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: '', endpoints: [] },
  { value: 'packycode', label: 'PackyCode', category: 'partner', baseUrl: 'https://api.packyapi.com/v1', compatibility: 'anthropic', apiFormat: 'anthropic', apiKeyField: 'x-api-key', defaultModel: '', endpoints: [] },
  // Style profiles (origin filled by user)
  { value: 'hermes', label: 'Hermes 风格', category: 'style', baseUrl: '', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: '', endpoints: [] },
  { value: 'openclaw', label: 'OpenClaw 风格', category: 'style', baseUrl: '', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: '', endpoints: [] },
  { value: 'opencode', label: 'OpenCode 风格', category: 'style', baseUrl: '', compatibility: 'openai', apiFormat: 'openai', apiKeyField: 'authorization_bearer', defaultModel: '', endpoints: [] },
]

const relayPresetCategories = [
  { key: 'official', label: '官方' },
  { key: 'partner', label: '合作中转' },
  { key: 'style', label: '风格预设' },
  { key: 'custom', label: '自定义' },
]

const relayCompatibilityOptions = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic-compatible' },
  { value: 'unknown', label: 'Auto / Unknown' },
]

const relayApiFormatOptions = [
  { value: 'openai', label: 'OpenAI Chat (/chat/completions)' },
  { value: 'anthropic', label: 'Anthropic (/messages)' },
  { value: 'openai_responses', label: 'OpenAI Responses (/responses)' },
  { value: 'gemini', label: 'Gemini (:generateContent)' },
]

const relayApiKeyFieldOptions = [
  { value: 'authorization_bearer', label: 'Authorization: Bearer' },
  { value: 'x-api-key', label: 'x-api-key (Anthropic)' },
  { value: 'x-goog-api-key', label: 'x-goog-api-key (Gemini)' },
]

const relayConfig = reactive({
  loading: false,
  saving: false,
  form: {
    profile: 'custom',
    baseUrl: '',
    modelId: '',
    compatibility: 'openai',
    apiFormat: 'openai',
    apiKeyField: 'authorization_bearer',
    endpoints: '',
    apiKey: '',
    clearApiKey: false,
  },
  snapshot: {
    baseUrl: '',
    modelId: '',
    compatibility: 'openai',
    apiFormat: 'openai',
    apiKeyField: 'authorization_bearer',
    endpoints: [],
    preferredAdapter: '',
    preferredModel: '',
    hasApiKey: false,
    apiKeyMasked: '',
  },
})

// Group presets by category for the pill selector.
const relayPresetGroups = computed(() => relayPresetCategories.map(cat => ({
  ...cat,
  items: relayProfilePresets.filter(p => p.category === cat.key),
})).filter(g => g.items.length > 0))

// Context-sensitive hint keyed off the selected preset's category.
const relayPresetHint = computed(() => {
  const preset = relayProfilePresets.find(p => p.value === relayConfig.form.profile)
  switch (preset?.category) {
    case 'official': return '官方直连：填写官方 API Key，协议与鉴权头已自动匹配。'
    case 'partner': return '合作中转：填写中转分发的 Key；如有多端点可在“候选端点”填备用地址实现故障转移。'
    case 'style': return '风格预设：仅约定协议风格，请手动填写上游 Base URL。'
    default: return '自定义：手动填写 Base URL、协议与鉴权头。'
  }
})

const isRelayConfigBusy = computed(() => relayConfig.loading)
const isGatewayStatusBusy = computed(() => gw.loading.value)

function applyRelaySnapshot(snapshot = {}) {
  relayConfig.snapshot.baseUrl = snapshot.baseUrl || ''
  relayConfig.snapshot.modelId = snapshot.modelId || ''
  relayConfig.snapshot.compatibility = snapshot.compatibility || 'openai'
  relayConfig.snapshot.apiFormat = snapshot.apiFormat || 'openai'
  relayConfig.snapshot.apiKeyField = snapshot.apiKeyField || 'authorization_bearer'
  relayConfig.snapshot.endpoints = Array.isArray(snapshot.endpoints) ? snapshot.endpoints : []
  relayConfig.snapshot.preferredAdapter = snapshot.preferredAdapter || ''
  relayConfig.snapshot.preferredModel = snapshot.preferredModel || ''
  relayConfig.snapshot.hasApiKey = !!snapshot.hasApiKey
  relayConfig.snapshot.apiKeyMasked = snapshot.apiKeyMasked || ''

  relayConfig.form.baseUrl = snapshot.baseUrl || ''
  relayConfig.form.modelId = snapshot.modelId || ''
  relayConfig.form.compatibility = snapshot.compatibility || 'openai'
  relayConfig.form.apiFormat = snapshot.apiFormat || 'openai'
  relayConfig.form.apiKeyField = snapshot.apiKeyField || 'authorization_bearer'
  relayConfig.form.endpoints = Array.isArray(snapshot.endpoints) ? snapshot.endpoints.join('\n') : ''
  relayConfig.form.apiKey = ''
  relayConfig.form.clearApiKey = false
}

function handleRelayProfileChange(profile) {
  const preset = relayProfilePresets.find(item => item.value === profile)
  if (!preset) return
  relayConfig.form.baseUrl = preset.baseUrl || relayConfig.form.baseUrl
  relayConfig.form.compatibility = preset.compatibility || relayConfig.form.compatibility
  relayConfig.form.apiFormat = preset.apiFormat || relayConfig.form.apiFormat
  relayConfig.form.apiKeyField = preset.apiKeyField || relayConfig.form.apiKeyField
  if (preset.defaultModel && !String(relayConfig.form.modelId || '').trim()) {
    relayConfig.form.modelId = preset.defaultModel
  }
  if (Array.isArray(preset.endpoints) && preset.endpoints.length) {
    relayConfig.form.endpoints = preset.endpoints.join('\n')
  }
}

async function loadRelayModelConfig() {
  relayConfig.loading = true
  try {
    const { data } = await request.get('/api/ai-gateway/model-config')
    const payload = data?.data || data
    if (!payload || typeof payload !== 'object') throw new Error('invalid model config payload')
    applyRelaySnapshot(payload)
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '加载模型配置失败')
  } finally {
    relayConfig.loading = false
  }
}

async function saveRelayModelConfig() {
  const baseUrl = String(relayConfig.form.baseUrl || '').trim()
  const modelId = String(relayConfig.form.modelId || '').trim()
  if (!baseUrl || !modelId) {
    ElMessage.warning('Base URL 和模型 ID 必填')
    return
  }
  relayConfig.saving = true
  try {
    const endpoints = String(relayConfig.form.endpoints || '')
      .split(/[\n,;]+/g)
      .map(s => s.trim())
      .filter(Boolean)
    const payload = {
      baseUrl,
      modelId,
      compatibility: relayConfig.form.compatibility,
      apiFormat: relayConfig.form.apiFormat,
      apiKeyField: relayConfig.form.apiKeyField,
      endpoints,
      clearApiKey: relayConfig.form.clearApiKey === true,
    }
    const apiKey = String(relayConfig.form.apiKey || '').trim()
    if (apiKey && !payload.clearApiKey) payload.apiKey = apiKey
    const { data } = await request.put('/api/ai-gateway/model-config', payload)
    const nextConfig = data?.data?.config || data?.config || data?.data || null
    if (nextConfig) applyRelaySnapshot(nextConfig)
    relayConfig.form.profile = 'custom'
    if (data?.data?.appendedV1) ElMessage.success('模型配置已保存，系统已自动补全 /v1')
    else ElMessage.success('模型配置已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '保存模型配置失败')
  } finally {
    relayConfig.saving = false
  }
}

// ── Codex upstream provider config (cc-switch-inspired presets) ──
// Presets are convenience data only (Base URL + default model); the user can
// override any field or pick "custom". This is NOT model-capability hardcoding —
// the real context window / effort are still sourced from config.toml at runtime.
const codexProviderPresets = [
  { value: 'custom', label: '自定义（手动填写）', providerName: '', baseUrl: '', model: '' },
  { value: 'openai', label: 'OpenAI 官方', providerName: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex' },
  { value: 'mindflow', label: 'MindFlow', providerName: 'mindflow', baseUrl: 'https://ai.mindflow.com.cn/v1', model: 'gpt-5.3-codex' },
  { value: 'shengsuanyun', label: '胜算云 (Shengsuanyun)', providerName: 'shengsuanyun', baseUrl: 'https://router.shengsuanyun.com/api/v1', model: 'gpt-5.4' },
]

const codexEffortOptions = [
  { value: 'minimal', label: 'minimal（最小）' },
  { value: 'low', label: 'low（低）' },
  { value: 'medium', label: 'medium（中）' },
  { value: 'high', label: 'high（高）' },
  { value: 'xhigh', label: 'xhigh（超高）' },
]

const codexConfig = reactive({
  loading: false,
  saving: false,
  form: {
    preset: 'custom',
    providerName: '',
    baseUrl: '',
    model: '',
    reasoningEffort: '',
    wireApi: 'responses',
    apiKey: '',
    activate: false,
  },
  snapshot: {
    provider: '',
    model: '',
    baseUrl: '',
    reasoningEffort: '',
    hasApiKey: false,
    active: false,
    configPath: '',
  },
})

function applyCodexSnapshot(snapshot = {}) {
  codexConfig.snapshot.provider = snapshot.provider || ''
  codexConfig.snapshot.model = snapshot.model || ''
  codexConfig.snapshot.baseUrl = snapshot.baseUrl || ''
  codexConfig.snapshot.reasoningEffort = snapshot.reasoningEffort || ''
  codexConfig.snapshot.hasApiKey = !!snapshot.hasApiKey
  codexConfig.snapshot.active = !!snapshot.active
  codexConfig.snapshot.configPath = snapshot.configPath || ''

  // Prefill the form with the live values so editing starts from reality.
  codexConfig.form.providerName = snapshot.provider || codexConfig.form.providerName
  codexConfig.form.baseUrl = snapshot.baseUrl || codexConfig.form.baseUrl
  codexConfig.form.model = snapshot.model || codexConfig.form.model
  codexConfig.form.reasoningEffort = snapshot.reasoningEffort || codexConfig.form.reasoningEffort
  codexConfig.form.apiKey = ''
}

function handleCodexPresetChange(preset) {
  const item = codexProviderPresets.find(p => p.value === preset)
  if (!item || preset === 'custom') return
  codexConfig.form.providerName = item.providerName || codexConfig.form.providerName
  codexConfig.form.baseUrl = item.baseUrl || codexConfig.form.baseUrl
  if (item.model) codexConfig.form.model = item.model
}

async function loadCodexConfig() {
  codexConfig.loading = true
  try {
    const { data } = await request.get('/api/ai-gateway/codex-config')
    const payload = data?.data || data
    if (payload && typeof payload === 'object') applyCodexSnapshot(payload)
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '加载 Codex 配置失败')
  } finally {
    codexConfig.loading = false
  }
}

async function saveCodexConfig() {
  const providerName = String(codexConfig.form.providerName || '').trim()
  const baseUrl = String(codexConfig.form.baseUrl || '').trim()
  const model = String(codexConfig.form.model || '').trim()
  if (!providerName || !baseUrl || !model) {
    ElMessage.warning('供应商名称、Base URL、模型 ID 必填')
    return
  }
  codexConfig.saving = true
  try {
    const payload = {
      providerName,
      baseUrl,
      model,
      wireApi: codexConfig.form.wireApi || 'responses',
      activate: codexConfig.form.activate === true,
    }
    const effort = String(codexConfig.form.reasoningEffort || '').trim()
    if (effort) payload.reasoningEffort = effort
    const apiKey = String(codexConfig.form.apiKey || '').trim()
    if (apiKey) payload.apiKey = apiKey

    const { data } = await request.put('/api/ai-gateway/codex-config', payload)
    const nextConfig = data?.data?.config || data?.config || null
    if (nextConfig) applyCodexSnapshot(nextConfig)
    const activated = data?.data?.activated
    ElMessage.success(activated ? 'Codex 上游已保存并设为当前适配器' : 'Codex 上游已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '保存 Codex 配置失败')
  } finally {
    codexConfig.saving = false
  }
}

const poolKeyDialog = reactive({
  visible: false,
  saving: false,
  form: {
    provider: 'alibaba',
    key: '',
    endpoint: '',
    priority: 10,
    label: '',
  },
})

const poolProviderGroups = computed(() => {
  const groups = [
    { label: '直连供应商', options: directProviderOptions },
    { label: '中转服务', options: relayProviderOptions },
    { label: '其他适配器', options: extensionProviderOptions },
  ]
  return groups.filter(group => group.options.length > 0)
})

const poolProviderType = computed(() => {
  const provider = String(poolKeyDialog.form.provider || '').trim().toLowerCase()
  return relayProviderOptions.includes(provider) ? 'relay' : 'direct'
})

function displayProviderName(provider) {
  const key = String(provider || '').trim().toLowerCase()
  return providerDisplayNameMap[key] || key || '-'
}

const poolProviderSections = computed(() => {
  const rawPool = gw.pool.value
  if (!rawPool || typeof rawPool !== 'object') return []

  const directItems = []
  const relayItems = []
  const otherItems = []

  for (const [provider, keys] of Object.entries(rawPool)) {
    const normalized = String(provider || '').trim().toLowerCase()
    const item = {
      provider,
      label: displayProviderName(normalized),
      keys: Array.isArray(keys) ? keys : [],
    }
    if (relayProviderOptions.includes(normalized)) {
      relayItems.push(item)
    } else if (directProviderOptions.includes(normalized)) {
      directItems.push(item)
    } else {
      otherItems.push(item)
    }
  }

  const sections = []
  if (directItems.length) {
    sections.push({
      key: 'direct',
      title: '直连供应商 Key',
      subtitle: '用于直接调用模型供应商官方 API（OpenAI / 阿里百炼 / Hugging Face 等）',
      items: directItems.sort((a, b) => a.provider.localeCompare(b.provider)),
    })
  }
  if (relayItems.length) {
    sections.push({
      key: 'relay',
      title: '中转服务 Key',
      subtitle: '用于第三方或自建 OpenAI-compatible 中转（Relay）',
      items: relayItems.sort((a, b) => a.provider.localeCompare(b.provider)),
    })
  }
  if (otherItems.length) {
    sections.push({
      key: 'other',
      title: '其他适配器 Key',
      subtitle: '非直连/中转的扩展适配器密钥',
      items: otherItems.sort((a, b) => a.provider.localeCompare(b.provider)),
    })
  }
  return sections
})

function openAddPoolKeyDialog() {
  poolKeyDialog.form = {
    provider: 'alibaba',
    key: '',
    endpoint: '',
    priority: 10,
    label: '',
  }
  poolKeyDialog.saving = false
  poolKeyDialog.visible = true
}

async function handleAddPoolKey() {
  const provider = String(poolKeyDialog.form.provider || '').trim()
  const key = String(poolKeyDialog.form.key || '').trim()
  if (!provider || !key) {
    ElMessage.warning('供应商与 API Key 必填')
    return
  }
  poolKeyDialog.saving = true
  try {
    const result = await gw.addPoolKey(provider, {
      key,
      endpoint: String(poolKeyDialog.form.endpoint || '').trim(),
      priority: Number(poolKeyDialog.form.priority || 10),
      label: String(poolKeyDialog.form.label || '').trim(),
    })
    poolKeyDialog.visible = false
    const addedCount = Number(result?.addedCount || result?.data?.addedCount || 1)
    const skippedCount = Number(result?.skippedCount || result?.data?.skippedCount || 0)
    if (addedCount > 1 || skippedCount > 0) {
      ElMessage.success(`已导入 ${addedCount} 个 Key，跳过 ${skippedCount} 个`)
    } else {
      ElMessage.success('密钥已添加')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '添加失败')
  } finally {
    poolKeyDialog.saving = false
  }
}

async function handleRemovePoolKey(provider, keyId) {
  try {
    await ElMessageBox.confirm(`确认删除 ${provider} 的密钥 ${keyId} 吗？`, '确认删除', { type: 'warning' })
    await gw.removePoolKey(provider, keyId)
    ElMessage.success('密钥已删除')
  } catch {
    // ignore cancel
  }
}

// ── Custom Providers (OpenAI-compatible) ──

const customProviderDialog = reactive({
  visible: false,
  saving: false,
  presetId: '__manual__',
  form: {
    displayName: '',
    poolKey: '',
    endpoint: '',
    keyInput: '',
    defaultModel: '',
    extraModels: '',
    tier: '',
  },
})

function openAddCustomProviderDialog() {
  customProviderDialog.presetId = '__manual__'
  customProviderDialog.form = {
    displayName: '',
    poolKey: '',
    endpoint: '',
    keyInput: '',
    defaultModel: '',
    extraModels: '',
    tier: '',
  }
  customProviderDialog.saving = false
  customProviderDialog.visible = true
}

function applyCustomPreset(presetId) {
  if (presetId === '__manual__') return
  const preset = (gw.customProviderPresets.value || []).find(p => p.id === presetId)
  if (!preset) return
  const extras = Array.isArray(preset.models)
    ? preset.models.filter(m => m !== preset.defaultModel)
    : []
  customProviderDialog.form.displayName = preset.name || ''
  customProviderDialog.form.poolKey = preset.id || ''
  customProviderDialog.form.endpoint = preset.endpoint || ''
  customProviderDialog.form.defaultModel = preset.defaultModel || ''
  customProviderDialog.form.extraModels = extras.join(', ')
  customProviderDialog.form.tier = preset.tier || ''
}

// Placeholder for the add-dialog API Key field: show the picked preset's example
// sk (e.g. Agnes → sk-agnes-xxxx) so the expected shape is visible; falls back
// to the generic multi-format hint. Example text only — never a real secret.
const customKeyPlaceholder = computed(() => {
  const preset = (gw.customProviderPresets.value || []).find(p => p.id === customProviderDialog.presetId)
  return (preset && preset.keyExample)
    ? preset.keyExample
    : '支持 sk-xxx / Bearer sk-xxx / JSON / 多行多 Key'
})

async function handleAddCustomProvider() {
  const f = customProviderDialog.form
  if (!String(f.displayName || '').trim() || !String(f.poolKey || '').trim()
    || !String(f.endpoint || '').trim() || !String(f.keyInput || '').trim()
    || !String(f.defaultModel || '').trim()) {
    ElMessage.warning('显示名称 / Provider ID / Base URL / API Key / 默认模型 必填')
    return
  }
  customProviderDialog.saving = true
  try {
    const result = await gw.addCustomProvider({
      displayName: String(f.displayName).trim(),
      poolKey: String(f.poolKey).trim(),
      endpoint: String(f.endpoint).trim(),
      keyInput: String(f.keyInput).trim(),
      defaultModel: String(f.defaultModel).trim(),
      extraModels: String(f.extraModels || '').trim(),
      tier: f.tier || '',
    })
    customProviderDialog.visible = false
    const p = result?.provider || result?.data?.provider || {}
    ElMessage.success(`${p.displayName || f.displayName} 已添加（${p.keyCount || 1} key，${(p.models || []).length || 1} 模型）`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '添加失败')
  } finally {
    customProviderDialog.saving = false
  }
}

async function handleRemoveCustomProvider(poolKey) {
  try {
    await ElMessageBox.confirm(`确认删除自定义 Provider "${poolKey}" 吗？（保留已存的 Key）`, '确认删除', { type: 'warning' })
    await gw.removeCustomProvider(poolKey)
    ElMessage.success('自定义 Provider 已删除')
  } catch {
    // ignore cancel
  }
}

async function handleReplaceCustomProviderKey(poolKey) {
  try {
    const { value } = await ElMessageBox.prompt(
      `为自定义 Provider "${poolKey}" 替换密钥，请输入新的 API Key（将替换该 Provider 现有全部 Key）：`,
      '替换 Key',
      {
        inputType: 'password',
        inputPlaceholder: 'sk-...',
        confirmButtonText: '替换',
        cancelButtonText: '取消',
        inputValidator: (v) => (v && String(v).trim() ? true : '请输入新的 API Key'),
      },
    )
    await gw.replaceCustomProviderKey(poolKey, String(value).trim())
    ElMessage.success('密钥已替换')
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.message || '替换失败')
  }
}

// ── Claude Code Model Slots ──

const SLOT_PRESETS = {
  kiro: { default: 'kiro/claude-sonnet-4.5', opus: 'deepseek-v4-flash', sonnet: 'kiro/deepseek-3.2', haiku: 'sensenova-6.7-flash-lite', subagent: 'ollama/qwen3.5:4b' },
  trae: { default: 'trae/gpt-5.4-beta', opus: 'trae/deepseek-v3.2', sonnet: 'trae/kimi-k2.5', haiku: 'trae/gemini-2.5-flash', subagent: 'ollama/qwen3.5:4b' },
  sensenova: { default: 'sensenova-u1-fast', opus: 'deepseek-v4-flash', sonnet: 'sensenova-6.7-flash-lite', haiku: 'sensenova-6.7-flash-lite', subagent: 'ollama/qwen3.5:4b' },
  local: { default: 'ollama/qwen3.5:4b', opus: 'ollama/qwen3.5:4b', sonnet: 'ollama/qwen3.5:4b', haiku: 'ollama/qwen3.5:4b', subagent: 'ollama/qwen3.5:4b' },
}

const slotsLoading = ref(false)
const slotsSaving = ref(false)
const slotPreset = ref('custom')
const isSlotRefreshBusy = computed(() => slotsLoading.value)
const slotForm = reactive({
  default: '', opus: '', sonnet: '', haiku: '', subagent: '', baseUrl: '',
})

function resolveSlotBaseUrlFallback() {
  const envBase = String(import.meta.env.VITE_AI_API_BASE_URL || '').trim()
  if (envBase) return envBase.replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/+$/, '')
  }
  return ''
}

const slotModelOptions = computed(() => {
  // The model catalog is adapter-grouped: [{ adapter, name, available, models: [{ id, name }] }].
  // Flatten to model ids; stay backward compatible with a flat list or string entries.
  const models = []
  for (const row of (gw.modelCatalog.value || [])) {
    if (Array.isArray(row?.models)) {
      for (const m of row.models) {
        const id = String(m?.id || m?.name || '').trim()
        if (id) models.push(id)
      }
    } else if (row?.id) {
      models.push(String(row.id).trim())
    } else if (typeof row === 'string') {
      models.push(row.trim())
    }
  }
  const builtins = ['sensenova-6.7-flash-lite', 'sensenova-u1-fast', 'deepseek-v4-flash', 'ollama/qwen3.5:4b']
  return toSortedUnique([...models.filter(Boolean), ...builtins])
})

// Virtualized-select option shape. `el-select-v2` renders only visible rows from
// an `:options="[{label,value}]"` array instead of eagerly mounting one
// `<el-option>` per model × 5 slots — the dominant tab-switch freeze source.
const slotModelOptionsV2 = computed(() => slotModelOptions.value.map((m) => ({ label: m, value: m })))

// Per-adapter available models for the "可用模型" display card. Mirrors the TUI's
// available-model list: only adapters reported available (locally installed + logged in)
// contribute models, since the backend only lists models for available adapters.
// Derive a provider label for a model served through the generic `api` adapter.
// Prefers the "Provider / model" display name, falling back to the poolKey
// segment of ids like "api:sensenova:xxx" or "sensenova:xxx".
function providerLabelFromApiModel(m) {
  const name = String(m?.name || '')
  if (name.includes(' / ')) return name.split(' / ')[0].trim() || 'API 云端服务'
  const parts = String(m?.id || '').split(':').filter(Boolean)
  if (parts.length >= 3 && parts[0] === 'api') return parts[1]
  if (parts.length === 2) return parts[0]
  return 'API 云端服务'
}

const availableModelGroups = computed(() => {
  const catalog = Array.isArray(gw.modelCatalog.value) ? gw.modelCatalog.value : []
  const groups = []
  for (const row of catalog) {
    if (!row || !row.available || !Array.isArray(row.models) || !row.models.length) continue
    const adapter = String(row.adapter || row.type || '').trim()
    const baseName = String(row.name || row.adapter || '').trim() || '未命名适配器'
    const kind = row.kind || null
    const source = String(row.source || '').trim()
    const models = row.models.map(m => ({
      id: String(m?.id || m?.name || '').trim(),
      name: String(m?.name || m?.id || '').trim(),
      isDefault: m?.isDefault === true,
      connectionMode: m?.connectionMode || (kind === 'local' ? 'local' : 'cloud'),
      discoverySource: m?.discoverySource || null,
      custom: m?.custom === true,
      verifyStatus: m?.verifyStatus || 'unknown',
    })).filter(m => m.id)
    if (!models.length) continue

    // The generic `api` adapter multiplexes several cloud providers (SenseNova,
    // DeepSeek, …). Split it into per-provider sub-groups so each appears as its
    // own channel card. The underlying curation key stays `api`, so edit/verify
    // operations keyed off group.adapter keep working unchanged.
    if (adapter === 'api') {
      const byProvider = new Map()
      for (const m of models) {
        const label = providerLabelFromApiModel(m)
        if (!byProvider.has(label)) byProvider.set(label, [])
        byProvider.get(label).push(m)
      }
      for (const [label, subModels] of byProvider) {
        groups.push({ key: `api:${label}`, adapter, name: label, kind, source, models: subModels })
      }
    } else {
      groups.push({ key: adapter || baseName, adapter, name: baseName, kind, source, models })
    }
  }
  return groups
})

const availableModelTotal = computed(() =>
  availableModelGroups.value.reduce((sum, group) => sum + group.models.length, 0))

// ── Multi-pivot views over the unified catalog edge list ──
// `by-provider` keeps using the rich `availableModelGroups` above (full per-model
// curation: verify / rename / hide / set-default) so the management path is
// byte-identical. Every OTHER view is a pure group-by over the joined edge list
// from /api/ai-gateway/catalog (capability / tier / status / connection / image /
// video) — a read-and-route surface; mutation still happens through the always
// present API Key Pool card and the per-provider curation under by-provider.
const modelViewMode = ref('by-provider')
const modelSearch = ref('')
const modelViews = PIVOT_VIEWS

// True when we should render the rich legacy per-provider card (default view,
// no active search). Any other view — or a search — switches to the lightweight
// pivot renderer driven by catalog edges.
const usesLegacyModelCard = computed(() =>
  modelViewMode.value === 'by-provider' && !modelSearch.value.trim())

const pivotedModelGroups = computed(() => {
  const edges = Array.isArray(gw.catalogEdges.value) ? gw.catalogEdges.value : []
  // Re-apply the 'api' curation override bucket client-side so inline edits in
  // any pivot view (hide / rename / add / default) are visible immediately —
  // catalog edges are raw (overrides only touch gw.modelCatalog). This also
  // tags each edge editable/qualifiedId/custom for the inline controls.
  const annotated = applyApiOverridesToEdges(edges, gw.modelOverrides.value)
  return pivotEdges(annotated, modelViewMode.value, { search: modelSearch.value })
})

const pivotedModelTotal = computed(() =>
  pivotedModelGroups.value.reduce((sum, g) => sum + g.edges.length, 0))

const pivotCapabilityLabel = capabilityLabel
const pivotStatusLabel = statusLabel
const pivotConnectionLabel = connectionLabel
const pivotStatusTagType = statusTagType

// by-key view: show each group's key as a MASKED preview (sk-…xxxx) + its label,
// joining the group key (a real pool key id) to the API key pool. Other views
// keep the pivot's own label. The synthetic (无 Key)/(系统密钥) buckets have no
// pool match → fall back to the bucket label (poolKeyForGroup returns null).
function pivotGroupHeadLabel(group) {
  if (modelViewMode.value === 'by-key') {
    const k = poolKeyForGroup(group.groupKey, gw.pool.value)
    if (k && k.keyPreview) return k.keyPreview
  }
  return group.groupLabel
}
function pivotGroupKeyLabel(group) {
  if (modelViewMode.value !== 'by-key') return ''
  const k = poolKeyForGroup(group.groupKey, gw.pool.value)
  return k && k.label ? k.label : ''
}

function modelKindLabel(kind) {
  if (kind === 'local') return '本地'
  if (kind === 'cloud') return '云端'
  return ''
}
function modelKindTagType(kind) {
  if (kind === 'local') return 'success'
  if (kind === 'cloud') return 'primary'
  return 'info'
}

// Source / verify provenance — state transparency: a hardcoded baseline model is
// labelled as such, never shown as a verified real one.
const MODEL_SOURCE_LABELS = { local: '实时', remote: '远程', baseline: '基线', config: '配置', user: '自定义' }
function modelSourceLabel(src) { return src ? (MODEL_SOURCE_LABELS[src] || src) : '' }
function modelSourceTagType(src) {
  if (src === 'local' || src === 'remote') return 'success'
  if (src === 'baseline') return 'warning'
  if (src === 'user') return 'primary'
  return 'info'
}
function modelVerifyLabel(s) {
  if (s === 'verified') return '已验证'
  if (s === 'failed') return '失败'
  return '未验证'
}
function modelVerifyTagType(s) {
  if (s === 'verified') return 'success'
  if (s === 'failed') return 'danger'
  return 'info'
}

// ── Model curation edit operations (per-adapter overrides) ──
const modelEditBusy = ref(false)
async function readAdapterOverride(adapter) {
  await gw.fetchModelOverrides()
  return (gw.modelOverrides.value && gw.modelOverrides.value[adapter]) || {}
}
async function applyModelPatch(adapter, patch) {
  modelEditBusy.value = true
  try {
    await gw.updateModelOverrides(adapter, patch)
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || e))
  } finally {
    modelEditBusy.value = false
  }
}
async function hideAdapterModel(adapter, modelId) {
  const ov = await readAdapterOverride(adapter)
  const hidden = Array.from(new Set([...(Array.isArray(ov.hidden) ? ov.hidden : []), modelId]))
  await applyModelPatch(adapter, { hidden })
}
async function setAdapterDefaultModel(adapter, modelId) {
  await applyModelPatch(adapter, { defaultModel: modelId })
}
async function renameAdapterModel(adapter, modelId, currentName) {
  try {
    const { value } = await ElMessageBox.prompt('输入新的显示名', '重命名模型', {
      inputValue: currentName || modelId, confirmButtonText: '保存', cancelButtonText: '取消',
    })
    const ov = await readAdapterOverride(adapter)
    const renamed = { ...(ov.renamed || {}), [modelId]: value }
    await applyModelPatch(adapter, { renamed })
  } catch { /* cancelled */ }
}
async function deleteAdapterCustomModel(adapter, modelId) {
  const ov = await readAdapterOverride(adapter)
  const added = (Array.isArray(ov.added) ? ov.added : []).filter(m => m.id !== modelId)
  await applyModelPatch(adapter, { added })
}
async function addAdapterModel(adapter) {
  try {
    // One API key often unlocks several models for a provider, so accept a batch:
    // separate IDs by comma / space / newline, and use "id:显示名" to set a label.
    const { value } = await ElMessageBox.prompt(
      '输入模型 ID（可一次添加多个，用逗号/空格/换行分隔；可写 id:显示名）',
      '添加模型',
      {
        confirmButtonText: '添加',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: 'simage, deepseek-v4-flash:DeepSeek V4 Flash',
      },
    )
    const tokens = String(value || '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
    if (!tokens.length) return
    const ov = await readAdapterOverride(adapter)
    const added = Array.isArray(ov.added) ? ov.added : []
    const byId = new Map(added.map(m => [m.id, m]))
    let addedCount = 0
    for (const tok of tokens) {
      const m = tok.match(/^([^:=]+)[:=](.+)$/)
      const id = (m ? m[1] : tok).trim()
      const name = (m ? m[2] : id).trim()
      if (!id || byId.has(id)) continue
      byId.set(id, { id, name })
      addedCount += 1
    }
    if (!addedCount) { ElMessage.warning('这些模型已存在'); return }
    await applyModelPatch(adapter, { added: Array.from(byId.values()) })
    ElMessage.success(`已添加 ${addedCount} 个模型`)
  } catch { /* cancelled */ }
}
async function verifyAdapterModelList(adapter) {
  modelEditBusy.value = true
  try {
    ElMessage.info('正在验证模型，请稍候…')
    await gw.verifyAdapterModels(adapter)
    ElMessage.success('验证完成')
  } catch (e) {
    ElMessage.error('验证失败：' + (e?.message || e))
  } finally {
    modelEditBusy.value = false
  }
  // Follow-up refresh: re-pull the catalog (with the list spinner) after verify
  // settles so the freshly written verifyStatus tags are unmistakably reflected.
  await refreshModels()
}

const modelsLoading = ref(false)
async function refreshModels() {
  modelsLoading.value = true
  try {
    await Promise.all([gw.fetchModelCatalog(), gw.fetchCatalog(), gw.fetchModelOverrides()])
  } finally {
    modelsLoading.value = false
  }
}

async function loadModelSlots() {
  slotsLoading.value = true
  try {
    await gw.fetchModelSlots()
    const data = gw.modelSlots.value
    if (data?.slots) {
      for (const key of ['default', 'opus', 'sonnet', 'haiku', 'subagent']) {
        slotForm[key] = data.slots[key]?.model || ''
      }
    }
    const baseUrl = String(data?.baseUrl || '').trim()
    slotForm.baseUrl = baseUrl || resolveSlotBaseUrlFallback()
    slotPreset.value = 'custom'
  } catch { /* ignore */ } finally {
    slotsLoading.value = false
  }
}

function applySlotPreset(preset) {
  const p = SLOT_PRESETS[preset]
  if (!p) return
  slotForm.default = p.default
  slotForm.opus = p.opus
  slotForm.sonnet = p.sonnet
  slotForm.haiku = p.haiku
  slotForm.subagent = p.subagent
}

async function saveModelSlots() {
  slotsSaving.value = true
  try {
    await gw.updateModelSlots({
      default: slotForm.default,
      opus: slotForm.opus,
      sonnet: slotForm.sonnet,
      haiku: slotForm.haiku,
      subagent: slotForm.subagent,
    })
    ElMessage.success('槽位配置已保存，Claude Code 新会话生效')
    slotPreset.value = 'custom'
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '保存失败')
  } finally {
    slotsSaving.value = false
  }
}

// ── Pool Key Edit ──

const poolKeyEditDialog = reactive({
  visible: false,
  saving: false,
  form: {
    provider: '',
    keyId: '',
    keyPreview: '',
    endpoint: '',
    label: '',
    priority: 10,
  },
})

function openEditPoolKeyDialog(provider, k) {
  poolKeyEditDialog.form = {
    provider,
    keyId: k.keyId,
    keyPreview: k.keyPreview || '***',
    endpoint: k.endpoint || '',
    label: k.label || '',
    priority: k.priority ?? 10,
  }
  poolKeyEditDialog.saving = false
  poolKeyEditDialog.visible = true
}

async function handleSavePoolKeyEdit() {
  const { provider, keyId, endpoint, label, priority } = poolKeyEditDialog.form
  if (!provider || !keyId) return
  poolKeyEditDialog.saving = true
  try {
    await gw.updatePoolKey(provider, keyId, {
      endpoint: String(endpoint || '').trim(),
      label: String(label || '').trim(),
      priority: Number(priority || 10),
    })
    poolKeyEditDialog.visible = false
    ElMessage.success('密钥已更新')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '更新失败')
  } finally {
    poolKeyEditDialog.saving = false
  }
}

const configForm = reactive({
  preferredAdapter: '',
  preferredModel: '',
  cliEnabled: true,
  relayPort: '9099',
  ollamaHost: '',
  ollamaModel: 'qwen2.5:7b',
  modelRouteStrict: false,
  keySelectionStrategy: 'round-robin',
  apiPoolProvider: '',
})

const modelRouteRows = ref([])
const keyStrategyRows = ref([])
const providerAliasRows = ref([])
const serviceMapRows = ref([])
const defaultModelRows = ref([])

const discoveredAdapterOptions = computed(() => {
  const rows = gw.status.value?.adapters || []
  return toSortedUnique(rows.map(r => r?.type || r?.key || ''))
})

const preferredAdapterOptions = computed(() => {
  return toSortedUnique([...adapterPresetOptions, ...discoveredAdapterOptions.value])
})

const discoveredModelOptions = computed(() => {
  const out = []
  const catalog = Array.isArray(gw.modelCatalog.value) ? gw.modelCatalog.value : []
  for (const row of catalog) {
    const adapter = String(row?.adapter || '').trim().toLowerCase()
    const models = Array.isArray(row?.models) ? row.models : []
    for (const model of models) {
      const rawId = String(model?.id || model?.name || '').trim()
      if (!rawId) continue
      out.push(rawId)
      if (adapter) out.push(`${adapter}/${rawId}`)
    }
  }
  for (const row of modelRouteRows.value) {
    if (row?.target) out.push(String(row.target || '').trim())
  }
  for (const row of defaultModelRows.value) {
    if (row?.value) out.push(String(row.value || '').trim())
  }
  return toSortedUnique(out)
})

const preferredModelOptions = computed(() => {
  return toSortedUnique([
    ...discoveredModelOptions.value,
    'gpt-4o-mini',
    'gpt-4o',
    'claude-sonnet-4',
    'qwen-plus',
    'mistralai/Mistral-7B-Instruct-v0.2',
    'deepseek-chat',
    'doubao-1.5-pro',
  ])
})

const routeTargetOptions = computed(() => {
  const out = [...preferredModelOptions.value]
  for (const adapter of preferredAdapterOptions.value) {
    if (!adapter || adapter === 'auto') continue
    out.push(`${adapter}/`)
  }
  return toSortedUnique(out)
})

const CONFIG_HELP_TEXT = Object.freeze({
  preferredAdapter: '指定默认优先尝试的适配器。留空时按系统自动排序；常见值：auto、api、relay_api、kiro、cursor、ollama。',
  preferredModel: '指定默认模型。支持 provider:model 或 adapter/model 两种格式；留空则由适配器自行选择。',
  keySelectionStrategy: '设置密钥池的默认选 key 策略。轮询适合均匀分摊，最少失败适合稳态可用性。',
  apiPoolProvider: '当使用通用 API 适配器且未显式指定 provider 时，优先使用这里配置的供应商（例如 openai / alibaba / huggingface）。',
  modelRouteStrict: '开启后，模型路由命中后只走目标适配器；关闭时目标失败可继续级联回退。',
  cliEnabled: '控制是否启用 CLI 类适配器（如 Kiro/Cursor/Codex 等本地登录态通道）。',
  relayPort: '网页 Relay 服务监听端口，通常默认 9099；被占用时请改为其他可用端口。',
  ollamaHost: 'Ollama 服务地址（建议从环境变量 OLLAMA_HOST 注入，可留空）。',
  ollamaModel: '默认使用的 Ollama 模型 ID，例如 qwen2.5:7b。',
  modelRouteMap: '将模型名按规则路由到指定适配器/模型。支持精确匹配和前缀通配（*）。',
  keySelectionStrategyMap: '按供应商覆写密钥策略。未配置的供应商会使用上面的默认策略。',
  apiPoolProviderAliasMap: '供应商别名映射。可把外部传入别名统一折叠到内部标准供应商名称。',
  apiPoolServiceMap: '供应商到服务实现的映射。比如 relay 映射到 openai 兼容服务。',
  apiPoolDefaultModelMap: '为每个供应商指定默认模型。请求未带模型时将自动使用该值。',
})

const CONFIG_EXAMPLES = Object.freeze({
  modelRouteMap: {
    'gpt-4o-mini': 'api/openai:gpt-4o-mini',
    'claude-*': { target: 'kiro/claude-sonnet-4', strict: true },
    'qwen-*': 'api/alibaba:qwen-plus',
    'hf-*': 'api/huggingface:mistralai/Mistral-7B-Instruct-v0.2',
  },
  keySelectionStrategyMap: {
    relay: 'least-used',
    openai: 'least-fail',
    alibaba: 'round-robin',
    huggingface: 'least-used',
  },
  apiPoolProviderAliasMap: {
    'openai-sb': 'openai',
    qwen: 'alibaba',
    dashscope: 'alibaba',
    hf: 'huggingface',
    relaycn: 'relay',
  },
  apiPoolServiceMap: {
    openai: 'openai',
    relay: 'openai',
    alibaba: 'alibaba',
    qwen: 'alibaba',
    huggingface: 'huggingface',
  },
  apiPoolDefaultModelMap: {
    relay: 'gpt-4o-mini',
    openai: 'gpt-4o-mini',
    alibaba: 'qwen-plus',
    huggingface: 'mistralai/Mistral-7B-Instruct-v0.2',
    deepseek: 'deepseek-chat',
  },
})

function helpText(fieldKey) {
  return CONFIG_HELP_TEXT[fieldKey] || '暂无说明'
}

function applyConfigExample(fieldKey) {
  const example = CONFIG_EXAMPLES[fieldKey]
  if (!example) return
  if (fieldKey === 'modelRouteMap') {
    modelRouteRows.value = modelRouteMapToRows(example)
    return
  }
  const target = fieldKey === 'keySelectionStrategyMap'
    ? keyStrategyRows
    : fieldKey === 'apiPoolProviderAliasMap'
      ? providerAliasRows
      : fieldKey === 'apiPoolServiceMap'
        ? serviceMapRows
        : defaultModelRows
  target.value = objectToSimpleRows(example)
}

function prettyJson(value) {
  try {
    return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2)
  } catch {
    return '{}'
  }
}

function objectToSimpleRows(map = {}) {
  const rows = []
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  for (const [key, value] of Object.entries(src)) {
    rows.push({ key: String(key), value: String(value ?? '') })
  }
  return rows
}

function modelRouteMapToRows(map = {}) {
  const rows = []
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  for (const [match, value] of Object.entries(src)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push({
        match: String(match),
        target: String(value.target || ''),
        strict: value.strict === true,
      })
    } else {
      rows.push({
        match: String(match),
        target: String(value ?? ''),
        strict: false,
      })
    }
  }
  return rows
}

function rowsToSimpleObject(rows = []) {
  const out = {}
  for (const row of rows) {
    const key = String(row?.key || '').trim()
    const value = String(row?.value || '').trim()
    if (!key || !value) continue
    out[key] = value
  }
  return out
}

function rowsToModelRouteMap(rows = []) {
  const out = {}
  for (const row of rows) {
    const match = String(row?.match || '').trim()
    const target = String(row?.target || '').trim()
    if (!match || !target) continue
    out[match] = row?.strict ? { target, strict: true } : target
  }
  return out
}

function addSimpleMapRow(rowsRef) {
  rowsRef.value.push({ key: '', value: '' })
}

function addModelRouteRow() {
  modelRouteRows.value.push({ match: '', target: '', strict: false })
}

function removeMapRow(rowsRef, index) {
  rowsRef.value.splice(index, 1)
}

function resetMapRows(fieldKey) {
  applyConfigExample(fieldKey)
}

function syncConfigForm(config) {
  if (!config) return
  configForm.preferredAdapter = config.preferredAdapter || ''
  configForm.preferredModel = config.preferredModel || ''
  configForm.cliEnabled = config.cliEnabled !== false
  configForm.relayPort = config.relayPort || '9099'
  configForm.ollamaHost = config.ollamaHost || ''
  configForm.ollamaModel = config.ollamaModel || 'qwen2.5:7b'
  configForm.modelRouteStrict = !!config.modelRouteStrict
  configForm.keySelectionStrategy = config.keySelectionStrategy || 'round-robin'
  configForm.apiPoolProvider = config.apiPoolProvider || ''
  modelRouteRows.value = modelRouteMapToRows(config.modelRouteMap)
  keyStrategyRows.value = objectToSimpleRows(config.keySelectionStrategyMap)
  providerAliasRows.value = objectToSimpleRows(config.apiPoolProviderAliasMap)
  serviceMapRows.value = objectToSimpleRows(config.apiPoolServiceMap)
  defaultModelRows.value = objectToSimpleRows(config.apiPoolDefaultModelMap)
}

async function loadGatewayConfig() {
  await gw.fetchConfig()
  syncConfigForm(gw.config.value)
}

async function saveGatewayConfig() {
  try {
    const payload = {
      preferredAdapter: configForm.preferredAdapter,
      preferredModel: configForm.preferredModel,
      cliEnabled: configForm.cliEnabled,
      relayPort: configForm.relayPort,
      ollamaHost: configForm.ollamaHost,
      ollamaModel: configForm.ollamaModel,
      modelRouteStrict: configForm.modelRouteStrict,
      keySelectionStrategy: configForm.keySelectionStrategy,
      apiPoolProvider: configForm.apiPoolProvider,
      modelRouteMap: rowsToModelRouteMap(modelRouteRows.value),
      keySelectionStrategyMap: rowsToSimpleObject(keyStrategyRows.value),
      apiPoolProviderAliasMap: rowsToSimpleObject(providerAliasRows.value),
      apiPoolServiceMap: rowsToSimpleObject(serviceMapRows.value),
      apiPoolDefaultModelMap: rowsToSimpleObject(defaultModelRows.value),
    }
    await gw.updateConfig(payload)
    syncConfigForm(gw.config.value)
    ElMessage.success('网关配置已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message || '保存失败')
  }
}

function toggleMonitorStream() {
  if (monitor.connected.value) {
    monitor.disconnect()
  } else {
    monitor.connectSSE()
  }
}

// ── Plugin Editor ──
const pluginDialog = reactive({
  visible: false,
  isNew: true,
  name: '',
  code: '',
  saving: false,
  validResult: null,
})

async function openNewPlugin() {
  pluginDialog.isNew = true
  pluginDialog.name = ''
  pluginDialog.validResult = null
  pluginDialog.saving = false
  try {
    pluginDialog.code = await gw.fetchTemplate()
  } catch {
    pluginDialog.code = '// New plugin\nmodule.exports = { name: "my-plugin", priority: 100, enabled: true, hooks: {} };'
  }
  pluginDialog.visible = true
}

async function openEditPlugin(name) {
  pluginDialog.isNew = false
  pluginDialog.name = name
  pluginDialog.validResult = null
  pluginDialog.saving = false
  try {
    pluginDialog.code = await gw.fetchPluginCode(name)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
    return
  }
  pluginDialog.visible = true
}

async function handleValidatePlugin() {
  pluginDialog.validResult = await gw.validatePlugin(pluginDialog.code)
}

async function handleSavePlugin() {
  if (!pluginDialog.name) {
    ElMessage.warning('插件名称不能为空')
    return
  }
  pluginDialog.saving = true
  try {
    if (pluginDialog.isNew) {
      await gw.createPlugin(pluginDialog.name, pluginDialog.code)
    } else {
      await gw.updatePlugin(pluginDialog.name, pluginDialog.code)
    }
    ElMessage.success('插件已保存')
    pluginDialog.visible = false
  } catch (err) {
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    pluginDialog.saving = false
  }
}

async function handleDeletePlugin(name) {
  try {
    await ElMessageBox.confirm(`确认删除插件「${name}」吗？`, '确认删除', { type: 'warning' })
    await gw.deletePlugin(name)
    ElMessage.success('插件已删除')
  } catch { /* cancelled */ }
}

// ── Account Pool ──

const accountImportProvider = ref('kiro')
const accountImporting = ref(false)

const accountsByProvider = computed(() => {
  const list = gw.accounts.value || []
  if (!list.length) return []
  const groups = {}
  for (const acct of list) {
    const prov = acct.provider || 'unknown'
    if (!groups[prov]) groups[prov] = { provider: prov, accounts: [] }
    groups[prov].accounts.push(acct)
  }
  return Object.values(groups).sort((a, b) => a.provider.localeCompare(b.provider))
})

function accountStatusType(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'active') return 'success'
  if (s === 'available') return ''
  if (s === 'banned') return 'danger'
  if (s === 'cooldown') return 'warning'
  if (s === 'disabled') return 'info'
  return 'info'
}

function accountStatusLabel(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'active') return '活跃'
  if (s === 'available') return '可用'
  if (s === 'banned') return '已封禁'
  if (s === 'cooldown') return '冷却中'
  if (s === 'disabled') return '已禁用'
  return status || '-'
}

function accountRowClass({ row }) {
  if (row.status === 'active') return 'account-row--active'
  if (row.status === 'banned') return 'account-row--banned'
  if (row.status === 'disabled') return 'account-row--disabled'
  return ''
}

async function handleImportAccounts() {
  accountImporting.value = true
  try {
    const result = await gw.importAccounts(accountImportProvider.value)
    const count = result?.imported || result?.count || 0
    ElMessage.success(`已导入 ${count} 个账号`)
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '导入失败')
  } finally {
    accountImporting.value = false
  }
}

async function handleUseAccount(provider, id) {
  try {
    await gw.usePoolAccount(provider, id)
    ElMessage.success('账号已切换')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '切换失败')
  }
}

async function handleToggleAccount(id, enabled) {
  try {
    await gw.togglePoolAccount(id, enabled)
    ElMessage.success(enabled ? '账号已启用' : '账号已禁用')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '操作失败')
  }
}

async function handleUnbanAccount(id) {
  try {
    await gw.unbanPoolAccount(id)
    ElMessage.success('账号已解封')
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || err.message || '解封失败')
  }
}

async function handleRemoveAccount(id) {
  try {
    await ElMessageBox.confirm('确认删除该账号吗？删除后需重新登录收录。', '确认删除', { type: 'warning' })
    await gw.removePoolAccount(id)
    ElMessage.success('账号已删除')
  } catch { /* cancelled */ }
}

async function bootstrapGateway() {
  await loadRelayModelConfig()
  await loadCodexConfig()
  await gw.fetchAll()
  // Eager-load curation overrides so the pivot views reflect hide/rename/add on
  // first paint (fetchAll does not pull them — they are otherwise lazy-loaded).
  await gw.fetchModelOverrides()
  syncConfigForm(gw.config.value)
  loadModelSlots()
  await monitor.fetchStats()
  await monitor.fetchTraces({ limit: 20 })
}

onMounted(bootstrapGateway)

// Under keep-alive onMounted fires once; refresh on each subsequent activation.
// onActivated also fires right after the first onMounted, so skip that first one.
let _activatedOnce = false
onActivated(() => {
  if (!_activatedOnce) { _activatedOnce = true; return }
  bootstrapGateway()
})

// The live monitor tail (opened only via toggleMonitorStream → monitor.connectSSE)
// is closed when this cached view is hidden, so caching can't leak an EventSource.
// useAIMonitor.disconnect() is idempotent when no stream is open.
onDeactivated(() => { monitor.disconnect() })
</script>

<style scoped>
.ai-gateway-admin {
  max-width: 1200px;
  margin: 0 auto;
}

/* 分类标签栏只当分区选择器用：pane 内容为空，靠 v-show 显隐真正的 section。
   隐藏空的 .el-tabs__content，只保留标签头（nav）。 */
.gateway-tabs {
  margin-bottom: 4px;
}
.gateway-tabs :deep(.el-tabs__content) {
  display: none;
}
.ai-gateway-admin h2 {
  margin-bottom: 20px;
  color: var(--el-text-color-primary);
}
.khy-page-subtitle {
  margin: -12px 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.section-card {
  margin-bottom: 16px;
}
.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.header-actions {
  display: flex;
  gap: 8px;
}
.section-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-subtitle {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.adapter-name-cell {
  display: inline-flex;
  align-items: center;
  font-weight: 500;
}
.model-group-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* Multi-pivot view selector + search */
.model-pivot-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.model-pivot-search {
  max-width: 240px;
}
.model-pivot-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.model-pivot-group {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}
.model-pivot-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.model-pivot-foot {
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: right;
}
.model-group {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
}
.model-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.model-group-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.model-group-name--key {
  font-family: var(--el-font-family, monospace);
  letter-spacing: 0.5px;
}
.model-group-type {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.model-group-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.model-group-source {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.model-tag-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.model-tag {
  font-family: var(--el-font-family, monospace);
}
.model-default-mark {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.8;
}
.model-group-verify {
  margin-left: 8px;
}
.model-row-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}
.model-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.model-row-name {
  font-family: var(--el-font-family, monospace);
  font-size: 13px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-row-ops {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.model-group-add {
  margin-top: 8px;
}
.config-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.help-icon {
  color: var(--el-color-info);
  font-size: 14px;
  cursor: help;
}
.config-form {
  margin-bottom: 8px;
}
.example-actions {
  margin-top: 4px;
  display: flex;
  gap: 8px;
}
.config-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
}
.config-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* Relay preset pill selector (cc-switch inspired, Element Plus only) */
.preset-pills {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.preset-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.preset-group-label {
  flex: 0 0 auto;
  min-width: 52px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.preset-pill {
  margin-left: 0 !important;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.preset-badge {
  margin-left: 2px;
  transform: scale(0.85);
  transform-origin: left center;
}
.preset-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.form-hint-inline {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.gateway-current-meta {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.form-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}
.plugin-validate-row {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.monitor-stats {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border: 1px solid #e5ebf5;
  border-radius: 10px;
  overflow: hidden;
}
.monitor-stat-item {
  flex: 1;
  padding: 14px 16px;
  text-align: center;
  border-right: 1px solid #e5ebf5;
  background: linear-gradient(180deg, #f8faff, #ffffff);
}
.monitor-stat-item:last-child {
  border-right: none;
}
.monitor-stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 600;
  margin-bottom: 6px;
}
.monitor-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.monitor-stat--success {
  color: #10b981;
}
.pool-section-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pool-section {
  border: 1px solid #e5ebf5;
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff, #f8fbff);
  padding: 12px;
}
.pool-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.pool-section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.pool-section-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.pool-provider {
  padding: 12px;
  border: 1px solid #e5ebf5;
  border-radius: 10px;
  background: linear-gradient(180deg, #fafbff, #ffffff);
}
.pool-provider h4 {
  margin: 0 0 10px;
  color: var(--el-text-color-regular);
  font-size: 14px;
}
.pool-key {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
  border-bottom: 1px solid #f0f3f9;
}
.pool-key:last-child {
  border-bottom: none;
}
.key-preview { font-family: monospace; color: var(--el-text-color-secondary); }
.key-label { color: var(--el-color-primary); }
.key-stats { color: var(--el-text-color-placeholder); margin-left: auto; white-space: nowrap; }
.oauth-list { display: flex; flex-direction: column; gap: 8px; }
.oauth-item { display: flex; align-items: center; gap: 8px; }
.oauth-name { font-weight: 500; }
.oauth-expiry { color: var(--el-text-color-secondary); font-size: 12px; }
.tls-info p { margin: 4px 0; font-size: 13px; }
.tls-actions { margin-top: 12px; }
.protocol-tag { margin-right: 8px; margin-bottom: 4px; }
.protocol-note { margin-top: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.account-provider-group { margin-bottom: 16px; }
.account-provider-group:last-child { margin-bottom: 0; }
.account-provider-title { font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); margin-bottom: 8px; }
.account-email { font-weight: 500; }
.token-preview { font-family: monospace; font-size: 12px; color: var(--el-text-color-secondary); }
:deep(.account-row--active) { background-color: rgba(16, 185, 129, 0.06) !important; }
:deep(.account-row--banned) { background-color: rgba(239, 68, 68, 0.04) !important; }
:deep(.account-row--disabled) { opacity: 0.6; }
</style>
