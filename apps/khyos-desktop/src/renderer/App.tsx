import { useState, useEffect, useCallback } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import { MessageList } from './components/message/MessageBubble'
import { Composer } from './components/composer/Composer'
import { WorkspacePicker } from './components/workspace/WorkspacePicker'
import { GoalBanner } from './components/message/GoalBanner'
import { AppHeader } from './components/message/AppHeader'
import { ContextUsagePanel } from './components/message/ContextUsage'
import { DiffSummary } from './components/message/DiffViewer'
import { ToastContainer } from './components/ui/ToastContainer'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { ToolExecutionPanel } from './components/message/ToolExecutionPanel'
import { KeyManagerPage } from './components/keyManager/KeyManagerPage'
import { SettingsPage } from './components/settings/SettingsPage'
import { AutomationsPage } from './components/automations/AutomationsPage'
import { store, useAppSelector } from './state/store'
import { appendMessageContent, clearMessages, setMessages, type Message } from './state/messageSlice'
import { addToast } from './state/toastSlice'
import { startToolExecution, updateToolExecution, recordAffectedFiles } from './state/toolExecutionSlice'
import { ElicitationPanel } from './components/message/ElicitationPanel'
import { loadTheme, subscribeToTheme, loadMessageFontSize } from './theme/theme'
import { fetchDynamicModels, getModelOptionLabel, loadPersistedModelSelection, persistModelSelection, useModelCatalog } from './utils/useModelCatalog'
import { AGENT_MODES, DEFAULT_AGENT_MODE } from './components/composer/ModeSelector'
import { openWorkspace } from './utils/openWorkspace'
import { resolveDesktopAction } from './shared/keymap'

// 当前选中模型的展示名不再有静态字面量兜底（P3-7④ 移除 GLM-5.3-Flash 品牌
// 残留）：经 useModelCatalog 的全量选项表（静态 presets + 动态 adapter 模型）
// 解析 label；未选择或选项未就绪时显示占位符「选择模型」（ZCode 同源 i18n
// chat.toolbar.model.label 语义）。

// Extract displayable text from an aiGateway onChunk payload. Chunk shapes
// vary by adapter ({type:'text',text} | {type:'status',text} | string).
// 'text' content becomes the reply body; 'status' lines (channel retries,
// routing fallbacks) are shown transiently as italic status rows and get
// replaced by the final result — the user sees exactly what the gateway does.
function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk && typeof chunk === 'object') {
    const c = chunk as { type?: string; text?: string; content?: string }
    if (c.type === 'status' && typeof c.text === 'string') return `*${c.text}*\n\n`
    if (c.type === 'text' && typeof c.text === 'string') return c.text
    if (!c.type && typeof c.text === 'string') return c.text
  }
  return ''
}

// 人在环请求（P1）：toolUseLoop 的 onControlRequest 经 main 中继而来。
type ControlRequest = {
  id: string
  requestId: string
  request: { tool_name?: string; input?: Record<string, unknown> }
}

type ControlCard = {
  kind: 'approval' | 'question'
  questions: { id: string; question: string; options: string[]; allowCustom: boolean }[]
}

// 把 control_request 归一成 ElicitationPanel 的 questions 形状。两类请求：
// - AskUserQuestion：问题卡，答案经 updatedInput.answers 回传给工具；
// - 审批（guardApproval 软守卫 / Stage 7 requestPermission / shell 审批）：
//   三选一映射 behavior（allow / allow-always / deny，后端 _decisionFromControl 解码）。
function buildControlCard(req: ControlRequest): ControlCard {
  const toolName = String(req.request?.tool_name || '')
  const input = req.request?.input || {}
  if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
    return {
      kind: 'question',
      questions: (input.questions as { question?: unknown; options?: unknown }[]).map((q) => ({
        id: String(q.question || ''),
        question: String(q.question || ''),
        options: Array.isArray(q.options) ? (q.options as unknown[]).map(String) : [],
        allowCustom: true,
      })),
    }
  }
  const reason = String(input._guardReason || input.reason || '')
  const detail =
    typeof input.command === 'string' ? String(input.command) : JSON.stringify(input).slice(0, 200)
  return {
    kind: 'approval',
    questions: [
      {
        id: 'decision',
        question: `允许 Agent 执行 ${toolName || '未知工具'}？${reason ? `（${reason}）` : ''} 目标：${detail}`,
        options: ['允许本次', '始终允许', '拒绝'],
        allowCustom: false,
      },
    ],
  }
}

