import { useState, useEffect, useRef, useMemo } from 'react'

interface Command {
  id: string
  label: string
  description?: string
  icon: string
  shortcut?: string
  category: string
  action: () => void
}

interface CommandCenterProps {
  visible: boolean
  onClose: () => void
}

export function CommandCenter({ visible, onClose }: CommandCenterProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands: Command[] = useMemo(() => [
    { id: 'new-task', label: '新建任务', description: '创建新的对话任务', icon: '➕', shortcut: 'Ctrl+N', category: '任务', action: () => console.log('[cmd] new task') },
    { id: 'open-workspace', label: '打开工作区', description: '选择项目文件夹', icon: '📂', shortcut: 'Ctrl+O', category: '任务', action: () => console.log('[cmd] open workspace') },
    { id: 'toggle-terminal', label: '切换终端', description: '显示/隐藏终端面板', icon: '💻', shortcut: 'Ctrl+J', category: '视图', action: () => console.log('[cmd] terminal') },
    { id: 'toggle-sidepane', label: '切换右侧面板', description: '显示/隐藏右侧面板', icon: '📋', shortcut: 'Ctrl+Alt+B', category: '视图', action: () => console.log('[cmd] sidepane') },
    { id: 'toggle-fullscreen', label: '切换全屏', description: '进入/退出全屏模式', icon: '⛶', shortcut: 'F11', category: '视图', action: () => console.log('[cmd] fullscreen') },
    { id: 'command-center', label: '命令中心', description: '搜索所有命令', icon: '🔍', shortcut: 'Ctrl+K', category: '视图', action: () => console.log('[cmd] command center') },
    { id: 'search', label: '搜索对话', description: '在当前对话中搜索', icon: '🔎', shortcut: 'Ctrl+F', category: '搜索', action: () => console.log('[cmd] search') },
    { id: 'switch-model', label: '切换模型', description: '选择 AI 模型', icon: '🧠', category: '模型', action: () => console.log('[cmd] switch model') },
    { id: 'switch-mode', label: '切换执行模式', description: '切换权限模式', icon: '⚡', shortcut: 'Shift+Tab', category: '模型', action: () => console.log('[cmd] switch mode') },
    { id: 'thought-level', label: '思考强度', description: '调整思考深度', icon: '💭', shortcut: 'Ctrl+T', category: '模型', action: () => console.log('[cmd] thought level') },
    { id: 'compact', label: '压缩上下文', description: '压缩对话历史', icon: '📦', category: '对话', action: () => console.log('[cmd] compact') },
    { id: 'clear', label: '清空对话', description: '清空当前对话', icon: '🗑️', category: '对话', action: () => console.log('[cmd] clear') },
    { id: 'reload-session', label: '重载会话', description: '重新加载当前会话', icon: '↻', category: '对话', action: () => console.log('[cmd] reload') },
    { id: 'settings', label: '打开设置', description: '打开应用设置', icon: '⚙️', shortcut: 'Ctrl+,', category: '应用', action: () => console.log('[cmd] settings') },
    { id: 'check-update', label: '检查更新', description: '检查应用更新', icon: '🔄', category: '应用', action: () => console.log('[cmd] check update') },
    { id: 'export-logs', label: '导出日志', description: '导出诊断日志', icon: '📤', category: '应用', action: () => console.log('[cmd] export logs') },
    { id: 'devtools', label: '切换开发者工具', description: '打开/关闭开发者工具', icon: '🔧', shortcut: 'F12', category: '开发', action: () => console.log('[cmd] devtools') },
  ], [])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter(cmd =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.description?.toLowerCase().includes(q) ||
      cmd.category.toLowerCase().includes(q)
    )
  }, [query, commands])

  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {}
    filtered.forEach(cmd => {
      if (!groups[cmd.category]) groups[cmd.category] = []
      groups[cmd.category].push(cmd)
    })
    return groups
  }, [filtered])

  useEffect(() => {
    if (visible) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [visible])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  // 滚动选中项到视图
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!visible) return null

  let flatIndex = -1

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* 面板 */}
      <div className="relative w-full max-w-lg bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 搜索框 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-popover-border">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-foreground/40 flex-shrink-0">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12.5 12.5L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索命令..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/30 focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 rounded text-xs text-foreground/40 bg-surface border border-border">Esc</kbd>
        </div>

        {/* 命令列表 */}
        <div ref={listRef} className="max-h-80 overflow-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/40">
              没有找到匹配的命令
            </div>
          ) : (
            Object.entries(grouped).map(([category, cmds]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-xs font-semibold text-foreground/40 uppercase tracking-wider">
                  {category}
                </div>
                {cmds.map(cmd => {
                  flatIndex++
                  const isSelected = flatIndex === selectedIndex
                  return (
                    <button
                      key={cmd.id}
                      data-index={flatIndex}
                      onClick={() => { cmd.action(); onClose() }}
                      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                        isSelected ? 'bg-selected' : 'hover:bg-surface-hover'
                      }`}
                    >
                      <span className="text-base w-6 text-center">{cmd.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-popover-foreground">{cmd.label}</div>
                        {cmd.description && (
                          <div className="text-xs text-foreground/40 truncate">{cmd.description}</div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="px-2 py-0.5 rounded text-xs text-foreground/40 bg-surface border border-border font-mono">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-popover-border flex items-center gap-4 text-xs text-foreground/30">
          <span>↑↓ 导航</span>
          <span>↵ 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
