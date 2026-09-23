// AutomationsPage — 定时任务管理（route #/automations, sidebar 自动化 entry).
// UI copy mirrors ZCode's automations i18n bundle extracted read-only from
// ZCode app.asar (automations.runNow/empty/lifecycle/schedule/runs.* keys).
// Every action goes through preload __KHYOS__ → main IPC → automationStore +
// host aiGateway — no mock data paths.

import { useCallback, useEffect, useState } from 'react'

interface AutomationRun {
  trigger: 'schedule' | 'manual'
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  startedAt: number
  durationMs?: number
  error?: string
  resultPreview?: string
}

interface Automation {
  id: string
  title: string
  prompt: string
  schedule: { kind: 'minutes' | 'daily' | 'weekdays'; intervalMinutes?: number; time?: string }
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  runCount: number
  maxRuns?: number
  runs: AutomationRun[]
}

interface KhyosAutomationsApi {
  automationsList?: () => Promise<{ ok: boolean; automations?: Automation[]; error?: string }>
  automationsCreate?: (input: Record<string, unknown>) => Promise<{ ok: boolean; automation?: Automation; error?: string }>
  automationsUpdate?: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; automation?: Automation; error?: string }>
  automationsDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>
  // skipped：调度触发时若上一条还在跑，main 会记一条 skipped 历史并回这个标记
  // （fireAutomation 的真实返回，见 main/index.ts）。此前两处类型都漏了它，
  // 于是下面 runNow 读 res.skipped 一直是类型错误 —— 运行时是好的，是契约没写全。
  automationsRunNow?: (id: string) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>
}

function api(): KhyosAutomationsApi {
  return (window as unknown as { __KHYOS__?: KhyosAutomationsApi }).__KHYOS__ || {}
}

// ZCode schedule labels: automations.schedule.customMinutes / daily / weekdays
function scheduleSummary(s: Automation['schedule']): string {
  if (s.kind === 'minutes') return `每 ${s.intervalMinutes} 分钟`
  if (s.kind === 'daily') return `每天 ${s.time}`
  return `每工作日 ${s.time}`
}

// ZCode lifecycle badges: automations.lifecycle.active/paused/completed
function lifecycle(a: Automation): { label: string; cls: string } {
  if (a.enabled && typeof a.maxRuns === 'number' && a.runCount >= a.maxRuns) {
    return { label: '已完成', cls: 'bg-blue-500/15 text-blue-400' }
  }
  if (!a.enabled) return { label: '已暂停', cls: 'bg-foreground/10 text-foreground/60' }
  return { label: '运行中', cls: 'bg-green-500/15 text-green-500' }
}

