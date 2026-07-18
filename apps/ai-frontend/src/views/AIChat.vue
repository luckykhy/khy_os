<template>
  <div class="ai-chat-page">
    <!-- 历史对话侧栏：新对话 + 最近对话列表（后端持久化，按用户隔离） -->
    <aside class="chat-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <div class="chat-sidebar-top">
        <el-button class="chat-new-btn" type="primary" :icon="Plus" @click="newConversation">新对话</el-button>
        <el-button class="chat-collapse-btn" text :icon="Fold" title="收起对话列表" @click="sidebarCollapsed = true" />
      </div>
      <!-- 项目工作区过滤：选中某项目 → 侧栏仅显示该项目对话，新对话归属该项目 -->
      <el-select
        class="chat-project-select"
        :model-value="activeProjectId"
        placeholder="全部项目"
        clearable
        size="small"
        @update:model-value="onProjectChange"
      >
        <el-option label="全部项目" :value="null" />
        <el-option
          v-for="p in projectList"
          :key="p.id"
          :label="(p.icon ? p.icon + ' ' : '') + p.name"
          :value="p.id"
        />
      </el-select>
      <div class="chat-sidebar-label">最近对话</div>
      <div v-loading="listLoading" class="chat-conv-list">
        <div
          v-for="c in conversations"
          :key="c.id"
          :class="['chat-conv-item', { active: c.id === activeId }]"
          @click="selectConversation(c.id)"
        >
          <div class="chat-conv-main">
            <div class="chat-conv-title" :title="c.title">{{ c.title }}</div>
            <div class="chat-conv-time">{{ relativeTime(c.updatedAt) }}</div>
          </div>
          <div class="chat-conv-ops">
            <el-icon class="chat-conv-op" title="重命名" @click.stop="renameConversation(c)"><EditPen /></el-icon>
            <el-icon class="chat-conv-op" title="删除" @click.stop="deleteConversation(c)"><Delete /></el-icon>
          </div>
        </div>
        <div v-if="!conversations.length && !listLoading" class="chat-conv-empty">暂无历史对话</div>
      </div>
    </aside>

    <div class="chat-main">
    <div class="chat-header">
      <el-button
        v-if="sidebarCollapsed"
        class="chat-expand-btn"
        text
        :icon="Expand"
        title="展开对话列表"
        @click="sidebarCollapsed = false"
      />
      <h2 class="khy-page-title">AI 对话</h2>
      <div class="chat-config">
        <div class="model-selector">
          <el-select v-model="selectedModel" placeholder="选择模型" size="default" :loading="modelsLoading" @focus="loadModels">
            <el-option label="自动选择" value="" />
            <el-option-group
              v-for="group in modelGroups"
              :key="group.adapter"
              :label="group.source ? `${group.name} · ${group.source}` : group.name"
            >
              <el-option
                v-for="m in group.models"
                :key="m.id"
                :label="m.name || m.id"
                :value="`${group.adapter}/${m.id}`"
              >
                <span>{{ m.name || m.id }}</span>
                <el-tag v-if="group.kind" size="small" :type="kindTagType(group.kind)" class="model-kind-tag">{{ kindLabel(group.kind) }}</el-tag>
                <el-tag v-if="m.isDefault" size="small" type="warning" class="model-default-tag">默认</el-tag>
                <el-tag size="small" :type="verifyTagType(m.verifyStatus)" effect="plain" class="model-verify-tag">{{ verifyLabel(m.verifyStatus) }}</el-tag>
              </el-option>
            </el-option-group>
          </el-select>
        </div>
        <div class="model-panel-trigger">
          <el-button size="default" plain @click="openModelPanel">可用模型</el-button>
        </div>
        <div class="transport-selector">
          <el-select v-model="transportMode" placeholder="传输方式" size="default">
            <el-option label="HTTP 流式" value="stream" />
            <el-option label="WebSocket" value="ws" />
          </el-select>
        </div>
        <el-popover
          v-if="contextStats && contextStats.contextWindow"
          placement="bottom-end"
          :width="320"
          trigger="hover"
        >
          <template #reference>
            <button type="button" :class="['ctx-usage-chip', ctxHealthClass(contextStats)]" aria-label="上下文用量">
              <span class="ctx-usage-dot" aria-hidden="true"></span>
              <span class="ctx-usage-pct">{{ ctxPercentLabel(contextStats) }}</span>
            </button>
          </template>
          <div class="ctx-usage-panel">
            <div class="ctx-usage-head">
              <strong>上下文用量</strong>
              <span class="ctx-usage-sub">
                {{ ctxFormatTokens(contextStats.totalTokens) }} / {{ ctxFormatTokens(contextStats.contextWindow) }}
                （剩 {{ ctxFormatTokens(contextStats.remainingTokens) }}）
              </span>
            </div>
            <div class="ctx-usage-bar" role="img" :aria-label="`已用 ${ctxPercentLabel(contextStats)}`">
              <div
                :class="['ctx-usage-fill', ctxHealthClass(contextStats)]"
                :style="{ width: Math.min(100, Math.round(contextStats.percentage)) + '%' }"
              ></div>
            </div>
            <ul v-if="contextStats.categories && contextStats.categories.length" class="ctx-usage-cats">
              <li v-for="cat in contextStats.categories" :key="cat.name">
                <span class="ctx-cat-name">{{ cat.name }}</span>
                <span class="ctx-cat-tok">{{ ctxFormatTokens(cat.tokens) }}</span>
              </li>
            </ul>
            <div v-if="contextStats.suggestions && contextStats.suggestions.length" class="ctx-usage-hints">
              <div
                v-for="(s, si) in contextStats.suggestions"
                :key="si"
                :class="['ctx-usage-hint', s.severity === 'warning' ? 'is-warn' : 'is-info']"
              >
                <span class="ctx-hint-glyph" aria-hidden="true">{{ s.severity === 'warning' ? '⚠' : 'ℹ' }}</span>
                <div class="ctx-hint-body">
                  <div class="ctx-hint-title">
                    {{ s.title }}
                    <span v-if="s.savingsTokens" class="ctx-hint-save">可省 ~{{ ctxFormatTokens(s.savingsTokens) }}</span>
                  </div>
                  <div v-if="s.detail" class="ctx-hint-detail">{{ s.detail }}</div>
                </div>
              </div>
            </div>
          </div>
        </el-popover>
      </div>
    </div>

    <div class="chat-layout">
    <el-card class="chat-card" shadow="hover">
      <div ref="chatContainer" class="chat-window" role="log" aria-live="polite" aria-label="对话记录">
        <div v-if="!messages.length && !loading" class="chat-empty" role="status">
          <div class="chat-empty-icon" aria-hidden="true">
            <el-icon><ChatDotRound /></el-icon>
          </div>
          <p class="chat-empty-title">开始和小K对话</p>
          <p class="chat-empty-sub">写代码、查资料，或聊聊任何话题——可以从下面的例子开始</p>
          <div class="chat-empty-prompts">
            <div
              v-for="group in groupedPrompts"
              :key="group.category"
              class="chat-empty-prompt-group"
            >
              <span class="chat-empty-prompt-cat">{{ group.category }}</span>
              <div class="chat-empty-prompt-btns">
                <el-button
                  v-for="(p, pi) in group.items"
                  :key="p.title + pi"
                  round
                  size="small"
                  @click="useExample(p)"
                >{{ p.title }}</el-button>
              </div>
            </div>
          </div>
        </div>
        <div v-for="(msg, i) in messages" :key="msg.id || i" :class="['chat-message-row', msg.role === 'user' ? 'user' : 'assistant']">
          <el-tag :type="msg.role === 'user' ? 'primary' : 'success'" size="small" class="chat-role-tag">
            {{ msg.role === 'user' ? '你' : (msg.model || '小K') }}
          </el-tag>
          <div :class="['chat-bubble', msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant']">
            <div v-if="msg.steps && msg.steps.length" class="chat-tool-steps" role="list" aria-label="工具调用过程">
              <div
                v-if="summarizeToolProgress(msg.steps)"
                class="chat-tool-progress"
                :class="{ 'is-active': summarizeToolProgress(msg.steps).active }"
                role="status"
                aria-live="polite"
              >
                <el-icon v-if="summarizeToolProgress(msg.steps).active" class="is-spin"><Loading /></el-icon>
                <el-icon v-else><Select /></el-icon>
                <span class="chat-tool-progress-label">{{ summarizeToolProgress(msg.steps).label }}</span>
              </div>
              <div v-for="step in msg.steps" :key="step.key" class="chat-tool-step-wrap" role="listitem">
                <div :class="['chat-tool-step', `is-${step.status}`]">
                  <span class="chat-tool-step-icon" aria-hidden="true">
                    <el-icon v-if="step.status === 'running'" class="is-spin"><Loading /></el-icon>
                    <el-icon v-else-if="step.status === 'ok'"><Select /></el-icon>
                    <el-icon v-else><CloseBold /></el-icon>
                  </span>
                  <span class="chat-tool-step-name">{{ step.tool }}</span>
                  <span v-if="step.input" class="chat-tool-step-input" :title="step.input">{{ step.input }}</span>
                  <span v-if="step.result && !step.sections" class="chat-tool-step-result" :title="step.result">{{ step.result }}</span>
                  <span v-else-if="step.sections" class="chat-tool-step-badge">{{ step.sections.length }} 节结构化输出</span>
                  <button
                    v-if="step.inputFull || step.result"
                    type="button"
                    class="chat-tool-step-toggle"
                    :aria-expanded="step.expanded ? 'true' : 'false'"
                    :title="step.expanded ? '收起参数与结果' : '展开完整参数与结果'"
                    @click="toggleStepExpand(step)"
                  >{{ step.expanded ? '收起 ▲' : '详情 ▼' }}</button>
                </div>
                <div v-if="step.expanded" class="chat-tool-step-detail" role="group" aria-label="工具调用完整参数与结果">
                  <div v-if="step.inputFull" class="chat-tool-detail-block">
                    <div class="chat-tool-detail-label">参数</div>
                    <pre class="chat-tool-detail-body">{{ step.inputFull }}</pre>
                  </div>
                  <div v-if="step.result && !step.sections" class="chat-tool-detail-block">
                    <div class="chat-tool-detail-label">{{ step.status === 'error' ? '错误' : '结果' }}</div>
                    <pre class="chat-tool-detail-body">{{ step.result }}</pre>
                  </div>
                </div>
                <div v-if="step.sections" class="chat-tool-output" role="group" aria-label="命令输出分节">
                  <div v-for="(sec, si) in step.sections" :key="si" class="chat-tool-output-section">
                    <div v-if="sec.title" class="chat-tool-output-title">{{ sec.title }}</div>
                    <pre v-if="sec.body" class="chat-tool-output-body">{{ sec.body }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="msg.content" class="chat-bubble-text">{{ msg.content }}</div>
            <div v-if="msg.error" class="chat-error-card" role="alert">
              <div class="chat-error-head">
                <span class="chat-error-icon" aria-hidden="true">⚠</span>
                <span class="chat-error-category">{{ msg.error.category }}</span>
                <span class="chat-error-code">[{{ msg.error.code }}]</span>
              </div>
              <div v-if="msg.error.why" class="chat-error-row">
                <span class="chat-error-label">为什么</span>
                <span class="chat-error-value">{{ msg.error.why }}</span>
              </div>
              <div v-if="msg.error.how" class="chat-error-row">
                <span class="chat-error-label">我可以怎么办</span>
                <span class="chat-error-value">{{ msg.error.how }}</span>
              </div>
              <div class="chat-error-actions">
                <el-button v-if="msg.error.retryable" text size="small" title="基于同一提问重试" @click="regenerate(msg)">
                  <el-icon><Refresh /></el-icon> 重试
                </el-button>
                <el-button
                  v-if="msg.error.requestId && !msg.error.sensitive"
                  text
                  size="small"
                  title="展开服务端分阶段时间线，钻取根因"
                  @click="toggleTrace(msg)"
                >
                  <el-icon><Loading v-if="msg.error._traceLoading" class="is-spin" /><View v-else /></el-icon>
                  {{ msg.error._traceOpen ? '收起追溯' : '技术详情 / 追溯' }}
                </el-button>
              </div>
              <div v-if="msg.error._traceOpen" class="chat-error-trace">
                <div v-if="msg.error._traceLoading" class="chat-error-trace-hint">正在加载服务端时间线…</div>
                <template v-else-if="msg.error._trace && msg.error._trace.ok">
                  <div v-if="brokenStageLabel(msg.error._trace)" class="chat-error-broken">
                    断点阶段：{{ brokenStageLabel(msg.error._trace) }}
                  </div>
                  <div v-if="!msg.error._trace.timeline || !msg.error._trace.timeline.length" class="chat-error-trace-hint">
                    暂无可见的分阶段时间线（可能权限不足或记录已过期）。
                  </div>
                  <ol v-else class="chat-error-timeline">
                    <li
                      v-for="(ev, idx) in msg.error._trace.timeline"
                      :key="idx"
                      :class="['chat-error-stage', { 'is-broken': isBrokenStage(msg.error._trace, idx) }]"
                    >
                      <span class="chat-error-stage-name">{{ stageLabel(ev.stage) }}</span>
                      <span class="chat-error-stage-type">{{ ev.type }}</span>
                      <span class="chat-error-stage-time">{{ formatTraceTime(ev.timestamp) }}</span>
                    </li>
                  </ol>
                </template>
                <div v-else class="chat-error-trace-hint">
                  {{ (msg.error._trace && msg.error._trace.summary) || '未能获取追溯信息（记录可能已过期或权限不足）。' }}
                </div>
              </div>
            </div>
            <div v-if="msg.attachments && msg.attachments.length" class="chat-bubble-attachments">
              <a
                v-for="att in msg.attachments"
                :key="att.id"
                class="chat-attachment-chip"
                :href="resolveApiUrl(att.url)"
                target="_blank"
                rel="noopener"
                :title="att.name"
              >
                <el-icon><component :is="attachmentIcon(att.kind)" /></el-icon>
                <span class="chat-attachment-name">{{ att.name }}</span>
              </a>
            </div>
            <div v-if="msg.role === 'assistant' && !loading" class="chat-bubble-actions">
              <el-button text size="small" title="撤回本轮（删除并把原文回填输入框）" @click="retract(msg)">
                <el-icon><RefreshLeft /></el-icon> 撤回
              </el-button>
              <el-button text size="small" title="基于同一提问重新生成" @click="regenerate(msg)">
                <el-icon><Refresh /></el-icon> 重做
              </el-button>
              <el-button text size="small" title="把本轮提问保存到提示词库" @click="savePromptToLibrary(msg)">
                <el-icon><Collection /></el-icon> 存提示词
              </el-button>
            </div>
          </div>
        </div>
        <div v-if="loading" class="chat-loading-row" role="status">
          <el-tag type="info" size="small">{{ loadingStatusText }}</el-tag>
        </div>
      </div>

      <div v-if="thinkingLogs.length" class="thinking-panel">
        <div class="thinking-header">
          <el-tag type="warning" size="small">{{ loading ? '执行过程（实时）' : '执行过程（最近一次）' }}</el-tag>
          <el-button text size="small" @click="clearThinkingLogs">清空</el-button>
        </div>
        <div ref="thinkingContainer" class="thinking-list">
          <div v-for="item in thinkingLogs" :key="item.id" class="thinking-item">
            <el-tag :type="thinkingTagType(item.type)" size="small">{{ thinkingTypeText(item.type) }}</el-tag>
            <span class="thinking-time">{{ item.time }}</span>
            <span class="thinking-text">{{ item.text }}</span>
          </div>
        </div>
      </div>

      <div v-if="pendingAttachments.length || uploadingCount" class="chat-pending-attachments" role="list" aria-label="待发送附件">
        <div
          v-for="att in pendingAttachments"
          :key="att.id"
          class="chat-pending-chip"
          role="listitem"
        >
          <el-icon><component :is="attachmentIcon(att.kind)" /></el-icon>
          <span class="chat-pending-name" :title="att.name">{{ att.name }}</span>
          <span class="chat-pending-size">{{ formatSize(att.size) }}</span>
          <el-icon class="chat-pending-remove" aria-label="移除附件" @click="removeAttachment(att.id)"><Close /></el-icon>
        </div>
        <div v-if="uploadingCount" class="chat-pending-chip chat-pending-uploading">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>上传中（{{ uploadingCount }}）…</span>
        </div>
      </div>

      <div class="chat-input-row">
        <el-button
          class="chat-attach-btn"
          aria-label="添加附件"
          title="添加图片 / 视频 / 文档 / 项目"
          :disabled="loading"
          @click="triggerAttachPicker"
          circle
        >
          <el-icon><Paperclip /></el-icon>
        </el-button>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.zip,.tar,.gz,.rar,.7z,.py,.js,.ts,.go,.rs,.java,.c,.cpp,.html,.css"
          class="chat-file-input-hidden"
          @change="onFilesSelected"
        />
        <el-input
          v-model="input"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          resize="none"
          :placeholder="dynamicPlaceholder"
          aria-label="对话输入框"
          :disabled="loading"
          @focus="onInputFocus"
          @blur="onInputBlur"
          @keydown.enter="handleInputEnter"
          @keydown.up="handleInputArrowHistoryGuard"
          @keydown.down="handleInputArrowHistoryGuard"
        />
        <div class="chat-action-buttons">
          <el-button class="chat-send-btn" type="primary" aria-label="发送消息" @click="sendMessage" :loading="loading">发送</el-button>
          <el-button
            v-if="loading"
            class="chat-stop-btn"
            type="danger"
            plain
            aria-label="停止生成"
            @click="stopGeneration"
          >
            停止生成
          </el-button>
        </div>
      </div>
    </el-card>

      <AgentStatePanel
        class="chat-side-panel"
        :orb-state="orbState"
        :persona="persona"
        :memory-items="memoryItems"
        :tool-calls="toolCalls"
        :activity="activity"
      />
    </div>
    </div>

    <el-drawer v-model="modelPanelVisible" title="可用模型" direction="rtl" size="440px">
      <div v-loading="modelsLoading || overridesBusy">
        <el-empty
          v-if="!modelGroups.length"
          description="暂无可用模型（请确认对应适配器已本地安装并登录）"
          :image-size="72"
        />
        <div v-else class="model-panel-list">
          <div v-for="group in modelGroups" :key="group.adapter" class="model-panel-group">
            <div class="model-panel-head">
              <el-tag v-if="group.kind" size="small" :type="kindTagType(group.kind)">{{ kindLabel(group.kind) }}</el-tag>
              <span class="model-panel-name">{{ group.name }}</span>
              <span class="model-panel-count">{{ group.models.length }} 个</span>
              <el-button class="model-panel-verify" link type="primary" size="small" @click="verifyAdapter(group.adapter)">验证全部</el-button>
            </div>
            <div v-if="group.source" class="model-panel-source">来源：{{ group.source }}</div>
            <div class="model-panel-rows">
              <div v-for="m in group.models" :key="m.id" class="model-panel-row">
                <div class="model-panel-row-main">
                  <span class="model-panel-row-name" :title="m.id">{{ m.name || m.id }}</span>
                  <el-tag v-if="m.isDefault" size="small" type="warning" effect="plain">默认</el-tag>
                  <el-tag v-if="m.discoverySource" size="small" :type="sourceTagType(m.discoverySource)" effect="plain">{{ sourceLabel(m.discoverySource) }}</el-tag>
                  <el-tag size="small" :type="verifyTagType(m.verifyStatus)" effect="plain">{{ verifyLabel(m.verifyStatus) }}</el-tag>
                </div>
                <div class="model-panel-row-ops">
                  <el-button link size="small" title="设为默认" @click="setDefaultModel(group.adapter, m.id)">默认</el-button>
                  <el-button link size="small" title="重命名" @click="renameModel(group.adapter, m.id, m.name)">改名</el-button>
                  <el-button v-if="m.custom" link type="danger" size="small" title="删除自定义模型" @click="deleteCustomModel(group.adapter, m.id)">删除</el-button>
                  <el-button v-else link type="warning" size="small" title="从列表隐藏" @click="hideModel(group.adapter, m.id)">隐藏</el-button>
                </div>
              </div>
            </div>
            <el-button class="model-panel-add" link type="primary" size="small" @click="addModelToAdapter(group.adapter)">+ 添加模型</el-button>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ChatDotRound, Paperclip, Close, Loading,
  Picture, VideoCamera, Headset, Document, Files, Folder,
  Plus, Fold, Expand, EditPen, Delete,
  Select, CloseBold, RefreshLeft, Refresh, View, Collection,
} from '@element-plus/icons-vue'
import request from '@/api/request'
import { authedFetch } from '@/api/authedFetch'
import { useUserStore } from '@/stores/user'
import AgentStatePanel from './AgentStatePanel.vue'
import { resolveAiChatThinkingEvent, mapEventToOrbState, formatToolParams, summarizeToolProgress } from './aiChatEventUtils'
import { parseToolOutputSections } from './toolOutputSections'
import { useChatConversations } from '@/composables/useChatConversations'
import { useProjects } from '@/composables/useProjects'