// ZCode has no login/welcome gate: the app boots straight into the IDE layout
// (ZC-ALIGN-002 E 区). Login lives in Settings → 账号 (login.* namespace) —
// LoginPage stays in components/auth for that future entry point.

export default function App() {
  const [goal, setGoal] = useState<string | undefined>()
  const [commandCenterOpen, setCommandCenterOpen] = useState(false)
  const [thoughtLevel, setThoughtLevel] = useState('max')
  // P3-7：当前选中模型（providerPresets 真源选项 id，如 `agnes` / `agnes/<model>`）。
  // P3-7②：启动时经 settingsStore 恢复持久化选中态，未持久化时为空
  // （不再静态兜底品牌模型名）。
  const [selectedModel, setSelectedModel] = useState('')
  // 模式选择器（ZCode G0b「切换模式」）：启动时从 settings 恢复，切换即落盘。
  const [agentMode, setAgentMode] = useState(DEFAULT_AGENT_MODE)
  const [showContextUsage, setShowContextUsage] = useState(true)
  // 空态（新任务首页）快捷卡片填入 composer 的预置 prompt；
  // composer 消费后置 null 复位，保证同一 prompt 可重复触发（ZCode 首页卡片语义）。
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  // Real workspace root from main (replaces hardcoded demo path, Rule 1)
  const [workspacePath, setWorkspacePath] = useState('')

  // P3-7②：启动时恢复持久化的模型选中态（settingsStore）。旧 id 对应的
  // provider 已不存在时保留该 id——AppHeader/Composer 的 label 解析（
  // getModelOptionLabel）会退化到占位符，不会出现裸 id 或品牌残留。
  useEffect(() => {
    void loadPersistedModelSelection().then((id) => {
      if (id) setSelectedModel(id)
    })
    // 模式恢复（settings.desktopAgentMode）——P3-9① 兼容性：旧落盘值
    // 'default'（表外 id，渲染时退化首项「变更前确认」）与当前 4 项表
    // 不一致，回退到新默认值「完全访问」（ZCode 同源 i18n 实测值）。
    const api = (window as unknown as { __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> } }).__KHYOS__
    void api?.getSettings?.().then((s) => {
      const m = s?.desktopAgentMode
      const valid = typeof m === 'string' && AGENT_MODES.some((x) => x.id === m)
      setAgentMode(valid ? m : DEFAULT_AGENT_MODE)
    }).catch(() => {})
  }, [])

  // P3-7③：选中 provider 的后端池 key（channel 字段）作 adapterKey，
  // 驱动动态 adapter.listModels 叠加。基线表（静态 presets）单独拉取以
  // 解析 channel；未选中或 channelKnown=false（未注册池）时不传，避免钉
  // 死无效通道（AGENTS 红线「未注册通道静默空返回」）。
  const baseline = useModelCatalog()
  const selectedChannel = (() => {
    const pid = selectedModel ? selectedModel.split('/')[0] : ''
    if (!pid) return undefined
    const opt = baseline.options.find((o) => o.id === pid)
    return opt?.channel && opt.channelKnown !== false ? opt.channel : undefined
  })()
  // 选中 provider 变化时拉取该 channel 的动态模型并入共享缓存表
  // （fetchDynamicModels 幂等：已拉过的 channel 命中 dynamicFetched 集合，
  // 零重复网络开销）；完成后 bump epoch 触发重渲染读到含动态结果的表。
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  useEffect(() => {
    if (!selectedChannel) return
    let cancelled = false
    void fetchDynamicModels(selectedChannel).then(() => {
      if (!cancelled) setCatalogEpoch((e) => e + 1)
    })
    return () => { cancelled = true }
  }, [selectedChannel])
  const catalog = useModelCatalog()
  void catalogEpoch
  // P3-7④：选中模型展示名 = 选项表 label 解析（provider「XX · 默认模型」
  // 或二级模型名）；未选中时退化为占位符，替代已删除的静态 GLM 默认名。
  const modelDisplayName = getModelOptionLabel(selectedModel, catalog.options) || '选择模型'

  // 选中模型变更：更新状态 + 持久化（P3-7②，settingsStore 原子写 fail-soft）。
  const handleModelChange = useCallback((id: string) => {
    setSelectedModel(id)
    persistModelSelection(id)
  }, [])

  // 模式变更：状态 + 持久化（settings.desktopAgentMode）
  const handleModeChange = useCallback((mode: string) => {
    setAgentMode(mode)
    const api = (window as unknown as { __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<void> } }).__KHYOS__
    void api?.setSetting?.('desktopAgentMode', mode).catch(() => {})
  }, [])

  // 会话消息数（Redux）——用于决定 Token 用量面板是否渲染（P3-6：ZCode 空态
  // 不显示用量区段）；currentSessionId 替换 AppHeader 的硬编码会话 ID。
  const messageCount = useAppSelector((s: { message: { messages: unknown[] } }) => s.message.messages.length)
  const currentSessionId = useAppSelector((s: { message: { currentSessionId: string | null } }) => s.message.currentSessionId)
  // 选中会话的标题（TitleBar 会话 tab 头，ZCode D5）；空 = 「新任务」。
  const [sessionTitle, setSessionTitle] = useState('')
  // 选中会话的真实落盘路径（AppHeader 复制路径/复制 JSONL 路径用，来自后端
  // sessionPersistence.jsonlPathFor，不是前端拼造的路径）。
  const [sessionJsonlPath, setSessionJsonlPath] = useState('')

  // 会话内容加载：点侧栏任务 / 「重载会话」都走这里。此前 onTaskSelect 只把
  // 高亮和 sessionId 换掉、消息流不动，点会话等于没反应（ZC-ALIGN-001 §2 A2）。
  const loadSessionMessages = useCallback((sessionId: string) => {
    const api = (window as unknown as {
      __KHYOS__?: { loadSession?: (id: string) => Promise<{ ok: boolean; title?: string; jsonlPath?: string; messages?: { role?: string; content?: string; timestamp?: number }[]; error?: string }> }
    }).__KHYOS__
    if (!api?.loadSession) {
      store.dispatch(addToast({ type: 'error', title: '会话加载不可用：preload 未注入 __KHYOS__，请重启应用' }))
      return
    }
    api.loadSession(sessionId).then((res) => {
      if (!res?.ok) {
        store.dispatch(addToast({ type: 'error', title: res?.error || '会话内容读取失败：host 进程无响应，请重启应用' }))
        return
      }
      const loaded: Message[] = (res.messages || []).map((m, i) => ({
        id: `h_${sessionId}_${i}`,
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        status: 'complete' as const,
      }))
      store.dispatch(setMessages(loaded))
      setSessionTitle(res.title || '')
      setSessionJsonlPath(res.jsonlPath || '')
      store.dispatch(addToast({ type: 'info', title: `已加载会话内容：${loaded.length} 条消息` }))
    }).catch((err: unknown) => {
      store.dispatch(addToast({ type: 'error', title: `会话内容读取失败：${String(err)}，请重启应用后重试` }))
    })
  }, [])

  const handleTaskSelect = useCallback((id: string) => {
    loadSessionMessages(id)
  }, [loadSessionMessages])

  // Hash routing: #/key-manager (standalone window), #/settings[/<page>]
  // (full-screen settings), #/automations.
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ''))
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#\/?/, ''))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const keyManager = route === 'key-manager'
  // Prefix match: the sidebar 插件市场 button deep-links to #/settings/plugins,
  // and SettingsPage reads the suffix to pick its start page. An exact
  // `=== 'settings'` test silently dropped that deep link back to the
  // workspace, so the button looked dead (ZC-ALIGN-001 §2 A2).
  const settings = route === 'settings' || route.startsWith('settings/')
  const automations = route === 'automations'

  // 侧栏「搜索」按钮派发的事件 → 打开命令中心（与 Ctrl+K 同一入口）
  useEffect(() => {
    const onOpen = () => setCommandCenterOpen(true)
    window.addEventListener('khy:open-command-center', onOpen)
    return () => window.removeEventListener('khy:open-command-center', onOpen)
  }, [])

  // 主题 + 消息字体大小：启动时从主进程加载持久化值并应用到 <html>
  useEffect(() => {
    loadTheme()
    void loadMessageFontSize()
    return subscribeToTheme()
  }, [])

  // Workspace root: 单一真源是 main 的 getWorkspaceRoot()（settings.desktopWorkspacePath
  // → process.cwd() 回落）。挂载拉一次，并订阅 khy:workspace-changed 重拉 ——
  // 此前只在挂载时拉（deps 为空数组），切工作空间后 AppHeader 仍显示旧根：TitleBar
  // 与 AppLayout 各自刷新，唯独 App 层没订阅（[DESIGN-ARCH-125] §9 待核实项 #1）。
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getWorkspacePath?: () => Promise<string> }
    }).__KHYOS__
    const load = () => {
      api?.getWorkspacePath?.().then((p) => {
        if (typeof p === 'string' && p) setWorkspacePath(p)
      }).catch(() => {})
    }
    load()
    window.addEventListener('khy:workspace-changed', load)
    return () => window.removeEventListener('khy:workspace-changed', load)
  }, [])

  const handleReload = useCallback(() => {
    if (!currentSessionId) {
      store.dispatch(addToast({ type: 'info', title: '当前没有选中的会话：请先在左侧任务列表中选择一个会话' }))
      return
    }
    loadSessionMessages(currentSessionId)
  }, [currentSessionId, loadSessionMessages])

  // 空态卡片快捷动作：填入 composer 预置 prompt（用户补充细节后发送）
  const handleQuickAction = useCallback((prompt: string) => {
    setComposerPrefill(prompt)
  }, [])

  // 侧栏「新建任务」/ 会话切换时的新会话复位：清消息回到启动卡片页
  const handleNewTask = useCallback(() => {
    store.dispatch(clearMessages())
    setGoal(undefined)
    setSessionTitle('')
  }, [])

  // 全局快捷键（主界面；settings / key-manager 路由下不接管）。
  //
  // 键位一律查 shared/keymap.ts 的单一真源（[DESIGN-ARCH-125] P-03）：此前这里
  // 只硬挂了 Ctrl+K / Ctrl+T 两个 if，而命令面板和窗口菜单都在展示 Ctrl+N /
  // Ctrl+O —— 用户按下去没有任何反应。现在三者共用同一张表，展示即事实。
  //
  // 副作用留在本层（薄壳）：命令面板开合、模型/强度状态都在 App。
  // 面板类快捷键（Ctrl+Alt+B / Ctrl+J）的副作用在 AppLayout，那边用自己的监听。
  useEffect(() => {
    if (keyManager || settings) return
    const THOUGHT_LEVELS = ['off', 'low', 'high', 'max']
    const handler = (e: KeyboardEvent) => {
      const action = resolveDesktopAction(e)
      if (action === 'commandCenter') {
        e.preventDefault()
        setCommandCenterOpen((v) => !v)
        return
      }
      if (action === 'newTask') {
        e.preventDefault()
        handleNewTask()
        return
      }
      if (action === 'openWorkspace') {
        e.preventDefault()
        void openWorkspace()
        return
      }
      if (action === 'openSettings') {
        e.preventDefault()
        window.location.hash = '#/settings'
        return
      }
      if (action === 'cycleThoughtLevel') {
        e.preventDefault()
        // 用函数式更新，免得把 thoughtLevel 塞进依赖数组导致每次切换强度都重订阅
        setThoughtLevel((prev) => THOUGHT_LEVELS[(THOUGHT_LEVELS.indexOf(prev) + 1) % THOUGHT_LEVELS.length])
        return
      }
      if (e.key === 'Escape') {
        setCommandCenterOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [keyManager, settings, handleNewTask])

  // host 流式 chunk → 追加到最后一条 streaming 消息（Composer 发起请求，
  // main 转发 host aiGateway onChunk 到这里）
  useEffect(() => {
    const api = (window as unknown as { __KHYOS__?: { onAiChunk?: (cb: (d: unknown) => void) => () => void } }).__KHYOS__
    if (!api?.onAiChunk) return
    return api.onAiChunk((data: unknown) => {
      const d = data as { id?: string; chunk?: unknown }
      const text = chunkToText(d?.chunk)
      if (!text) return
      const { messages } = store.getState().message
      const streaming = [...messages].reverse().find((m) => m.status === 'streaming')
      if (streaming) store.dispatch(appendMessageContent({ id: streaming.id, content: text }))
    })
  }, [])

  // 工具循环事件 → 工具执行面板。
  // host 的 runToolUseLoop 回调经 main 中继到这里，是「agent 真的在读写文件」的
  // 唯一证据来源。在此之前 startToolExecution 零调用方，ToolExecutionPanel 因
  // 数据源恒空而永不显形（activeExecutions.length === 0 时它 return null）。
  // callId 由 host 侧按同名 FIFO 配对（循环回调不带 id），据此精确收敛结果，
  // 不按工具名找 —— 并行同名工具会张冠李戴。
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        onAiToolCall?: (cb: (d: unknown) => void) => () => void
        onAiToolResult?: (cb: (d: unknown) => void) => () => void
      }
    }).__KHYOS__
    if (!api?.onAiToolCall || !api?.onAiToolResult) return

    const offCall = api.onAiToolCall((data: unknown) => {
      const d = data as { callId?: string; tool?: string; input?: Record<string, unknown> }
      const callId = String(d?.callId || '').trim()
      const toolName = String(d?.tool || '').trim()
      if (!callId || !toolName) return
      store.dispatch(
        startToolExecution({
          id: callId,
          name: toolName,
          input: d?.input || {},
          requiresConfirmation: false,
        })
      )
    })

    const offResult = api.onAiToolResult((data: unknown) => {
      const d = data as { callId?: string; tool?: string; result?: unknown }
      const callId = String(d?.callId || '').trim()
      if (!callId) return
      const raw = d?.result
      // 工具自身报错时 loop 会把错误塞进结果对象；据此区分成功/失败，
      // 不一律判成功 —— 失败被显示成「完成」比不显示更糟。
      const failed =
        (raw && typeof raw === 'object' && ((raw as { isError?: boolean }).isError === true ||
          (raw as { success?: boolean }).success === false)) ||
        (typeof raw === 'string' && /^\s*error[:：]/i.test(raw))
      let resultText: string
      if (typeof raw === 'string') {
        resultText = raw
      } else {
        try {
          resultText = JSON.stringify(raw ?? '', null, 2)
        } catch {
          resultText = String(raw ?? '')
        }
      }
      store.dispatch(
        updateToolExecution({
          id: callId,
          status: failed ? 'error' : 'success',
          result: resultText.slice(0, 4000),
          error: failed ? resultText.slice(0, 600) : undefined,
        })
      )
      const affected = (data as { affectedFiles?: string[] }).affectedFiles
      if (Array.isArray(affected) && affected.length > 0) {
        store.dispatch(recordAffectedFiles(affected))
      }
    })

    return () => {
      offCall()
      offResult()
    }
  }, [])

  // 人在环（P1）：审批 / 提问队列。处理中工具循环被 await 挂起，同一时刻至多一个
  // 待决请求；但收发有竞态，用队列兜底，界面只渲染队首、提交后出队。
  // 不放 permissionSlice：其 ToolPermission 结构（toolName/riskLevel/description）
  // 没有 requestId，也表达不了阻塞式三选一应答 —— 硬套是削足适履。
  const [controlQueue, setControlQueue] = useState<ControlRequest[]>([])

  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { onAiControlRequest?: (cb: (d: unknown) => void) => () => void }
    }).__KHYOS__
    if (!api?.onAiControlRequest) return
    const off = api.onAiControlRequest((data: unknown) => {
      const d = data as ControlRequest
      if (!d?.id || !d?.requestId) return
      setControlQueue((q) => (q.some((x) => x.requestId === d.requestId) ? q : [...q, d]))
    })
    return off
  }, [])

  const resolveControl = useCallback(
    (response: unknown) => {
      const head = controlQueue[0]
      if (!head) return
      setControlQueue((q) => q.slice(1))
      const api = (window as unknown as {
        __KHYOS__?: {
          aiControlResponse?: (p: { id: string; requestId: string; response: unknown }) => Promise<unknown>
        }
      }).__KHYOS__
      void api?.aiControlResponse?.({ id: head.id, requestId: head.requestId, response })
    },
    [controlQueue]
  )

  // 本轮文件改动（P2）：host 在 tool_result 事件里对编辑类工具附带目标文件，
  // 落在 toolExecutionSlice.affectedFiles（与 clearExecutions 同生命周期——发新消息即清）。
  // additions/deletions 恒 0：工具结果不携带行数，DiffSummary 对 0 不渲染数字，不造假数据。
  const affectedFiles = useAppSelector((state) => state.toolExecution.affectedFiles)
  const changedFiles = affectedFiles.map((path) => ({ path, status: 'modified', additions: 0, deletions: 0 }))

  if (keyManager) {
    return (
      <>
        <ErrorBoundary>
          <KeyManagerPage standalone />
        </ErrorBoundary>
        <ToastContainer />
      </>
    )
  }

  // Settings page (full-screen replacement, ZC-ALIGN-003 §1 D1)
  if (settings) {
    return (
      <>
        <ErrorBoundary>
          <SettingsPage />
        </ErrorBoundary>
        <ToastContainer />
      </>
    )
  }

  // Automations page (定时任务, ZC-ALIGN-003 对齐 ZCode 自动化页)
  if (automations) {
    return (
      <>
        <ErrorBoundary>
          <AutomationsPage />
        </ErrorBoundary>
        <ToastContainer />
      </>
    )
  }

  // 主界面（无登录闸门，与 ZCode 一致）
  return (
    <AppLayout
      commandCenterOpen={commandCenterOpen}
      onCommandCenterClose={() => setCommandCenterOpen(false)}
      onNewTask={handleNewTask}
      onTaskSelect={handleTaskSelect}
      sessionTitle={sessionTitle}
      onReloadSession={handleReload}
    >
      {/* 工作区内容区兜底：用 section 变体，崩了只替换内容区，标题栏与侧栏保持可用
          （ErrorBoundary 的 section 文案就是为此写的：「错误已经限制在当前区域」）。 */}
      <ErrorBoundary section>
      <div className="flex flex-col h-full">
        {/* 会话头部 */}
        <AppHeader
          sessionId={currentSessionId || ''}
          sessionJsonlPath={sessionJsonlPath}
          workspacePath={workspacePath}
          modelName={modelDisplayName}
          onReload={handleReload}
        />
        {/* Goal 横幅 */}
        <GoalBanner
          goal={goal}
          status={goal ? 'running' : 'idle'}
          onSetGoal={setGoal}
          onCancel={() => setGoal(undefined)}
        />

        {/* 正在执行的工具 */}
        <ToolExecutionPanel />

        {/* 人在环：审批 / 提问（阻塞工具循环 —— 必须应答，或等 5 分钟超时 fail-closed） */}
        {controlQueue.length > 0 && (
          <ElicitationPanel
            questions={buildControlCard(controlQueue[0]).questions}
            onSubmit={(answers) => {
              const head = controlQueue[0]
              if (!head) return
              if (buildControlCard(head).kind === 'question') {
                resolveControl({ behavior: 'allow', updatedInput: { answers } })
              } else {
                const choice = String(answers.decision || '')
                resolveControl({
                  behavior:
                    choice === '始终允许' ? 'allow-always' : choice === '允许本次' ? 'allow' : 'deny',
                })
              }
            }}
            onDismiss={() => resolveControl({ behavior: 'deny' })}
          />
        )}

        {/* 消息列表（空态 = ZCode 首页居中卡片 + 嵌入 composer；有消息 = 正常列表 + 底部 composer） */}
        <MessageList
          onQuickAction={handleQuickAction}
          composer={messageCount === 0 ? (
            <Composer
              modelName={modelDisplayName}
              variant="card"
              // 卡片顶端工作空间选择行（[DESIGN-ARCH-125] P-01）：空态开新对话时
              // 直接在此选定工作空间，不必先离开卡片去翻窗口菜单。
              header={<WorkspacePicker variant="card-header" />}
              prefillText={composerPrefill ?? undefined}
              onPrefillConsumed={() => setComposerPrefill(null)}
              thoughtLevel={thoughtLevel}
              onThoughtLevelChange={setThoughtLevel}
              onModelChange={handleModelChange}
              agentMode={agentMode}
              onModeChange={handleModeChange}
            />
          ) : undefined}
        />

        {/* 上下文用量面板 — 仅在有会话内容时显示（ZCode 空态不渲染用量区段，
            P3-6 实测对齐）。每会话的「上下文已用/总量」已移入 Composer 工具行按钮。 */}
        {showContextUsage && messageCount > 0 && <ContextUsagePanel />}

        {/* 本轮文件改动（P2）：数据源 toolExecutionSlice.affectedFiles；无改动时不渲染。 */}
        {changedFiles.length > 0 && (
          <DiffSummary
            files={changedFiles}
            onViewDiff={(p) => {
              // AppLayout 持有 side-pane 标签状态机，用与 khy:workspace-changed
              // 同一模式的窗口事件把「查看文件」交给它开 codeViewer 标签
              window.dispatchEvent(new CustomEvent('khy:open-file', { detail: p }))
            }}
          />
        )}

        {/* 底部区域 — 仅在进入对话（有消息）后显示；空态首页 composer 嵌入居中卡片。
            P3-8：模式/推理强度选择器已并入 Composer 工具行右下角同簇（对齐 ZCode
            实测 a48/a51 形态），不再在 Composer 上方单独成行。 */}
        {messageCount > 0 && (
        <div className="border-t border-border bg-panel">
          <Composer
            modelName={modelDisplayName}
            prefillText={composerPrefill ?? undefined}
            onPrefillConsumed={() => setComposerPrefill(null)}
            thoughtLevel={thoughtLevel}
            onThoughtLevelChange={setThoughtLevel}
            onModelChange={handleModelChange}
            agentMode={agentMode}
            onModeChange={handleModeChange}
          />
        </div>
        )}
      </div>
      </ErrorBoundary>

      {/* Toast 通知 */}
      <ToastContainer />
    </AppLayout>
  )
}
