import { useCallback, useEffect, useRef, useState } from 'react'
import { openWorkspace } from '../../utils/openWorkspace'

// 工作空间选择器（[DESIGN-ARCH-125] P-01）—— 两处入口共用同一组件，避免出现
// 第三份实现：
//   'card-header'：新对话卡片顶端一整行（空态首页，本次新增）
//   'titlebar'   ：标题栏工作区 chip（替换原有只读 chip）
//
// 数据一律来自 main 的 workspace:list 真值（当前根 + 最近打开候选集）。
// 渲染层**不缓存**第二份「当前工作空间」—— 那是 getWorkspaceRoot() 的职责，
// 这里照抄一份就会重演「chip / 文件树 / 文件索引各说各话」的老问题。
//
// 诚实边界：候选集为空时只渲染兜底项，不补示例路径。

interface WorkspaceEntry {
  path: string
  name: string
}

interface WorkspaceListResult {
  ok: boolean
  current?: string
  recents?: WorkspaceEntry[]
  error?: string
}

interface WorkspaceApi {
  workspaceList?: () => Promise<WorkspaceListResult>
}

export function WorkspacePicker({ variant = 'card-header' }: { variant?: 'card-header' | 'titlebar' }) {
  const [current, setCurrent] = useState('')
  const [recents, setRecents] = useState<WorkspaceEntry[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    const api = (window as unknown as { __KHYOS__?: WorkspaceApi }).__KHYOS__
    if (!api?.workspaceList) {
      setError('工作空间列表不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.workspaceList().then((res) => {
      if (!res?.ok) {
        setError(res?.error || '工作空间列表读取失败：host 进程无响应，请重试')
        return
      }
      setError('')
      setCurrent(res.current || '')
      setRecents(res.recents || [])
    }).catch((err: unknown) => {
      setError(`工作空间列表读取失败：${String(err)}，请重试`)
    })
  }, [])

  // 挂载时拉一次；任何来源的切换（卡片、标题栏、窗口菜单、侧栏）都会广播
  // khy:workspace-changed，这里跟着刷新，保证两处入口显示同一个值。
  useEffect(() => {
    refresh()
    const onChanged = () => refresh()
    window.addEventListener('khy:workspace-changed', onChanged)
    return () => window.removeEventListener('khy:workspace-changed', onChanged)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const switchTo = useCallback((target?: string) => {
    setOpen(false)
    setBusy(true)
    void openWorkspace(target).finally(() => {
      setBusy(false)
      // 成功路径已由 khy:workspace-changed 触发 refresh；失败/取消时这里兜一次，
      // 保证「列表过期」（例如某目录刚被删）也能被纠正。
      refresh()
    })
  }, [refresh])

  const displayName = current ? (current.split(/[\\/]/).filter(Boolean).pop() || current) : '未打开工作区'
  const isCardHeader = variant === 'card-header'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={
          isCardHeader
            ? 'w-full flex items-center gap-2 text-sm text-foreground/70 hover:text-foreground transition-colors disabled:opacity-50'
            : 'flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-card border border-card-border text-xs text-foreground/70 flex-shrink-0 hover:bg-surface-hover transition-colors disabled:opacity-50'
        }
        title={current ? `当前工作空间：${current}（点击切换）` : '未打开工作空间：点击选择目录'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <path
            d="M2 4h8M2 4a1 1 0 011-1h2l1 1h3a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
        <span className="truncate">{displayName}</span>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" className="shrink-0">
          <path d="M2 3.5l2.5 2.5L7 3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        {isCardHeader && current && (
          <span className="ml-auto text-xs text-foreground/40 truncate hidden md:inline">{current}</span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden z-50 ${
            isCardHeader ? 'left-0 w-[320px]' : 'left-0 w-[300px]'
          }`}
        >
          {error ? (
            <div className="px-3 py-2.5 text-xs text-destructive leading-relaxed">{error}</div>
          ) : (
            <>
              {/* 空候选集时不渲染分组标题，直接给兜底项（不补示例路径） */}
              {recents.length > 0 && (
                <>
                  <div className="px-3 py-2 text-xs font-semibold text-popover-header border-b border-popover-border">
                    最近打开
                  </div>
                  <div className="max-h-56 overflow-auto py-1">
                    {recents.map((entry) => {
                      const isCurrent = entry.path === current
                      return (
                        <button
                          key={entry.path}
                          role="menuitem"
                          onClick={() => switchTo(entry.path)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                            isCurrent ? 'bg-selected' : 'hover:bg-surface-hover'
                          }`}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`shrink-0 ${isCurrent ? 'text-brand' : ''}`}>
                            <path
                              d="M2 4h8M2 4a1 1 0 011-1h2l1 1h3a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
                              stroke="currentColor"
                              strokeWidth="1.2"
                            />
                          </svg>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-popover-foreground truncate">{entry.name}</span>
                            <span className="block text-xs text-foreground/50 truncate">{entry.path}</span>
                          </span>
                          {isCurrent && (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-brand">
                              <path
                                d="M2.5 6.2l2.4 2.4L9.5 3.6"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <div className="border-t border-popover-border" />
                </>
              )}
              <button
                role="menuitem"
                onClick={() => switchTo()}
                className="w-full text-left px-3 py-2.5 text-sm text-popover-foreground hover:bg-surface-hover transition-colors flex items-center gap-2.5"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="shrink-0">
                  <path
                    d="M7 2.5v6M4 6l3 3 3-3M2.5 11.5h9"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>打开其他文件夹…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
