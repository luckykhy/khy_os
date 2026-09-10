import { useState } from 'react'

interface AppHeaderProps {
  sessionId?: string
  workspacePath?: string
  modelName?: string
  onReload?: () => void
}

export function AppHeader({ sessionId = 'sess_74b99e12-4b39-45a0-ac8f-539e2a5e1b8a', workspacePath = 'D:\\Portable\\khy-os', modelName = 'GLM-5.3Max', onReload }: AppHeaderProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleReload = () => {
    setReloading(true)
    onReload?.()
    setTimeout(() => setReloading(false), 1000)
  }

  return (
    <div className="bg-panel border-b border-border px-4 py-2 flex items-center gap-2 flex-wrap">
      {/* 会话信息 */}
      <div className="flex items-center gap-2 text-xs text-foreground/60 mr-2">
        <span className="font-medium text-foreground/80">{modelName}</span>
        <span className="text-foreground/30">·</span>
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
          onClick={() => copyToClipboard(`${workspacePath}/.khyos/conversations/${sessionId}.jsonl`, 'jsonl')}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="复制 JSONL 路径"
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
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5"
          title="在编辑器中打开"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M7 2H3a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M7 5l3-3M5 8l3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>在编辑器中打开</span>
        </button>

        <button
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