const messages = ref([])
const input = ref('')
const loading = ref(false)
const chatContainer = ref(null)
const thinkingContainer = ref(null)
const thinkingLogs = ref([])

// ── Conversation history sidebar (backend-persisted, per-user) ──────────────
const {
  conversations,
  activeId,
  listLoading,
  fetchList,
  openConversation,
  createConversation,
  updateConversation,
  removeConversation,
  relativeTime,
} = useChatConversations()
const sidebarCollapsed = ref(false)

// ── Coding project workspace filter (aligns to Hermes coding projects) ──────
// The sidebar can scope its history to one project; new conversations inherit
// the active project. null = 全部 (all conversations visible, default behavior).
const { projects: projectList, activeProjectId, list: listProjects, setActiveProject } = useProjects()

// Persist the current transcript: create on the first turn (server derives the
// title), update thereafter. Never throws — history persistence must not break
// the chat flow.
//
// Serialized via `_persistChain`: overlapping turns must not both take the
// "first turn → create" branch. `loading` is cleared before persistActive()
// resolves (it is fire-and-forget in runAssistantTurn's finally), so a fast
// second send could otherwise run while the first create POST is still in
// flight — with `activeId` still null it would POST a *second* row for the same
// first conversation, surfacing one conversation as several in the sidebar.
// Chaining guarantees the first create assigns `activeId` before the next
// persist reads it, so subsequent turns correctly take the update branch.
let _persistChain = Promise.resolve()
function persistActive() {
  _persistChain = _persistChain.catch(() => {}).then(() => persistActiveOnce())
  return _persistChain
}
async function persistActiveOnce() {
  // Allow persisting an emptied transcript when it already exists server-side
  // (e.g. 撤回 cleared the only turn) so the stored row is synced to empty
  // rather than left holding the stale prior content. A brand-new, never-saved
  // conversation still does not create an empty row.
  if (!messages.value.length && activeId.value == null) return
  const payload = messages.value.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    attachments: m.attachments,
  }))
  try {
    if (activeId.value == null) {
      await createConversation({ messages: payload, projectId: activeProjectId.value })
    } else {
      await updateConversation(activeId.value, { messages: payload })
    }
  } catch (err) {
    console.warn('[chat] persist conversation failed:', err?.message || err)
  }
}

