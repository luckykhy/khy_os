// host 进程：Agent 运行时适配 — 桥接 KhyOS 后端
// 通道选择（AGENTS.md 五通道决策矩阵）：host 与 backend 同为 Node 进程语义，
// 用 CH-2 服务直调（运行时 require aiGateway）；main↔host 用 Electron fork IPC。
//
// 协议（fork IPC，process.send/on('message')）：
//   ← { type: 'ai.generate', id, prompt, options? }
//   → { type: 'ai.chunk',   id, chunk }          (流式，best effort)
//   → { type: 'ai.result',  id, ok, text?, model?, tokenUsage?, error? }
//   ← { type: 'session.list', id, limit? }
//   → { type: 'session.listResult', id, ok, sessions?, error? }
//   ← { type: 'session.create', id, cwd }
//   → { type: 'session.createResult', id, ok, sessionId?, error? }
//   ← { type: 'session.messages', id, sessionId }
//   → { type: 'session.messagesResult', id, ok, sessionId?, title?, model?, messages?, error? }
//   ← { type: 'token.usage', id }
//   → { type: 'token.usageResult', id, ok, usage?, error? }
//   ← { type: 'usage.history', id, days? }
//   → { type: 'usage.historyResult', id, ok, history?, models?, error? }
//   ← { type: 'context.size', id, contentChars }
//   → { type: 'context.sizeResult', id, ok, estimate?, error? }
//   ← { type: 'models.list', id, adapterKey? }
//   → { type: 'models.listResult', id, ok, models?, presets?, error? }
//   ← { type: 'gateway.status', id }
//   → { type: 'gateway.statusResult', id, ok, status?, error? }
//   ← { type: 'desktopGate.set', id, mode?, budget?, allowedApps? }
//   → { type: 'desktopGate.setResult', id, ok, gate?, error? }
//   ← { type: 'desktopGate.get', id }
//   → { type: 'desktopGate.getResult', id, ok, gate?, error? }
//   ← { type: 'background.status', id }
//   → { type: 'background.statusResult', id, ok, status?, error? }
//   ← { type: 'ping' }  →  { type: 'ready', pid }
//
// backend 发现顺序（零硬编码）：KHY_OS_DIR env → cwd/../../（apps/khyos-desktop 相对仓库根）。

import path from 'node:path'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const nodeRequire = createRequire(import.meta.url)

function resolveKhyOsDir(): string {
  if (process.env.KHY_OS_DIR) return path.resolve(process.env.KHY_OS_DIR)
  // out/host/index.js → out/host → out → apps/khyos-desktop → apps → <repo root>
  return path.resolve(process.cwd(), '..', '..')
}

// Pre-load the gateway .env (canonical: services/backend/.env, same file the
// `khy gateway config` CLI writes). The electron-spawned host does not go
// through the khy CLI dotenv loader, so load it here — before aiGateway is
// required — without overriding values already present in the environment.
function loadGatewayEnvFile(): void {
  const envPath = path.join(resolveKhyOsDir(), 'services', 'backend', '.env')
  let content = ''
  try {
    content = fs.readFileSync(envPath, 'utf8')
  } catch {
    console.log('[host] 无网关 .env（', envPath, '），AI 通道未配置时将返回引导错误')
    return
  }
  let loaded = 0
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].replace(/^["']|["']$/g, '')
    if (!(key in process.env)) {
      process.env[key] = value
      loaded++
    }
  }
  console.log('[host] 已加载网关 .env（新注入', loaded, '项，不覆盖已有环境）')
}

type PersistedSession = {
  sessionId: string
  title: string
  model: string
  messageCount: number
  createdAt: number
  updatedAt: number
  projectDir: string
  cwd: string
  firstUserMessage: string
}

type HostMsg = { type: string; id?: string; prompt?: string; limit?: number; cwd?: string; text?: string; days?: number; mode?: string; budget?: string; allowedApps?: string; options?: Record<string, unknown>; requestId?: string; response?: unknown }

let gateway: { generate: (prompt: string, options?: Record<string, unknown>) => Promise<{ text?: string; model?: string; tokenUsage?: unknown }> } | null = null

