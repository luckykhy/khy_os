import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { execFile, fork } from 'child_process'
import { openKeyManagerWindow } from './keyManagerWindow'
import { registerKeyManagerIpc } from './keyManager/ipc'
import { getSettingsStore, setSetting, getTheme, setTheme } from './settingsStore'
import { getDataHome, baseHomeFile, _resetDataHomeCache } from './keyManager/keyStore'
import {
  getAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  recordRunStart,
  recordRunSkipped,
  recordRunEnd,
  type Automation,
} from './automationStore'
import {
  getPlugins,
  installPlugin,
  setPluginEnabled,
  uninstallPlugin,
  checkPluginUpdates,
} from './pluginStore'
import {
  getMcpServers,
  createMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
  importMcpServers,
} from './mcpStore'
import {
  listItems,
  createItem,
  setItemEnabled,
  deleteItem,
  importItems,
  scanMigrations,
  importMigration,
  migrationDataHome,
} from './agentItemStore'
import {
  listIndexes,
  createIndex,
  rebuildIndex,
  setIndexEnabled,
  deleteIndex,
} from './indexStore'

// ZCode has a frameless window with NO native menu bar: all actions live in a
// custom top-right "窗口菜单" dropdown (ZC-ALIGN-002 L 区实测 12 项). The native
// application menu is therefore unset; accelerators (Ctrl+N/O) move to renderer.
const nodeRequire = createRequire(import.meta.url)

// Suppress GPU disk-cache errors on Windows (ACCESS_DENIED when cache dir is
// read-only or locked).  These flags are also passed via CLI args in package.json
// to ensure they take effect before Chromium spawns the GPU process.
// `disable-gpu` alone does NOT fully silence the shared-context warnings
// (gpu_channel_manager "Failed to create shared context for virtualization"),
// so we add `disable-gpu-sandbox` + `disable-gpu-compositing` and point the
// disk-cache to a writable, per-app directory to avoid the ACCESS_DENIED lock.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-gpu-compositing')
// CacheDir default is the user profile; when running from a read-only / portable
// drive the cache files can be locked → GPUCache ACCESS_DENIED. Point the disk
// cache at a per-app dir under OS temp (always writable, no lock-on-open risk).
// os/path already imported at module top as node:fs/node:path — reuse via import.meta.
app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'KhyOS-Desktop', 'GPUCache'))

// Phase 0a + 0b + 0c: 最小主进程 + IPC handler + host 进程
// KeyManager (DESIGN-ARCH-091 P1): standalone key/endpoint manager window

let hostProcess: ReturnType<typeof fork> | null = null
// scheduler 子进程（四进程架构的第四位，见 startSchedulerProcess）
let schedulerProcess: ReturnType<typeof fork> | null = null

// Single workspace-root resolver. 打开工作区 / 添加项目 persist the chosen
// directory to settings.desktopWorkspacePath; every workspace-scoped channel
// (app:workspacePath, workspace:listFiles, workspace:readTree default) reads
// through here so the chip, the file tree and the file index can never
// disagree. Unset or no-longer-existing path falls back to process.cwd().
async function getWorkspaceRoot(): Promise<string> {
  try {
    const settings = await getSettingsStore()
    const configured = settings.desktopWorkspacePath
    if (typeof configured === 'string' && configured.trim()) {
      const resolved = path.resolve(configured.trim())
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved
    }
  } catch {
    /* fail-soft: settings unreadable → cwd */
  }
  return process.cwd()
}

// ── 工作空间候选集（[DESIGN-ARCH-125] P-02）──
// MRU 上限。列表项要能真的切过去，所以读取侧先过滤已不存在的路径 ——
// 诚实红线：宁可列表为空（选择器只渲染兜底项），也不返回切不过去的死链。
const RECENT_WORKSPACES_MAX = 8

async function readRecentWorkspaces(): Promise<{ path: string; name: string }[]> {
  try {
    const settings = await getSettingsStore()
    const raw = settings.desktopRecentWorkspaces
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: { path: string; name: string }[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      const resolved = path.resolve(entry.trim())
      if (seen.has(resolved)) continue
      seen.add(resolved)
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue
      } catch {
        continue
      }
      out.push({ path: resolved, name: path.basename(resolved) || resolved })
    }
    return out
  } catch {
    /* fail-soft: settings unreadable → 空列表，选择器退化为只有「打开其他文件夹…」 */
    return []
  }
}

// 切换工作空间根：校验 → 写 desktopWorkspacePath（唯一真源）→ 更新 MRU。
// 校验失败即返回错误且**不动任何持久化状态**，避免把坏路径写进真源后
// getWorkspaceRoot 静默回落到 cwd、UI 却显示已切换。
async function switchWorkspace(rawPath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const resolved = path.resolve(rawPath)
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `该路径不是可用目录：${resolved}` }
    }
  } catch (err) {
    return { ok: false, error: `无法访问该路径：${String(err)}` }
  }
  await setSetting('desktopWorkspacePath', resolved)
  const settings = await getSettingsStore()
  const prev = Array.isArray(settings.desktopRecentWorkspaces) ? settings.desktopRecentWorkspaces : []
  const next = [resolved, ...prev.filter((p) => typeof p === 'string' && path.resolve(p) !== resolved)]
    .slice(0, RECENT_WORKSPACES_MAX)
  await setSetting('desktopRecentWorkspaces', next)
  return { ok: true, path: resolved }
}

// Pending ai.generate requests: id → resolver, answered by host messages.
const pendingAi = new Map<string, { resolve: (v: unknown) => void; win: BrowserWindow }>()
// Pending session.list requests: id → resolver.
const pendingSessionList = new Map<string, { resolve: (v: unknown) => void }>()
// Pending session.create requests: id → resolver.
const pendingSessionCreate = new Map<string, { resolve: (v: unknown) => void }>()
// Pending session.messages requests: id → resolver.
const pendingSessionMessages = new Map<string, { resolve: (v: unknown) => void }>()
// Pending token.usage requests: id → resolver.
const pendingTokenUsage = new Map<string, { resolve: (v: unknown) => void }>()
// Pending usage.history requests: id → resolver.
const pendingUsageHistory = new Map<string, { resolve: (v: unknown) => void }>()
// Pending context.size requests: id → resolver.
const pendingContextSize = new Map<string, { resolve: (v: unknown) => void }>()
// Pending models.list requests: id → resolver.
const pendingModelList = new Map<string, { resolve: (v: unknown) => void }>()
// Pending desktopGate requests: id → resolver.
const pendingDesktopGate = new Map<string, { resolve: (v: unknown) => void }>()
// Pending background.status requests: id → resolver.
const pendingBackgroundStatus = new Map<string, { resolve: (v: unknown) => void }>()
// In-flight automation runs: host request id → { automationId, startedAt }.
// A run settles only on ai.result or host process exit — no wall-clock kill
// (Rule 3: the gateway owns its own HTTP timeouts).
const pendingAutomationRuns = new Map<string, { automationId: string; startedAt: number }>()
// One run per automation at a time (ZCode: runNowAlreadyRunning)
const runningAutomationIds = new Set<string>()
let aiSeq = 0