// ── Context-usage indicator (reuses the CC context-visualization backend) ────
// After each turn we ask the backend to measure the live transcript and return a
// per-category breakdown, % full, remaining tokens and actionable optimization
// hints (near-capacity → /compact, large tool results, Read bloat …). The heavy
// lifting is the pure-leaf backend logic (webContextStats → messageBreakdown +
// contextSuggestions); the frontend only renders. Best-effort and serialized so
// overlapping turns don't race — the indicator must never break the chat flow.
const contextStats = ref(null)
let _ctxStatsChain = Promise.resolve()
function refreshContextStats() {
  _ctxStatsChain = _ctxStatsChain.catch(() => {}).then(refreshContextStatsOnce)
  return _ctxStatsChain
}
async function refreshContextStatsOnce() {
  if (!messages.value.length) { contextStats.value = null; return }
  const payload = messages.value.map((m) => ({ role: m.role, content: m.content }))
  try {
    const { data } = await request.post('/api/ai/context-stats', { messages: payload })
    const stats = data?.data ?? data
    // Gate off / empty transcript → backend returns null; hide the indicator.
    contextStats.value = (stats && typeof stats === 'object') ? stats : null
  } catch {
    // Auxiliary indicator: keep the last-known value rather than flicker to null.
  }
}

// Present-form helpers for the indicator (kept tiny; the numbers come from backend).
function ctxPercentLabel(stats) {
  if (!stats || !Number.isFinite(stats.percentage)) return ''
  return `${Math.round(stats.percentage)}%`
}
function ctxHealthClass(stats) {
  const p = stats && Number.isFinite(stats.percentage) ? stats.percentage : 0
  if (p >= 80) return 'ctx-critical'
  if (p >= 50) return 'ctx-warning'
  return 'ctx-healthy'
}
function ctxFormatTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v < 1000) return String(Math.round(v))
  const k = v / 1000
  const s = k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace(/\.0$/, '')
  return `${s}k`
}

// Start a fresh conversation: clear the canvas; the row is created lazily on the
// first send (matches 清言 — no empty conversations pile up).
function newConversation() {
  if (loading.value) { ElMessage.warning('请等待当前回复完成'); return }
  messages.value = []
  contextStats.value = null
  thinkingLogs.value = []
  input.value = ''
  pendingAttachments.value = []
  activeId.value = null
}

// Switch the active coding-project filter: re-fetch the sidebar scoped to the
// chosen project (null = 全部) and reset to a fresh conversation so the current
// transcript isn't mis-filed under the newly selected project.
async function onProjectChange(id) {
  if (loading.value) { ElMessage.warning('请等待当前回复完成'); return }
  setActiveProject(id)
  newConversation()
  try {
    await fetchList(activeProjectId.value)
    if (conversations.value.length) {
      messages.value = await openConversation(conversations.value[0].id)
      nextTick(scrollToBottom)
      refreshContextStats()
    }
  } catch (err) {
    console.warn('[chat] project switch reload failed:', err?.message || err)
  }
}

async function selectConversation(id) {
  if (id === activeId.value) return
  if (loading.value) { ElMessage.warning('请等待当前回复完成'); return }
  try {
    messages.value = await openConversation(id)
    thinkingLogs.value = []
    nextTick(scrollToBottom)
    refreshContextStats()
  } catch (err) {
    ElMessage.error(`加载对话失败：${err?.message || '未知错误'}`)
  }
}

async function renameConversation(c) {
  try {
    const { value } = await ElMessageBox.prompt('重命名对话', '修改标题', {
      inputValue: c.title,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (v) => (v && v.trim() ? true : '标题不能为空'),
    })
    await updateConversation(c.id, { title: value.trim() })
    ElMessage.success('已重命名')
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('重命名失败')
  }
}

