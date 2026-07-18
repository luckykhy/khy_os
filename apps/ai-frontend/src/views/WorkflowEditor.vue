<template>
  <div class="wf-editor-page">
    <div class="editor-toolbar">
      <el-button :icon="ArrowLeft" @click="goBack">返回</el-button>
      <span class="wf-title">{{ store.meta.name || '工作流' }}</span>
      <span class="wf-meta">v{{ store.meta.version }}</span>
      <el-tag v-if="store.dirty" type="warning" size="small" effect="plain">未保存</el-tag>
      <div class="toolbar-spacer" />
      <el-button
        :icon="VideoPlay"
        :loading="running"
        @click="doRun"
      >运行</el-button>
      <el-button
        :icon="Upload"
        :loading="exporting"
        @click="doExport"
      >导出</el-button>
      <el-button
        type="primary"
        :icon="Check"
        :loading="saving"
        :disabled="!store.dirty"
        @click="save"
      >保存</el-button>
    </div>

    <el-dialog v-model="exportDialog" title="导出结果" width="560px">
      <template v-if="exportResult">
        <el-alert
          type="success"
          :closable="false"
          :title="`已导出 ${exportResult.summary?.nodes ?? 0} 个节点`"
          :description="`运行方式：${exportResult.summary?.run || ''}`"
          show-icon
        />
        <div class="export-files">
          <div v-for="f in exportResult.files" :key="f.path" class="export-file">
            <el-tag size="small" :type="f.kind === 'agent' ? 'warning' : 'success'" effect="plain">
              {{ f.kind === 'agent' ? '子代理' : '技能' }}
            </el-tag>
            <code class="export-file__path">{{ f.path }}</code>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button type="primary" @click="exportDialog = false">知道了</el-button>
      </template>
    </el-dialog>

    <div class="editor-body" v-loading="loading">
      <NodePalette :catalog="catalog" />
      <div class="editor-canvas">
        <WorkflowCanvas :catalog="catalog" :run-status="runNodeStatus" />
      </div>
      <NodePropertiesPanel :catalog="catalog" />
    </div>

    <el-drawer v-model="runDrawer" title="运行" size="420px" :destroy-on-close="false">
      <div v-if="run" class="run-panel">
        <div class="run-status">
          <el-tag :type="RUN_STATUS_TYPE[run.status] || 'info'" effect="dark">
            {{ RUN_STATUS_LABEL[run.status] || run.status }}
          </el-tag>
          <span class="run-id">#{{ run.id }}</span>
          <el-icon v-if="runPolling" class="is-loading"><Loading /></el-icon>
        </div>

        <el-alert
          v-if="run.error"
          type="error"
          :closable="false"
          :title="run.error"
          show-icon
          class="run-error"
        />

        <div v-if="run.status === 'awaiting_input' && run.pending" class="run-ask">
          <div class="run-ask__question">{{ run.pending.question || '请输入回答' }}</div>
          <template v-if="run.pending.options && run.pending.options.length">
            <el-radio-group v-model="answerValue" class="run-ask__options">
              <el-radio
                v-for="opt in run.pending.options"
                :key="opt"
                :value="opt"
                border
              >{{ opt }}</el-radio>
            </el-radio-group>
          </template>
          <el-input
            v-else
            v-model="answerValue"
            type="textarea"
            :rows="2"
            placeholder="输入回答"
          />
          <el-button
            type="primary"
            size="small"
            :loading="answering"
            :disabled="answerValue === '' || answerValue == null"
            class="run-ask__submit"
            @click="submitAnswer"
          >提交回答</el-button>
        </div>

        <div class="run-log">
          <div
            v-for="(entry, i) in run.log"
            :key="`${entry.nodeId}-${i}`"
            class="run-log__row"
          >
            <el-tag size="small" :type="NODE_STATUS_TYPE[entry.status] || 'info'" effect="plain">
              {{ NODE_STATUS_LABEL[entry.status] || entry.status }}
            </el-tag>
            <span class="run-log__name">{{ entry.name || entry.type }}</span>
            <span class="run-log__type">{{ entry.type }}</span>
            <div v-if="entry.summary" class="run-log__summary">{{ entry.summary }}</div>
            <div v-if="entry.error" class="run-log__error">{{ entry.error }}</div>
          </div>
          <el-empty v-if="!run.log || !run.log.length" description="尚无执行记录" :image-size="60" />
        </div>

        <div v-if="run.vars && Object.keys(run.vars).length" class="run-vars">
          <div class="run-vars__title">变量</div>
          <pre class="run-vars__body">{{ JSON.stringify(run.vars, null, 2) }}</pre>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Check, Upload, VideoPlay, Loading } from '@element-plus/icons-vue'