function formatWhen(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(d, now)) return `今天 ${hm}`
  if (sameDay(d, tomorrow)) return `明天 ${hm}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

const TRIGGER_LABEL: Record<AutomationRun['trigger'], string> = { schedule: '定时', manual: '手动' }
const RUN_STATUS: Record<AutomationRun['status'], { label: string; cls: string }> = {
  running: { label: '进行中', cls: 'text-foreground/60' },
  succeeded: { label: '成功', cls: 'text-green-500' },
  failed: { label: '失败', cls: 'text-red-400' },
  skipped: { label: '已跳过', cls: 'text-foreground/40' },
}

const EMPTY = { title: '还没有定时任务', description: '创建一个任务，按周期自动运行你的指令。', create: '手动创建' }

export function AutomationsPage() {
  const [items, setItems] = useState<Automation[]>([])
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  // form: null = closed; 'create' | automation id = open (create or edit)
  const [formTarget, setFormTarget] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [freq, setFreq] = useState<'minutes' | 'daily' | 'weekdays'>('daily')
  const [intervalMinutes, setIntervalMinutes] = useState('30')
  const [time, setTime] = useState('09:00')
  const [maxRuns, setMaxRuns] = useState('')
  const [formError, setFormError] = useState('')

  const flash = useCallback((msg: string, isError = false) => {
    setNotice(msg)
    setNoticeError(isError)
  }, [])

  const refresh = useCallback(async () => {
    const res = await api().automationsList?.()
    if (res?.ok) setItems(res.automations || [])
    else flash(res?.error || '读取定时任务列表失败：请重启应用后重试', true)
  }, [flash])

  // 首屏拉取。⚠️ 顺序是硬要求：`refresh` 必须声明在下面那个轮询 effect **之前**。
  // 轮询 effect 的依赖数组 [hasRunning, refresh] 是**渲染期求值**的，若 refresh 还
  // 在后面用 const + useCallback 声明，进这个页面就会抛
  // `Cannot access 'refresh' before initialization`（TDZ 暂时性死区），React 卸载
  // 整棵树 → #/automations 纯白屏。这正是该页面一直空白的原因（tsc 其实早就在
  // 报 TS2448 / TS2454，只是没人看）。改动本文件时不要把这两段位置对调。
  useEffect(() => {
    void refresh()
  }, [refresh])

  // A run settles on the next ai.result (seconds after trigger) — poll while
  // any row is 进行中, stop when all settle. Activity-driven, no fixed kill.
  const hasRunning = items.some((a) => a.runs[0]?.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(() => {
      void refresh()
    }, 5000)
    return () => {
      clearInterval(t)
    }
  }, [hasRunning, refresh])

  const openCreate = useCallback(() => {
    setTitle('')
    setPrompt('')
    setFreq('daily')
    setIntervalMinutes('30')
    setTime('09:00')
    setMaxRuns('')
    setFormError('')
    setFormTarget('create')
  }, [])

  const openEdit = useCallback((a: Automation) => {
    setTitle(a.title)
    setPrompt(a.prompt)
    setFreq(a.schedule.kind)
    setIntervalMinutes(String(a.schedule.intervalMinutes ?? 30))
    setTime(a.schedule.time ?? '09:00')
    setMaxRuns(typeof a.maxRuns === 'number' ? String(a.maxRuns) : '')
    setFormError('')
    setFormTarget(a.id)
  }, [])

  const closeForm = useCallback(() => {
    setFormTarget(null)
    setFormError('')
  }, [])

  const submitForm = useCallback(async () => {
    setFormError('')
    const payload: Record<string, unknown> = {
      title,
      prompt,
      schedule:
        freq === 'minutes'
          ? { kind: 'minutes', intervalMinutes: Number(intervalMinutes) }
          : { kind: freq, time },
      ...(maxRuns.trim() ? { maxRuns: Number(maxRuns) } : {}),
    }
    const res =
      formTarget === 'create'
        ? await api().automationsCreate?.(payload)
        : await api().automationsUpdate?.(formTarget || '', payload)
    if (res?.ok) {
      flash(formTarget === 'create' ? '已创建任务' : '保存成功')
      closeForm()
      await refresh()
    } else {
      setFormError(res?.error || (formTarget === 'create' ? '创建失败，请重试' : '保存失败，请重试'))
    }
  }, [title, prompt, freq, intervalMinutes, time, maxRuns, formTarget, flash, closeForm, refresh])

  const toggleEnabled = useCallback(
    async (a: Automation) => {
      const res = await api().automationsUpdate?.(a.id, { enabled: !a.enabled })
      if (res?.ok) {
        flash(a.enabled ? '已暂停' : '继续运行')
        await refresh()
      } else {
        flash(res?.error || '状态更新失败，请重试', true)
      }
    },
    [flash, refresh]
  )

  const runNow = useCallback(
    async (a: Automation) => {
      const res = await api().automationsRunNow?.(a.id)
      if (res?.ok) {
        flash(res.skipped ? '上一条正在运行中，本次调度已跳过' : '已触发，即将运行')
        await refresh()
      } else {
        flash(res?.error || '触发运行失败', true)
      }
    },
    [flash, refresh]
  )

  const doDelete = useCallback(
    async (a: Automation) => {
      const res = await api().automationsDelete?.(a.id)
      if (res?.ok) {
        flash('已删除')
        setConfirmDelete(null)
        await refresh()
      } else {
        flash(res?.error || '删除失败，请重试', true)
      }
    },
    [flash, refresh]
  )

  const editing = formTarget && formTarget !== 'create' ? items.find((a) => a.id === formTarget) : null

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar — same frame as SettingsPage (返回工作区 back entry) */}
      <div className="flex items-center justify-between h-[60px] px-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">KhyOS</span>
        </div>
        <button
          onClick={() => {
            window.location.hash = ''
          }}
          className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
        >
          返回工作区
        </button>
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 pt-8 pb-16">
          {/* Page header — ZCode: settings.automations.title + description + betaBadge */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-foreground">自动化</h1>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-brand/15 text-brand">Beta</span>
              </div>
              <p className="text-sm text-foreground/50 mt-1">创建定时任务，或排队在闲时算力空间时后台执行。</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  void refresh()
                }}
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
              >
                刷新
              </button>
              <button
                onClick={openCreate}
                className="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors bg-brand text-white hover:opacity-90"
              >
                新建
              </button>
            </div>
          </div>

          {/* Action feedback — ZCode: runNowQueued / pause / resume / 已删除 */}
          {notice && (
            <div
              className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${
                noticeError ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-500'
              }`}
            >
              {notice}
            </div>
          )}

          {/* Create / edit form (ZCode: form.createTitle / editTitle) */}
          {formTarget && (
            <div className="bg-card border border-card-border rounded-xl p-5 mb-6">
              <h2 className="text-sm font-medium text-foreground mb-1">
                {editing ? '编辑定时任务' : '新建定时任务'}
              </h2>
              <p className="text-xs text-foreground/50 mb-4">配置任务的执行时间、指令和运行方式。</p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-foreground/60 mb-1.5">任务标题</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：每日站会摘要"
                    className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
                  />
                </div>

                <div>
                  <label className="block text-xs text-foreground/60 mb-1.5">调度</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={freq}
                      onChange={(e) => setFreq(e.target.value as 'minutes' | 'daily' | 'weekdays')}
                      className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused"
                    >
                      <option value="minutes">自定义间隔</option>
                      <option value="daily">每天</option>
                      <option value="weekdays">每工作日</option>
                    </select>
                    {freq === 'minutes' ? (
                      <div className="flex items-center gap-2 text-sm text-foreground/60">
                        <span>每</span>
                        <input
                          type="number"
                          min={5}
                          max={1440}
                          value={intervalMinutes}
                          onChange={(e) => setIntervalMinutes(e.target.value)}
                          className="w-20 bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused"
                        />
                        <span>分钟</span>
                      </div>
                    ) : (
                      <input
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                        className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused"
                      />
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-foreground/60 mb-1.5">指令</label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="每次运行时这个任务要做什么？"
                    className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused resize-y"
                  />
                </div>

                <div>
                  <label className="block text-xs text-foreground/60 mb-1.5">最大运行次数（留空表示无限重复）</label>
                  <input
                    type="number"
                    min={1}
                    value={maxRuns}
                    onChange={(e) => setMaxRuns(e.target.value)}
                    placeholder="例如：10"
                    className="w-40 bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
                  />
                </div>

                {formError && <p className="text-sm text-red-400">{formError}</p>}

                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => {
                      void submitForm()
                    }}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:opacity-90 transition-opacity"
                  >
                    {editing ? '保存' : '创建定时任务'}
                  </button>
                  <button
                    onClick={closeForm}
                    className="px-4 py-2 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* List / empty state — ZCode: automations.empty.* */}
          {items.length === 0 ? (
            <div className="bg-card border border-card-border rounded-xl p-12 text-center">
              <span className="text-3xl mb-3 block">⏰</span>
              <p className="text-sm font-medium text-foreground/70 mb-1">{EMPTY.title}</p>
              <p className="text-xs text-foreground/40 mb-5">{EMPTY.description}</p>
              <button
                onClick={openCreate}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors"
              >
                {EMPTY.create}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((a) => {
                const lc = lifecycle(a)
                const isRunning = a.runs[0]?.status === 'running' && a.enabled
                return (
                  <div key={a.id} className="bg-card border border-card-border rounded-xl p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">{a.title}</span>
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${lc.cls}`}>{lc.label}</span>
                        </div>
                        <div className="text-xs text-foreground/50 mt-1.5 flex items-center gap-3 flex-wrap">
                          <span>{scheduleSummary(a.schedule)}</span>
                          <span>
                            {typeof a.maxRuns === 'number'
                              ? `已运行 ${a.runCount}/${a.maxRuns} 次`
                              : `已运行 ${a.runCount} 次`}
                          </span>
                          {a.enabled && a.nextRunAt !== null && !isRunning && (
                            <span>下次运行 {formatWhen(a.nextRunAt)}</span>
                          )}
                          {isRunning && <span className="text-foreground/60">进行中</span>}
                        </div>
                      </div>
                      {/* Row actions — ZCode: runNow / pause / resume / edit / history / delete */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => {
                            void runNow(a)
                          }}
                          disabled={isRunning}
                          className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          立即运行
                        </button>
                        <button
                          onClick={() => {
                            void toggleEnabled(a)
                          }}
                          className="px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                        >
                          {a.enabled ? '暂停' : '继续'}
                        </button>
                        <button
                          onClick={() => openEdit(a)}
                          className="px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => setHistoryOpen(historyOpen === a.id ? null : a.id)}
                          className="px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                        >
                          历史
                        </button>
                        {confirmDelete === a.id ? (
                          <span className="flex items-center gap-1.5">
                            <span className="text-xs text-foreground/60">确定删除？此操作无法撤销</span>
                            <button
                              onClick={() => {
                                void doDelete(a)
                              }}
                              className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                            >
                              确认
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                            >
                              取消
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(a.id)}
                            className="px-2.5 py-1.5 text-xs text-red-400/80 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Prompt preview */}
                    <div className="text-xs text-foreground/40 mt-2 line-clamp-2">{a.prompt}</div>

                    {/* Run history — ZCode: runs.title / col.* / status.* */}
                    {historyOpen === a.id && (
                      <div className="mt-4 border-t border-card-border pt-3">
                        <div className="text-xs font-medium text-foreground/60 mb-2">运行历史</div>
                        {a.runs.length === 0 ? (
                          <p className="text-xs text-foreground/40">还没有运行记录。</p>
                        ) : (
                          <div className="space-y-2">
                            {a.runs.map((r, i) => {
                              const st = RUN_STATUS[r.status]
                              return (
                                <div key={i} className="text-xs flex items-center gap-3 flex-wrap">
                                  <span className="text-foreground/60 w-32">{formatWhen(r.startedAt)}</span>
                                  <span className="text-foreground/40 w-10">{TRIGGER_LABEL[r.trigger]}</span>
                                  <span className={`w-12 ${st.cls}`}>{st.label}</span>
                                  <span className="text-foreground/40 w-16">{formatDuration(r.durationMs)}</span>
                                  {r.resultPreview && (
                                    <span className="text-foreground/50 truncate flex-1 min-w-[200px]">
                                      {r.resultPreview}
                                    </span>
                                  )}
                                  {r.error && <span className="text-red-400/80 truncate flex-1 min-w-[200px]">{r.error}</span>}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
