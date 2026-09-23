import { useCallback, useEffect, useRef, useState } from 'react'

// 工作区文件树（workspaceSidebar.showFileTree 视图，workspaceFileTree.* 文案）：
// 数据经 __KHYOS__.workspaceReadTree → main workspace:readTree（单目录懒加载，
// 展开时按需拉子层）。点文件 → 调用方在侧边面板打开 codeViewer 标签。

export interface TreeItem {
  name: string
  path: string
  kind: 'directory' | 'file'
}

interface ReadTreePayload {
  ok: boolean
  root?: string
  items?: TreeItem[]
  error?: string
}

interface FileTreeProps {
  // 选中文件 → 侧边面板 codeViewer 标签（AppLayout.openFileTab）
  onOpenFile: (filePath: string) => void
  // 可选树根：调用方有会话级工作区（session workspacePath）时传入该目录；
  // 缺省则回退主进程 cwd 工作区（旧行为）
  rootPath?: string
}

// Loading text carries action + target (Rule 2). Item count is unknown until
// readdir returns, so no fabricated progress digits are shown.
const loadingText = (dirName: string) => `读取 ${dirName} 目录...`

const loadDir = (dirPath: string, query: string): Promise<ReadTreePayload> => {
  const api = (window as unknown as {
    __KHYOS__?: { workspaceReadTree?: (dir?: string, q?: string) => Promise<ReadTreePayload> }
  }).__KHYOS__
  if (!api?.workspaceReadTree) {
    return Promise.resolve({
      ok: false,
      error: '文件树通道不可用：preload 未注入 __KHYOS__，请重启应用',
    })
  }
  return api.workspaceReadTree(dirPath, query)
}

export function FileTree({ onOpenFile, rootPath }: FileTreeProps) {
  const [resolvedRoot, setResolvedRoot] = useState('')
  const [rootName, setRootName] = useState('Workspace')
  const [items, setItems] = useState<TreeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Resolve the root once: caller-provided session workspace (rootPath prop)
  // takes priority; otherwise fall back to app:workspacePath (main process cwd)
  useEffect(() => {
    if (rootPath) {
      setResolvedRoot(rootPath)
      setRootName(rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath)
      return
    }
    const api = (window as unknown as {
      __KHYOS__?: { getWorkspacePath?: () => Promise<string> }
    }).__KHYOS__
    if (api?.getWorkspacePath) {
      api.getWorkspacePath().then((p) => {
        if (typeof p === 'string' && p) {
          setResolvedRoot(p)
          setRootName(p.split(/[\\/]/).filter(Boolean).pop() || 'Workspace')
        }
      })
    } else {
      setLoading(false)
      setError('工作区路径不可用：preload 未注入 __KHYOS__，请重启应用')
    }
  }, [rootPath])

  // Load the root level (and its filtered view) whenever root or search changes
  useEffect(() => {
    if (!resolvedRoot) return
    let cancelled = false
    setLoading(true)
    loadDir(resolvedRoot, search).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res?.ok) {
        setError(res?.error || '读取目录失败：主进程无响应，请重启应用')
        setItems([])
        return
      }
      setError('')
      setItems(res.items || [])
    })
    return () => { cancelled = true }
  }, [resolvedRoot, search, reloadSeq])

  // Escape clears the file search (workspaceFileTree.clearSearch)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && search) setSearch('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [search])

  const handleRefresh = useCallback(() => setReloadSeq((n) => n + 1), [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：workspaceFileTree.title + 返回任务由 WorkspaceSidebar 视图切换承担 */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 shrink-0">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0 text-foreground/60">
          <path d="M2 4h8M2 4a1 1 0 011-1h2l1 1h3a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="text-sm font-medium text-foreground truncate" title={rootPath}>{rootName}</span>
        <div className="flex-1" />
        <button
          onClick={handleRefresh}
          className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="刷新文件树"
          aria-label="刷新文件树"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M12 7a5 5 0 11-1.5-3.5M12 1.5V4h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 搜索框：workspaceFileTree.searchPlaceholder */}
      <div className="px-2.5 pb-2 shrink-0">
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索文件..."
            aria-label="搜索文件"
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-input-border-focused focus:outline-none transition-colors"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchInputRef.current?.focus() }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground/50 hover:text-foreground text-sm font-bold"
              title="清空文件搜索"
              aria-label="清空文件搜索"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 树体 */}
      <div className="flex-1 overflow-auto py-1">
        {loading ? (
          <div className="px-3 py-6 text-sm text-foreground/50">{loadingText(rootName)}</div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="text-3xl mb-3">⚠️</span>
            <span className="text-sm text-destructive leading-relaxed">{error}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-6 text-sm text-foreground/40">
            {search ? '没有匹配的文件。' : '当前目录为空。'}
          </div>
        ) : (
          items.map((item) => (
            <TreeRow key={item.path} item={item} depth={0} onOpenFile={onOpenFile} />
          ))
        )}
      </div>
    </div>
  )
}

function TreeRow({
  item,
  depth,
  onOpenFile,
}: {
  item: TreeItem
  depth: number
  onOpenFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<TreeItem[]>([])
  const [childState, setChildState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const isDir = item.kind === 'directory'

  const toggle = useCallback(() => {
    if (!isDir) { onOpenFile(item.path); return }
    setExpanded((open) => {
      // First expansion lazily loads children (workspace:readTree per level)
      if (!open && childState === 'idle') {
        setChildState('loading')
        loadDir(item.path, '').then((res) => {
          if (!res?.ok) {
            setChildState('error')
            setChildren([])
            return
          }
          setChildren(res.items || [])
          setChildState('loaded')
        })
      }
      return !open
    })
  }, [isDir, item.path, childState, onOpenFile])

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-1 px-2 py-1 mx-1 rounded-md text-left transition-colors hover:bg-surface-hover"
        style={{ paddingLeft: depth * 14 + 8 }}
        title={item.path}
      >
        {isDir ? (
          <span className={`w-4 h-4 flex items-center justify-center text-xs text-foreground/40 transition-transform duration-150 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}>
            ▶
          </span>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <span className="text-xs flex-shrink-0" aria-hidden="true">
          {isDir ? (expanded ? '📂' : '📁') : fileIcon(item.name)}
        </span>
        <span className="truncate text-sm text-foreground/90">{item.name}</span>
      </button>
      {expanded && isDir && (
        <div>
          {childState === 'loading' ? (
            <div className="px-3 py-1.5 text-xs text-foreground/40" style={{ paddingLeft: depth * 14 + 30 }}>
              {loadingText(item.name)}
            </div>
          ) : childState === 'error' ? (
            <div className="px-3 py-1.5 text-xs text-destructive" style={{ paddingLeft: depth * 14 + 30 }}>
              读取目录失败：请检查目录权限后重试
            </div>
          ) : children.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-foreground/40" style={{ paddingLeft: depth * 14 + 30 }}>
              当前目录为空。
            </div>
          ) : (
            children.map((child) => (
              <TreeRow key={child.path} item={child} depth={depth + 1} onOpenFile={onOpenFile} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Glyph icons by extension (placeholder set — swap for real assets later)
const FILE_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', mjs: '🟨', cjs: '🟨',
  vue: '🟢', json: '📋', md: '📝', css: '🎨', html: '🌐',
  py: '🐍', bat: '⚙️', ps1: '⚙️', sh: '⚙️', yml: '⚙️', yaml: '⚙️', toml: '⚙️',
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICONS[ext] ?? '📄'
}
