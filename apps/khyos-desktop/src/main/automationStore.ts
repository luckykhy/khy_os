// automationStore — file-backed automation (定时任务) persistence for the main
// process. Mirrors settingsStore: JSON file under the BASE data home, atomic
// writes, defaults on read, in-memory cache invalidated on write.
//
// The scheduler tick in main/index.ts reads due automations and fires them
// through the existing host bridge (`ai.generate`, CH-2) — so every button on
// the 自动化 page exercises the real AI gateway, never a mock path.
//
// Schedule model (subset of ZCode's automations feature, aligned with the
// ZCode i18n evidence: frequency 每小时/每天/每工作日 + custom minutes):
//   { kind: 'minutes',  intervalMinutes: N }   every N minutes (5–1440)
//   { kind: 'daily',    time: 'HH:mm' }        every day at time
//   { kind: 'weekdays', time: 'HH:mm' }        Mon–Fri at time

import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { baseHomeFile } from './keyManager/keyStore'

const AUTOMATIONS_FILE = 'automations.json'
const MAX_RUN_HISTORY = 20
const MIN_INTERVAL_MINUTES = 5
const MAX_INTERVAL_MINUTES = 1440

export type ScheduleKind = 'minutes' | 'daily' | 'weekdays'

export interface AutomationRun {
  trigger: 'schedule' | 'manual'
  // Lifecycle statuses shown in 运行历史 (ZCode: 进行中/成功/失败/已跳过)
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  startedAt: number
  durationMs?: number
  error?: string
  resultPreview?: string
}

export interface Automation {
  id: string
  title: string
  prompt: string
  schedule: { kind: ScheduleKind; intervalMinutes?: number; time?: string }
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  runCount: number
  // undefined = 无限重复 (ZCode: recurring toggle off → stop after fixed runs)
  maxRuns?: number
  runs: AutomationRun[] // newest first, capped at MAX_RUN_HISTORY
}

function automationsPath(): string {
  return baseHomeFile(AUTOMATIONS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = path.dirname(automationsPath())
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

let cache: Automation[] | null = null
let seq = 0

async function load(): Promise<Automation[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(automationsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as { automations?: Automation[] }
    cache = Array.isArray(parsed.automations) ? parsed.automations : []
  } catch {
    cache = []
  }
  // Self-heal on boot: any run still marked running was left dangling by a
  // hard kill / crash of a previous process. Settle it as failed so the UI
  // never shows a forever-进行中 entry after restart.
  let healed = false
  for (const a of cache) {
    for (const r of a.runs) {
      if (r.status === 'running') {
        r.status = 'failed'
        r.error = '进程异常退出，运行未完成'
        r.durationMs = Date.now() - r.startedAt
        healed = true
      }
    }
  }
  if (healed) await persist(cache)
  return cache
}

async function persist(list: Automation[]): Promise<void> {
  await ensureDir()
  const tmpPath = automationsPath() + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify({ automations: list }, null, 2), 'utf-8')
  await fs.rename(tmpPath, automationsPath())
  cache = list
}

export function computeNextRunAt(a: Automation, from = Date.now()): number | null {
  if (!a.enabled) return null
  if (typeof a.maxRuns === 'number' && a.runCount >= a.maxRuns) return null
  const s = a.schedule
  if (s.kind === 'minutes') {
    const interval = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, s.intervalMinutes || 60))
    return from + interval * 60_000
  }
  const [hh, mm] = (s.time || '09:00').split(':').map((v) => Number(v))
  const d = new Date(from)
  d.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0)
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  if (s.kind === 'weekdays') {
    // 0 = Sunday, 6 = Saturday → roll to Monday
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

function normalizeSchedule(input: unknown): { schedule?: Automation['schedule']; error?: string } {
  const s = (input || {}) as { kind?: string; intervalMinutes?: number; time?: string }
  if (s.kind === 'minutes') {
    const n = Math.round(Number(s.intervalMinutes))
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      return { error: `间隔分钟数无效：请输入 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数` }
    }
    return { schedule: { kind: 'minutes', intervalMinutes: n } }
  }
  if (s.kind === 'daily' || s.kind === 'weekdays') {
    if (typeof s.time !== 'string' || !/^\d{2}:\d{2}$/.test(s.time)) {
      return { error: '运行时间无效：请按 HH:mm 格式填写（例如 09:00）' }
    }
    return { schedule: { kind: s.kind, time: s.time } }
  }
  return { error: '调度类型无效：请选择 每 N 分钟 / 每天 / 每工作日' }
}

export async function getAutomations(): Promise<Automation[]> {
  // Return a shallow copy so callers cannot mutate the cache in place.
  return [...(await load())]
}

