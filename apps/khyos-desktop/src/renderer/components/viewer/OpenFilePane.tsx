import { useEffect, useRef, useState } from 'react'

// 打开文件选择器（sidePane.openFile.* 文案）：
// 「从当前 workspace 中选择文件并在侧边面板打开。」
// 数据经 __KHYOS__.workspaceListFiles → main workspace:listFiles（有界遍历，
// 只索引文本类文件）。选中文件 → 调用方打开 codeViewer 标签。

interface WorkspaceFilesPayload {
  ok: boolean
  root?: string
  files?: { path: string; name: string }[]
  error?: string
}

interface OpenFilePaneProps {
  onOpenFile: (filePath: string) => void
}

export function OpenFilePane({ onOpenFile }: OpenFilePaneProps) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [error, setError] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Load the workspace index once; typing only filters client-side
  useEffect(() => {
    let cancelled = false
    const api = (window as unknown as {
      __KHYOS__?: { workspaceListFiles?: (q?: string) => Promise<WorkspaceFilesPayload> }
    }).__KHYOS__
    if (!api?.workspaceListFiles) {
      setError('文件索引通道不可用：preload 未注入 __KHYOS__，请重启应用')
      setLoading(false)
      return
    }
    api.workspaceListFiles('').then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res?.ok) {
        setError(res?.error || '文件索引不可用：主进程无响应，请重启应用')
        return
      }
      setFiles(res.files || [])
    }).catch(() => {
      if (!cancelled) {
        setLoading(false)
        setError('文件索引请求失败：主进程无响应，请重启应用')
      }
    })
    return () => { cancelled = true }
  }, [])

  const filtered = query.trim()
    ? files.filter(f => f.path.toLowerCase().includes(query.trim().toLowerCase()))
    : files

  useEffect(() => { setSelectedIndex(0) }, [query])

  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const file = filtered[selectedIndex]
      if (file) onOpenFile(file.path)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：sidePane.openFileDescription */}
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h3 className="text-sm font-medium text-foreground">打开文件</h3>
        <p className="text-xs text-foreground/50 mt-1">从当前 workspace 中选择文件并在侧边面板打开。</p>
      </div>
      {/* 搜索框 */}
      <div className="px-3 pb-2 shrink-0">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索当前 workspace 文件..."
          className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-input-border-focused focus:outline-none transition-colors"
        />
      </div>
      {/* 文件列表 */}
      <div ref={listRef} className="flex-1 overflow-auto px-2 pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-foreground/50">
            正在加载文件...
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="text-3xl mb-3">⚠️</span>
            <span className="text-sm text-destructive leading-relaxed">{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-sm text-foreground/40">
            {query ? '没有找到文件。' : '没有找到文件。'}
          </div>
        ) : (
          filtered.map((file, idx) => (
            <button
              key={file.path}
              data-index={idx}
              onClick={() => onOpenFile(file.path)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                idx === selectedIndex ? 'bg-selected' : 'hover:bg-surface-hover'
              }`}
            >
              <div className="text-sm text-foreground truncate">{file.name}</div>
              <div className="text-xs text-foreground/40 truncate font-mono" title={file.path}>
                {file.path}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