import { useWorkflow } from '@/composables/useWorkflow'
import { useWorkflowEditorStore } from '@/stores/workflowEditor'
import WorkflowCanvas from '@/components/workflow/WorkflowCanvas.vue'
import NodePalette from '@/components/workflow/NodePalette.vue'
import NodePropertiesPanel from '@/components/workflow/NodePropertiesPanel.vue'

const route = useRoute()
const router = useRouter()
const store = useWorkflowEditorStore()
const { getWorkflow, saveWorkflow, exportWorkflow, runWorkflow, getRun, answerRun, streamRun, fetchNodeTypes, saving } = useWorkflow()

const loading = ref(false)
const catalog = ref({ categories: [], nodes: [] })
const exporting = ref(false)
const exportDialog = ref(false)
const exportResult = ref(null)

// ── Run state ────────────────────────────────────────────────────────────────
const running = ref(false)
const runDrawer = ref(false)
const run = ref(null)
const runPolling = ref(false)
const answering = ref(false)
const answerValue = ref('')
let runTimer = null
let stopStream = null

const RUN_STATUS_LABEL = { queued: '排队中', running: '运行中', awaiting_input: '等待回答', succeeded: '成功', failed: '失败' }
const RUN_STATUS_TYPE = { queued: 'info', running: 'warning', awaiting_input: 'primary', succeeded: 'success', failed: 'danger' }
const NODE_STATUS_LABEL = { running: '运行中', awaiting_input: '等待回答', succeeded: '成功', failed: '失败', skipped: '跳过' }
const NODE_STATUS_TYPE = { running: 'warning', awaiting_input: 'primary', succeeded: 'success', failed: 'danger', skipped: 'info' }
const TERMINAL = new Set(['succeeded', 'failed'])
// Parked: execution stopped pending user input — polling rests until an answer.
const PARKED = new Set(['awaiting_input'])

// Live per-node status overlaid on the canvas during a run. Derived from the
// run log (newest entry per node wins, so a looped node shows its latest pass);
// empty once the drawer is closed so the canvas returns to its neutral editing
// look. Keyed by the canonical node id, which round-trips through the adapter.
const runNodeStatus = computed(() => {
  const map = {}
  if (!runDrawer.value || !run.value || !Array.isArray(run.value.log)) return map
  for (const entry of run.value.log) {
    if (entry && entry.nodeId) map[entry.nodeId] = entry.status
  }
  return map
})

function stopWatch() {
  if (runTimer) { clearTimeout(runTimer); runTimer = null }
  if (stopStream) { stopStream(); stopStream = null }
  runPolling.value = false
}

// Track a run to completion. Prefer the SSE stream (one connection, server-side
// push); on any transport failure fall back to getRun polling so the panel keeps
// updating. Both stop at a terminal (succeeded/failed) or parked (awaiting_input)
// state.
function track(runId) {
  stopWatch()
  if (TERMINAL.has(run.value?.status)) return
  runPolling.value = true
  stopStream = streamRun(runId, {
    onUpdate: (view) => { run.value = view },
    onDone: () => { runPolling.value = false },
    onError: () => {
      // Stream unavailable (proxy, old backend, network) — degrade to polling.
      stopStream = null
      runTimer = setTimeout(() => pollRun(runId), 800)
    },
  })
}

