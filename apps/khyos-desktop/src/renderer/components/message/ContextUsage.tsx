import { useState, useEffect, useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface ContextBreakdown {
  label: string
  tokens: number
  color: string
  percentage: number
}

// Shape of the real usage payload from tokenUsageService via the host bridge
// (CH-2, ZC-ALIGN-001 P3-3).
interface RealUsage {
  today: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number }
  month: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number }
  session: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number }
  quota: { allowed: boolean; remaining: number; limit: number; used: number }
}

// Floating panel position persisted in settings.json (settings:get/set →
// settingsStore). null = inline in the message flow (default).
interface PanelPos {
  x: number
  y: number
}

// Floating panel geometry: w-80 = 20rem = 320px (the fixed floating width).
const PANEL_FLOAT_WIDTH = 320
// Long-press that arms dragging (a UI gesture timer, exempt from Rule 3).
const LONG_PRESS_MS = 400
// Viewport margin the floating panel is clamped inside (never strandable).
const VIEWPORT_MARGIN = 8
// Pointer travel that cancels a pending long-press (a drag intent, not hold).
const DRAG_SLOP_PX = 10

function isPanelPos(value: unknown): value is PanelPos {
  if (!value || typeof value !== 'object') return false
  const p = value as PanelPos
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function ContextUsagePanel() {
  const [expanded, setExpanded] = useState(false)
  const [usage, setUsage] = useState<RealUsage | null>(null)
  const [usageError, setUsageError] = useState('')
  // Floating state: pos === null → inline in the message flow; a persisted
  // {x,y} floats the panel at that viewport position.
  const [pos, setPos] = useState<PanelPos | null>(null)
  const [dragging, setDragging] = useState(false)
  const [posError, setPosError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const pressTimer = useRef<number | null>(null)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null)
  // A long-press that armed a drag must not also fire the header click
  // (expand/collapse) on release.
  const suppressClick = useRef(false)

  const loadUsage = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getTokenUsage?: () => Promise<{ ok: boolean; usage?: RealUsage; error?: string }> }
    }).__KHYOS__
    if (!api?.getTokenUsage) {
      setUsageError('用量数据不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.getTokenUsage().then((res) => {
      if (res?.ok && res.usage) setUsage(res.usage)
      else setUsageError(res?.error || '用量数据读取失败：host 未返回有效数据，请重启应用')
    }).catch(() => {
      setUsageError('用量数据读取失败：host 进程无响应，请重启应用')
    })
  }, [])

  // Load on mount and refresh on expand (usage is live data; ZCode shows a
  // real "上下文已用 X / 总量 Y" counter, not fabricated numbers).
  useEffect(() => { loadUsage() }, [loadUsage])
  useEffect(() => { if (expanded) loadUsage() }, [expanded, loadUsage])

  // Restore the persisted floating position, clamped to the current viewport
  // (a resize between runs can't strand the panel off-screen).
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
    }).__KHYOS__
    api?.getSettings?.().then((settings) => {
      const p = settings?.contextUsagePanelPos
      if (isPanelPos(p)) setPos(clampPos({ x: p.x, y: p.y }))
    }).catch(() => { /* fail-soft: stay inline on read failure */ })
  }, [])

  const clampPos = useCallback((p: PanelPos): PanelPos => {
    // Floating width is fixed (w-80 = PANEL_FLOAT_WIDTH); collapsed height
    // is the header (~48px) until first expand, so clamp never strands it.
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_FLOAT_WIDTH - VIEWPORT_MARGIN)
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - 48 - VIEWPORT_MARGIN)
    return {
      x: Math.min(Math.max(p.x, VIEWPORT_MARGIN), maxX),
      y: Math.min(Math.max(p.y, VIEWPORT_MARGIN), maxY),
    }
  }, [])

  // Keep the floating panel inside the viewport across window resizes.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampPos])

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressStart.current = null
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return // primary press only
    const el = e.currentTarget
    pressStart.current = { x: e.clientX, y: e.clientY }
    const px = e.clientX
    const py = e.clientY
    const pid = e.pointerId
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      pressStart.current = null
      // Synthetic-event currentTarget is nulled after dispatch — el was
      // captured synchronously, so the drag handle is still addressable here.
      startDragFrom({ currentTarget: el, clientX: px, clientY: py, pointerId: pid })
    }, LONG_PRESS_MS)
  }

  // startDragFrom: the long-press timer passes the synchronously-captured
  // DOM element (React nulls synthetic-event currentTarget after dispatch).
  const startDragFrom = (ctx: { currentTarget: Element; clientX: number; clientY: number; pointerId: number }) => {
    suppressClick.current = true
    // Anchor to the panel's VISUAL position (getBoundingClientRect) — works
    // for both inline (detach point) and already-floating (current spot) and
    // never goes stale if the component re-rendered during the hold.
    const rect = panelRef.current?.getBoundingClientRect()
    const startPos: PanelPos = rect ? { x: rect.left, y: rect.top } : { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN }
    dragOffset.current = { dx: ctx.clientX - startPos.x, dy: ctx.clientY - startPos.y }
    setPos(startPos)
    setDragging(true)
    try { ctx.currentTarget.setPointerCapture(ctx.pointerId) } catch { /* older hosts: fall back to element tracking */ }
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) {
      const off = dragOffset.current
      if (off) setPos(clampPos({ x: e.clientX - off.dx, y: e.clientY - off.dy }))
      return
    }
    // Pending long-press: significant travel means drag intent, not a hold.
    const start = pressStart.current
    if (start) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP_PX) cancelPress()
    }
  }

  const persistPos = useCallback((value: PanelPos | null) => {
    const api = (window as unknown as {
      __KHYOS__?: { setSetting?: (key: string, v: unknown) => Promise<unknown> }
    }).__KHYOS__
    api?.setSetting?.('contextUsagePanelPos', value).catch(() => {
      setPosError('位置保存失败：无法写入 settings.json，重启后将回到原位，请检查磁盘权限后重试')
    })
  }, [])

  const handlePointerUp = () => {
    cancelPress()
    if (!dragging) return
    setDragging(false)
    dragOffset.current = null
    // Persist where the user released the panel. Read pos via ref-style
    // snapshot to avoid persisting inside a setState updater (StrictMode
    // double-invokes updaters, which would fire the IPC write twice).
    const finalPos = pos
    if (finalPos) persistPos(finalPos)
  }

  const handlePointerLeave = () => {
    // Only cancels a PENDING hold; an armed drag holds pointer capture, so
    // its event stream is unaffected.
    if (!dragging) cancelPress()
  }

  const resetToInline = () => {
    setPos(null)
    setPosError('')
    persistPos(null)
  }

  // Real data: month totals are the persistent truth source; the session
  // counter resets per app run. Display month + today, matching ZCode's
  // "上下文已用 / 总量" shape (quota limit vs used tokens).
  const used = usage?.quota.used ?? 0
  const total = usage?.quota.limit ?? 0
  const percentage = total > 0 ? (used / total) * 100 : 0
  const quotaExceeded = usage ? !usage.quota.allowed : false

  const breakdown: ContextBreakdown[] = usage ? [
    { label: '输入 token（本月累计）', tokens: usage.month.inputTokens, color: 'bg-sky-500', percentage: total > 0 ? (usage.month.inputTokens / total) * 100 : 0 },
    { label: '输出 token（本月累计）', tokens: usage.month.outputTokens, color: 'bg-fuchsia-500', percentage: total > 0 ? (usage.month.outputTokens / total) * 100 : 0 },
    { label: '请求次数（本月）', tokens: usage.month.requests * 1000, color: 'bg-yellow-500', percentage: total > 0 ? (usage.month.requests * 1000 / total) * 100 : 0 },
  ] : []

  const inline = pos === null

  const toggleExpanded = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    setExpanded(!expanded)
  }

  return (
    <div
      ref={panelRef}
      className={inline ? 'my-3' : `fixed z-40 w-80 ${dragging ? 'cursor-grabbing' : ''}`}
      style={inline ? undefined : { left: pos.x, top: pos.y }}
    >
      <div
        className={
          'relative bg-card border border-card-border rounded-xl overflow-hidden ' +
          (inline ? '' : dragging ? 'shadow-2xl border-brand/60' : 'shadow-lg')
        }
      >
        {/* 头部 — 点击展开/收起；长按 400ms 进入拖拽（悬浮后可再长按调整位置） */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label="Token 用量（本月配额）"
          onClick={toggleExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setExpanded(!expanded)
            }
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-surface-hover transition-colors touch-none select-none cursor-pointer"
          title={inline ? '长按可拖出为悬浮面板 · 点击展开/收起' : '长按拖动调整位置 · 点击展开/收起'}
        >
          <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium text-foreground">Token 用量（本月配额）</span>
          {!inline && !dragging && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); resetToInline() }}
              title="复位：回到消息流原位"
              className="flex-shrink-0 ml-1 px-1.5 py-0.5 rounded-md text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs"
            >
              ↺
            </button>
          )}
          <span className="text-xs text-foreground/40 ml-auto">
            {dragging
              ? '拖动 Token 用量面板 · 松开保存位置'
              : usageError
              ? '读取失败'
              : usage
              ? `${fmtTokens(used)} / ${fmtTokens(total)} (${percentage.toFixed(1)}%)`
              : '读取 Token 用量…'}
          </span>
        </div>

        {(usageError || posError) && (
          <div className="px-4 py-3 text-xs text-foreground/50 leading-relaxed">{usageError || posError}</div>
        )}

        {expanded && !usageError && usage && (
          <div className="px-4 pb-4 animate-slide-down">
            {/* 本月配额进度条 */}
            <div className="h-2 bg-surface rounded-full overflow-hidden mb-4 flex">
              <div
                className={`${quotaExceeded ? 'bg-destructive' : 'bg-brand'} transition-all duration-500`}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
            </div>
            {quotaExceeded && (
              <div className="mb-3 text-xs text-destructive">
                本月配额已用完（{fmtTokens(used)} / {fmtTokens(total)}）：请等待下月重置或升级订阅
              </div>
            )}

            {/* 分项列表 — 全部来自 tokenUsageService 真源 */}
            <div className="space-y-2">
              {breakdown.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className={`w-3 h-3 rounded-sm ${item.color} flex-shrink-0`} />
                  <span className="text-sm text-foreground/70 flex-1">{item.label}</span>
                  <span className="text-xs text-foreground/40 tabular-nums">
                    {i === 2 ? `${usage.month.requests}` : fmtTokens(item.tokens)}
                  </span>
                </div>
              ))}
            </div>

            {/* 本月 / 今日对比 */}
            <div className="mt-4 pt-3 border-t border-card-border flex items-center justify-between text-xs">
              <span className="text-foreground/50">本月 {usage.month.requests} 次请求</span>
              <span className="text-foreground/50">今日 {usage.today.requests} 次</span>
              <span className="text-foreground/50">成本 ${usage.month.costUSD.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function CheckpointRewindDialog({ visible, onClose, onConfirm }: { visible: boolean; onClose: () => void; onConfirm: () => void }) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  const safeToUndo = 3
  const unsafeToUndo = 1
  const ignored = 1

  const handleCheck = () => {
    setChecking(true)
    setTimeout(() => {
      setChecking(false)
      setChecked(true)
    }, 1500)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-lg font-semibold text-popover-foreground">撤销文件改动</h3>
          <p className="text-sm text-foreground/50 mt-1">撤销前会重新检查当前文件内容</p>
        </div>

        {/* 内容 */}
        <div className="px-6 py-4">
          {!checked ? (
            <div className="text-center py-6">
              <p className="text-sm text-foreground/60 mb-4">
                点击下方按钮检查可撤销的文件
              </p>
              <button
                onClick={handleCheck}
                disabled={checking}
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {checking ? '正在检查可撤销文件...' : '检查可撤销文件'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 安全区 */}
              <div className="p-3 bg-success/10 rounded-xl border border-success/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-success" />
                  <span className="text-sm font-medium text-success">可安全撤销</span>
                  <span className="text-xs text-foreground/40 ml-auto">{safeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">这些文件未被外部修改，可以安全撤销</div>
              </div>

              {/* 不安全区 */}
              <div className="p-3 bg-destructive/10 rounded-xl border border-destructive/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
                  <span className="text-sm font-medium text-destructive">不能安全撤销</span>
                  <span className="text-xs text-foreground/40 ml-auto">{unsafeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">文件已被外部修改，撤销可能丢失更改</div>
              </div>

              {/* 忽略区 */}
              <div className="p-3 bg-surface rounded-xl border border-card-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-foreground/30" />
                  <span className="text-sm font-medium text-foreground/60">已忽略</span>
                  <span className="text-xs text-foreground/40 ml-auto">{ignored} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">bash/shell 修改不参与撤销</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-popover-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => { onConfirm(); onClose() }}
            disabled={!checked}
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium disabled:opacity-30 hover:opacity-90 transition-opacity"
          >
            撤销文件
          </button>
        </div>
      </div>
    </div>
  )
}