function loadGateway(): { generate: (prompt: string, options?: Record<string, unknown>) => Promise<{ text?: string; model?: string; tokenUsage?: unknown }> } {
  if (gateway) return gateway
  const gwPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'gateway', 'aiGateway.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  gateway = nodeRequire(gwPath)
  console.log('[host] aiGateway 已加载:', gwPath)
  return gateway
}

// ── 智能体工具循环（CH-2 服务直调）──────────────────────────────────
// 桌面端此前只调 aiGateway.generate(prompt)：单轮文本、不跑工具循环，于是
// tool_use 被静默丢弃，用户只看到一条回复——与网页端修复前完全同病（见
// services/backend/src/services/aiManagementChatHttp.js 的 transport 注释）。
// 这里改用与 CLI / 网页端 / AgentTool 同一条 canonical 路径：
//   runToolUseLoop(msg, { chat, chatOpts, onToolCall, onToolResult, ... })
// 由既有循环负责工具派发、截断恢复、权限闸门与去重，host 只做事件适配，
// 不自行实现任何循环逻辑（否则会与 toolUseLoopCore 漂移）。
// 工作区根走 chatOpts.cwd —— toolUseLoopCore 的 effectiveChatOpts.cwd 是其
// 唯一消费点（工具执行根目录 / 路径解析 / 目标存储作用域）。

type AiChatFn = (userMessage: string, opts?: Record<string, unknown>) => Promise<unknown>

type ToolLoopResult = {
  finalResponse?: string
  toolCallLog?: unknown[]
  iterations?: number
  provider?: string
}

type ToolLoopFn = (userMessage: string, options?: Record<string, unknown>) => Promise<ToolLoopResult>

let aiChat: AiChatFn | null = null
let toolLoop: { runToolUseLoop: ToolLoopFn } | null = null

function loadAiChat(): AiChatFn {
  if (aiChat) return aiChat
  const chatPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'cli', 'ai.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  aiChat = nodeRequire(chatPath).chat as AiChatFn
  return aiChat
}

function loadToolLoop(): { runToolUseLoop: ToolLoopFn } {
  if (toolLoop) return toolLoop
  const loopPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'toolUseLoop.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  toolLoop = nodeRequire(loopPath) as { runToolUseLoop: ToolLoopFn }
  return toolLoop
}

let sessionPersistence: {
  listPersistedSessions: (opts?: { limit?: number }) => PersistedSession[]
  persistSession: (sessionId: string | undefined, state: { messages: unknown[]; metadata?: { cwd?: string; projectDir?: string }; title?: string }) => string
} | null = null

function loadSessionPersistence(): { listPersistedSessions: (opts?: { limit?: number }) => PersistedSession[]; persistSession: (sessionId: string | undefined, state: { messages: unknown[]; metadata?: { cwd?: string; projectDir?: string }; title?: string }) => string } {
  if (sessionPersistence) return sessionPersistence
  const spPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'sessionPersistence.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sessionPersistence = nodeRequire(spPath)
  console.log('[host] sessionPersistence 已加载:', spPath)
  return sessionPersistence
}

type UsageBucket = { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number }

let tokenUsageService: {
  getTodayUsage: () => UsageBucket
  getMonthUsage: () => UsageBucket
  getSessionUsage: () => UsageBucket & { records?: unknown[] }
  getRemainingQuota: () => { allowed: boolean; remaining: number; limit: number; used: number }
  estimateTokens: (text: string) => number
  getUsageHistory: (days?: number) => Array<{ date: string; totalTokens: number; requests: number; costUSD: number }>
  getModelUsage: () => Array<{ model: string; inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number; percentage: number }>
} | null = null

function loadTokenUsageService(): {
  getTodayUsage: () => UsageBucket
  getMonthUsage: () => UsageBucket
  getSessionUsage: () => UsageBucket & { records?: unknown[] }
  getRemainingQuota: () => { allowed: boolean; remaining: number; limit: number; used: number }
  estimateTokens: (text: string) => number
  getUsageHistory: (days?: number) => Array<{ date: string; totalTokens: number; requests: number; costUSD: number }>
  getModelUsage: () => Array<{ model: string; inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number; percentage: number }>
} {
  if (tokenUsageService) return tokenUsageService
  const tuPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'tokenUsageService.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  tokenUsageService = nodeRequire(tuPath)
  console.log('[host] tokenUsageService 已加载:', tuPath)
  return tokenUsageService
}

