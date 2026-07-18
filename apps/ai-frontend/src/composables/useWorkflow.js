import { ref } from 'vue'
import request from '@/api/request'
import { authedFetch } from '@/api/authedFetch'
import { unwrap } from '@/api/unwrap'

/**
 * Per-user (multi-tenant) visual workflow state.
 *
 * Talks ONLY to `/api/workflow/*` (auth-only, scoped to req.user.id on the
 * backend). Mirrors the `useUserGateway` composable shape: shared `unwrap(res)`
 * envelope handling (from `@/api/unwrap`), `request.get/post/put/delete`, and
 * ref-backed state. A normal user can only ever read/write their own workflows.
 */

export function useWorkflow() {
  const workflows = ref([])
  const current = ref(null)
  const nodeTypes = ref(null)
  const loading = ref(false)
  const saving = ref(false)
  // 列表加载失败的**本页可见降级**状态。该请求标记 silent(见下),不再叠全局 toast,
  // 因此失败信息改由 Workflows.vue 就地渲染(inline el-alert + 重试),否则会静默吞掉。
  const loadError = ref('')

  async function listWorkflows() {
    loading.value = true
    loadError.value = ''
    try {
      // silent:true —— 本 composable 的列表载入自带可见降级 UI(loadError 渲染 + 重试),
      // 遵 request.js:88-94 约定不触发全局 notifyError。这样一次导航遗留 / 后端不可达的
      // 工作流请求失败,不会把「无法访问 /api/workflow」横幅泄漏到别的页面(如代理管理)。
      const res = await request.get('/api/workflow', { silent: true })
      workflows.value = unwrap(res) || []
      return workflows.value
    } catch (err) {
      loadError.value =
        err?.userMessage || err?.response?.data?.message || err?.message || '加载工作流失败'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function getWorkflow(id) {
    const res = await request.get(`/api/workflow/${id}`)
    current.value = unwrap(res)
    return current.value
  }

  async function createWorkflow(payload) {
    const res = await request.post('/api/workflow', payload || {})
    await listWorkflows()
    return unwrap(res)
  }

  async function saveWorkflow(id, payload) {
    saving.value = true
    try {
      const res = await request.put(`/api/workflow/${id}`, payload || {})
      current.value = unwrap(res)
      return current.value
    } finally {
      saving.value = false
    }
  }

  async function deleteWorkflow(id) {
    await request.delete(`/api/workflow/${id}`)
    await listWorkflows()
  }

  // Built-in templates (示范模板) — list summaries, and instantiate one as a new
  // per-user workflow via the server-side template catalog.
  async function listTemplates() {
    const res = await request.get('/api/workflow/templates')
    return unwrap(res) || []
  }

  async function createFromTemplate(templateId, payload) {
    const res = await request.post(`/api/workflow/templates/${templateId}`, payload || {})
    await listWorkflows()
    return unwrap(res)
  }

  // Coze import (按需安装) — enumerate EVERY workflow in an uploaded collection
  // without persisting, then install entries one at a time by { sessionId, index }.
  //   enumerateCoze({ contentBase64 }) -> { sessionId, total, skipped, entries[] }
  //   cozeCatalog()                    -> built-in catalog, same shape + { builtin }
  //   installCozeEntry({ sessionId, index, name? }) -> created workflow + report
  async function enumerateCoze(payload) {
    const res = await request.post('/api/workflow/import/coze/enumerate', payload || {})
    return unwrap(res)
  }

  async function cozeCatalog() {
    const res = await request.get('/api/workflow/import/coze/catalog')
    return unwrap(res)
  }

  async function installCozeEntry(payload) {
    const res = await request.post('/api/workflow/import/coze/install', payload || {})
    await listWorkflows()
    return unwrap(res)
  }

  // Natural-language generation — describe a task and let the user's own AI
  // upstream draft a graph. Default does NOT persist: returns { graph, name,
  // description, report } for the editor to preview/edit before saving.
  async function generateWorkflow(prompt, opts = {}) {
    const res = await request.post('/api/workflow/generate', {
      prompt,
      model: opts.model,
      persist: !!opts.persist,
    })
    return unwrap(res)
  }

  // Node-type catalog (palette + property panel) — added in slice 2.
  async function fetchNodeTypes() {
    if (nodeTypes.value) return nodeTypes.value
    const res = await request.get('/api/workflow/node-types')
    nodeTypes.value = unwrap(res)
    return nodeTypes.value
  }

  // Markdown export — added in slice 4.
  async function exportWorkflow(id) {
    const res = await request.post(`/api/workflow/${id}/export`, {})
    return unwrap(res)
  }

  // Native execution (Phase 2) — enqueue a run, then poll its status.
  async function runWorkflow(id, payload) {
    const res = await request.post(`/api/workflow/${id}/run`, payload || {})
    return unwrap(res)
  }

  async function getRun(runId) {
    const res = await request.get(`/api/workflow/runs/${runId}`)
    return unwrap(res)
  }

  async function listRuns(id) {
    const res = await request.get(`/api/workflow/${id}/runs`)
    return unwrap(res) || []
  }

  async function answerRun(runId, answer) {
    const res = await request.post(`/api/workflow/runs/${runId}/answer`, { answer })
    return unwrap(res)
  }

  // Live run status over SSE (Phase 2). Native EventSource can't send the auth
  // header, so we stream via fetch + a ReadableStream reader and parse SSE frames
  // ourselves. Returns a stop() fn (aborts the connection). On any transport
  // failure the caller should fall back to getRun polling.
  function streamRun(runId, { onUpdate, onDone, onError } = {}) {
    const controller = new AbortController()
    const base = request.defaults?.baseURL || ''

    ;(async () => {
      try {
        // 走统一带认证入口:token 注入 + 401 登出;stream:true 关闭超时(SSE 长连接),
        // 并把本地 controller 的 signal 传入以支持 stop()。
        const resp = await authedFetch(`${base}/api/workflow/runs/${runId}/events`, {
          signal: controller.signal,
          stream: true,
        })
        if (!resp.ok || !resp.body) throw new Error(`SSE failed: ${resp.status}`)

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line.
          let sep
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            if (frame.startsWith(':')) continue // keepalive comment
            const isDone = /(^|\n)event:\s*done/.test(frame)
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
            if (dataLine) {
              const json = dataLine.slice(5).trim()
              if (isDone) { onDone && onDone(); return }
              try { onUpdate && onUpdate(JSON.parse(json)) } catch { /* skip */ }
            } else if (isDone) {
              onDone && onDone(); return
            }
          }
        }
        onDone && onDone()
      } catch (err) {
        if (controller.signal.aborted) return // intentional stop, not an error
        onError && onError(err)
      }
    })()

    return () => controller.abort()
  }

  return {
    workflows, current, nodeTypes, loading, saving, loadError,
    listWorkflows, getWorkflow, createWorkflow, saveWorkflow, deleteWorkflow,
    listTemplates, createFromTemplate,
    enumerateCoze, cozeCatalog, installCozeEntry,
    generateWorkflow,
    fetchNodeTypes, exportWorkflow,
    runWorkflow, getRun, listRuns, answerRun, streamRun,
  }
}
