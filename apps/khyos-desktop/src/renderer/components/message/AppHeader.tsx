import { useState } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'

interface AppHeaderProps {
  sessionId?: string
  // 会话落盘 JSONL 的真实路径（后端 jsonlPathFor 解析结果）
  sessionJsonlPath?: string
  workspacePath?: string
  modelName?: string
  onReload?: () => void
}

export function AppHeader({ sessionId = '', sessionJsonlPath = '', workspacePath = '', modelName, onReload }: AppHeaderProps) {
  // Display-only: App.tsx passes the catalog-resolved label of the selected
  // model (P3-7④) or the '选择模型' placeholder; never a brand literal.
  const modelLabel = modelName ?? ''
  const [copied, setCopied] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const dispatch = useAppDispatch()

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) {
      dispatch(addToast({ type: 'error', title: '复制失败：内容为空，请先选择工作区或会话' }))
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      dispatch(addToast({ type: 'error', title: `复制失败：${String(err)}，请检查剪贴板权限` }))
    }
  }

  // 「重载会话」：真实重新拉取当前会话消息（App 层 session:messages 桥），
  // 无当前会话时 App 层会给出可选择会话的提示。
  const handleReload = () => {
    setReloading(true)
    onReload?.()
    setTimeout(() => setReloading(false), 1000)
  }

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))

  // 在编辑器中打开 / 在资源管理器中打开：都走 main 的真实 IPC
  const openInEditor = () => {
    const api = (window as unknown as {
      __KHYOS__?: { openInEditor?: (t?: string) => Promise<{ ok: boolean; editor?: string; error?: string }> }
    }).__KHYOS__
    if (!api?.openInEditor) { toast('编辑器打开不可用：preload 未注入 __KHYOS__，请重启应用', 'error'); return }
    void api.openInEditor(workspacePath).then((r) => {
      if (!r?.ok) toast(r.error || '编辑器启动失败', 'error')
      else toast(`已在编辑器 ${r.editor ?? ''} 中打开 ${workspacePath}`)
    }).catch((err: unknown) => toast(`编辑器启动失败：${String(err)}`, 'error'))
  }

  const openInFileManager = () => {
    const api = (window as unknown as {
      __KHYOS__?: { openPath?: (p: string) => Promise<{ ok: boolean; error?: string }> }
    }).__KHYOS__
    if (!workspacePath) { toast('工作区路径不可用：请先在窗口菜单中打开工作区', 'error'); return }
    if (!api?.openPath) { toast('打开目录不可用：preload 未注入 __KHYOS__，请重启应用', 'error'); return }
    void api.openPath(workspacePath).then((r) => {
      if (r && !r.ok) toast(r.error || '打开失败', 'error')
    }).catch((err: unknown) => toast(`打开目录失败：${String(err)}`, 'error'))
  }

  return (
    <div className="bg-panel border-b border-border px-4 py-2 flex items-center gap-2 flex-wrap">
      {/* 会话信息 */}
      <div className="flex items-center gap-2 text-xs text-foreground/60 mr-2">
        {modelLabel && (
          <>
            <span className="font-medium text-foreground/80">{modelLabel}</span>
            <span className="text-foreground/30">·</span>
          </>
        )}
        <span className="truncate max-w-[200px]" title={workspacePath}>{workspacePath}</span>
      </div>

      <div className="flex-1" />

      {/* 操作按钮组 */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => copyToClipboard(workspacePath, 'path')}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="复制路径"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 2.5H8a1.5 1.5 0 011.5 1.5V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span>{copied === 'path' ? '已复制' : '复制路径'}</span>
        </button>

        <button
          onClick={() => copyToClipboard(sessionId, 'session')}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="复制会话 ID"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 2.5H8a1.5 1.5 0 011.5 1.5V7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span>{copied === 'session' ? '已复制' : '复制会话 ID'}</span>
        </button>

        <button
          onClick={() => copyToClipboard(sessionJsonlPath, 'jsonl')}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title={sessionJsonlPath ? `复制 JSONL 路径：${sessionJsonlPath}` : '复制 JSONL 路径：请先选择一个会话'}
        >
          <span>{copied === 'jsonl' ? '已复制' : '复制JSONL路径'}</span>
        </button>

        <div className="w-px h-4 bg-border mx-1" />

        <button
          onClick={handleReload}
          disabled={reloading}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5 disabled:opacity-50"
          title="重载会话"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={reloading ? 'animate-spin' : ''}>
            <path d="M2.5 6a3.5 3.5 0 016.7-1.3M9.5 6a3.5 3.5 0 01-6.7 1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M9 2.5V4H7.5M3 9.5V8H4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{reloading ? '重载中...' : '重载会话'}</span>
        </button>

        <button
          onClick={openInEditor}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="在编辑器中打开（编辑器取 设置 → 常规 或 KHY_EDITOR）"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M7 2H3a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M7 5l3-3M5 8l3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>在编辑器中打开</span>
        </button>

        <button
          onClick={openInFileManager}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="在资源管理器中打开"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4h8M2 4a1 1 0 011-1h2l1 1h3a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span>在资源管理器中打开</span>
        </button>
      </div>
    </div>
  )
}