// Default context window for the "上下文已用 X / 总量 Y" counter. Overridable
// via KHY_CONTEXT_WINDOW env (zero-hardcoding: env wins).
function contextWindowLimit(): number {
  const envVal = Number(process.env.KHY_CONTEXT_WINDOW)
  if (Number.isFinite(envVal) && envVal > 0) return Math.floor(envVal)
  return 128000
}

type ModelOption = {
  id: string
  label: string
  format: string
  channel?: string
  channelKnown?: boolean
}

let providerPresets: {
  getProviderPresets: () => Array<{ id: string; label?: string; name?: string; apiFormat?: string; format?: string; models?: unknown[] }>
} | null = null

function loadProviderPresets(): {
  getProviderPresets: () => Array<{ id: string; label?: string; name?: string; apiFormat?: string; format?: string; models?: unknown[] }>
} {
  if (providerPresets) return providerPresets
  const ppPath = path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'gateway', 'providerPresets.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  providerPresets = nodeRequire(ppPath)
  console.log('[host] providerPresets 已加载:', ppPath)
  return providerPresets
}

// 把 providerPresets 真源投影成模型选择器的选项列表（provider 一级 + 模型二级）。
// 选项的 channel 字段是后端池 key（poolKey）——网关 preferredAdapter 认的是池
// 名（glm/agnes/qwen/deepseek/anthropic/openai/...），不是 preset 的目录 id
// （zhipu/openrouter/...，AGENTS 红线「未注册通道静默空返回」）。preset 无
// poolKey 映射时（聚合网关/第三方，如 openrouter/groq），channel 回退 preset
// id 并标记 channelKnown=false，UI 端据此不传 preferredAdapter（走网关默认
// 通道级联），避免钉死未注册通道。
async function listModelOptions(adapterKey?: string): Promise<ModelOption[]> {
  const pp = loadProviderPresets()
  const presets = pp.getProviderPresets()
  // 池 key 映射：built-in providerConfig.js 的 poolKey 真源（CH-2 同进程可直调）
  let poolKeyByPreset: Record<string, string> = {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bpc = nodeRequire(path.join(resolveKhyOsDir(), 'services', 'backend', 'src', 'services', 'gateway', 'builtinProviderConfig.js'))
    const builtins: Array<{ poolKey?: string; name?: string; defaultEndpoint?: string }> =
      (bpc.BUILTIN_PROVIDERS || bpc.builtinProviders || []).filter(Boolean)
    // 通过 label 名称匹配 preset 与 built-in（两侧都归一化中文括号/空格）
    const norm = (s: string) => String(s || '').replace(/[\s（）()·\/]/g, '').toLowerCase()
    for (const b of builtins) {
      if (!b.poolKey) continue
      const bName = norm(b.name || '')
      for (const p of presets) {
        const pLabel = norm(p.label || p.name || p.id)
        if (pLabel && bName && (pLabel === bName || pLabel.includes(bName) || bName.includes(pLabel))) {
          poolKeyByPreset[p.id] = b.poolKey
        }
      }
      // id 直匹配（preset id 与 poolKey 同名时，如 openai/anthropic/deepseek）
      if (presets.some((p) => p.id === b.poolKey)) {
        poolKeyByPreset[b.poolKey] = b.poolKey
      }
    }
    console.log('[host] poolKey 映射（preset→通道）:', JSON.stringify(poolKeyByPreset))
  } catch {
    /* fail-soft：映射加载失败时回退 preset id（channelKnown=false） */
  }
  const out: ModelOption[] = []
  for (const p of presets) {
    const label = p.label || p.name || p.id
    const mapped = poolKeyByPreset[p.id]
    const channelId = mapped || p.id
    const channelKnown = Boolean(mapped)
    const defaultModel = typeof p.defaultModel === 'string' && p.defaultModel ? p.defaultModel : ''
    out.push({
      id: p.id,
      channel: channelId,
      channelKnown,
      label: defaultModel ? `${label} · ${defaultModel}` : label,
      format: p.apiFormat || p.format || 'openai',
    })
    if (Array.isArray(p.models) && p.models.length > 0) {
      for (const m of p.models) {
        const mid = typeof m === 'string' ? m : String((m as { id?: string }).id || m)
        out.push({
          id: `${p.id}/${mid}`,
          channel: channelId,
          channelKnown,
          label: mid,
          format: p.apiFormat || p.format || 'openai',
        })
      }
    }
  }
  // 若指定 adapter 且有 listModels 能力，追加运行时模型（best-effort，
  // 无凭据/无网络时 adapter.listModels() 返回空数组，不抛错）。
  // P3-7③：动态模型以 preset id 前缀（与静态二级选项同键形），
  // 避免 adapterKey != preset id 时（如 preset `zhipu` ↔ 池 key `glm`）
  // 前端按 id 前缀归组时动态结果挂到不存在的 provider 下。
  if (adapterKey && gateway) {
    try {
      const gw = gateway as unknown as { listModels?: (k: string) => Promise<unknown[]> }
      if (typeof gw.listModels === 'function') {
        // 用 adapterKey 匹配的 preset（poolKey 或 id 相等）做前缀，找不到
        // 时回退 adapterKey 本身（group by provider 会补占位 provider）。
        const prefixPreset = presets.find((p) => {
          const key = poolKeyByPreset[p.id] || p.id
          return key === adapterKey
        })
        const prefix = prefixPreset?.id || adapterKey
        const models = await gw.listModels(adapterKey)
        const seen = new Set(out.map((o) => o.id))
        for (const m of Array.isArray(models) ? models : []) {
          const mid = typeof m === 'string' ? m : String((m as { id?: string }).id || m)
          const optId = `${prefix}/${mid}`
          if (seen.has(optId)) continue
          seen.add(optId)
          out.push({ id: optId, channel: adapterKey, channelKnown: true, label: mid, format: 'openai' })
        }
      }
    } catch {
      /* fail-soft：listModels 失败不影响 provider 预设列表 */
    }
  }
  return out
}

