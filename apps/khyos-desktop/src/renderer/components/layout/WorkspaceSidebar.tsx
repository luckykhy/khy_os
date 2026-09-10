import { useState, useMemo } from 'react'

interface Task {
  id: string
  title: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  archived: boolean
}

interface WorkspaceSidebarProps {
  tasks: Task[]
  archivedTasks?: Task[]
  activeTaskId: string | null
  onTaskSelect: (id: string) => void
  onNewTask: () => void
  viewMode: 'grouped' | 'chronological'
  onViewModeChange: (mode: 'grouped' | 'chronological') => void
  searchQuery: string
  onSearchChange: (query: string) => void
}

export function WorkspaceSidebar({
  tasks,
  archivedTasks = [],
  activeTaskId,
  onTaskSelect,
  onNewTask,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
}: WorkspaceSidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [sortBy, setSortBy] = useState<'updatedAt' | 'createdAt'>('updatedAt')

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return `${Math.floor(diff / 86400000)} 天前`
  }

  // 过滤和排序任务
  const filteredTasks = useMemo(() => {
    let result = tasks
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(t => t.title.toLowerCase().includes(q))
    }
    return [...result].sort((a, b) => b[sortBy] - a[sortBy])
  }, [tasks, searchQuery, sortBy])

  const sortedArchived = useMemo(() => {
    return [...archivedTasks].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [archivedTasks])

  return (
    <div className="bg-sidebar border-r border-border flex flex-col h-full overflow-hidden" style={{ width: 280 }}>
      {/* 搜索栏 */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="搜索任务..."
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-input-border-focused focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground/50 hover:text-foreground text-sm font-bold"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 视图切换 + 排序 */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <button
          onClick={() => onViewModeChange('grouped')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'grouped'
              ? 'bg-selected text-foreground'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          分组
        </button>
        <button
          onClick={() => onViewModeChange('chronological')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'chronological'
              ? 'bg-selected text-foreground'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          时间线
        </button>
        <div className="flex-1" />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'updatedAt' | 'createdAt')}
          className="text-xs bg-input border border-input-border rounded-md px-2 py-1 text-foreground/60 focus:outline-none"
        >
          <option value="updatedAt">更新时间</option>
          <option value="createdAt">创建时间</option>
        </select>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-auto p-2">
        {filteredTasks.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground/50 text-sm py-12">
            <span className="text-3xl mb-3">📭</span>
            <span className="font-medium">还没有任务</span>
            <span className="text-xs text-foreground/30 mt-1">点击下方按钮创建新任务</span>
          </div>
        ) : filteredTasks.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground/50 text-sm py-12">
            <span className="text-3xl mb-3">🔍</span>
            <span className="font-medium">没有匹配的任务</span>
            <span className="text-xs text-foreground/30 mt-1">尝试其他搜索词</span>
          </div>
        ) : (
          <div className="space-y-1">
            {!collapsed && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-foreground/50 uppercase tracking-wider flex items-center justify-between">
                  <span>项目</span>
                  <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="text-foreground/30 hover:text-foreground"
                  >
                    {collapsed ? '▸' : '▾'}
                  </button>
                </div>
                {filteredTasks.map(task => (
                  <button
                    key={task.id}
                    onClick={() => onTaskSelect(task.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150 ${
                      activeTaskId === task.id
                        ? 'bg-selected text-foreground ring-1 ring-brand/20'
                        : 'text-foreground/80 hover:bg-surface-hover hover:text-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                        activeTaskId === task.id ? 'bg-brand' : 'bg-foreground/20'
                      }`} />
                      <span className="text-sm font-medium truncate flex-1">{task.title}</span>
                    </div>
                    <div className="text-xs text-foreground/40 mt-1 pl-5">
                      {formatTime(task.updatedAt)}
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* 归档任务 */}
        {archivedTasks.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full px-3 py-1.5 text-xs font-semibold text-foreground/50 uppercase tracking-wider flex items-center justify-between"
            >
              <span>归档任务 ({archivedTasks.length})</span>
              <span className="text-foreground/30">{showArchived ? '▾' : '▸'}</span>
            </button>
            {showArchived && (
              <div className="space-y-1 mt-1">
                {sortedArchived.map(task => (
                  <button
                    key={task.id}
                    onClick={() => onTaskSelect(task.id)}
                    className="w-full text-left px-3 py-2 rounded-lg text-foreground/50 hover:bg-surface-hover hover:text-foreground/70 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-2 h-2 rounded-full bg-foreground/20 flex-shrink-0" />
                      <span className="text-sm truncate flex-1">{task.title}</span>
                    </div>
                    <div className="text-xs text-foreground/30 mt-0.5 pl-4.5">
                      {formatTime(task.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="p-3 border-t border-border flex flex-col gap-1.5">
        <button
          onClick={onNewTask}
          className="w-full text-left px-3 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-2.5"
        >
          <span className="text-base w-5 text-center">+</span>
          <span>新建任务</span>
        </button>
        <button className="w-full text-left px-3 py-2.5 text-sm font-medium text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-2.5">
          <span className="text-base w-5 text-center">📂</span>
          <span>添加项目</span>
        </button>
      </div>
    </div>
  )
}