async function pollRun(runId) {
  try {
    const latest = await getRun(runId)
    run.value = latest
    if (TERMINAL.has(latest.status) || PARKED.has(latest.status)) {
      stopWatch()
      return
    }
  } catch (err) {
    // Transient read failure — keep polling; surface only if it persists.
  }
  runTimer = setTimeout(() => pollRun(runId), 1500)
}

async function submitAnswer() {
  if (!run.value) return
  answering.value = true
  try {
    const updated = await answerRun(run.value.id, answerValue.value)
    run.value = updated
    answerValue.value = ''
    // Re-enqueued (queued) — resume watching until the next pause or terminal.
    if (!TERMINAL.has(updated.status) && !PARKED.has(updated.status)) {
      track(updated.id)
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '提交回答失败')
  } finally {
    answering.value = false
  }
}

function goBack() {
  router.push({ name: 'Workflows' })
}

async function save() {
  try {
    const payload = store.exportPayload()
    const record = await saveWorkflow(store.meta.id, payload)
    store.markSaved(record)
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '保存失败')
  }
}

async function doExport() {
  // Export reads the persisted graph — save any pending edits first.
  if (store.dirty) {
    try {
      const record = await saveWorkflow(store.meta.id, store.exportPayload())
      store.markSaved(record)
    } catch (err) {
      ElMessage.error(err?.response?.data?.message || err?.message || '保存失败')
      return
    }
  }
  exporting.value = true
  try {
    exportResult.value = await exportWorkflow(store.meta.id)
    exportDialog.value = true
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '导出失败（请确认工作流含 1 个开始与 ≥1 个结束节点）')
  } finally {
    exporting.value = false
  }
}

async function doRun() {
  // The run executes the persisted snapshot — save any pending edits first.
  if (store.dirty) {
    try {
      const record = await saveWorkflow(store.meta.id, store.exportPayload())
      store.markSaved(record)
    } catch (err) {
      ElMessage.error(err?.response?.data?.message || err?.message || '保存失败')
      return
    }
  }
  running.value = true
  stopWatch()
  try {
    const enqueued = await runWorkflow(store.meta.id, {})
    run.value = enqueued
    runDrawer.value = true
    if (!TERMINAL.has(enqueued.status)) track(enqueued.id)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '运行失败（请确认工作流含 1 个开始与 ≥1 个结束节点）')
  } finally {
    running.value = false
  }
}

onMounted(async () => {
  loading.value = true
  try {
    catalog.value = await fetchNodeTypes()
    const record = await getWorkflow(route.params.id)
    store.loadWorkflow(record)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '加载失败')
    goBack()
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(stopWatch)
</script>

<style scoped>
.wf-editor-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
}
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.wf-title {
  font-size: 16px;
  font-weight: 600;
}
.wf-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.toolbar-spacer {
  flex: 1;
}
.editor-body {
  flex: 1;
  display: flex;
  min-height: 480px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-bg-color-page);
}
.editor-canvas {
  flex: 1;
  position: relative;
}
.export-files {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.export-file {
  display: flex;
  align-items: center;
  gap: 8px;
}
.export-file__path {
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}
.run-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.run-status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.run-id {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.run-error {
  margin: 0;
}
.run-ask {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
}
.run-ask__question {
  font-size: 13px;
  font-weight: 600;
  white-space: pre-wrap;
  word-break: break-word;
}
.run-ask__options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.run-ask__submit {
  align-self: flex-start;
}
.run-log {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.run-log__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    "tag name type"
    "summary summary summary"
    "error error error";
  align-items: center;
  gap: 4px 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}
.run-log__name { grid-area: name; font-weight: 600; font-size: 13px; }
.run-log__type { grid-area: type; font-size: 11px; color: var(--el-text-color-secondary); }
.run-log__summary {
  grid-area: summary;
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-word;
}
.run-log__error {
  grid-area: error;
  font-size: 12px;
  color: var(--el-color-danger);
  word-break: break-word;
}
.run-vars__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.run-vars__body {
  margin: 0;
  padding: 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 12px;
  max-height: 240px;
  overflow: auto;
}
</style>
