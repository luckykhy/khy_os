import { useEffect, useState } from 'react'

// 进程监视器（窗口菜单 → 进程监视器；ZCode M1 processMonitor 的 khy-os 等效实现）。
// 显示四进程架构的真实存活状态：main / host / scheduler + 渲染窗口数。
// 数据来自 main 的 app:processInfo（pid、连接态、内存、版本），非自造数字——
// 任一子进程未起来时如实显示「未启动」，并给出可执行的下一步。

interface ProcessInfo {
  ok: boolean
  main?: { pid: number; rssBytes: number; uptimeMs: number }
  host?: { pid: number | null; alive: boolean }
  scheduler?: { pid: number | null; alive: boolean }
  rendererCount?: number
  platform?: string
  versions?: { electron?: string; chrome?: string; node?: string }
  error?: string
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function ProcessMonitorDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ProcessInfo | null>(null)

  useEffect(() => {
    const api = (window as unknown as { __KHYOS__?: { processInfo?: () => Promise<ProcessInfo> } }).__KHYOS__
    if (!api?.processInfo) {
      setInfo({ ok: false, error: '进程信息不可用：preload 未注入 __KHYOS__，请重启应用' })
      return
    }
    let cancelled = false
    const load = () => {
      api.processInfo!().then((res) => {
        if (!cancelled) setInfo(res)
      }).catch((err: unknown) => {
        if (!cancelled) setInfo({ ok: false, error: `进程信息读取失败：${String(err)}，请重启应用后重试` })
      })
    }
    load()
    // 1s 轮询仅刷新只读快照（纯 UI 刷新，非任务截止 —— 规则 3 合规）
    const timer = setInterval(load, 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const row = (name: string, pid: number | null | undefined, alive: boolean, extra?: string) => (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border last:border-b-0">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${alive ? 'bg-brand' : 'bg-destructive'}`} />
      <span className="text-sm text-foreground flex-1">{name}</span>
      <span className="text-xs text-foreground/50 tabular-nums">{pid ? `pid ${pid}` : '未启动'}</span>
      {extra && <span className="text-xs text-foreground/40 tabular-nums">{extra}</span>}
    </div>
  )

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[420px] rounded-xl border border-border bg-popover shadow-2xl"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        role="dialog"
        aria-label="进程监视器"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">进程监视器</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
            aria-label="关闭进程监视器"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {!info ? (
          <div className="px-4 py-6 text-sm text-foreground/50">正在读取进程状态…</div>
        ) : !info.ok ? (
          <div className="px-4 py-6 text-sm text-destructive">{info.error || '进程状态不可用'}</div>
        ) : (
          <div>
            {row('主进程 main', info.main?.pid, Boolean(info.main?.pid), info.main ? formatBytes(info.main.rssBytes) : '')}
            {row('Agent 运行时 host', info.host?.pid, Boolean(info.host?.alive))}
            {row('定时任务 scheduler', info.scheduler?.pid, Boolean(info.scheduler?.alive))}
            <div className="px-3 py-2 text-xs text-foreground/50 flex flex-wrap gap-x-4 gap-y-1">
              <span>渲染窗口 {info.rendererCount ?? 0} 个</span>
              {info.main && <span>主进程已运行 {formatUptime(info.main.uptimeMs)}</span>}
              {info.versions && <span>Electron {info.versions.electron} · Chromium {info.versions.chrome} · Node {info.versions.node}</span>}
              {info.platform && <span>{info.platform}</span>}
            </div>
            {!info.host?.alive && (
              <div className="px-3 pb-3 text-xs text-foreground/50">
                host 未存活：Agent 能力（会话列表/模型/网关）不可用，请重启 KhyOS Desktop。
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