// In-flight ai.generate ids → start time; a background task, per the i18n
// 真源 template (chat.composer.backgroundWorks.ariaLabel: "Bash {n} 个，
// 子智能体 {n} 个，共 {n} 个"), is anything still awaiting an aiGateway
// reply. Settle entries on ai.result/abort so idle state hides the button.
const activeGenerations = new Map<string, number>()

// 在途工具循环的中断句柄：main 的 ai:abort 经 IPC 到达后立即 abort，让 in-flight
// 工具释放（toolUseLoop 的 abortSignal 语义），而不是干等它跑完自己的超时。
const activeAborts = new Map<string, AbortController>()

// runToolUseLoop 的 onToolCall/onToolResult 只给工具名，不给调用 id；而同一批次里
// 同名工具可能并行多个。这里按「同名先进先出」自行配对 —— 循环按派发顺序回结果，
// 所以 FIFO 是安全口径；不配对则界面只能按名字猜，并行同名会张冠李戴。
const pendingToolCalls = new Map<string, string[]>()
let toolCallSeq = 0

function registerToolCall(generationId: string, toolName: string): string {
  const callId = `tc_${++toolCallSeq}`
  const key = `${generationId}\u0000${toolName}`
  const queue = pendingToolCalls.get(key)
  if (queue) queue.push(callId)
  else pendingToolCalls.set(key, [callId])
  return callId
}

function settleToolCall(generationId: string, toolName: string): string | null {
  const key = `${generationId}\u0000${toolName}`
  const queue = pendingToolCalls.get(key)
  if (!queue || queue.length === 0) return null
  const callId = queue.shift() as string
  if (queue.length === 0) pendingToolCalls.delete(key)
  return callId
}

function clearToolCallQueue(generationId: string): void {
  const prefix = `${generationId}\u0000`
  for (const key of Array.from(pendingToolCalls.keys())) {
    if (key.startsWith(prefix)) pendingToolCalls.delete(key)
  }
}

