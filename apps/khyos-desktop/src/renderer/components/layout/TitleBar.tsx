import { useState, useEffect, useRef } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'
import { ProcessMonitorDialog } from './ProcessMonitorDialog'
import { WorkspacePicker } from '../workspace/WorkspacePicker'
import { openWorkspace } from '../../utils/openWorkspace'
import { keyLabelFor } from '../../shared/keymap'

const TITLEBAR_HEIGHT = 48
const CAPTION_BUTTON_WIDTH = 46

interface TitleBarProps {
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
  onOpenSidePane?: () => void
  onToggleTerminal?: () => void
  // 会话 tab 头：会话标题（空 → 「新任务」）
  sessionTitle?: string
  // 新建任务（窗口菜单 Ctrl+N）→ AppLayout 清会话 + 回启动卡片页
  onNewTask?: () => void
  // 重载会话 → 重新拉取当前会话消息
  onReloadSession?: () => void
  // 后退 / 前进（会话导航历史，AppLayout 持有栈）
  onBack?: () => void
  onForward?: () => void
  canBack?: boolean
  canForward?: boolean
}

type MenuItem =
  | { kind: 'action'; label: string; shortcut?: string; disabled?: boolean; run: () => void }
  | { kind: 'separator' }

export function TitleBar({
  onToggleSidebar,
  sidebarVisible = true,
  onOpenSidePane,
  onToggleTerminal,
  sessionTitle,
  onNewTask,
  onReloadSession,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
}: TitleBarProps) {
  const [platform, setPlatform] = useState('win32')
  const [menuOpen, setMenuOpen] = useState(false)
  const [processOpen, setProcessOpen] = useState(false)
  // Real workspace root from the main process. main resolves it through
  // getWorkspaceRoot() (settings.desktopWorkspacePath → cwd fallback), so the
  // chip follows 打开工作区 immediately instead of freezing the boot directory.
  const [workspacePath, setWorkspacePath] = useState('')
  const dispatch = useAppDispatch()

  const refreshWorkspacePath = () => {
    void apiRef.current?.getWorkspacePath?.().then((p: unknown) => {
      if (typeof p === 'string' && p) setWorkspacePath(p)
    }).catch(() => {})
  }

  useEffect(() => {
    const api = (window as any).__KHYOS__
    if (api) {
      setPlatform(api.getPlatform())
      void api.getWorkspacePath?.().then((p: unknown) => {
        if (typeof p === 'string' && p) setWorkspacePath(p)
      })
    }
  }, [])

  const isMac = platform === 'darwin'
  const api = (window as any).__KHYOS__ as
    | {
        openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
        openPath?: (dir: string) => Promise<{ ok: boolean; error?: string }>
        openInEditor?: (target?: string) => Promise<{ ok: boolean; editor?: string; error?: string }>
        openDirectoryPicker?: () => Promise<string | null>
        setSetting?: (k: string, v: unknown) => Promise<void>
        getBrandingLinks?: () => Promise<{ ok: boolean; feedback?: string; docs?: string; community?: string; issues?: string; error?: string }>
        closeWindow?: () => void
        getWorkspacePath?: () => Promise<string>
      }
    | undefined
  // api object is recreated每渲染，但 refreshWorkspacePath 在事件回调里用；
  // 用 ref 保证拿到最新一份而不触发 effect 重订阅。
  const apiRef = useRef(api)
  apiRef.current = api

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))
  const openUrl = async (url?: string) => {
    if (!url) {
      toast('链接不可用：品牌真源未配置，请检查 KHY_OS_DIR 与 serviceDefaults', 'error')
      return
    }
    const res = await api?.openExternal?.(url)
    if (res && !res.ok) toast(res.error || '外部链接打开失败', 'error')
  }

  // 打开工作区（窗口菜单 Ctrl+O）：收敛为 utils/openWorkspace.ts 的唯一入口
  // （[DESIGN-ARCH-125] P-02）。此前这里、WorkspaceSidebar、CommandCenter 各写了
  // 一遍 picker → setSetting → 广播；现在校验与持久化都在 main（workspace:open），
  // 渲染层只负责发起 + 广播 khy:workspace-changed + 提示用户。
  const pickWorkspace = async () => {
    await openWorkspace()
  }

  // 工作区根变更后重取（本组件用它给「在资源管理器中打开」等菜单项做可用性判断，
  // 不跟着刷新就会出现「已经切走了、菜单还在按旧根判断」）。
  useEffect(() => {
    window.addEventListener('khy:workspace-changed', refreshWorkspacePath)
    return () => window.removeEventListener('khy:workspace-changed', refreshWorkspacePath)
  }, [])

  const menuItems: MenuItem[] = [
    // 键位标签取自 shared/keymap.ts 单一真源（[DESIGN-ARCH-125] P-03）：菜单里
    // 写死 'Ctrl+N' 而加速键没人实现，是命令面板与窗口菜单双双骗人的根源。
    { kind: 'action', label: '新建任务', shortcut: keyLabelFor('newTask'), run: () => onNewTask?.() },
    { kind: 'action', label: '打开工作区', shortcut: keyLabelFor('openWorkspace'), run: () => { void pickWorkspace() } },
    { kind: 'action', label: '重新加载会话', run: () => onReloadSession?.() },
    { kind: 'action', label: '在资源管理器中打开', run: () => {
      if (!workspacePath) { toast('工作区路径不可用：请重启应用后重试', 'error'); return }
      void api?.openPath?.(workspacePath).then((r) => { if (r && !r.ok) toast(r.error || '打开失败', 'error') })
    } },
    { kind: 'action', label: '在编辑器中打开', run: () => {
      void api?.openInEditor?.(workspacePath).then((r) => {
        if (r && !r.ok) toast(r.error || '编辑器启动失败', 'error')
        else toast(`已在编辑器 ${r?.editor ?? ''} 中打开 ${workspacePath}`)
      })
    } },
    { kind: 'separator' },
    { kind: 'action', label: '关于 KhyOS', run: () => toast('KhyOS Desktop — ZCode 1:1 复刻（开发构建）') },
    { kind: 'action', label: '检查更新', run: () => toast('当前为开发构建：自动更新通道未配置，跳过检查') },
    { kind: 'action', label: '进程监视器', run: () => setProcessOpen(true) },
    { kind: 'separator' },
    { kind: 'action', label: '问题反馈', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.feedback)) } },
    { kind: 'action', label: '给产品提需求', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.issues)) } },
    { kind: 'action', label: '用户社群', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.community)) } },
    { kind: 'action', label: '产品文档', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.docs)) } },
    { kind: 'action', label: '导出日志', run: () => toast('导出日志：请在应用数据目录 ~/.khyquant/logs 中查看（自动导出通道未接线）') },
    { kind: 'separator' },
    { kind: 'action', label: '关闭窗口', run: () => api?.closeWindow?.() },
  ]

  return (
    <div
      className="bg-header flex items-center select-none"
      style={{ height: TITLEBAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left icon group — mirrors ZCode D1: 切换侧边栏 / 后退 / 前进 */}
      {!isMac && (
        <div className="flex items-center gap-0.5 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onToggleSidebar}
            className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/70 hover:text-foreground transition-colors"
            title="切换侧边栏"
            aria-label="切换侧边栏"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5.5 2.5v9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            onClick={onBack}
            disabled={!canBack}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              canBack ? 'hover:bg-surface-hover text-foreground/70 hover:text-foreground' : 'text-foreground/25 cursor-default'
            }`}
            title={canBack ? '后退（上一个会话）' : '后退：没有更早的会话'}
            aria-label="后退"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={onForward}
            disabled={!canForward}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              canForward ? 'hover:bg-surface-hover text-foreground/70 hover:text-foreground' : 'text-foreground/25 cursor-default'
            }`}
            title={canForward ? '前进（下一个会话）' : '前进：没有更新的会话'}
            aria-label="前进"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5.5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
      <div
        className="flex-1 flex items-center gap-2 text-sm select-none min-w-0"
        style={{ paddingLeft: isMac ? 76 : 8 }}
      >
        {/* Session title + workspace chip — mirrors ZCode appHeader row
            (ZC-ALIGN-002 D5). Title reflects the selected session (host truth). */}
        <span className="text-foreground font-medium truncate max-w-[280px]" title={sessionTitle || '新任务'}>
          {sessionTitle || '新任务'}
        </span>
        {/* 工作空间 chip → 选择器（[DESIGN-ARCH-125] P-01）：点开即「最近打开 +
            打开其他文件夹…」，不再每次都弹系统目录框。与空态卡片顶端那行是同一个
            组件，两处永远显示同一个值（都以 workspace:list 真值为准）。 */}
        <WorkspacePicker variant="titlebar" />
      </div>
      {/* Right icon group — mirrors ZCode D2-D4: 展开侧边面板 / 切换终端 / 窗口菜单 */}
      {!isMac && (
        <div className="flex items-center gap-0.5 pr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onOpenSidePane}
            className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/70 hover:text-foreground transition-colors"
            title="展开侧边面板"
            aria-label="展开侧边面板"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M8.5 2.5v9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            onClick={onToggleTerminal}
            className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/70 hover:text-foreground transition-colors"
            title="切换终端"
            aria-label="切换终端"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M4 5.5l2 1.7-2 1.7M7.3 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${menuOpen ? 'bg-selected text-foreground' : 'hover:bg-surface-hover text-foreground/70 hover:text-foreground'}`}
            title="窗口菜单"
            aria-label="窗口菜单"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2.5 4h9M2.5 7h9M2.5 10h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      {/* 窗口菜单自绘下拉 — ZCode L 区实测 12 项合并式（无边框窗口无原生菜单栏） */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => setMenuOpen(false)} />
          <div
            className="fixed right-2 top-12 z-50 w-64 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm select-none"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {menuItems.map((item, idx) =>
              item.kind === 'separator' ? (
                <div key={`sep_${idx}`} className="my-1.5 border-t border-border" />
              ) : (
                <button
                  key={item.label}
                  disabled={item.disabled}
                  onClick={() => {
                    setMenuOpen(false)
                    item.run()
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    item.disabled
                      ? 'text-foreground/30 cursor-default'
                      : 'text-foreground hover:bg-surface-hover'
                  }`}
                >
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut && <span className="text-xs text-foreground/40">{item.shortcut}</span>}
                </button>
              )
            )}
          </div>
        </>
      )}
      {/* 进程监视器（窗口菜单 L4 / ZCode M1）：展示 main/host/scheduler 真实
          pid 与存活态（四进程架构自检的 UI 入口） */}
      {processOpen && <ProcessMonitorDialog onClose={() => setProcessOpen(false)} />}
      {!isMac && (
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => (window as any).__KHYOS__?.minimizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最小化窗口">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
          <button onClick={() => (window as any).__KHYOS__?.maximizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最大化或还原窗口">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
          </button>
          <button onClick={() => (window as any).__KHYOS__?.closeWindow()} className="flex items-center justify-center hover:bg-destructive text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="关闭">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>
      )}
    </div>
  )
}