export async function createAutomation(input: {
  title?: string
  prompt?: string
  schedule?: unknown
  maxRuns?: number
}): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) {
    return { ok: false, error: '指令为空：请填写每次运行时这个任务要做什么' }
  }
  const norm = normalizeSchedule(input.schedule)
  if (norm.error || !norm.schedule) {
    return { ok: false, error: norm.error || '调度配置无效：请检查调度设置' }
  }
  let maxRuns: number | undefined
  if (input.maxRuns !== undefined && input.maxRuns !== null) {
    const n = Math.round(Number(input.maxRuns))
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: '最大运行次数无效：请填写 1 以上的整数，或留空表示无限重复' }
    }
    maxRuns = n
  }
  const list = await load()
  const now = Date.now()
  const a: Automation = {
    id: `auto_${now.toString(36)}_${++seq}`,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '未命名定时任务',
    prompt,
    schedule: norm.schedule,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    runCount: 0,
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    runs: [],
  }
  a.nextRunAt = computeNextRunAt(a, now)
  list.unshift(a)
  await persist(list)
  return { ok: true, automation: a }
}

export async function updateAutomation(
  id: string,
  patch: {
    title?: string
    prompt?: string
    schedule?: unknown
    enabled?: boolean
    maxRuns?: number | null
    // Only touchable through recordRun* helpers; accepted here to keep the
    // IPC surface honest for the scheduler (it routes through these too).
    nextRunAt?: number | null
  }
): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
  const list = await load()
  const a = list.find((x) => x.id === id)
  if (!a) {
    return { ok: false, error: '未找到该定时任务，可能已被删除' }
  }
  if (typeof patch.title === 'string' && patch.title.trim()) a.title = patch.title.trim()
  if (typeof patch.prompt === 'string' && patch.prompt.trim()) a.prompt = patch.prompt.trim()
  if (patch.schedule !== undefined) {
    const norm = normalizeSchedule(patch.schedule)
    if (norm.error || !norm.schedule) {
      return { ok: false, error: norm.error || '调度配置无效：请检查调度设置' }
    }
    a.schedule = norm.schedule
  }
  if (patch.enabled !== undefined) {
    a.enabled = !!patch.enabled
  }
  if (patch.maxRuns !== undefined) {
    if (patch.maxRuns === null) {
      delete a.maxRuns
    } else {
      const n = Math.round(Number(patch.maxRuns))
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, error: '最大运行次数无效：请填写 1 以上的整数，或留空表示无限重复' }
      }
      a.maxRuns = n
    }
  }
  a.updatedAt = Date.now()
  a.nextRunAt = computeNextRunAt(a, a.updatedAt)
  await persist(list)
  return { ok: true, automation: a }
}

export async function deleteAutomation(id: string): Promise<{ ok: boolean; error?: string }> {
  const list = await load()
  const idx = list.findIndex((x) => x.id === id)
  if (idx === -1) {
    return { ok: false, error: '未找到该定时任务，可能已被删除' }
  }
  list.splice(idx, 1)
  await persist(list)
  return { ok: true }
}

// Called by the scheduler/fire path when a run starts: bumps runCount, pushes
// a running-history entry and recomputes nextRunAt from now.
export async function recordRunStart(
  id: string,
  trigger: AutomationRun['trigger']
): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
  const list = await load()
  const a = list.find((x) => x.id === id)
  if (!a) {
    return { ok: false, error: '未找到该定时任务，可能已被删除' }
  }
  a.runCount += 1
  a.runs.unshift({ trigger, status: 'running', startedAt: Date.now() })
  if (a.runs.length > MAX_RUN_HISTORY) a.runs.length = MAX_RUN_HISTORY
  a.updatedAt = Date.now()
  a.nextRunAt = computeNextRunAt(a, a.updatedAt)
  await persist(list)
  return { ok: true, automation: a }
}

// Skipped schedule ticks (previous run still in flight) get a history entry
// without bumping runCount — matches ZCode's 已跳过 status.
export async function recordRunSkipped(id: string): Promise<{ ok: boolean; error?: string }> {
  const list = await load()
  const a = list.find((x) => x.id === id)
  if (!a) return { ok: false, error: '未找到该定时任务，可能已被删除' }
  a.runs.unshift({ trigger: 'schedule', status: 'skipped', startedAt: Date.now(), error: '上一条正在运行中，本次调度已跳过' })
  if (a.runs.length > MAX_RUN_HISTORY) a.runs.length = MAX_RUN_HISTORY
  a.nextRunAt = computeNextRunAt(a, Date.now())
  await persist(list)
  return { ok: true }
}

export async function recordRunEnd(
  id: string,
  startedAt: number,
  status: 'succeeded' | 'failed',
  extra: { durationMs: number; error?: string; resultPreview?: string }
): Promise<{ ok: boolean; error?: string }> {
  const list = await load()
  const a = list.find((x) => x.id === id)
  if (!a) return { ok: false, error: '未找到该定时任务，可能已被删除' }
  const run = a.runs.find((r) => r.startedAt === startedAt && r.status === 'running')
  if (!run) return { ok: false, error: '未找到进行中的运行记录：可能已被清理' }
  run.status = status
  run.durationMs = extra.durationMs
  if (extra.error) run.error = extra.error
  if (extra.resultPreview) run.resultPreview = extra.resultPreview
  await persist(list)
  return { ok: true }
}