// 人在环（P1）：审批 / 提问等待用户应答的 promise 注册表。
// onControlRequest 发出请求后把 resolve 挂在这里，ai.controlResponse 到达时取走。
// 超时 fail-closed（RUNTIME-010：授权解析不得 fail-open）——用户未及时响应按拒绝处理，
// 绝不能挂死工具循环，更不能默认放行。
const pendingControls = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
const CONTROL_RESPONSE_TIMEOUT_MS = 300_000

function settleControl(generationId: string, requestId: string, response: unknown): boolean {
  const key = `${generationId}\u0000${requestId}`
  const entry = pendingControls.get(key)
  if (!entry) return false
  pendingControls.delete(key)
  clearTimeout(entry.timer)
  entry.resolve(response)
  return true
}

function failAllControls(generationId: string): void {
  const prefix = `${generationId}\u0000`
  for (const key of Array.from(pendingControls.keys())) {
    if (!key.startsWith(prefix)) continue
    const entry = pendingControls.get(key)
    if (!entry) continue
    pendingControls.delete(key)
    clearTimeout(entry.timer)
    // 显式 deny 而非 undefined：三态解码器把 undefined 也读成 deny，
    // 但显式值让行为可解释（用户未响应 ≠ 通道故障）。
    entry.resolve({ behavior: 'deny' })
  }
}

// 编辑类工具（小写归一）：其参数指明要改的目标文件，用于「本轮文件改动」列表。
// 参数键口径与 guardApproval._rememberApprovedDirectory 相同（file_path / filePath / path）。
// 只在 tool_result 里附带文件名，不解析行数 —— 行数要么造假要么脆弱，DiffSummary
// 对 0 不渲染数字，诚实留空。
const EDITING_TOOL_NAMES = new Set(['edit', 'write', 'multiedit', 'applypatch', 'notebookedit'])

function affectedFilesOf(toolName: string, params: unknown): string[] {
  if (!EDITING_TOOL_NAMES.has(String(toolName).toLowerCase())) return []
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const raw = p.file_path || p.filePath || p.path || p.notebook_path || ''
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s ? [s] : []
}

async function handleAiGenerate(id: string, prompt: string, options: Record<string, unknown> = {}): Promise<void> {
  const send = (msg: unknown) => {
    if (process.send) process.send(msg)
    else console.log('[host]', JSON.stringify(msg))
  }
  activeGenerations.set(id, Date.now())
  const controller = new AbortController()
  activeAborts.set(id, controller)
  try {
    loadGatewayEnvFile()
    const chat = loadAiChat()
    const loop = loadToolLoop()
    // 工作区根：main 侧 getWorkspaceRoot() 注入（工作区单一真源）；缺省回退 host 进程 cwd。
    const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : process.cwd()
    const costSink: { usage?: unknown } = {}
    // 单一执行路径：runToolUseLoop 是 canonical 循环（CLI / 网页端 / AgentTool 同款），
    // 这里只把它的回调适配成 main↔host 的 IPC 事件流，不自建任何循环逻辑。
    const result = await loop.runToolUseLoop(prompt, {
      chat,
      chatOpts: {
        cwd,
        effort: options.effort,
        preferredAdapter: options.preferredAdapter,
        preferredModel: options.preferredModel,
        images: options.images,
        onChunk: (chunk: unknown) => send({ type: 'ai.chunk', id, chunk }),
      },
      abortSignal: controller.signal,
      onCost: (usage: unknown) => {
        costSink.usage = usage
      },
      onToolCall: (name: string, params: unknown) =>
        send({ type: 'ai.toolCall', id, callId: registerToolCall(id, name), tool: name, input: params || {} }),
      onToolResult: (name: string, params: unknown, toolResult: unknown, iteration: number, elapsed: number) =>
        send({
          type: 'ai.toolResult',
          id,
          callId: settleToolCall(id, name),
          tool: name,
          input: params || {},
          result: toolResult,
          iteration,
          elapsed,
          affectedFiles: affectedFilesOf(name, params),
        }),
      // 人在环（P1）：审批 / 提问。同一通道承载多条产生路径（guardApproval 的软守卫审批、
      // Stage 7 requestPermission、shell 命令审批、AskUserQuestion），request 统一为
      // { subtype:'can_use_tool', tool_name, input }，响应按 { behavior } 三态解码
      // （toolCallingPermissions._decisionFromControl：allow / allow-always / 其它=deny）。
      // 5 分钟未响应 → 显式 deny（fail-closed），不挂死循环、绝不默认放行。
      onControlRequest: ({ requestId, request }: { requestId: string; request: unknown }) => {
        const key = `${id}\u0000${requestId}`
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (pendingControls.delete(key)) {
              resolve({ behavior: 'deny' })
            }
          }, CONTROL_RESPONSE_TIMEOUT_MS)
          pendingControls.set(key, { resolve, timer })
          send({ type: 'ai.controlRequest', id, requestId, request })
        })
      },
    })
    const replyText = String((result && result.finalResponse) || '')
    const toolCallLog = Array.isArray(result?.toolCallLog) ? result.toolCallLog : []
    // 纯工具轮次没有正文是正常的（模型只用工具回答）；不能把它当"空回复"报错，
    // 否则每完成一次纯工具任务都会弹「未返回正文」。判空需同时看工具日志。
    const okFlag = !!replyText || toolCallLog.length > 0
    send({
      type: 'ai.result',
      id,
      ok: okFlag,
      text: replyText,
      empty: !replyText && toolCallLog.length === 0,
      provider: result?.provider,
      iterations: result?.iterations,
      toolCallCount: toolCallLog.length,
      tokenUsage: costSink.usage,
    })
  } catch (error) {
    // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
    send({
      type: 'ai.result',
      id,
      ok: false,
      error: `AI 调用失败：${String((error as Error)?.message || error)}，请运行 khy gateway status 检查通道配置`,
    })
  } finally {
    clearToolCallQueue(id)
    failAllControls(id)
    activeAborts.delete(id)
    activeGenerations.delete(id)
  }
}