async function deleteConversation(c) {
  try {
    await ElMessageBox.confirm(`删除对话「${c.title}」？此操作不可恢复。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    const wasActive = c.id === activeId.value
    await removeConversation(c.id)
    if (wasActive) newConversation()
    ElMessage.success('已删除')
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('删除失败')
  }
}

// Attachment state: files the user has uploaded and will send with the next
// message. Each entry is the structured descriptor returned by /api/ai/upload
// ({ id, name, mimeType, size, kind, url }). Only ids are sent with the chat
// request; the backend resolves them back to files (keeps the body tiny).
const pendingAttachments = ref([])
const uploadingCount = ref(0)
const fileInputRef = ref(null)

const ATTACHMENT_ICONS = {
  image: Picture, video: VideoCamera, audio: Headset,
  document: Document, text: Document, code: Document,
  archive: Folder, other: Files,
}
function attachmentIcon(kind) {
  return ATTACHMENT_ICONS[kind] || Files
}

function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function triggerAttachPicker() {
  if (loading.value) return
  fileInputRef.value?.click()
}

function removeAttachment(id) {
  pendingAttachments.value = pendingAttachments.value.filter(a => a.id !== id)
}

async function onFilesSelected(event) {
  const input = event.target
  const files = Array.from(input?.files || [])
  if (input) input.value = '' // allow re-selecting the same file
  if (!files.length) return

  for (const file of files) {
    const form = new FormData()
    form.append('file', file)
    uploadingCount.value += 1
    try {
      // 上传走统一带认证入口:注入 token、30s 超时(卡死不再无限等待)、
      // 401 自动登出。失败提示仍由本地处理(逐文件反馈)。
      const res = await authedFetch(resolveApiUrl('/api/ai/upload'), {
        method: 'POST',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        ElMessage.error(`「${file.name}」上传失败：${data.message || `HTTP ${res.status}`}`)
        continue
      }
      const list = Array.isArray(data.attachments) ? data.attachments : []
      for (const att of list) {
        if (att && att.id) pendingAttachments.value.push(att)
      }
    } catch (err) {
      ElMessage.error(`「${file.name}」上传失败：${err?.message || '网络错误'}`)
    } finally {
      uploadingCount.value = Math.max(0, uploadingCount.value - 1)
    }
  }
}

// C2 — digital-human status panel state
const orbState = ref('idle')
const persona = ref({ present: false, sections: [] })
const memoryItems = ref([])
const toolCalls = ref([])
const activity = ref([])

function setOrbState(channel, payload) {
  const next = mapEventToOrbState(channel, payload)
  if (next) orbState.value = next
}

function pushBounded(listRef, value, cap = 40) {
  const v = String(value || '').trim()
  if (!v) return
  listRef.value.push(v)
  if (listRef.value.length > cap) listRef.value = listRef.value.slice(-cap)
}

async function loadPersonaCard() {
  try {
    const { data } = await request.get('/api/ai/persona')
    const payload = data?.data || data
    if (payload && typeof payload === 'object') {
      persona.value = { present: !!payload.present, sections: Array.isArray(payload.sections) ? payload.sections : [] }
    }
  } catch { /* persona endpoint unavailable — leave default empty state */ }
}

const selectedModel = ref('')
const modelGroups = ref([])
const modelsLoading = ref(false)
const transportMode = ref('stream')
let modelsLoaded = false
let currentStreamAbortController = null
let currentChatSocket = null
let manualAbortRequested = false
const userStore = useUserStore()

// Normalize a single model entry, carrying through the local/cloud + source
// provenance fields the backend now exposes (provider/connectionMode/discoverySource).
function normalizeModelEntry(m, groupKind) {
  return {
    id: m.id || m.name,
    name: m.name || m.id,
    isDefault: m.isDefault === true,
    provider: m.provider || null,
    connectionMode: m.connectionMode || (groupKind === 'local' ? 'local' : 'cloud'),
    discoverySource: m.discoverySource || null,
    custom: m.custom === true,
    verifyStatus: m.verifyStatus || 'unknown',
  }
}

async function loadModels() {
  if (modelsLoaded) return
  modelsLoading.value = true
  try {
    // Prefer /models: it returns the real per-adapter model list enriched with
    // kind (local/cloud) and a human-readable source label. Fall back to
    // /status (coarse, one pseudo-model per adapter) only if /models fails.
    const { data } = await request.get('/api/ai-gateway/models')
    const payload = data?.data || data || []
    modelGroups.value = (Array.isArray(payload) ? payload : [])
      .filter(a => a.available !== false)
      .map(a => ({
        adapter: a.adapter || a.name,
        name: a.name || a.adapter,
        kind: a.kind || null,
        source: a.source || '',
        models: (a.models || [{ id: a.adapter || a.name, name: a.name }]).map(m => normalizeModelEntry(m, a.kind))
      }))
    modelsLoaded = true
  } catch {
    try {
      const { data } = await request.get('/api/ai-gateway/status')
      const payload = data?.data || data
      const adapters = payload?.adapters || payload || []
      modelGroups.value = (Array.isArray(adapters) ? adapters : [])
        .filter(a => a.available !== false)
        .map(a => ({
          adapter: a.type || a.name,
          name: a.name || a.type,
          kind: a.kind || null,
          source: a.source || '',
          models: (a.models || [{ id: a.type || a.name, name: a.name }]).map(m => normalizeModelEntry(m, a.kind))
        }))
      modelsLoaded = true
    } catch { /* no models available */ }
  } finally {
    modelsLoading.value = false
  }
}

// Starter prompts shown in the empty state to give the page a purposeful,
// content-first entry point (instead of a blank screen). Clicking one fills the
// composer without auto-sending, so the user stays in control.
//
// Source of truth is the backend built-in catalog (GET /api/ai/prompts/builtin,
// backed by services/backend/src/services/promptTemplateCatalog.js). We fetch it on
// mount; if the backend is unreachable / gated off / empty, we fall back to the local
// mirror below so the empty state is NEVER blank. The mirror is a small subset covering
// the main angles — intentionally duplicated (not drift): "never blank even offline".
const FALLBACK_PROMPT_TEMPLATES = [
  { title: '写一个脚本', category: '编码', prompt: '用 Python 写一个读取 CSV 并做分组统计的脚本，带简单的错误处理和注释。' },
  { title: '解释这段代码', category: '编码', prompt: '逐段解释下面这段代码在做什么，指出可能的坑或改进点：\n\n' },
  { title: '提炼要点', category: '分析总结', prompt: '帮我总结下面内容的核心要点，用简洁的分点列出，并指出最关键的一条：\n\n' },
  { title: '帮我看报错', category: '调试', prompt: '我遇到这个报错，帮我把它翻译成人话，分析可能的原因，并给出排查步骤：\n\n' },
  { title: '拆解成任务清单', category: '规划', prompt: '帮我把下面这个需求拆成可执行的任务清单，标出依赖关系和优先级：\n\n' },
  { title: '润色这段文字', category: '写作', prompt: '帮我润色下面这段文字，让它更通顺、专业，同时保持原意：\n\n' },
  { title: '中英互译', category: '翻译', prompt: '帮我把下面内容翻译成地道的英文（如果原文是英文则翻成中文），保留专业术语：\n\n' },
  { title: '通俗讲清一个概念', category: '学习', prompt: '用通俗的比喻和一个简单例子，讲清楚【在此填入概念，如"梯度下降"】这个概念，假设我是初学者。' },
]

// The live template list (backend-driven, with local fallback). Each entry is
// { title, category, prompt }. Rendered grouped by category in the empty state.
const examplePrompts = ref(FALLBACK_PROMPT_TEMPLATES.slice())

// Group templates by category for the empty-state render, preserving first-seen order.
const groupedPrompts = computed(() => {
  const groups = []
  const index = new Map()
  for (const t of examplePrompts.value) {
    const item = typeof t === 'string' ? { title: t, category: '', prompt: t } : t
    const cat = item.category || '常用'
    if (!index.has(cat)) {
      index.set(cat, groups.length)
      groups.push({ category: cat, items: [] })
    }
    groups[index.get(cat)].items.push(item)
  }
  return groups
})

// Fetch the backend built-in template catalog once; fall back to the local mirror on
// any failure/empty. silent:true so a transient failure never pops an error toast — the
// fallback already keeps the UI populated.
async function loadPromptTemplates() {
  try {
    const { data } = await request.get('/api/ai/prompts/builtin', { silent: true })
    const payload = data?.data || data
    const templates = payload && Array.isArray(payload.templates) ? payload.templates : []
    if (templates.length) {
      examplePrompts.value = templates
    }
  } catch { /* backend unreachable / gated off — keep local fallback, never blank */ }
}

function useExample(t) {
  // Accept both the new object shape and any legacy plain-string entry (defensive).
  input.value = typeof t === 'string' ? t : (t && t.prompt) || ''
}

// 输入框智能引导:占位符轮播,低调地暗示"小K 还能做这些",不打断输入。
// 仅在输入框为空且未聚焦时轮换;一聚焦或开始输入就固定,避免文字在光标下跳动。
const placeholderHints = [
  '输入任何问题，写代码、查资料或聊天都可以…（可添加图片/视频/文档/项目附件）',
  '试试：帮我把这段报错翻译成人话，并给出修复思路',
  '试试：读取这张截图里的表格，整理成 Markdown',
  '试试：把这个需求拆成可执行的任务清单',
  '试试：审查这段代码有没有安全隐患',
  '提示：想看有哪些能力？左侧菜单 →「功能索引」',
]
const placeholderIndex = ref(0)
const inputFocused = ref(false)
const dynamicPlaceholder = computed(() => placeholderHints[placeholderIndex.value] || placeholderHints[0])
let placeholderTimer = null
function startPlaceholderRotation() {
  stopPlaceholderRotation()
  placeholderTimer = setInterval(() => {
    // 只在"空且未聚焦"时轮换,其余情况保持不动。
    if (input.value || inputFocused.value) return
    placeholderIndex.value = (placeholderIndex.value + 1) % placeholderHints.length
  }, 4200)
}
function stopPlaceholderRotation() {
  if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null }
}
function onInputFocus() { inputFocused.value = true }
function onInputBlur() { inputFocused.value = false }

// Drawer state for the dedicated "available models" panel
const modelPanelVisible = ref(false)
function openModelPanel() {
  modelPanelVisible.value = true
  loadModels()
}
function kindLabel(kind) {
  if (kind === 'local') return '本地'
  if (kind === 'cloud') return '云端'
  return ''
}
function kindTagType(kind) {
  if (kind === 'local') return 'success'
  if (kind === 'cloud') return 'primary'
  return 'info'
}

// Source / verify provenance helpers (state transparency: never present a
// hardcoded baseline model as if it were a verified real one).
const SOURCE_LABELS = {
  local: '实时', remote: '远程', baseline: '基线', config: '配置', user: '自定义',
}
function sourceLabel(src) {
  if (!src) return ''
  return SOURCE_LABELS[src] || src
}
function sourceTagType(src) {
  if (src === 'local' || src === 'remote') return 'success'
  if (src === 'baseline') return 'warning'
  if (src === 'user') return 'primary'
  return 'info'
}
function verifyLabel(s) {
  if (s === 'verified') return '已验证'
  if (s === 'failed') return '失败'
  return '未验证'
}
function verifyTagType(s) {
  if (s === 'verified') return 'success'
  if (s === 'failed') return 'danger'
  return 'info'
}

// Edit operations on the per-adapter curation layer. Each persists via the
// model-overrides endpoint, then force-reloads the catalog so the drawer and the
// model selector both reflect the change.
const overridesBusy = ref(false)
async function reloadModels() {
  modelsLoaded = false
  await loadModels()
}
async function patchOverride(adapter, patch) {
  overridesBusy.value = true
  try {
    await request.put(`/api/ai-gateway/model-overrides/${adapter}`, patch)
    await reloadModels()
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || e))
  } finally {
    overridesBusy.value = false
  }
}
async function hideModel(adapter, modelId) {
  // Hidden models are absent from the visible list, so merge with the persisted
  // hidden set (fetched fresh) to avoid clobbering earlier hides.
  await patchOverride(adapter, { hidden: await mergedHidden(adapter, modelId) })
}
async function mergedHidden(adapter, addId) {
  // Fetch current overrides to preserve previously-hidden ids.
  let existing = []
  try {
    const { data } = await request.get('/api/ai-gateway/model-overrides')
    const ov = (data?.data || data)?.overrides || {}
    existing = Array.isArray(ov[adapter]?.hidden) ? ov[adapter].hidden : []
  } catch { /* ignore */ }
  return Array.from(new Set([...existing, addId]))
}
async function setDefaultModel(adapter, modelId) {
  await patchOverride(adapter, { defaultModel: modelId })
}
async function renameModel(adapter, modelId, currentName) {
  try {
    const { value } = await ElMessageBox.prompt('输入新的显示名', '重命名模型', {
      inputValue: currentName || modelId,
      confirmButtonText: '保存', cancelButtonText: '取消',
    })
    let existing = {}
    try {
      const { data } = await request.get('/api/ai-gateway/model-overrides')
      const ov = (data?.data || data)?.overrides || {}
      existing = (ov[adapter]?.renamed) || {}
    } catch { /* ignore */ }
    await patchOverride(adapter, { renamed: { ...existing, [modelId]: value } })
  } catch { /* cancelled */ }
}
async function deleteCustomModel(adapter, modelId) {
  // Custom (user-added) models are removed from the `added` list.
  let existing = []
  try {
    const { data } = await request.get('/api/ai-gateway/model-overrides')
    const ov = (data?.data || data)?.overrides || {}
    existing = Array.isArray(ov[adapter]?.added) ? ov[adapter].added : []
  } catch { /* ignore */ }
  await patchOverride(adapter, { added: existing.filter(m => m.id !== modelId) })
}
async function addModelToAdapter(adapter) {
  try {
    const { value } = await ElMessageBox.prompt('输入模型 ID（如 my-model）', '添加模型', {
      confirmButtonText: '添加', cancelButtonText: '取消',
    })
    const id = String(value || '').trim()
    if (!id) return
    let existing = []
    try {
      const { data } = await request.get('/api/ai-gateway/model-overrides')
      const ov = (data?.data || data)?.overrides || {}
      existing = Array.isArray(ov[adapter]?.added) ? ov[adapter].added : []
    } catch { /* ignore */ }
    if (existing.some(m => m.id === id)) { ElMessage.warning('该模型已存在'); return }
    await patchOverride(adapter, { added: [...existing, { id, name: id }] })
  } catch { /* cancelled */ }
}
async function verifyAdapter(adapter) {
  overridesBusy.value = true
  try {
    ElMessage.info('正在验证模型，请稍候…')
    await request.post(`/api/ai-gateway/models/${adapter}/verify`)
    await reloadModels()
    ElMessage.success('验证完成')
  } catch (e) {
    ElMessage.error('验证失败：' + (e?.message || e))
  } finally {
    overridesBusy.value = false
  }
}

function resolveApiUrl(path) {
  const base = String(request.defaults.baseURL || '').trim()
  if (!base) return path
  if (/^https?:\/\//i.test(base)) return `${base.replace(/\/+$/, '')}${path}`
  return `${base.replace(/\/+$/, '')}${path}`
}

function resolveWsUrl(path) {
  const normalizedPath = `/${String(path || '/ws').replace(/^\/+/, '')}`
  if (typeof window === 'undefined') return normalizedPath

  const origin = String(window.location.origin || '').trim()
  const base = String(request.defaults.baseURL || '').trim()
  const url = base ? new URL(base, origin) : new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = normalizedPath
  url.search = ''
  url.hash = ''
  return url.toString()
}

// WebSocket watchdog windows (env-tunable, no magic constants). The auth phase
// gets a short window; once authenticated the watchdog switches to an idle
// window that is re-armed on every inbound frame, so a silently stalled socket
// (half-open TCP / backend hang) still rejects instead of leaving `loading`
// stuck true and freezing every loading-bound control.
function readTimeoutEnv(key, fallback) {
  const raw = Number(import.meta.env?.[key])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
const WS_AUTH_TIMEOUT_MS = readTimeoutEnv('VITE_AI_WS_AUTH_TIMEOUT_MS', 15000)
const WS_IDLE_TIMEOUT_MS = readTimeoutEnv('VITE_AI_WS_IDLE_TIMEOUT_MS', 60000)
const WS_STOP_FALLBACK_MS = readTimeoutEnv('VITE_AI_WS_STOP_FALLBACK_MS', 2500)

function makeMsgId() {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeThinkingLog(type, text) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: type || 'status',
    text: String(text || '').trim(),
    time: new Date().toLocaleTimeString()
  }
}

function addThinkingLog(type, text) {
  const item = makeThinkingLog(type, text)
  if (!item.text) return
  thinkingLogs.value.push(item)
  if (thinkingLogs.value.length > 160) {
    thinkingLogs.value = thinkingLogs.value.slice(-160)
  }
  scrollThinkingToBottom()
}

function clearThinkingLogs() {
  thinkingLogs.value = []
}

function thinkingTagType(type) {
  if (type === 'error') return 'danger'
  if (type === 'done') return 'success'
  if (type === 'heartbeat') return 'info'
  if (type === 'control') return 'warning'
  return 'warning'
}

function thinkingTypeText(type) {
  if (type === 'error') return '异常'
  if (type === 'done') return '完成'
  if (type === 'heartbeat') return '心跳'
  if (type === 'control') return '控制'
  return '状态'
}

function scrollThinkingToBottom() {
  nextTick(() => {
    if (thinkingContainer.value) {
      thinkingContainer.value.scrollTop = thinkingContainer.value.scrollHeight
    }
  })
}

function extractSseData(rawEvent) {
  const lines = String(rawEvent || '').split('\n')
  const dataLines = []
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return null
  return dataLines.join('\n')
}

// Record a tool_use / tool_result event onto the assistant message so the
// conversation bubble shows the full agentic flow inline (call → result),
// not just the final text. A tool_result is matched back to its tool_use by
// id when available, so the same step shows both its invocation and outcome.
function appendToolStep(assistantMessage, payload) {
  if (!assistantMessage) return
  if (!Array.isArray(assistantMessage.steps)) assistantMessage.steps = []
  const steps = assistantMessage.steps
  const type = String(payload?.type || '')
  const tool = String(payload?.tool || payload?.name || 'tool').trim() || 'tool'
  // Internal pseudo-tools (_system_retry / _system_summarize / _task_notification
  // / _teammate_message) are status carriers, not real tool invocations. They are
  // surfaced in the thinking log via describeToolEvent; rendering them as an inline
  // tool-step card would show a misleading green ✓ on "_system_retry" and leak the
  // internal name into the conversation bubble.
  if (tool.startsWith('_')) return
  const id = String(payload?.id || '').trim()

  if (type === 'tool_use') {
    steps.push({
      key: `${id || tool}-${steps.length}`,
      id,
      tool,
      input: summarizeStepInput(payload?.input),
      // #7 透明化:保留完整(脱敏)参数供「详情」展开,不再只留 120 字截断芯片。
      inputFull: formatToolParams(payload?.input),
      expanded: false,
      status: 'running',
      result: ''
    })
    scrollToBottom()
    return
  }

  if (type === 'tool_result') {
    const ok = payload?.success !== false
    const detail = String(payload?.text || '').trim()
    // Pair with the most recent still-running step that shares the id (or, if no
    // id, the latest running step for the same tool).
    let target = null
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const s = steps[i]
      if (s.status !== 'running') continue
      if (id && s.id && s.id === id) { target = s; break }
      if (!id && s.tool === tool) { target = s; break }
    }
    if (target) {
      target.status = ok ? 'ok' : 'error'
      target.result = detail
      // `=== label ===` 分节表头 → 预解析成带标题的块供结构化渲染;无表头 → null(回退单行)。
      target.sections = parseToolOutputSections(detail)
    } else {
      steps.push({
        key: `${id || tool}-${steps.length}`,
        id,
        tool,
        input: '',
        inputFull: '',
        expanded: false,
        status: ok ? 'ok' : 'error',
        result: detail,
        sections: parseToolOutputSections(detail)
      })
    }
    scrollToBottom()
  }
}

// #7 展开/收起某条工具步骤的完整参数与结果面板。
function toggleStepExpand(step) {
  if (!step) return
  step.expanded = !step.expanded
}

// Compact a tool input object to a short single-line preview for the step chip.
function summarizeStepInput(input) {
  if (input == null) return ''
  if (typeof input === 'string') {
    const s = input.replace(/\s+/g, ' ').trim()
    return s.length > 120 ? `${s.slice(0, 120)}…` : s
  }
  let s = ''
  try { s = JSON.stringify(input) } catch { s = String(input) }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

// A terminal structured failure (E0x from the backend failsafe). Carries the
// human-readable attribution so runAssistantTurn can stop WITHOUT falling back to
// the plain endpoint (which would mask the failure behind another attempt).
class StructuredChatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StructuredChatError'
    this.structured = true
  }
}

// Attach a structured E0x attribution to an assistant message so the bubble renders
// the human-readable failure card (发生了什么 / 为什么 / 我可以怎么办) plus the
// trace drill-down. `logEvent` is the normalized object from structuredErrorEvent.
function applyStructuredError(assistantMessage, logEvent) {
  if (!assistantMessage || !logEvent || !logEvent.code) return
  assistantMessage.error = {
    code: logEvent.code,
    category: logEvent.category || '执行失败',
    why: logEvent.reason || '',
    how: logEvent.suggestion || '',
    retryable: logEvent.retryable === true,
    sensitive: logEvent.sensitive === true,
    requestId: logEvent.requestId || '',
    _trace: null,        // lazily fetched on drill-down
    _traceLoading: false,
    _traceOpen: false,
  }
}

function handleStreamEvent(rawEvent, assistantMessage) {
  const dataText = extractSseData(rawEvent)
  if (!dataText) return

  let payload = null
  try {
    payload = JSON.parse(dataText)
  } catch {
    payload = { type: 'chunk', content: dataText }
  }

  const type = String(payload?.type || 'chunk')
  setOrbState('stream', payload)

  // 响应防抖抗拼接：后端判定本轮已流出的文本是废稿（无理由套话拒绝重试），
  // 丢弃已累积的气泡内容，等待修正内容替换——而非把修正内容追加在废稿后面。
  if (type === 'reset') {
    assistantMessage.content = ''
    if (Array.isArray(assistantMessage.steps)) assistantMessage.steps = []
    const resetLog = resolveAiChatThinkingEvent('stream', payload)
    if (resetLog) addThinkingLog(resetLog.type, resetLog.text)
    scrollToBottom()
    return
  }

  // Inline tool flow (call → result) on the assistant bubble, in addition to
  // the thinking-panel log below.
  if (type === 'tool_use' || type === 'tool_result') {
    appendToolStep(assistantMessage, payload)
  }

  const logEvent = resolveAiChatThinkingEvent('stream', payload)
  if (logEvent) {
    addThinkingLog(logEvent.type, logEvent.text)
    pushBounded(activity, logEvent.text)
    if (type === 'error') {
      // Structured E0x → render the human-readable card and stop terminally (no
      // plain-endpoint fallback). Legacy errors (no code) keep the throw→fallback.
      if (logEvent.code) {
        applyStructuredError(assistantMessage, logEvent)
        throw new StructuredChatError(logEvent.text)
      }
      throw new Error(payload.message || '流式响应失败')
    }
    return
  }

  if (type === 'chunk') {
    const piece = String(payload.content || '')
    if (!piece) return
    assistantMessage.content += piece
    scrollToBottom()
    return
  }

  // 用户可见的中间消息(如视觉路由说明)——SSE 路径同 WS:以段落分隔追加到气泡内容,
  // 后续 chunk/最终答复自然衔接其后(resolveAiChatThinkingEvent 对该类型返 null,故不被日志块吞掉)。
  if (type === 'assistant_message') {
    const piece = String(payload.content || payload.text || '').trim()
    if (!piece) return
    assistantMessage.content += (assistantMessage.content ? '\n\n' : '') + piece
    scrollToBottom()
    return
  }

  if (type === 'done') {
    if (!assistantMessage.content && payload.content) {
      assistantMessage.content = String(payload.content)
    }
    if (payload.model) {
      assistantMessage.model = String(payload.model)
    }
    addThinkingLog('done', `步骤 3/3：生成完成，来源=${payload.model || payload.adapter || 'AI'}`)
    return
  }

}

function closeCurrentChatSocket() {
  const ws = currentChatSocket
  currentChatSocket = null
  if (!ws) return
  ws.onopen = null
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  } catch { /* noop */ }
}

function handleWsEvent(payload, assistantMessage, done) {
  const type = String(payload?.type || '')
  if (type === 'connected') return

  setOrbState('ws', payload)
  // 响应防抖抗拼接：丢弃废稿气泡，等待修正内容替换（详见 stream 分支注释）。
  if (type === 'reset') {
    assistantMessage.content = ''
    if (Array.isArray(assistantMessage.steps)) assistantMessage.steps = []
    const resetLog = resolveAiChatThinkingEvent('ws', payload)
    if (resetLog) pushBounded(activity, resetLog.text)
    return
  }
  if (type === 'tool_call') {
    pushBounded(toolCalls, String(payload.command || payload.tool || 'unknown'))
  }
  if (type === 'tool_use' || type === 'tool_result') {
    appendToolStep(assistantMessage, payload)
  }
  const logEvent = resolveAiChatThinkingEvent('ws', payload)
  if (logEvent) pushBounded(activity, logEvent.text)

  if (type === 'text') {
    const piece = String(payload.text || '')
    if (!piece) return
    assistantMessage.content += piece
    scrollToBottom()
    return
  }

  // 用户可见的中间消息(如视觉路由说明:文本模型先说明「我无法识别图片，正在调用视觉模型」)。
  // 这是 khy 在回合中对用户说的一句话 → 以段落分隔追加到气泡内容，后续视觉识别/最终答复
  // 经 text 事件自然衔接其后，用户在同一个气泡里看到完整的「说明 → 识别 → 作答」流程。
  if (type === 'assistant_message') {
    const piece = String(payload.content || payload.text || '').trim()
    if (!piece) return
    assistantMessage.content += (assistantMessage.content ? '\n\n' : '') + piece
    scrollToBottom()
    return
  }

  if (type === 'chat_complete') {
    if (!assistantMessage.content && payload.reply) {
      assistantMessage.content = String(payload.reply)
    }
    if (payload.provider && payload.provider !== 'cancelled') {
      assistantMessage.model = String(payload.provider)
    }
    if (payload.provider === 'cancelled' || manualAbortRequested) {
      done({ cancelled: true })
      return
    }
    if (logEvent) {
      addThinkingLog(logEvent.type, logEvent.text)
    }
    done({ cancelled: false })
    return
  }

  if (logEvent) {
    addThinkingLog(logEvent.type, logEvent.text)
  }
}

async function sendMessageByWebSocket(text, assistantMessage, attachmentIds = []) {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
    throw new Error('当前浏览器不支持 WebSocket')
  }

  const payload = { type: 'chat', message: text }
  if (attachmentIds.length) payload.attachments = attachmentIds
  if (selectedModel.value) {
    const [adapter, ...rest] = selectedModel.value.split('/')
    payload.preferredAdapter = adapter
    payload.preferredModel = rest.join('/')
  }

  addThinkingLog('status', '步骤 1/3：正在建立 WebSocket 连接并等待认证')

  return new Promise((resolve, reject) => {
    let settled = false
    let authed = false
    let watchdog = null
    const ws = new WebSocket(resolveWsUrl('/ws'))
    currentChatSocket = ws

    const armWatchdog = (ms, message) => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => fail(message), ms)
    }

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      closeCurrentChatSocket()
      callback(value)
    }

    const fail = (message) => {
      finish(reject, new Error(message || 'WebSocket 会话失败'))
    }

    armWatchdog(WS_AUTH_TIMEOUT_MS, 'WebSocket 认证超时')

    ws.onopen = () => {
      addThinkingLog('status', '步骤 1/3：WebSocket 已连接，正在发送认证信息')
      ws.send(JSON.stringify({
        type: 'auth',
        token: userStore.token || ''
      }))
    }

    ws.onmessage = (event) => {
      let payloadData = null
      try {
        payloadData = JSON.parse(String(event.data || '{}'))
      } catch {
        return
      }

      // Any inbound frame is liveness — re-arm the watchdog so the window only
      // trips on genuine silence (no auth / no chunk for the whole interval).
      armWatchdog(authed ? WS_IDLE_TIMEOUT_MS : WS_AUTH_TIMEOUT_MS,
        authed ? 'WebSocket 响应超时' : 'WebSocket 认证超时')

      const type = String(payloadData?.type || '')
      if (type === 'auth_ok') {
        authed = true
        armWatchdog(WS_IDLE_TIMEOUT_MS, 'WebSocket 响应超时')
        addThinkingLog('status', '步骤 2/3：WebSocket 认证成功，AI 请求已发送')
        ws.send(JSON.stringify(payload))
        return
      }

      if (type === 'auth_error') {
        fail(payloadData.message || 'WebSocket 认证失败')
        return
      }

      if (!authed && type !== 'connected') return

      if (type === 'error') {
        // Structured E0x → terminal attribution: render the card and resolve
        // cleanly so we do NOT fall back to SSE/plain (which would mask it).
        // Connection-level errors (no code) keep rejecting → WS→SSE fallback.
        if (payloadData.error_code) {
          const logEvent = resolveAiChatThinkingEvent('ws', payloadData)
          if (logEvent) { addThinkingLog(logEvent.type, logEvent.text); pushBounded(activity, logEvent.text) }
          applyStructuredError(assistantMessage, logEvent || {})
          finish(resolve, { structured: true })
          return
        }
        fail(payloadData.message || 'WebSocket 会话失败')
        return
      }

      handleWsEvent(payloadData, assistantMessage, (result) => {
        finish(resolve, result)
      })
    }

    ws.onerror = () => {
      fail('WebSocket 连接失败')
    }

    ws.onclose = () => {
      if (settled) return
      if (manualAbortRequested) {
        finish(resolve, { cancelled: true })
        return
      }
      fail('WebSocket 连接已关闭')
    }
  })
}

async function sendMessageByStream(text, assistantMessage, attachmentIds = []) {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || typeof TextDecoder === 'undefined') {
    throw new Error('当前浏览器不支持流式响应读取')
  }

  const payload = { message: text, question: text }
  if (attachmentIds.length) payload.attachments = attachmentIds
  if (selectedModel.value) {
    const [adapter, ...rest] = selectedModel.value.split('/')
    payload.preferredAdapter = adapter
    payload.preferredModel = rest.join('/')
  }

  currentStreamAbortController = new AbortController()
  addThinkingLog('status', '步骤 1/3：正在建立流式连接并发送请求')

  // 流式响应:stream:true 关闭内部超时(长时间生成不受影响),并把"停止生成"
  // 按钮的 signal 传给 authedFetch,内部 401 处理与外部中止二者兼容。
  const res = await authedFetch(resolveApiUrl('/api/ai/chat/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: currentStreamAbortController.signal,
    stream: true,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new Error('浏览器未提供可读流接口')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const rawEvent of events) {
      handleStreamEvent(rawEvent, assistantMessage)
    }
  }

  const tail = buffer.trim()
  if (tail) {
    handleStreamEvent(tail, assistantMessage)
  }
}

async function sendMessageByFallback(text, attachmentIds = []) {
  const body = { message: text, question: text }
  if (attachmentIds.length) body.attachments = attachmentIds
  if (selectedModel.value) {
    const [adapter, ...rest] = selectedModel.value.split('/')
    body.preferredAdapter = adapter
    body.preferredModel = rest.join('/')
  }
  const { data } = await request.post('/api/ai/chat', body)
  return {
    content: data.answer || data.reply || data.content || JSON.stringify(data),
    model: data.model || ''
  }
}

// Run one assistant turn: drive the transport (WS→SSE fallback), accumulate the
// reply into the given `assistantMessage` object, and finalize. Shared by the
// initial send (sendMessage) and re-runs (regenerate) so both behave identically.
async function runAssistantTurn(text, assistantMessage, attachmentIds = []) {
  manualAbortRequested = false
  loading.value = true
  clearThinkingLogs()
  addThinkingLog('status', '请求已提交：等待 AI 网关建立处理链路')
  scrollToBottom()

  try {
    let transportResult = null
    if (transportMode.value === 'ws') {
      try {
        transportResult = await sendMessageByWebSocket(text, assistantMessage, attachmentIds)
      } catch (wsErr) {
        addThinkingLog('error', `WebSocket 模式失败，正在回退到 HTTP 流式：${wsErr?.message || '未知异常'}`)
        await sendMessageByStream(text, assistantMessage, attachmentIds)
      }
    } else {
      await sendMessageByStream(text, assistantMessage, attachmentIds)
    }

    if (transportResult?.cancelled) {
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '已停止生成。'
      }
      addThinkingLog('done', '已按用户请求停止生成')
      return
    }

    // A structured E0x failure is the terminal answer for this turn — the card is
    // already shown. Do NOT mask it behind a plain-endpoint retry.
    if (transportResult?.structured || assistantMessage.error) {
      addThinkingLog('error', '本轮已归因失败，详见消息内的失败卡片')
      return
    }

    if (!assistantMessage.content.trim()) {
      const fallback = await sendMessageByFallback(text, attachmentIds)
      assistantMessage.content = fallback.content
      assistantMessage.model = fallback.model
      addThinkingLog('status', '未收到流式文本，已自动切换为普通响应模式')
    }
  } catch (err) {
    const aborted = manualAbortRequested || err?.name === 'AbortError'
    if (aborted) {
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '已停止生成。'
      }
      addThinkingLog('done', '已按用户请求停止生成')
      return
    }

    // Structured E0x from the SSE path: card already attached, stop terminally.
    if (err?.structured || assistantMessage.error) {
      addThinkingLog('error', '本轮已归因失败，详见消息内的失败卡片')
      return
    }

    addThinkingLog('error', `流式模式失败，正在回退：${err?.message || '未知异常'}`)
    try {
      const fallback = await sendMessageByFallback(text, attachmentIds)
      assistantMessage.content = fallback.content
      assistantMessage.model = fallback.model
      addThinkingLog('done', '回退到普通响应模式成功')
    } catch (fallbackErr) {
      assistantMessage.content = `错误：${fallbackErr.response?.data?.message || fallbackErr.message}`
      addThinkingLog('error', `普通响应模式也失败：${fallbackErr?.message || '未知异常'}`)
    }
  } finally {
    loading.value = false
    currentStreamAbortController = null
    orbState.value = 'idle'
    scrollToBottom()
    // Persist this turn to backend history (create on first turn, else update).
    persistActive()
    // Refresh the context-usage indicator from the live transcript.
    refreshContextStats()
  }
}

async function sendMessage() {
  const text = input.value.trim()
  const attachments = pendingAttachments.value.slice()
  const attachmentIds = attachments.map(a => a.id)
  if ((!text && !attachmentIds.length) || loading.value) return
  if (uploadingCount.value > 0) {
    ElMessage.warning('附件仍在上传中，请稍候')
    return
  }

  messages.value.push({
    id: makeMsgId(),
    role: 'user',
    content: text,
    attachments: attachments.length ? attachments : undefined,
  })
  input.value = ''
  pendingAttachments.value = []

  const assistantMessage = { id: makeMsgId(), role: 'assistant', content: '', model: '', steps: [], error: null }
  messages.value.push(assistantMessage)

  await runAssistantTurn(text, assistantMessage, attachmentIds)
}

// Locate the nearest preceding user message for an assistant reply at `idx`.
function findTriggeringUserIndex(idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') return i
  }
  return -1
}

// 重做：re-run the same user prompt and regenerate this reply in place. Later
// messages are untouched (the assistant object is reset, not removed).
async function regenerate(msg) {
  if (loading.value) { ElMessage.warning('请等待当前回复完成'); return }
  const idx = messages.value.findIndex(m => m.id === msg.id)
  if (idx < 0 || msg.role !== 'assistant') return
  const userIdx = findTriggeringUserIndex(idx)
  if (userIdx < 0) { ElMessage.warning('找不到对应的用户消息，无法重做'); return }
  const userMsg = messages.value[userIdx]
  const text = userMsg.content || ''
  const attachmentIds = (userMsg.attachments || []).map(a => a.id)
  // Reset the reply in place (mirrors the SSE 'reset' event handling).
  msg.content = ''
  msg.steps = []
  msg.model = ''
  msg.error = null
  await runAssistantTurn(text, msg, attachmentIds)
}

// 保存到提示词库：save the user prompt that produced this reply as a manual,
// active prompt template. Lets the user title it first. Best-effort — a failure
// only surfaces a toast, never disturbs the chat.
async function savePromptToLibrary(msg) {
  const idx = messages.value.findIndex(m => m.id === msg.id)
  if (idx < 0 || msg.role !== 'assistant') return
  const userIdx = findTriggeringUserIndex(idx)
  if (userIdx < 0) { ElMessage.warning('找不到对应的提问，无法保存'); return }
  const content = (messages.value[userIdx].content || '').trim()
  if (!content) { ElMessage.warning('提问内容为空，无法保存'); return }
  let title
  try {
    const r = await ElMessageBox.prompt('给这条提示词起个标题', '保存到提示词库', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: content.length > 40 ? `${content.slice(0, 40)}…` : content,
    })
    title = r.value
  } catch {
    return // cancelled
  }
  try {
    await request.post('/api/ai/prompts', { title: (title || '').trim(), content, source: 'manual' })
    ElMessage.success('已保存到提示词库')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '保存失败')
  }
}
// Human-readable labels for the timeline stages traceAuditService emits.
const TRACE_STAGE_LABELS = {
  session_start: '会话开始',
  model_request: '模型请求',
  tool_call: '工具调用',
  tool_result: '工具结果',
  model_response: '模型响应',
  delivery_final: '交付收尾',
  language_first_chunk: '首段输出',
  language_final_response: '最终回复',
  session_end: '会话结束',
  unknown: '未知阶段',
  other: '其他',
}
function stageLabel(stage) {
  return TRACE_STAGE_LABELS[String(stage || '').trim()] || String(stage || '未知阶段')
}

// Map the delivery summary's brokenStage (a semantic phase) to a human sentence.
const BROKEN_STAGE_LABELS = {
  before_tool_call: '模型已发起请求，但在调用工具前中断',
  tool_execution: '工具已调用，但未返回结果（执行中断）',
  after_tool_result: '工具已返回结果，但模型未继续响应',
  final_conclusion: '已产生响应，但收尾结论缺失',
  delivery_event_missing: '已产生响应，但交付事件缺失',
}
function brokenStageLabel(trace) {
  const bs = trace && trace.delivery && trace.delivery.brokenStage
  if (!bs) return ''
  return BROKEN_STAGE_LABELS[bs] || `断点：${bs}`
}

// The chain stopped at its last recorded stage when delivery is not 'completed';
// highlight that row so the eye lands on "断在哪一环".
function isBrokenStage(trace, idx) {
  if (!trace || !Array.isArray(trace.timeline) || !trace.timeline.length) return false
  const status = trace.delivery && trace.delivery.status
  if (status === 'completed') return false
  return idx === trace.timeline.length - 1
}

function formatTraceTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return String(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  } catch {
    return String(ts)
  }
}

// Toggle the trace panel; fetch the server-side timeline on first open and cache
// it on msg.error._trace so re-opening is instant. All failure states are handled
// locally — a fetch error never throws into the bubble.
async function toggleTrace(msg) {
  const err = msg && msg.error
  if (!err) return
  err._traceOpen = !err._traceOpen
  if (!err._traceOpen || err._trace || err._traceLoading || !err.requestId) return
  err._traceLoading = true
  try {
    const res = await authedFetch(
      resolveApiUrl(`/api/ai-gateway/monitor/attribution?requestId=${encodeURIComponent(err.requestId)}`),
      { silent: true }
    )
    err._trace = await res.json().catch(() => ({ ok: false, summary: '响应解析失败', timeline: [] }))
  } catch (e) {
    err._trace = { ok: false, summary: `追溯请求失败：${e?.message || '网络异常'}`, timeline: [] }
  } finally {
    err._traceLoading = false
  }
}

// 撤回：retract this whole turn (the reply + the user message that triggered it)
// and restore the user's text/attachments into the composer for editing.
function retract(msg) {
  if (loading.value) { ElMessage.warning('请等待当前回复完成'); return }
  const idx = messages.value.findIndex(m => m.id === msg.id)
  if (idx < 0 || msg.role !== 'assistant') return
  const userIdx = findTriggeringUserIndex(idx)
  if (userIdx >= 0) {
    const userMsg = messages.value[userIdx]
    input.value = userMsg.content || ''
    if (userMsg.attachments && userMsg.attachments.length) {
      pendingAttachments.value = userMsg.attachments.slice()
    }
    messages.value.splice(userIdx, idx - userIdx + 1)
  } else {
    messages.value.splice(idx, 1)
  }
  persistActive()
}

function stopGeneration() {
  if (!loading.value) return
  manualAbortRequested = true
  if (transportMode.value === 'ws' && currentChatSocket && currentChatSocket.readyState === WebSocket.OPEN) {
    addThinkingLog('status', '收到停止指令：正在通过 WebSocket 终止当前生成')
    const ws = currentChatSocket
    try {
      ws.send(JSON.stringify({ type: 'stop' }))
    } catch { /* noop */ }
    // Fallback: if the server ignores the stop frame, close the socket so the
    // existing onclose handler settles the promise (manualAbortRequested →
    // cancelled) instead of hanging on `loading` until the idle watchdog fires.
    setTimeout(() => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try { ws.close() } catch { /* noop */ }
      }
    }, WS_STOP_FALLBACK_MS)
    return
  }

  addThinkingLog('status', '收到停止指令：正在终止当前生成')
  if (currentStreamAbortController) {
    try { currentStreamAbortController.abort() } catch { /* noop */ }
  }
}

function handleInputEnter(event) {
  if (event?.isComposing || event?.keyCode === 229) return
  if (event?.shiftKey || event?.ctrlKey || event?.altKey || event?.metaKey) return
  event.preventDefault()
  sendMessage()
}

function handleInputArrowHistoryGuard(event) {
  if (event?.isComposing || event?.keyCode === 229) return
  const current = String(input.value || '')
  // Guard against browser/IME history recall when input is empty.
  if (current.trim().length > 0) return
  event.preventDefault()
  event.stopPropagation()
}

// Coalesce scroll requests to one per animation frame. During token streaming
// scrollToBottom() is called dozens of times per second; reading scrollHeight on
// every call forces a synchronous reflow each time and is the main chat-freeze
// cause. rAF batching collapses a burst of calls into a single layout read+write.
let _scrollRafId = 0
function scrollToBottom() {
  if (_scrollRafId) return
  _scrollRafId = requestAnimationFrame(() => {
    _scrollRafId = 0
    const el = chatContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const loadingStatusText = computed(() => (
  transportMode.value === 'ws'
    ? 'AI 输出通道已建立（WebSocket），正在接收增量内容'
    : 'AI 输出通道已建立（HTTP 流式），正在接收增量内容'
))

onMounted(async () => {
  loadModels()
  loadPersonaCard()
  loadPromptTemplates()
  startPlaceholderRotation()
  // Load history list and restore the most recent conversation, so returning to
  // the page resumes where the user left off (cross-device via backend store).
  try {
    // Load the project list for the sidebar selector (best-effort — the chat
    // works without it), then fetch history scoped to the active project.
    listProjects().catch(() => {})
    await fetchList(activeProjectId.value)
    if (conversations.value.length) {
      messages.value = await openConversation(conversations.value[0].id)
      nextTick(scrollToBottom)
      refreshContextStats()
    }
  } catch (err) {
    console.warn('[chat] load history failed:', err?.message || err)
  }
})

onBeforeUnmount(() => {
  if (_scrollRafId) { cancelAnimationFrame(_scrollRafId); _scrollRafId = 0 }
  stopPlaceholderRotation()
  if (currentStreamAbortController) {
    try { currentStreamAbortController.abort() } catch { /* noop */ }
    currentStreamAbortController = null
  }
  closeCurrentChatSocket()
  // Fallback persist: catch a turn whose stream was interrupted by navigation.
  persistActive()
})
</script>

<style scoped>
.ai-chat-page {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  max-width: 1320px;
  margin: 0 auto;
}

/* ── History sidebar ── */
.chat-sidebar {
  flex: 0 0 260px;
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--khy-border);
  border-radius: var(--khy-radius-lg, 12px);
  background: var(--khy-bg-soft, var(--el-fill-color-blank, transparent));
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 110px);
}

.chat-sidebar.is-collapsed {
  display: none;
}

.chat-sidebar-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-project-select {
  width: 100%;
  margin-top: 8px;
}

.chat-new-btn {
  flex: 1;
}

.chat-sidebar-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--khy-text-muted, var(--el-text-color-secondary));
  padding: 2px 2px 0;
}

.chat-conv-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 60px;
}

.chat-conv-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}

.chat-conv-item:hover {
  background: var(--el-fill-color-light);
  transform: translateX(2px);
}

.chat-conv-item.active {
  background: var(--el-color-primary-light-9);
}

/* Active accent bar — matches the main sidebar's current-route marker. */
.chat-conv-item.active::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--khy-primary), var(--khy-primary-strong));
}

.chat-conv-main {
  flex: 1;
  min-width: 0;
}

.chat-conv-title {
  font-size: 13px;
  color: var(--khy-text-strong, var(--el-text-color-primary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-conv-time {
  font-size: 11px;
  color: var(--khy-text-muted, var(--el-text-color-secondary));
  margin-top: 2px;
}

.chat-conv-ops {
  display: none;
  gap: 4px;
  flex-shrink: 0;
}

.chat-conv-item:hover .chat-conv-ops {
  display: flex;
}

.chat-conv-op {
  cursor: pointer;
  font-size: 14px;
  color: var(--khy-text-muted, var(--el-text-color-secondary));
}

.chat-conv-op:hover {
  color: var(--el-color-primary);
}

.chat-conv-empty {
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
  color: var(--khy-text-muted, var(--el-text-color-secondary));
}

.chat-main {
  flex: 1;
  min-width: 0;
  max-width: 1040px;
}

.chat-expand-btn {
  margin-right: 4px;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 12px;
  flex-wrap: wrap;
}

.chat-header .khy-page-title {
  margin: 0;
}

.chat-config {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.model-selector {
  min-width: 220px;
}

.model-selector .el-select {
  width: 100%;
}

.transport-selector {
  min-width: 150px;
}

.transport-selector .el-select {
  width: 100%;
}

/* ── Context-usage indicator ─────────────────────────────────────────────── */
.ctx-usage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 14px;
  background: var(--el-fill-color-blank, #fff);
  cursor: default;
  font-size: 12px;
  line-height: 1;
  color: var(--el-text-color-regular, #606266);
  transition: border-color 0.2s ease;
}
.ctx-usage-chip:hover { border-color: var(--el-color-primary, #409eff); }
.ctx-usage-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #67c23a;
}
.ctx-usage-chip.ctx-warning .ctx-usage-dot { background: #e6a23c; }
.ctx-usage-chip.ctx-critical .ctx-usage-dot { background: #f56c6c; }
.ctx-usage-pct { font-variant-numeric: tabular-nums; font-weight: 600; }

.ctx-usage-panel { font-size: 12px; color: var(--el-text-color-regular, #606266); }
.ctx-usage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.ctx-usage-sub { color: var(--el-text-color-secondary, #909399); font-variant-numeric: tabular-nums; }
.ctx-usage-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--el-fill-color, #f0f2f5);
  overflow: hidden;
  margin-bottom: 10px;
}
.ctx-usage-fill { height: 100%; border-radius: 3px; background: #67c23a; transition: width 0.3s ease; }
.ctx-usage-fill.ctx-warning { background: #e6a23c; }
.ctx-usage-fill.ctx-critical { background: #f56c6c; }
.ctx-usage-cats { list-style: none; margin: 0 0 8px; padding: 0; }
.ctx-usage-cats li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}
.ctx-cat-name { color: var(--el-text-color-regular, #606266); }
.ctx-cat-tok { color: var(--el-text-color-secondary, #909399); font-variant-numeric: tabular-nums; }
.ctx-usage-hints { border-top: 1px solid var(--el-border-color-lighter, #ebeef5); padding-top: 8px; }
.ctx-usage-hint { display: flex; gap: 6px; padding: 4px 0; }
.ctx-hint-glyph { flex: 0 0 auto; }
.ctx-usage-hint.is-warn .ctx-hint-glyph { color: #e6a23c; }
.ctx-usage-hint.is-info .ctx-hint-glyph { color: #909399; }
.ctx-hint-title { font-weight: 600; color: var(--el-text-color-primary, #303133); }
.ctx-hint-save {
  margin-left: 6px;
  font-weight: 400;
  color: var(--el-color-success, #67c23a);
  font-variant-numeric: tabular-nums;
}
.ctx-hint-detail { color: var(--el-text-color-secondary, #909399); margin-top: 2px; }

.model-default-tag {
  margin-left: 6px;
  vertical-align: middle;
}

.model-kind-tag {
  margin-left: 6px;
  vertical-align: middle;
}

.model-verify-tag {
  margin-left: 6px;
  vertical-align: middle;
}

.model-panel-trigger {
  min-width: 96px;
}

.model-panel-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.model-panel-group {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
}

.model-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-panel-name {
  font-weight: 600;
}

.model-panel-count {
  margin-left: auto;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.model-panel-source {
  margin: 6px 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.model-panel-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.model-default-mark {
  margin-left: 4px;
  opacity: 0.8;
}

.model-panel-verify {
  margin-left: 8px;
}

.model-panel-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.model-panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.model-panel-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

.model-panel-row-name {
  font-size: 13px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-panel-row-ops {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.model-panel-add {
  margin-top: 8px;
}

.chat-layout {
  display: flex;
  gap: 16px;
  align-items: stretch;
  max-width: 1240px;
  margin: 0 auto;
}

.chat-card {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 920px;
  display: flex;
  flex-direction: column;
}

/* Make the card body a full-height flex column so the composer row is pinned to
   the bottom edge — lining the send button up with the bottom of the side panel
   (its last card's text) instead of floating above empty space. */
.chat-card :deep(.el-card__body) {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-side-panel {
  flex: 0 0 280px;
  width: 280px;
  align-self: stretch;
  overflow-y: auto;
  padding-right: 2px;
}

@media (max-width: 900px) {
  .chat-layout {
    flex-direction: column;
    align-items: stretch;
  }
  .chat-side-panel {
    flex-basis: auto;
    width: 100%;
    align-self: auto;
    overflow-y: visible;
  }
}

.chat-window {
  flex: 1 1 auto;
  min-height: 320px;
  overflow-y: auto;
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid var(--khy-border-light);
  border-radius: var(--khy-radius-lg);
  background: var(--khy-bg-soft);
}

/* Empty state — purposeful entry point instead of a blank canvas. A soft chat
   glyph keeps it on-brand for a conversation surface (no generic placeholder box). */
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.chat-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 14px;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  animation: chat-empty-pulse 2.8s ease-in-out infinite;
}

@keyframes chat-empty-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--khy-primary-soft); }
  50%      { box-shadow: 0 0 0 10px transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .chat-empty-icon { animation: none; }
}

.chat-empty-icon .el-icon {
  font-size: 28px;
}

.chat-empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.chat-empty-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.chat-empty-prompts {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.chat-empty-prompt-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: 640px;
}

.chat-empty-prompt-cat {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  letter-spacing: 0.5px;
}

.chat-empty-prompt-btns {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.chat-message-row {
  margin-bottom: 14px;
  text-align: left;
  animation: chat-msg-in 0.25s ease-out;
}

@keyframes chat-msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.chat-message-row.user {
  text-align: right;
}

.chat-role-tag {
  margin-bottom: 4px;
}

.chat-bubble {
  display: inline-block;
  max-width: 84%;
  padding: 10px 14px;
  border-radius: 14px;
  text-align: left;
  line-height: 1.55;
  color: var(--khy-text-main);
  border: 1px solid transparent;
  box-shadow: var(--khy-shadow);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  transition: box-shadow 0.2s ease;
}

.chat-bubble:hover {
  box-shadow: var(--khy-shadow-lift);
}

/* User bubble: a saturated brand gradient with white text — the modern chat
   read, and it's what the in-bubble attachment chips (translucent-white bg)
   were already designed for. Dark mode uses a deeper gradient so white text
   keeps a comfortable contrast against the lighter dark-theme primary token. */
.chat-bubble-user {
  background: linear-gradient(135deg, var(--khy-primary), var(--khy-primary-strong));
  border-color: transparent;
  color: #fff;
  border-bottom-right-radius: 4px;
  box-shadow: 0 6px 18px rgba(47, 126, 247, 0.26);
}

html.dark .chat-bubble-user {
  background: linear-gradient(135deg, #2f6fd6, #2456ad);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.chat-bubble-assistant {
  background: var(--khy-bg-card);
  border-color: var(--khy-border);
  border-bottom-left-radius: 4px;
}

/* Per-reply 撤回 / 重做 actions — revealed on hover (or keyboard focus). */
.chat-bubble-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.chat-message-row:hover .chat-bubble-actions,
.chat-bubble-actions:focus-within {
  opacity: 1;
}

/* Inline tool-call flow shown above the assistant's text answer. */
.chat-tool-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.chat-tool-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--khy-primary-soft);
  border: 1px solid var(--khy-border);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
}

.chat-tool-step.is-error {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-5);
}

.chat-tool-step.is-ok {
  border-color: var(--el-color-success-light-5);
}

.chat-tool-step-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--el-color-primary);
}

.chat-tool-step.is-ok .chat-tool-step-icon { color: var(--el-color-success); }
.chat-tool-step.is-error .chat-tool-step-icon { color: var(--el-color-danger); }

.chat-tool-step-icon .is-spin {
  animation: khy-tool-spin 1s linear infinite;
}

@keyframes khy-tool-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.chat-tool-step-name {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--khy-text-main);
}

.chat-tool-step-input,
.chat-tool-step-result {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--khy-text-secondary);
}

.chat-tool-step-result {
  color: var(--khy-text-main);
  opacity: 0.85;
}

/* ── 结构化命令输出:`=== label ===` 分节块(对齐 CC 的分节展示) ───────────── */
.chat-tool-step-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 有分节时,芯片行只作紧凑摘要;徽标提示可展开的结构化输出。 */
.chat-tool-step-badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--khy-primary-soft);
  border: 1px solid var(--khy-border-light);
  border-radius: 6px;
  padding: 0 6px;
}

.chat-tool-output {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--khy-border);
  border-left: 3px solid var(--el-color-primary);
  background: var(--khy-bg-soft);
}

.chat-tool-output-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-tool-output-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--khy-text-main);
  letter-spacing: 0.02em;
}

.chat-tool-output-title::before {
  content: '▸ ';
  color: var(--el-color-primary);
}

.chat-tool-output-body {
  margin: 0;
  font-family: var(--khy-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--khy-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
}

/* ── #6 一眼看清进度:工具步骤进度摘要芯片 ───────────────────────────────── */
.chat-tool-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  font-size: 12px;
  font-weight: 600;
  color: var(--khy-text-secondary);
  background: var(--khy-bg-soft);
  border: 1px solid var(--khy-border-light);
  border-radius: 6px;
  padding: 2px 8px;
}

.chat-tool-progress.is-active {
  color: var(--el-color-primary);
  background: var(--khy-primary-soft);
  border-color: var(--khy-border-light);
}

.chat-tool-progress .is-spin {
  animation: khy-tool-spin 1s linear infinite;
}

/* ── #7 工具调用透明化:「详情」可展开完整参数 + 结果 ─────────────────────── */
.chat-tool-step-toggle {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: transparent;
  border: 1px solid var(--khy-border-light);
  border-radius: 6px;
  padding: 0 6px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.chat-tool-step-toggle:hover {
  background: var(--khy-primary-soft);
}

.chat-tool-step-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-left: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--khy-border);
  border-left: 3px solid var(--el-color-primary);
  background: var(--khy-bg-soft);
}

.chat-tool-detail-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-tool-detail-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--khy-text-main);
  letter-spacing: 0.02em;
}

.chat-tool-detail-label::before {
  content: '▸ ';
  color: var(--el-color-primary);
}

.chat-tool-detail-body {
  margin: 0;
  font-family: var(--khy-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--khy-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow-y: auto;
}

/* ── Failure attribution card (人话三段 + 追溯下钻) ───────────────────────── */
.chat-error-card {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--el-color-danger-light-9);
  border: 1px solid var(--el-color-danger-light-5);
  font-size: 13px;
  line-height: 1.5;
}

.chat-error-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--el-color-danger);
}

.chat-error-icon { font-size: 14px; }
.chat-error-category { flex: 1 1 auto; min-width: 0; }
.chat-error-code {
  flex: 0 0 auto;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--el-color-danger-light-7);
  color: var(--el-color-danger);
}

.chat-error-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  color: var(--khy-text-main);
}
.chat-error-label {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--khy-text-secondary);
}
.chat-error-value { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; }

.chat-error-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.chat-error-trace {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-color-danger-light-5);
}

.chat-error-trace-hint {
  font-size: 12px;
  color: var(--khy-text-secondary);
}

.chat-error-broken {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-danger);
  margin-bottom: 6px;
}

.chat-error-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.chat-error-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--khy-primary-soft);
  border: 1px solid var(--khy-border);
  font-size: 12px;
}
.chat-error-stage.is-broken {
  background: var(--el-color-danger-light-8);
  border-color: var(--el-color-danger-light-5);
}
.chat-error-stage-name { flex: 0 0 auto; font-weight: 600; color: var(--khy-text-main); }
.chat-error-stage-type {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--khy-text-secondary);
  font-family: var(--el-font-family-mono, monospace);
  font-size: 11px;
}
.chat-error-stage-time { flex: 0 0 auto; color: var(--khy-text-secondary); font-size: 11px; }

.chat-bubble-text {
  white-space: pre-wrap;
}

.chat-loading-row {
  text-align: left;
  margin-top: 6px;
}

.thinking-panel {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  padding: 10px 12px;
  margin-bottom: 12px;
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.thinking-list {
  max-height: 160px;
  overflow-y: auto;
  border-top: 1px dashed var(--el-border-color-lighter);
  padding-top: 8px;
}

.thinking-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.thinking-time {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  min-width: 64px;
}

.thinking-text {
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.chat-attach-btn {
  height: 44px;
  width: 44px;
  flex: 0 0 auto;
}

.chat-file-input-hidden {
  display: none;
}

/* Pending-attachment chips sit just above the composer. */
.chat-pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.chat-pending-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 4px 10px;
  background: var(--el-fill-color-light, #f0f2f5);
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: 16px;
  font-size: 12px;
  line-height: 18px;
}

.chat-pending-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-pending-size {
  color: var(--el-text-color-secondary, #909399);
  flex: 0 0 auto;
}

.chat-pending-remove {
  cursor: pointer;
  flex: 0 0 auto;
  color: var(--el-text-color-secondary, #909399);
}

.chat-pending-remove:hover {
  color: var(--el-color-danger, #f56c6c);
}

.chat-pending-uploading {
  color: var(--el-text-color-secondary, #909399);
}

/* Attachment chips rendered inside a sent user bubble. */
.chat-bubble-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.chat-attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  padding: 3px 8px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 12px;
  text-decoration: none;
  color: inherit;
}

.chat-attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Make a single-line composer the same height (44px) as the send button so the
   two bottom edges line up; when the textarea grows to multiple rows the row's
   flex-end keeps the button pinned to the bottom. */
.chat-input-row :deep(.el-textarea__inner) {
  min-height: 44px;
  padding-top: 11px;
  padding-bottom: 11px;
  line-height: 20px;
}

.chat-action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-send-btn {
  height: 44px;
  min-width: 88px;
}

.chat-stop-btn {
  height: 44px;
  min-width: 88px;
}

@media (max-width: 900px) {
  .chat-window {
    flex: 0 0 auto;
    height: min(60vh, 500px);
  }
}

@media (max-width: 768px) {
  .chat-config {
    width: 100%;
  }

  .model-selector {
    width: 100%;
  }

  .transport-selector {
    width: 100%;
  }

  .chat-input-row {
    flex-direction: column;
    align-items: stretch;
  }

  .chat-attach-btn {
    align-self: flex-start;
  }

  .chat-action-buttons {
    width: 100%;
  }

  .chat-send-btn {
    flex: 1;
    width: 100%;
  }

  .chat-stop-btn {
    flex: 1;
  }
}
</style>