const AUTOMATION_HOST_PREFIX = 'auto_'

// Parse `git status --porcelain=v1 -z --branch` output into the review panel's
// change model. -z uses NUL separators so paths with spaces/newlines survive.
// Branch header lines: `## main...origin/main [ahead 1, behind 2]` (possibly
// `## No commits yet on main`, or `## HEAD (no branch)` for detached HEAD).
export interface GitStatusResult {
  ok: boolean
  state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error'
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  changes?: { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; staged: boolean }[]
  error?: string
}

function parseGitStatus(stdout: string): GitStatusResult {
  const entries = stdout.split('\0').filter((s) => s.length > 0)
  const branchEntry = entries.find((s) => s.startsWith('## '))
  const changes: GitStatusResult['changes'] = []
  let branch: string | undefined
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  if (branchEntry) {
    const header = branchEntry.slice(3)
    const m = header.match(/^([^.\s]+(?:\/[^.\s]+)?)?(\.{2,3}(\S+))?\s*(\[ahead (\d+)(?:, )?(?:behind (\d+))?\]|\[behind (\d+)\])?/)
    branch = m?.[1] || (header.includes('HEAD') ? 'HEAD' : header.split(/\s|\.{2,3}/)[0] || undefined)
    upstream = m?.[3]
    const aheadStr = m?.[5]
    const behindStr = m?.[6] || m?.[7]
    if (aheadStr) ahead = Number(aheadStr)
    if (behindStr) behind = Number(behindStr)
  }
  // XY status codes → panel kind. X = staged, Y = worktree. Rename entries end
  // with \0<oldPath> in -z mode (handled below via the 2-entry peek).
  const entriesNoBranch = entries.filter((s) => !s.startsWith('## '))
  for (let i = 0; i < entriesNoBranch.length; i++) {
    const entry = entriesNoBranch[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const rawPath = entry.slice(3)
    let status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
    if (xy === '??') {
      status = 'untracked'
    } else if (xy[0] === 'R' || xy[1] === 'R') {
      // -z rename format: `XY new\0old` — the next NUL entry holds the old path
      if (i + 1 < entriesNoBranch.length) i++
      status = 'renamed'
    } else if (xy[0] === 'A' || xy[1] === 'A') {
      status = 'added'
    } else if (xy[0] === 'D' || xy[1] === 'D') {
      status = 'deleted'
    } else {
      status = 'modified'
    }
    // X (staged column) non-blank = staged; '?'/'untracked' never staged
    const staged = xy !== '??' && xy[0] !== ' '
    changes.push({ path: rawPath, status, staged })
  }
  return { ok: true, state: 'ok', branch, upstream, ahead, behind, changes }
}

// After 'ready', detach host-side sockets from the main event loop: a
// long-lived in-flight AI call must not block app exit (sockets unref'd).
function unrefSockets(proc: { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream }): void {
  try {
    for (const s of [proc.stdout, proc.stderr]) {
      const unref = (s as { unref?: () => void } | null | undefined)?.unref
      if (typeof unref === 'function') unref.call(s)
    }
  } catch {
    /* best effort */
  }
}

function handleHostMessage(msg: unknown): void {
  const m = msg as { type?: string; id?: string; [k: string]: unknown }
  if (!m || typeof m !== 'object') return
  if (m.type === 'session.listResult' && m.id) {
    const entry = pendingSessionList.get(m.id)
    if (entry) {
      pendingSessionList.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'session.createResult' && m.id) {
    const entry = pendingSessionCreate.get(m.id)
    if (entry) {
      pendingSessionCreate.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'session.messagesResult' && m.id) {
    const entry = pendingSessionMessages.get(m.id)
    if (entry) {
      pendingSessionMessages.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'token.usageResult' && m.id) {
    const entry = pendingTokenUsage.get(m.id)
    if (entry) {
      pendingTokenUsage.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'usage.historyResult' && m.id) {
    const entry = pendingUsageHistory.get(m.id)
    if (entry) {
      pendingUsageHistory.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'context.sizeResult' && m.id) {
    const entry = pendingContextSize.get(m.id)
    if (entry) {
      pendingContextSize.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'models.listResult' && m.id) {
    const entry = pendingModelList.get(m.id)
    if (entry) {
      pendingModelList.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if ((m.type === 'desktopGate.setResult' || m.type === 'desktopGate.getResult') && m.id) {
    const entry = pendingDesktopGate.get(m.id)
    if (entry) {
      pendingDesktopGate.delete(m.id)
      entry.resolve(m)
      return
    }
    // settings:set 的 fire-and-forget 推送没有等待方——落到日志供导出排查。
    console.log('[host] desktopGate:', JSON.stringify(m))
    return
  }
  if (m.type === 'background.statusResult' && m.id) {
    const entry = pendingBackgroundStatus.get(m.id)
    if (entry) {
      pendingBackgroundStatus.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  // Automation runs ride the same host ai.generate channel; results settle the
  // run history entry instead of being forwarded to a renderer window.
  if (m.type === 'ai.result' && m.id && String(m.id).startsWith(AUTOMATION_HOST_PREFIX)) {
    void settleAutomationRun(m.id, m)
    return
  }
  // 流事件中继：文本/思考 chunk、工具调用与结果、终局 result 都发回发起窗口。
  // toolCall / toolResult 来自 runToolUseLoop 的循环级回调（不是 chat 的 onChunk），
  // 桌面端靠它们把「agent 真的在干活」渲染出来 —— 缺这两条通道时它们会被静默丢弃。
  if (
    (m.type === 'ai.chunk' ||
      m.type === 'ai.toolCall' ||
      m.type === 'ai.toolResult' ||
      m.type === 'ai.controlRequest' ||
      m.type === 'ai.result') &&
    m.id
  ) {
    const entry = pendingAi.get(m.id)
    if (m.type === 'ai.result') pendingAi.delete(m.id)
    // Guard every hop: the sender window may be gone before the reply lands.
    const wc = entry?.win
    if (wc && !wc.isDestroyed()) {
      try {
        wc.webContents.send(m.type, m)
      } catch (err) {
        console.log('[host] send to renderer failed:', String(err))
      }
    }
    if (m.type === 'ai.result') {
      try {
        entry?.resolve(m)
      } catch (err) {
        console.log('[host] resolve failed:', String(err))
      }
    }
    return
  }
  // Detach host sockets from the event loop on ready: a long-lived in-flight
  // AI call must not block app exit. Runs settle via ai.result / host exit /
  // app quit — not via the pipe.
  if (m.type === 'ready') {
    console.log('[host] ready:', JSON.stringify(m))
    unrefSockets(hostProcess)
    void applyDesktopGateFromSettings()
    return
  }
  console.log('[host] message:', JSON.stringify(m))
}

// ── 电脑控制安全闸（backend desktopControl/safetyGate）联动 ──
// safetyGate 每次授权调用都重读 host 进程的 process.env
// （KHY_DESKTOP_CONTROL / KHY_DESKTOP_MAX_ACTUATIONS /
// KHY_COMPUTER_USE_ALLOWED_APPS），所以设置页写入这三个设置键后由 main
// 转发 host 改写自己的 env，下一次操作立即生效；host 就绪时也用持久化
// 设置初始化一遍。fail-closed：缺省不写 = off（总闸关闭）。
const CUA_GATE_KEYS = ['cuaDesktopControlMode', 'cuaMaxActuations', 'cuaAllowedApps']

async function desktopGatePatchFromSettings(): Promise<{
  mode?: string
  budget?: string
  allowedApps?: string
}> {
  const settings = await getSettingsStore()
  const patch: { mode?: string; budget?: string; allowedApps?: string } = {}
  const mode = String(settings.cuaDesktopControlMode || '').trim().toLowerCase()
  if (['off', 'ask', 'on', 'strict'].includes(mode)) patch.mode = mode
  const budget = String(settings.cuaMaxActuations ?? '').trim()
  if (/^\d+$/.test(budget) && Number(budget) > 0) patch.budget = budget
  if (typeof settings.cuaAllowedApps === 'string') patch.allowedApps = settings.cuaAllowedApps.trim()
  return patch
}

async function applyDesktopGateFromSettings(): Promise<void> {
  if (!hostProcess || !hostProcess.connected) return
  try {
    const patch = await desktopGatePatchFromSettings()
    if (Object.keys(patch).length === 0) return
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`
    hostProcess.send({ type: 'desktopGate.set', id, ...patch })
  } catch (err) {
    console.log('[host] desktopGate 初始化失败:', String(err))
  }
}

const KEY_MANAGER_STANDALONE = process.argv.includes('--key-manager')

// Fire one automation run through the host bridge (CH-2). One run per
// automation at a time; manual triggers while busy fail with ZCode's copy,
// schedule triggers while busy record a skipped history entry.
// skipped：调度触发撞上「上一条还在跑」时置 true（下面 runningAutomationIds 分支
// 会记 skipped 历史并回这个标记）。原返回类型漏了它，导致渲染层读 res.skipped
// 报类型错 —— 运行时本就返回，是契约没写全。
async function fireAutomation(id: string, trigger: 'manual' | 'schedule'): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!hostProcess || !hostProcess.connected) {
    return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
  }
  const list = await getAutomations()
  const a = list.find((x) => x.id === id)
  if (!a) {
    return { ok: false, error: '未找到该定时任务，可能已被删除' }
  }
  if (runningAutomationIds.has(id)) {
    if (trigger === 'manual') {
      return { ok: false, error: '上一条正在运行中，请稍后再试' }
    }
    await recordRunSkipped(id)
    return { ok: true, skipped: true }
  }
  const started = await recordRunStart(id, trigger)
  if (!started.ok || !started.automation) {
    return { ok: false, error: started.error || '触发运行失败' }
  }
  const hostReqId = `${AUTOMATION_HOST_PREFIX}${Date.now().toString(36)}_${++aiSeq}`
  runningAutomationIds.add(id)
  pendingAutomationRuns.set(hostReqId, { automationId: id, startedAt: Date.now() })
  hostProcess.send({ type: 'ai.generate', id: hostReqId, prompt: a.prompt, options: {} })
  return { ok: true }
}

async function settleAutomationRun(hostReqId: string, result: { ok?: boolean; error?: string; text?: string }): Promise<void> {
  const entry = pendingAutomationRuns.get(hostReqId)
  pendingAutomationRuns.delete(hostReqId)
  if (!entry) return
  runningAutomationIds.delete(entry.automationId)
  const durationMs = Date.now() - entry.startedAt
  const okFlag = result.ok !== false && typeof result.text === 'string' && result.text.length > 0
  await recordRunEnd(entry.automationId, entry.startedAt, okFlag ? 'succeeded' : 'failed', {
    durationMs,
    error: okFlag ? undefined : (result.error || '模型无输出：可能端点错误/模型名无效/额度不足，运行 khy gateway status 检查'),
    resultPreview: okFlag && typeof result.text === 'string' ? result.text.slice(0, 400) : undefined,
  }).catch((e: unknown) => {
    console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`)
  })
}

// Scheduler tick: fire every enabled automation whose nextRunAt is due.
// Periodic poll, not a task deadline — Rule 3 compliant (no kill path; runs
// settle on ai.result or host exit only).
const AUTOMATION_TICK_MS = 30_000
let automationTimer: NodeJS.Timeout | null = null

async function runDueAutomations(): Promise<void> {
  const list = await getAutomations()
  for (const a of list) {
    if (a.enabled && a.nextRunAt !== null && a.nextRunAt <= Date.now()) {
      const r = await fireAutomation(a.id, 'schedule')
      if (!r.ok) console.log(`[automation] 调度触发失败 (${a.title}): ${r.error}`)
    }
  }
}

function startAutomationScheduler(): void {
  if (automationTimer) return
  automationTimer = setInterval(() => {
    void runDueAutomations()
  }, AUTOMATION_TICK_MS)
  automationTimer.unref?.()
}

// Host died mid-run: settle every in-flight automation run as failed so the
// history never shows a forever-进行中 entry.
function failAllAutomationRuns(reason: string): void {
  for (const [hostReqId, entry] of pendingAutomationRuns) {
    pendingAutomationRuns.delete(hostReqId)
    runningAutomationIds.delete(entry.automationId)
    void recordRunEnd(entry.automationId, entry.startedAt, 'failed', {
      durationMs: Date.now() - entry.startedAt,
      error: reason,
    }).catch((e: unknown) => {
      console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}

// App quitting (window-all-closed / tray exit) while a run is in flight:
// settle as failed so a restart never inherits a dangling 进行中 entry.
function settleAutomationRunsOnQuit(): void {
  if (pendingAutomationRuns.size === 0) return
  failAllAutomationRuns('应用已退出，运行中断')
  // recordRunEnd is async fs — give it a beat before the event loop can end
  setTimeout(() => {}, 500)
}

function startHostProcess() {
  const hostPath = path.join(__dirname, '../host/index.js')
  hostProcess = fork(hostPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  // EPIPE guard: writing to a closed stdout/stderr pipe throws EPIPE
  // (uncaught in the main process = crash). Wrap every relayed line so a
  // host exit mid-stream degrades to a logged note instead of a kill.
  const logSafe = (tag: string, write: (s: string) => void) => (data: Buffer) => {
    const text = data.toString()
    try {
      write(text)
    } catch (err) {
      console.log(`[host] ${tag} 输出管道已关闭，停止转发: ${String(err)}`)
    }
  }
  hostProcess.stdout?.on('data', logSafe('stdout', (s) => console.log(`[host] ${s}`)))
  hostProcess.stderr?.on('data', logSafe('stderr', (s) => console.error(`[host] ${s}`)))
  hostProcess.on('message', handleHostMessage)
  hostProcess.on('exit', (code) => {
    console.log(`[host] 进程退出, code=${code}`)
    hostProcess = null
    failAllAutomationRuns(`host 进程退出 (code=${code})，运行中断`)
  })
}

// 四进程架构（092 Phase 0d / CLAUDE.md「四进程 + 五 preload」）：main 拉起
// host（Agent 运行时）与 scheduler（定时任务/闲时算力）。scheduler 的业务逻辑
// 仍在 Phase 10，这里只保证进程存活 + IPC 通道可达，进程监视器据此显示真实 pid。
function startSchedulerProcess() {
  const schedulerPath = path.join(__dirname, '../scheduler/index.js')
  try {
    schedulerProcess = fork(schedulerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  } catch (err) {
    console.log(`[scheduler] 进程启动失败: ${String(err)}`)
    schedulerProcess = null
    return
  }
  const logSafe = (tag: string, write: (s: string) => void) => (data: Buffer) => {
    const text = data.toString()
    try {
      write(text)
    } catch {
      console.log(`[scheduler] ${tag} 输出管道已关闭，停止转发`)
    }
  }
  schedulerProcess.stdout?.on('data', logSafe('stdout', (s) => console.log(`[scheduler] ${s}`)))
  schedulerProcess.stderr?.on('data', logSafe('stderr', (s) => console.error(`[scheduler] ${s}`)))
  schedulerProcess.on('message', (msg: unknown) => {
    const m = msg as { type?: string; pid?: number } | null
    if (m?.type === 'ready') console.log(`[scheduler] ready: pid=${m.pid}`)
  })
  schedulerProcess.on('exit', (code) => {
    console.log(`[scheduler] 进程退出, code=${code}`)
    schedulerProcess = null
  })
}

// Resolve the refined app icon (deep-space blue rounded square + white K) for
// the taskbar / window chrome. The .ico ships in several places depending on
// how the app is launched (repo source tree vs electron-builder packaged run),
// so probe known locations and use the first that exists; if none, start
// without a custom icon rather than break launch.
function resolveAppIcon(): string | undefined {
  const candidates = [
    // electron-builder packaged resources (win.icon in package.json build block)
    path.join(process.resourcesPath, 'icon', 'icon.ico'),
    path.join(process.resourcesPath, 'icon.ico'),
    // Repo / portable source tree (public dir next to the main entry's out/)
    path.join(__dirname, '../../public/icon.ico'),
    path.join(__dirname, '../renderer/icon.ico'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

async function createWindow() {
  // Restore last window geometry from settings.json (desktopWindowSize,
  // ZC-ALIGN-003 backend wiring) — falls back to ZCode's 1216×808 default.
  const settings = await getSettingsStore()
  const size = (settings.desktopWindowSize as {
    width?: number; height?: number; maximized?: boolean
  }) || {}
  const width = typeof size.width === 'number' && size.width >= 800 ? size.width : 1216
  const height = typeof size.height === 'number' && size.height >= 600 ? size.height : 808

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    // Refined KhyOS app icon on the taskbar / window chrome (deep-space blue
    // rounded square + white K). Resolved from known locations; undefined when
    // none exist so launch never breaks.
    ...(resolveAppIcon() ? { icon: resolveAppIcon() } : {}),
    webPreferences: {
      // Preload is built as CJS (electron.vite.config.ts forces format:'cjs')
      // because sandboxed preloads cannot be ESM — see P0-6 in ZC-ALIGN-001.
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Browser tab (BrowserPane) embeds live pages via <webview> — ZCode uses
      // a guest view for its side-panel browser; webview is the Electron
      // equivalent (back/forward/reload + did-navigate/did-fail-load events).
      webviewTag: true
    }
  })

  // Persist window geometry on close so the next launch restores it.
  const persistGeometry = () => {
    if (win.isDestroyed()) return
    // getNormalBounds returns the restored size even while maximized
    const bounds = win.getNormalBounds()
    setSetting('desktopWindowSize', {
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
    }).catch((e: unknown) => {
      console.log(`[settings] 窗口尺寸保存失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
  win.on('close', persistGeometry)

  // dev-server URL from env (electron-vite injects VITE_DEV_SERVER_URL); the
  // port falls back to a variable (zero-hardcoding exemption class)
  const devPort = process.env.VITE_DEV_PORT || '5173'
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
    // Re-maximize if the last session closed while maximized
    if (size.maximized === true) win.maximize()
  })

  // 窗口控制
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => win.close())
  ipcMain.handle('app:version', () => app.getVersion())
  // Real workspace root: the cwd the app was launched from (the open
  // workspace), replacing the previous hardcoded demo path (Rule 1).
  ipcMain.handle('app:workspacePath', () => getWorkspaceRoot())

  // ── 工作空间选择（[DESIGN-ARCH-125] P-01/P-02）──
  // 读：当前根 + 最近打开候选集。当前值一律经 getWorkspaceRoot() 的唯一真源
  // 给出；desktopRecentWorkspaces 只回答「可切到哪几个」，不参与「当前是谁」。
  ipcMain.handle('workspace:list', async () => {
    return { ok: true, current: await getWorkspaceRoot(), recents: await readRecentWorkspaces() }
  })
  // 切：带 target 就切到它（选择器点「最近打开」），不带就弹系统目录框
  // （「打开其他文件夹…」）。取消不算失败，用 canceled 区分，调用方不报错。
  ipcMain.handle('workspace:open', async (_e, target?: string) => {
    const requested = typeof target === 'string' ? target.trim() : ''
    let chosen = requested
    if (!chosen) {
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
      chosen = result.filePaths[0]
    }
    return switchWorkspace(chosen)
  })

  // 设置读写（持久化到 baseHome/settings.json）
  ipcMain.handle('settings:get', async () => {
    return getSettingsStore()
  })
  ipcMain.handle('settings:set', async (_e, key: string, value: unknown) => {
    await setSetting(key, value)
    if (typeof key === 'string' && CUA_GATE_KEYS.includes(key)) {
      await applyDesktopGateFromSettings()
    }
    return true
  })

  // 数据存储路径变更：复制现有数据到 <newPath>/.khy，然后写指针。
  // 迁移采用「复制而非移动」——base home 的 settings.json（存指针的文件）
  // 不迁移，旧数据保留，用户可手动清理（可逆、零数据丢失）。
  ipcMain.handle('settings:setDataPath', async (_e, newPath: string) => {
    if (typeof newPath !== 'string' || !newPath.trim()) {
      return { ok: false, error: '路径为空：请选择或输入有效的数据存储路径' }
    }
    const target = path.resolve(newPath.trim())
    const baseSettings = baseHomeFile('settings.json')
    const currentHome = getDataHome()
    const newHome = path.join(target, '.khy')
    if (newHome === currentHome) {
      return { ok: true, moved: false, home: newHome }
    }
    try {
      const fs = await import('node:fs')
      // fs.cp recursive copy of the current data home (skips settings.json
      // via filter — the pointer file stays in the base home)
      await fs.promises.cp(currentHome, newHome, {
        recursive: true,
        force: true,
        filter: (src) => path.resolve(src) !== path.resolve(baseSettings),
      })
      await setSetting('dataPath', target)
      // Switch the running process to the new home immediately
      _resetDataHomeCache()
      return { ok: true, moved: true, home: newHome }
    } catch (err) {
      return {
        ok: false,
        error: `数据迁移失败：${err instanceof Error ? err.message : String(err)}，已保留原路径，请检查目标磁盘可写后重试`,
      }
    }
  })

  // 主题（持久化到 settings.json 的 theme 字段）
  ipcMain.handle('theme:get', async () => {
    return getTheme()
  })
  ipcMain.handle('theme:set', async (_e, mode: string) => {
    await setTheme(mode)
    // 通知所有渲染窗口更新主题 class
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('theme:changed', mode)
      }
    }
    return true
  })

  // 界面缩放：clamped 0.5–2.0, applied to the sender window only (ZCode
  // account-menu 界面缩放 submenu: 放大/缩小/实际大小). Returns the applied
  // factor so callers can update any local UI state.
  ipcMain.handle('zoom:set', async (e, factor: number) => {
    const clamped = Math.min(2, Math.max(0.5, Number(factor)))
    const wc = e.sender
    if (!Number.isFinite(clamped)) {
      throw new Error('缩放值无效：请传入 0.5–2.0 之间的数字')
    }
    wc.setZoomFactor(clamped)
    return clamped
  })

  // 文件系统
  ipcMain.handle('fs:openDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
  })
  // 附件/图片选择（Composer 添加上下文 → 添加附件 / 上传图片）。filters 由
  // 调用方给出（附件：文本类扩展名；图片：image/*），multiSelections 允许一次
  // 多个 —— 返回值是真实路径数组，取消返回空数组（不再自造 file_N.tsx 假名）。
  ipcMain.handle('fs:selectFiles', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: Array.isArray(filters) && filters.length > 0 ? filters : undefined,
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('fs:readFile', async (e, filePath: string) => {
    const fs = await import('fs/promises')
    return fs.readFile(filePath, 'utf-8')
  })
  ipcMain.handle('fs:writeFile', async (e, filePath: string, content: string) => {
    const fs = await import('fs/promises')
    await fs.writeFile(filePath, content, 'utf-8')
    return true
  })

  // ── 代码查看（codeViewer.* 文案）— 只读预览通道，四态契约 ──
  // ok（文本内容）/ tooLarge（>256KB 预览上限）/ binary（NUL 字节检测）/
  // missing / empty。只读短 I/O，无长任务截止，Rule 3 无涉。
  ipcMain.handle('codeViewer:read', async (_e, filePath: string) => {
    const PREVIEW_LIMIT = 256 * 1024
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, state: 'missing' as const }
      }
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) {
        return { ok: false, state: 'missing' as const }
      }
      if (stat.size > PREVIEW_LIMIT) {
        return { ok: false, state: 'tooLarge' as const, size: stat.size }
      }
      const buf = await fs.promises.readFile(filePath)
      if (buf.length === 0) {
        return { ok: false, state: 'empty' as const }
      }
      // Binary heuristic: a NUL byte in the first 8KB means not previewable text
      const probe = buf.subarray(0, Math.min(buf.length, 8192))
      if (probe.includes(0)) {
        return { ok: false, state: 'binary' as const }
      }
      return { ok: true, state: 'ok' as const, content: buf.toString('utf-8'), size: buf.length }
    } catch {
      return { ok: false, state: 'missing' as const }
    }
  })

  // ── 打开文件（sidePane.openFile）：workspace 文件索引，仅返回文本类文件 ──
  // 深度/数量有界（Rule 3 精神：单次遍历，无长任务）；忽略 node_modules 等噪声目录。
  ipcMain.handle('workspace:listFiles', async (_e, query: string) => {
    const root = await getWorkspaceRoot()
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
    ])
    const TEXT_EXTS = new Set([
      '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.vue', '.css',
      '.html', '.yml', '.yaml', '.toml', '.ini', '.sh', '.bat', '.ps1', '.py', '.cjs', '.mjs',
    ])
    const MAX_FILES = 5000
    const results: { path: string; name: string }[] = []
    const q = (query || '').trim().toLowerCase()
    try {
      const walk = (dir: string, depth: number) => {
        if (results.length >= MAX_FILES || depth > 8) return
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return // unreadable subdir: skip, don't fail the whole index
        }
        for (const ent of entries) {
          if (results.length >= MAX_FILES) return
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name.toLowerCase()) && !ent.name.startsWith('.')) {
              walk(full, depth + 1)
            }
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase()
            if (!TEXT_EXTS.has(ext)) continue
            if (q && !full.toLowerCase().includes(q)) continue
            results.push({ path: full, name: ent.name })
          }
        }
      }
      walk(root, 0)
      return { ok: true, root, files: results }
    } catch (err) {
      return { ok: false, error: `工作区文件索引失败：${err instanceof Error ? err.message : String(err)}，请检查工作区目录权限` }
    }
  })

  // ── 工作区文件树（workspaceSidebar.showFileTree 视图）：单目录懒加载 ──
  // 每次只读一层（readdir withFileTypes），展开目录时再拉取子层，避免一次性
  // 深遍历大工作区（Rule 3 精神：按需短 I/O，无长任务）。隐藏项与噪声目录
  // （node_modules/.git 等，与 workspace:listFiles 的 SKIP_DIRS 一致）默认折叠
  // 为 "pruned" 条目并计入，由渲染层按需懒加载展开。query 提供子串过滤。
  ipcMain.handle('workspace:readTree', async (_e, dirPath: string, query: string) => {
    const root = (typeof dirPath === 'string' && dirPath.trim()) ? path.resolve(dirPath.trim()) : await getWorkspaceRoot()
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
    ])
    const q = (query || '').trim().toLowerCase()
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      const items = entries
        .map((ent) => ({
          name: ent.name,
          path: path.join(root, ent.name),
          kind: ent.isDirectory() ? 'directory' as const
            : ent.isFile() ? 'file' as const
            : 'other' as const,
        }))
        // .name files/dirs (dotfiles) stay visible like any IDE tree; only
        // dependency-cache and build-output dirs are pruned as noise.
        .filter((it) => it.kind !== 'other')
        .filter((it) => !(it.kind === 'directory' && SKIP_DIRS.has(it.name.toLowerCase())))
        .filter((it) => !q || it.name.toLowerCase().includes(q))
        // Directories first, then files; each bucket alphabetical (case-insensitive)
        .sort((a, b) =>
          a.kind === b.kind
            ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            : a.kind === 'directory' ? -1 : 1
        )
      return { ok: true, root, items }
    } catch (err) {
      return { ok: false, error: `读取目录失败：${err instanceof Error ? err.message : String(err)}，请检查目录权限后重试` }
    }
  })

  // AI 网关 — 转发给 host 进程，host 动态 require KhyOS 后端 AI 入口（CH-2）。
  // 工作区根在这里注入（单一真源 getWorkspaceRoot）：agent 的读写 / 命令都以它为
  // 执行根，不注入则 host 会拿 apps/khyos-desktop 当根目录 —— 能跑通但改错地方。
  ipcMain.handle('ai:send', async (e, payload: { prompt?: string; options?: Record<string, unknown> }) => {
    const prompt = payload?.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, error: '请求缺少 prompt：请输入要发送的内容后重试' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `ai_${Date.now()}_${++aiSeq}`
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: '发送窗口已关闭：请重试' }
    }
    const workspaceRoot = await getWorkspaceRoot()
    const options = { ...(payload?.options || {}), cwd: workspaceRoot }
    return new Promise((resolve) => {
      pendingAi.set(id, { resolve: resolve as (v: unknown) => void, win: senderWin })
      hostProcess!.send({ type: 'ai.generate', id, prompt, options })
      // Guard: host died mid-request
      setTimeout(() => {
        if (pendingAi.has(id)) {
          pendingAi.delete(id)
          resolve({ ok: false, error: 'host 进程响应超时：请查看导出日志排查 host 状态' })
        }
      }, 300000)
    })
  })
  ipcMain.handle('ai:stream', async (e, payload: unknown) => {
    console.log('[ai] stream (streaming flows through ai:send + ai:chunk)', payload)
    return { ok: true }
  })

  // 会话 — 转发给 host 进程，host 动态 require KhyOS 后端 sessionPersistence（CH-2），
  // 读本地 .khy/sessions 真源（与 `khy` CLI 同源），替代旧的静态 [] stub。
  ipcMain.handle('session:list', async (e, limit?: number) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, sessions: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_list_${Date.now()}_${++aiSeq}`
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionList.delete(id)
        resolve({ ok: false, sessions: [], error: '会话列表读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingSessionList.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'session.list', id, limit: typeof limit === 'number' ? limit : 50 })
    })
  })

  // 新建会话 — 同 session:list 链路：host 直调 sessionPersistence.persistSession
  // （CH-2），空消息 + cwd/projectDir 元数据落盘，返回新 sessionId。
  ipcMain.handle('session:create', async (e, workspacePath?: string) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_create_${Date.now()}_${++aiSeq}`
    const cwd = typeof workspacePath === 'string' && workspacePath ? workspacePath : process.cwd()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionCreate.delete(id)
        resolve({ ok: false, error: '会话创建超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingSessionCreate.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'session.create', id, cwd })
    })
  })

  // 会话消息 — 点击侧栏任务 / 「重载会话」时加载该会话的真实消息流。
  // 同 session:list 链路：host 直调 sessionPersistence.restoreSession（CH-2），
  // 返回 { sessionId, title, model, messages[] }。没有这条通道时点会话只换高亮
  // 不换内容（复刻端侧栏「跳转」形同虚设）。
  ipcMain.handle('session:messages', async (e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, messages: [], error: '会话 ID 为空：请先在左侧任务列表中选择一个会话' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, messages: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_msgs_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionMessages.delete(id)
        resolve({ ok: false, messages: [], error: '会话内容读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingSessionMessages.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'session.messages', id, sessionId })
    })
  })

  // host 进程状态
  ipcMain.handle('host:status', async () => {
    return { running: !!hostProcess, pid: hostProcess?.pid }
  })

  // Token 用量 — 转发给 host 进程，host 动态 require KhyOS 后端
  // tokenUsageService（CH-2），替代 UI 侧的自造假数据（ZC-ALIGN-001 P3-3）。
  ipcMain.handle('token:usage', async (e) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, usage: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `token_usage_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTokenUsage.delete(id)
        resolve({ ok: false, usage: null, error: 'Token 用量读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingTokenUsage.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'token.usage', id })
    })
  })

  // 用量历史（近 N 日 + 按模型分桶）— 转发给 host，host 读后端
  // tokenUsageService.getUsageHistory/getModelUsage（CH-2），替代使用统计页的
  // 自造假数据（ZC-ALIGN-001 P13）。
  ipcMain.handle('usage:history', async (_e, days?: number) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, history: null, models: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `usage_history_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingUsageHistory.delete(id)
        resolve({ ok: false, history: null, models: null, error: '用量历史读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingUsageHistory.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'usage.history', id, days: typeof days === 'number' && days > 0 ? Math.floor(days) : 30 })
    })
  })

  // 运行中后台任务计数（P3-6①）— 转发给 host，host 统计在途 ai.generate
  // （含自动化运行，其 hostReqId 也落在 host 侧 activeGenerations 集合）。
  // Composer「打开运行中的后台任务」按钮数据源；count=0 时 UI 隐藏按钮，
  // 与 ZCode 实测空态行为一致（i18n chat.composer.backgroundWorks 模板）。
  ipcMain.handle('background:status', async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, status: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `bg_status_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBackgroundStatus.delete(id)
        resolve({ ok: false, status: null, error: '后台任务计数读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingBackgroundStatus.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'background.status', id })
    })
  })

  // 电脑控制安全闸生效状态 — 从 host 读回当前真实 env（设置页展示后端
  // 实际生效的 mode/预算/白名单，而非渲染进程自报的写入值）。
  ipcMain.handle('desktopGate:get', async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, gate: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDesktopGate.delete(id)
        resolve({ ok: false, gate: null, error: '安全闸状态读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingDesktopGate.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'desktopGate.get', id })
    })
  })

  // 上下文窗口估算 — 转发给 host，host 用后端 tokenUsageService.estimateTokens
  // （与 /cost 同源启发式）估算当前会话 token 数 + 上下文窗口上限（ZC-ALIGN-001 P3-5/P3-6）。
  ipcMain.handle('context:size', async (_e, text?: string) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, estimate: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `ctx_size_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingContextSize.delete(id)
        resolve({ ok: false, estimate: null, error: '上下文估算超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingContextSize.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'context.size', id, text: typeof text === 'string' ? text : '' })
    })
  })

  // 模型/provider 列表 — 转发给 host，host 用后端 providerPresets.getProviderPresets()
  // （模型选择器真源，CH-2，ZC-ALIGN-001 P3-7）。
  ipcMain.handle('models:list', async (_e, adapterKey?: string) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, models: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `models_list_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingModelList.delete(id)
        resolve({ ok: false, models: [], error: '模型列表读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingModelList.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'models.list', id, adapterKey: typeof adapterKey === 'string' ? adapterKey : undefined })
    })
  })

  // ── 自动化（定时任务）— store 落盘 + 调度 tick + 经 host ai.generate 执行 ──
  ipcMain.handle('automation:list', async () => {
    return { ok: true, automations: await getAutomations() }
  })
  ipcMain.handle('automation:create', (_e, input: Parameters<typeof createAutomation>[0]) => createAutomation(input || {}))
  ipcMain.handle('automation:update', (_e, id: string, patch: Parameters<typeof updateAutomation>[1]) =>
    updateAutomation(id, patch || {})
  )
  ipcMain.handle('automation:delete', (_e, id: string) => deleteAutomation(id))
  ipcMain.handle('automation:runNow', (_e, id: string) => fireAutomation(id, 'manual'))

  // ── 插件设置页 — pluginStore 落盘（registry + 启用态 + 卸载 + 检查更新）──
  ipcMain.handle('plugin:list', async () => {
    return { ok: true, plugins: await getPlugins() }
  })
  ipcMain.handle('plugin:install', (_e, input: Parameters<typeof installPlugin>[0]) =>
    installPlugin(input || {})
  )
  ipcMain.handle('plugin:setEnabled', (_e, id: string, enabled: boolean) => setPluginEnabled(id, enabled))
  ipcMain.handle('plugin:uninstall', (_e, id: string) => uninstallPlugin(id))
  ipcMain.handle('plugin:checkUpdates', async () => checkPluginUpdates())

  // ── MCP 设置页 — mcpStore 落盘（用户自建服务器：新建/启用/删除/导入）──
  // 插件宿主区不在此列：宿主服务器由 plugin:list 按 components.mcp>0 派生（只读）。
  ipcMain.handle('mcp:list', async () => {
    return { ok: true, servers: await getMcpServers() }
  })
  ipcMain.handle('mcp:create', (_e, input: Parameters<typeof createMcpServer>[0]) => createMcpServer(input || {}))
  ipcMain.handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => setMcpServerEnabled(id, enabled))
  ipcMain.handle('mcp:delete', (_e, id: string) => deleteMcpServer(id))
  ipcMain.handle('mcp:import', (_e, rows: unknown) => importMcpServers(rows))

  // ── Agent 扩展条目（命令/钩子/技能/子智能体/记忆）— agentItemStore 正门 ──
  // 列表页 Pattern-B 六页的 CRUD + 导入；kind 由 preload 传入（command/hook/
  // skill/subagent/memory），store 侧白名单校验。
  ipcMain.handle('agent:list', (_e, kind: string) => listItems(kind))
  ipcMain.handle('agent:create', (_e, kind: string, input: unknown) => createItem(kind, input))
  ipcMain.handle('agent:setEnabled', (_e, kind: string, id: string, enabled: boolean) =>
    setItemEnabled(kind, id, enabled))
  ipcMain.handle('agent:delete', (_e, kind: string, id: string) => deleteItem(kind, id))
  ipcMain.handle('agent:import', (_e, kind: string, rows: unknown) => importItems(kind, rows))

  // ── 索引库页 — indexStore（真实磁盘扫描统计）──
  ipcMain.handle('index:list', async () => listIndexes())
  ipcMain.handle('index:create', (_e, input: unknown) => createIndex(input))
  ipcMain.handle('index:rebuild', (_e, id: string) => rebuildIndex(id))
  ipcMain.handle('index:setEnabled', (_e, id: string, enabled: boolean) => setIndexEnabled(id, enabled))
  ipcMain.handle('index:delete', (_e, id: string) => deleteIndex(id))

  // ── 外部 Agent 迁移（引导弹窗「数据迁移向导」，D5/s-8）— 只读扫描 +
  //    导入到 agent_items.json；数据根路径只读查询（Rule 1：不硬编码路径）──
  ipcMain.handle('migration:scan', async () => scanMigrations())
  ipcMain.handle('migration:import', (_e, sourceId: string) => importMigration(sourceId))
  ipcMain.handle('app:dataHome', () => migrationDataHome())

  // ── 审查面板（Git 状态）— 只读 git status -z --branch，作用于当前工作区 cwd ──
  // 结果四态：ok（含改动）/ notRepository / gitUnavailable（本机无 git.exe，
  // 诚实呈现 git.empty.gitUnavailable* 文案）/ error。只读短 I/O 超时属 Rule 3
  // 合法例外（防挂死的探测调用，非长任务截止）。
  ipcMain.handle('git:status', async () => {
    const cwd = process.cwd()
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('git', ['status', '--porcelain=v1', '-z', '--branch'], { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
          if (err) reject(err)
          else resolve(out)
        })
      })
      return parseGitStatus(stdout)
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string }
      // spawn ENOENT: no git binary on this machine — distinct from not-a-repo
      if (e.code === 'ENOENT') {
        return { ok: false, state: 'gitUnavailable' as const }
      }
      // fatal: not a git repository (or any of the parent directories)
      if (typeof e.stderr === 'string' && /not a git repository/i.test(e.stderr)) {
        return { ok: false, state: 'notRepository' as const }
      }
      // 128 with the repo detection phrase is the same not-a-repo outcome
      if (e.code === '128' && typeof e.message === 'string' && /not a git repository/i.test(e.message)) {
        return { ok: false, state: 'notRepository' as const }
      }
      return { ok: false, state: 'error' as const, error: e.stderr?.trim() || e.message || 'git status 执行失败' }
    }
  })

  // ── 窗口菜单动作（L 区对齐：自绘下拉，替代原生菜单栏）──
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      return { ok: false, error: '仅允许 https 链接：已拒绝非 https 的外部打开请求' }
    }
    await shell.openExternal(url)
    return { ok: true }
  })
  ipcMain.handle('app:openPath', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !dir.trim()) {
      return { ok: false, error: '路径为空：请先选择工作区' }
    }
    const err = shell.openPath(dir)
    return err ? { ok: false, error: `无法打开目录 ${dir}：${err}` } : { ok: true }
  })
  // 「在编辑器中打开」（appHeader D6 / D9）。编辑器来自 settings.desktopEditor
  // 或 KHY_EDITOR env（零硬编码：源码里没有字面量编辑器名/路径）。两者都未
  // 配置时如实说明怎么配，而不是静默无响应或改开资源管理器。
  ipcMain.handle('app:openInEditor', async (_e, target?: string) => {
    let editor = ''
    try {
      const settings = await getSettingsStore()
      if (typeof settings.desktopEditor === 'string') editor = settings.desktopEditor.trim()
    } catch {
      /* fail-soft */
    }
    if (!editor) editor = (process.env.KHY_EDITOR || '').trim()
    if (!editor) {
      return {
        ok: false,
        error: '未配置编辑器：请在「设置 → 常规」填写编辑器命令，或设置 KHY_EDITOR 环境变量（例如 code），然后重试',
      }
    }
    const dir = typeof target === 'string' && target.trim() ? target.trim() : await getWorkspaceRoot()
    return new Promise((resolve) => {
      try {
        const child = execFile(editor, [dir], { windowsHide: true }, (err) => {
          if (err) resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${err.message}` })
        })
        child.unref()
        // execFile 的 error 回调只在启动失败时触发；resolve 成功路径用一次性定时器
        // 兜底（短 I/O 探针，非长任务截止 —— Rule 3 合规）
        setTimeout(() => resolve({ ok: true, editor, target: dir }), 600)
      } catch (err) {
        resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${String((err as Error)?.message || err)}` })
      }
    })
  })
  // 进程监视器（窗口菜单 → 进程监视器，ZCode M1）。返回 main/host/scheduler
  // 的真实 pid 与存活状态，供 renderer 的监视器弹窗渲染（不再是 disabled 死项）。
  ipcMain.handle('app:processInfo', async () => {
    const mem = process.memoryUsage()
    return {
      ok: true,
      main: { pid: process.pid, rssBytes: mem.rss, uptimeMs: Math.round(process.uptime() * 1000) },
      host: { pid: hostProcess?.pid ?? null, alive: Boolean(hostProcess?.connected) },
      scheduler: { pid: schedulerProcess?.pid ?? null, alive: Boolean(schedulerProcess?.connected) },
      rendererCount: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
      platform: `${os.platform()} ${os.release()}`,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    }
  })
  // First-party URLs come from servicesDefaults (single truth source); main
  // resolves it via KHY_OS_DIR / relative fallback, same as the host bridge.
  ipcMain.handle('app:brandingLinks', async () => {
    try {
      const root = process.env.KHY_OS_DIR
        ? path.resolve(process.env.KHY_OS_DIR)
        : path.resolve(__dirname, '..', '..', '..')
      const sd = nodeRequire(path.join(root, 'services', 'backend', 'src', 'constants', 'serviceDefaults.js'))
      const host = sd.CLOUD_DEFAULT_HOST || ''
      return {
        ok: true,
        cloudHost: host,
        feedback: host ? `https://${host}/feedback` : '',
        docs: host ? `https://${host}/docs` : '',
        community: host ? `https://${host}/community` : '',
        issues: host ? `https://${host}/issues` : '',
      }
    } catch (err) {
      return { ok: false, error: `品牌链接真源不可用：${String((err as Error)?.message || err)}` }
    }
  })
  // 停止等待：放弃 pending 请求（底层 HTTP 无法中断，UI 立即恢复并如实说明）
  // 人在环应答（P1）：renderer 的审批 / 提问回答 → host → toolUseLoop 的
  // onControlRequest promise。这里只做透传，不做语义校验 —— {behavior} 三态
  // 解码在后端解码器、超时 fail-closed 在 host 侧，两层兜底不在 main 重复造。
  ipcMain.handle('ai:controlResponse', (_e, payload: { id?: string; requestId?: string; response?: unknown }) => {
    const id = payload?.id
    const requestId = payload?.requestId
    if (typeof id !== 'string' || !id || typeof requestId !== 'string' || !requestId) {
      return { ok: false, error: '应答缺少 id 或 requestId：请重试' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    hostProcess.send({ type: 'ai.controlResponse', id, requestId, response: payload?.response })
    return { ok: true }
  })

  ipcMain.handle('ai:abort', async (e) => {
    let aborted = 0
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    for (const [id, entry] of pendingAi) {
      if (entry.win === senderWin) {
        pendingAi.delete(id)
        // 真的中断 host 侧的工具循环（abortSignal），而不只是本地丢弃结果：
        // 否则用户点了停止，in-flight 的 Bash / 写文件仍会在后台跑完。
        if (hostProcess && hostProcess.connected) {
          try {
            hostProcess.send({ type: 'ai.abort', id })
          } catch {
            /* host 已断开：本地丢弃已足够 */
          }
        }
        entry.resolve({ ok: false, error: '已停止：本轮工具执行已请求中断，已产生的中间结果将被丢弃' })
        aborted++
      }
    }
    return { ok: true, aborted }
  })

  return win
}

app.whenReady().then(() => {
  // Key/Endpoint Manager IPC (DESIGN-ARCH-091 §6) — global, registered once
  registerKeyManagerIpc(ipcMain)

  if (KEY_MANAGER_STANDALONE) {
    // standalone entry: `npm run dev -- --key-manager` — only the manager
    // window is created, no main window / host process (spec §5.1 入口③)
    openKeyManagerWindow({ standalone: true })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openKeyManagerWindow({ standalone: true })
    })
    return
  }

  startHostProcess()
  startSchedulerProcess()
  // 自动化调度：先算一次 nextRunAt（老数据可能缺该字段），再启动周期 tick
  void (async () => {
    const list = await getAutomations()
    for (const a of list) {
      if (a.enabled && a.nextRunAt === null) {
        await updateAutomation(a.id, {})
      }
    }
  })()
  startAutomationScheduler()
  void createWindow()
  // Frameless, no native menu bar — actions live in the TitleBar 窗口菜单
  // dropdown (L 区对齐). Menu items fire via IPC (menu:new-task etc.) which
  // createWindow registers on every window.
  Menu.setApplicationMenu(null)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    settleAutomationRunsOnQuit()
    app.quit()
  }
})

app.on('will-quit', () => {
  settleAutomationRunsOnQuit()
  // 子进程随应用退出（scheduler 也会在 IPC disconnect 时自退，这里是双保险）
  try {
    schedulerProcess?.send?.({ type: 'shutdown' })
  } catch {
    /* already gone */
  }
})