// P3-6①：运行中的后台任务计数（供 Composer「打开运行中的后台任务」按钮，
// 对齐 i18n chat.composer.backgroundWorks.ariaLabel 模板）。数据源是 host
// 进程在途 ai.generate 集合（aiGateway 调用期间）——main 侧另有自动化
// 运行集合（pendingAutomationRuns，经 ai.generate 执行，其 id 也落在
// activeGenerations 里），两边 union 后按 id 去重即得全局在途任务。
// 无任务时 count=0，UI 侧据此隐藏按钮（ZCode 实测空态无此按钮）。
function backgroundTaskStatus(): { count: number; bash: number; subagents: number; taskIds: string[] } {
  const taskIds = Array.from(activeGenerations.keys())
  // 分类启发式：自动化运行 id 带 `auto_` 前缀（main 侧 hostReqId），其余
  // 视为交互会话发起的 AI 调用。Bash 工具子进程计数暂为 0——khy 后端的
  // bash 工具执行不经 aiGateway，事件流桥（bash.start/stop）登记为下轮
  // 余留，不在本轮猜测。
  const subagents = taskIds.filter((tid) => tid.startsWith('auto_')).length
  const bash = 0
  return { count: taskIds.length, bash, subagents, taskIds }
}

// 电脑控制安全闸（backend desktopControl/safetyGate）生效状态：host 进程
// env 是单一真源，safetyGate._envMode() 每次授权调用重读——这里的归一化
// 规则与其保持一致（未知值保守视为 off，fail-closed）。
function desktopGateState(): { mode: string; budget: string | null; allowedApps: string } {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || '').trim().toLowerCase()
  let mode = 'off'
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') mode = 'on'
  else if (raw === 'ask') mode = 'ask'
  else if (raw === 'strict') mode = 'strict'
  const budgetRaw = String(process.env.KHY_DESKTOP_MAX_ACTUATIONS || '').trim()
  return {
    mode,
    budget: /^\d+$/.test(budgetRaw) && Number(budgetRaw) > 0 ? budgetRaw : null,
    allowedApps: String(process.env.KHY_COMPUTER_USE_ALLOWED_APPS || '').trim(),
  }
}

