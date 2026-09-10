import { useState } from 'react'

interface GitChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions?: number
  deletions?: number
}

const mockChanges: GitChange[] = [
  { path: 'src/renderer/App.tsx', status: 'modified', additions: 12, deletions: 3 },
  { path: 'src/renderer/components/layout/TitleBar.tsx', status: 'added', additions: 85 },
  { path: 'src/renderer/components/terminal/Terminal.tsx', status: 'added', additions: 120 },
  { path: 'src/renderer/components/composer/Composer.tsx', status: 'modified', additions: 45, deletions: 8 },
  { path: 'old-file.js', status: 'deleted', deletions: 30 },
  { path: 'src/renderer/theme/globals.css', status: 'modified', additions: 200, deletions: 50 },
]

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: string }> = {
  modified: { color: 'var(--color-git-modified)', label: 'M', icon: '✏️' },
  added: { color: 'var(--color-git-added)', label: 'A', icon: '➕' },
  deleted: { color: 'var(--color-git-deleted)', label: 'D', icon: '🗑️' },
  renamed: { color: 'var(--color-git-renamed)', label: 'R', icon: '📝' },
  untracked: { color: 'var(--color-git-untracked)', label: 'U', icon: '❓' },
}

export function GitPanel() {
  const [activeTab, setActiveTab] = useState('changes')
  const [commitMessage, setCommitMessage] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(mockChanges.map(c => c.path)))

  const toggleFile = (path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectAll = () => {
    setSelectedFiles(new Set(mockChanges.map(c => c.path)))
  }

  return (
    <div className="h-full flex flex-col">
      {/* 标签栏 */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('changes')}
          className={`px-3 py-2.5 text-sm font-medium transition-all relative ${
            activeTab === 'changes' ? 'text-brand' : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          Changes
          {activeTab === 'changes' && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-brand rounded-full" />}
        </button>
        <button
          onClick={() => setActiveTab('commit')}
          className={`px-3 py-2.5 text-sm font-medium transition-all relative ${
            activeTab === 'commit' ? 'text-brand' : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          Commit
          {activeTab === 'commit' && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-brand rounded-full" />}
        </button>
      </div>

      {/* Changes 面板 */}
      {activeTab === 'changes' && (
        <div className="flex-1 overflow-auto">
          {/* 全选按钮 */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <button
              onClick={selectAll}
              className="text-xs text-foreground/40 hover:text-foreground transition-colors"
            >
              {selectedFiles.size === mockChanges.length ? '取消全选' : '全选'}
            </button>
            <span className="text-xs text-foreground/30">
              {selectedFiles.size}/{mockChanges.length} 文件
            </span>
          </div>

          {/* 文件列表 */}
          <div className="py-1">
            {mockChanges.map(change => {
              const config = STATUS_CONFIG[change.status]
              const isSelected = selectedFiles.has(change.path)
              return (
                <div
                  key={change.path}
                  className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors rounded-md mx-1 ${
                    isSelected ? 'bg-selected' : 'hover:bg-surface-hover'
                  }`}
                  onClick={() => toggleFile(change.path)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleFile(change.path)}
                    className="rounded border-border"
                  />
                  <span
                    className="w-4 h-4 rounded text-xs font-bold flex items-center justify-center"
                    style={{ backgroundColor: config.color + '20', color: config.color }}
                  >
                    {config.label}
                  </span>
                  <span className="text-sm text-foreground truncate flex-1">{change.path}</span>
                  {change.additions !== undefined && (
                    <span className="text-xs text-success">+{change.additions}</span>
                  )}
                  {change.deletions !== undefined && (
                    <span className="text-xs text-destructive">-{change.deletions}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Commit 面板 */}
      {activeTab === 'commit' && (
        <div className="flex-1 p-3 flex flex-col">
          <textarea
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            placeholder="Commit message..."
            className="flex-1 w-full bg-input border border-input-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-foreground/30 resize-none focus:outline-none focus:border-input-border-focused transition-colors"
            rows={4}
          />
          <div className="flex items-center gap-2 mt-3">
            <span className="text-xs text-foreground/40">
              {selectedFiles.size} 个文件已暂存
            </span>
            <div className="flex-1" />
            <button
              onClick={() => { setCommitMessage(''); console.log('[git] commit') }}
              disabled={!commitMessage.trim() || selectedFiles.size === 0}
              className="bg-success text-success-foreground px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              Commit
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