function handleMessage(msg: HostMsg): void {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ping') {
    if (process.send) process.send({ type: 'ready', pid: process.pid })
    return
  }
  if (msg.type === 'ai.generate' && msg.id && typeof msg.prompt === 'string') {
    void handleAiGenerate(msg.id, msg.prompt, msg.options)
    return
  }
  if (msg.type === 'ai.abort' && msg.id) {
    const controller = activeAborts.get(msg.id)
    if (controller) {
      try {
        controller.abort('aborted by host caller')
      } catch {
        /* already aborted — idempotent */
      }
    }
    return
  }
  if (msg.type === 'ai.controlResponse' && msg.id && typeof msg.requestId === 'string') {
    settleControl(msg.id, msg.requestId, msg.response)
    return
  }
  if (msg.type === 'session.list' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const limit = typeof msg.limit === 'number' && msg.limit > 0 ? Math.min(msg.limit, 500) : 50
    try {
      const sp = loadSessionPersistence()
      const sessions = sp.listPersistedSessions({ limit })
      console.log('[host] session.listResult: ', sessions.length, 'sessions')
      send({ type: 'session.listResult', id: msg.id, ok: true, sessions })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'session.listResult',
        id: msg.id,
        ok: false,
        error: `读取本地会话列表失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'session.create' && msg.id && typeof msg.cwd === 'string') {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      const sp = loadSessionPersistence() as {
        listPersistedSessions: (opts?: { limit?: number }) => PersistedSession[]
        persistSession: (sessionId: string | undefined, state: { messages: unknown[]; metadata?: { cwd?: string; projectDir?: string }; title?: string }) => string
      }
      const sessionId = sp.persistSession(undefined, {
        messages: [],
        metadata: { cwd: msg.cwd, projectDir: msg.cwd },
        title: '',
      })
      console.log('[host] session.createResult:', sessionId)
      send({ type: 'session.createResult', id: msg.id, ok: true, sessionId })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'session.createResult',
        id: msg.id,
        ok: false,
        error: `创建会话失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'session.messages' && msg.id && typeof msg.sessionId === 'string') {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      const sp = loadSessionPersistence() as {
        restoreSession: (sessionId: string) => {
          sessionId: string
          title?: string
          model?: string
          messages?: { role?: string; content?: unknown; uuid?: string; timestamp?: number }[]
        }
        jsonlPathFor?: (sessionId: string) => string
      }
      const restored = sp.restoreSession(msg.sessionId)
      const messages = (restored.messages || []).map((m) => ({
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        // content may be a string, a content-part array, or an object — flatten
        // to the display text the bubble renders (same normalization as
        // listPersistedSessions' firstUserMessage).
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (p && typeof p === 'object' ? String((p as { text?: string }).text || '') : String(p || ''))).join(' ')
              : m.content && typeof m.content === 'object'
                ? String((m.content as { text?: string }).text || '')
                : '',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
      }))
      console.log('[host] session.messagesResult:', msg.sessionId, messages.length, 'messages')
      // 会话落盘路径（复制路径/复制 JSONL 路径用）：来自后端 jsonlPathFor 的
      // 真实解析结果，renderer 侧不再拼造路径。后端无此方法时留空（UI 会
      // 如实显示「路径不可用」而不是复制一个不存在的文件路径）。
      let jsonlPath = ''
      try {
        jsonlPath = sp.jsonlPathFor?.(msg.sessionId) || ''
      } catch {
        jsonlPath = ''
      }
      send({
        type: 'session.messagesResult',
        id: msg.id,
        ok: true,
        sessionId: restored.sessionId || msg.sessionId,
        title: restored.title || '',
        model: restored.model || '',
        messages,
        jsonlPath,
      })
    } catch (error) {
      send({
        type: 'session.messagesResult',
        id: msg.id,
        ok: false,
        messages: [],
        error: `读取会话内容失败：${String((error as Error)?.message || error)}，请确认该会话仍存在于 .khy/sessions 后重试`,
      })
    }
    return
  }
  if (msg.type === 'token.usage' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      const tu = loadTokenUsageService()
      const usage = {
        today: tu.getTodayUsage(),
        month: tu.getMonthUsage(),
        session: tu.getSessionUsage(),
        quota: tu.getRemainingQuota(),
      }
      console.log('[host] token.usageResult: month.totalTokens=', usage.month.totalTokens)
      send({ type: 'token.usageResult', id: msg.id, ok: true, usage })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'token.usageResult',
        id: msg.id,
        ok: false,
        error: `读取 Token 用量统计失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'usage.history' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    // Clamp to the persistence horizon (recordUsage prunes days > 90).
    const days = typeof msg.days === 'number' && msg.days > 0 ? Math.min(Math.floor(msg.days), 90) : 30
    try {
      const tu = loadTokenUsageService()
      const history = tu.getUsageHistory(days)
      const models = tu.getModelUsage()
      console.log('[host] usage.historyResult: days=', days, '| history=', history.length, '| models=', models.length)
      send({ type: 'usage.historyResult', id: msg.id, ok: true, history, models })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'usage.historyResult',
        id: msg.id,
        ok: false,
        error: `读取用量历史失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'context.size' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const contentChars = typeof msg.contentChars === 'number' ? msg.contentChars : 0
    const text = String((msg as { text?: string }).text ?? '').slice(0, 400_000)
    try {
      const tu = loadTokenUsageService()
      // estimateTokens(text) is the backend's real heuristic (tokenPricing,
      // 同 /cost 与 gateway token-budget 同源) — 比字符数更贴近真实 token 数。
      const estimate = tu.estimateTokens(text)
      send({
        type: 'context.sizeResult',
        id: msg.id,
        ok: true,
        estimate: { used: estimate, total: contextWindowLimit() },
      })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'context.sizeResult',
        id: msg.id,
        ok: false,
        error: `估算上下文 token 数失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'models.list' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const adapterKey = typeof (msg as { adapterKey?: string }).adapterKey === 'string'
      ? (msg as { adapterKey?: string }).adapterKey
      : undefined
    listModelOptions(adapterKey).then((models) => {
      console.log('[host] models.listResult:', models.length, 'options')
      send({ type: 'models.listResult', id: msg.id, ok: true, models })
    }).catch((error) => {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'models.listResult',
        id: msg.id,
        ok: false,
        error: `读取模型列表失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    })
    return
  }
  if (msg.type === 'background.status' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const status = backgroundTaskStatus()
    send({ type: 'background.statusResult', id: msg.id, ok: true, status })
    return
  }
  if (msg.type === 'desktopGate.set' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    // fail-closed：非法值一律忽略，绝不落入宽松模式。
    const mode = typeof msg.mode === 'string' ? msg.mode.trim().toLowerCase() : ''
    if (['off', 'ask', 'on', 'strict'].includes(mode)) process.env.KHY_DESKTOP_CONTROL = mode
    const budget = typeof msg.budget === 'string' ? msg.budget.trim() : ''
    if (/^\d+$/.test(budget) && Number(budget) > 0) process.env.KHY_DESKTOP_MAX_ACTUATIONS = budget
    if (typeof msg.allowedApps === 'string') {
      if (msg.allowedApps.trim()) process.env.KHY_COMPUTER_USE_ALLOWED_APPS = msg.allowedApps.trim()
      else delete process.env.KHY_COMPUTER_USE_ALLOWED_APPS
    }
    console.log('[host] desktopGate.set:', JSON.stringify(desktopGateState()))
    send({ type: 'desktopGate.setResult', id: msg.id, ok: true, gate: desktopGateState() })
    return
  }
  if (msg.type === 'desktopGate.get' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    send({ type: 'desktopGate.getResult', id: msg.id, ok: true, gate: desktopGateState() })
    return
  }
}

process.on('message', handleMessage)

// 兼容 stdin JSON（保留 Phase 0c 行为）
process.stdin.on('data', (data) => {
  for (const line of data.toString().split('\n')) {
    if (!line.trim()) continue
    try {
      handleMessage(JSON.parse(line))
    } catch {
      /* ignore malformed line */
    }
  }
})

console.log('[host] 进程启动, pid:', process.pid)
if (process.send) process.send({ type: 'ready', pid: process.pid })
